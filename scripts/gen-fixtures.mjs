#!/usr/bin/env node
/**
 * Generates deterministic mock fixtures for MOCK_PANTA=true.
 * Shapes follow https://docs.panta.market exactly (see lib/schemas.ts).
 *
 *   node scripts/gen-fixtures.mjs
 *
 * Output (all fake data, no real wallets or signatures):
 *   fixtures/markets.json    - market detail rows (list mode nulls the price fields)
 *   fixtures/trades.json     - flat catalog trade rows (market + wallet tapes are filtered from this)
 *   fixtures/positions.json  - { [wallet]: position rows } derived from trades
 *   fixtures/creators.json   - { [marketId]: creator wallet } = simulated on-chain create-tx lookup
 */
import bs58 from "bs58";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// ---- deterministic PRNG (mulberry32) ----
let seed = 0xc0ffee;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randBytes = (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
const pubkey = () => bs58.encode(randBytes(32));
const signature = () => bs58.encode(randBytes(64));
const money = (n) => n.toFixed(2);

const NOW = 1790553600; // 2026-09-28T00:00:00Z, fixed so fixtures are stable
const DAY = 86400;

// ---- markets ----
const TITLES = [
  ["crypto", "Will SOL close above $300 on Oct 31?"],
  ["crypto", "Will BTC hit a new all-time high in October?"],
  ["crypto", "ETH above $5k by end of Q4?"],
  ["crypto", "Will a new Solana memecoin top $1B market cap this month?"],
  ["sports", "Will Nigeria qualify for the 2026 AFCON knockout stage?"],
  ["sports", "Arsenal to win the Premier League 2026/27?"],
  ["sports", "Will the Lakers win their season opener?"],
  ["sports", "Super Eagles to beat Ghana in the friendly?"],
  ["politics", "Will the Fed cut rates at the next meeting?"],
  ["politics", "Will the EU pass the new AI Act amendment this year?"],
  ["tech", "Will Apple announce a foldable iPhone before 2027?"],
  ["tech", "Will OpenAI release a new flagship model in October?"],
  ["tech", "Will Solana Firedancer reach 50% of stake by December?"],
  ["culture", "Will Burna Boy headline a major US festival in 2027?"],
  ["culture", "Will the next Marvel film gross $1B worldwide?"],
  ["crypto", "Will USDC supply exceed 80B by November?"],
  ["crypto", "Will Jupiter's next airdrop happen before Christmas?"],
  ["sports", "Will Victor Osimhen score 20+ league goals this season?"],
  ["politics", "Will Lagos open the next Red Line phase on schedule?"],
  ["tech", "Will Starlink launch direct-to-cell service in Nigeria this year?"],
  ["culture", "Will a Nollywood film top the global Netflix chart this quarter?"],
  ["crypto", "Will SOL/ETH ratio exceed 0.1 this month?"],
  ["sports", "Will Chelsea finish in the top four?"],
  ["tech", "Will a Solana phone ship 200k units by year end?"],
];

// phases: 9 resolved, 2 cancelled, 4 secondary, rest primary
const phases = [
  ...Array(9).fill("resolved"),
  ...Array(2).fill("cancelled"),
  ...Array(4).fill("secondary"),
  ...Array(TITLES.length - 15).fill("primary"),
];

const markets = TITLES.map(([category, title], i) => {
  const phase = phases[i];
  const start = NOW - (40 + Math.floor(rand() * 20)) * DAY;
  const end = phase === "resolved" || phase === "cancelled" ? NOW - (2 + i) * DAY : NOW + (5 + i) * DAY;
  const yes = phase === "resolved" || phase === "cancelled" ? null : 0.15 + rand() * 0.7;
  return {
    marketId: pubkey(),
    category,
    title,
    description: `Fixture market for Copycall mock mode. ${title}`,
    images: [],
    phase,
    marketType: i % 7 === 3 ? "breaking" : "standard",
    startTime: start,
    endTime: end,
    resolutionTime: end + 3600,
    region: "Global",
    resolved: phase === "resolved",
    status: phase === "resolved" ? "resolved" : phase === "cancelled" ? "cancelled" : "open",
    volumeUsdc: "0.00", // filled in below
    campaignId: null,
    createdByPartner: false,
    yesPrice: yes === null ? null : yes.toFixed(2),
    noPrice: yes === null ? null : (1 - yes).toFixed(2),
    primaryYesPrice: phase === "primary" && yes !== null ? yes.toFixed(2) : null,
    primaryNoPrice: phase === "primary" && yes !== null ? (1 - yes).toFixed(2) : null,
    secondaryYesPrice: phase === "secondary" && yes !== null ? yes.toFixed(2) : null,
    secondaryNoPrice: phase === "secondary" && yes !== null ? (1 - yes).toFixed(2) : null,
  };
});

// hidden outcomes for resolved markets (Panta exposes these only via positions)
const outcomes = {};
for (const m of markets) if (m.phase === "resolved") outcomes[m.marketId] = rand() < 0.5 ? "yes" : "no";

// ---- wallets with a "skill" = probability of picking the winning side ----
const SKILLS = [0.9, 0.85, 0.8, 0.75, 0.72, 0.7, 0.65, 0.6, 0.55, 0.5, 0.48, 0.45, 0.4, 0.35, 0.3, 0.5, 0.6, 0.7];
const wallets = SKILLS.map((skill, i) => ({ wallet: pubkey(), skill, activity: i < 12 ? 1 : 0.35 }));

// ---- creators (simulated on-chain lookup): 3 markets created by active traders ----
const creators = {};
for (const m of markets) creators[m.marketId] = pubkey(); // default: a non-trading creator wallet
const creatorMarkets = [markets[0], markets[4], markets[16]]; // resolved, resolved, primary
creatorMarkets.forEach((m, i) => (creators[m.marketId] = wallets[[1, 3, 0][i]].wallet));

// ---- trades ----
let tradeId = 1000;
const trades = [];
function addTrade(m, w, side) {
  const usdc = 2 + rand() * 48;
  const price = 0.2 + rand() * 0.6;
  const shares = usdc / price;
  const fee = usdc * 0.02;
  const t = Math.min(m.endTime - 3600, m.startTime + Math.floor(rand() * (Math.min(m.endTime, NOW) - m.startTime)));
  trades.push({
    id: tradeId++,
    marketId: m.marketId,
    wallet: w.wallet,
    isPrimary: m.phase !== "secondary" || rand() < 0.5,
    yesAmount: side === "yes" ? money(shares) : "0",
    noAmount: side === "no" ? money(shares) : "0",
    feePaid: money(fee),
    blockTime: t,
    signature: signature(),
    quoteAsset: "USDC",
  });
  m._vol = (m._vol ?? 0) + usdc;
}

for (const m of markets) {
  for (const w of wallets) {
    if (rand() > 0.72 * w.activity) continue;
    const outcome = outcomes[m.marketId];
    const side = outcome ? (rand() < w.skill ? outcome : outcome === "yes" ? "no" : "yes") : rand() < 0.55 ? "yes" : "no";
    const n = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < n; k++) addTrade(m, w, side);
  }
}
// guarantee the creator trades exist
creatorMarkets.forEach((m) => {
  const w = wallets.find((x) => x.wallet === creators[m.marketId]);
  addTrade(m, w, outcomes[m.marketId] ?? "yes");
});
// one row with a null blockTime (docs allow `integer | null`)
trades[5].blockTime = null;

trades.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
for (const m of markets) {
  m.volumeUsdc = money(m._vol ?? 0);
  delete m._vol;
}

// ---- positions derived from trades ----
const positions = {};
for (const w of wallets) positions[w.wallet] = [];
const agg = new Map();
for (const t of trades) {
  for (const side of ["yes", "no"]) {
    const amt = Number(side === "yes" ? t.yesAmount : t.noAmount);
    if (amt <= 0) continue;
    const key = `${t.wallet}|${t.marketId}|${side}`;
    agg.set(key, (agg.get(key) ?? 0) + amt);
  }
}
for (const [key, shares] of agg) {
  const [wallet, marketId, side] = key.split("|");
  const m = markets.find((x) => x.marketId === marketId);
  const outcome = outcomes[marketId] ?? null;
  const won = outcome !== null && side === outcome;
  const claimed = won && rand() < 0.4;
  positions[wallet].push({
    marketId,
    category: m.category,
    side,
    shares: money(shares),
    phase: m.phase,
    claimable: won && !claimed,
    claimed,
    outcome,
  });
}

mkdirSync(OUT, { recursive: true });
const write = (name, data) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 2) + "\n");
write("markets.json", markets);
write("trades.json", trades);
write("positions.json", positions);
write("creators.json", creators);

const creatorTradeCount = trades.filter((t) => creators[t.marketId] === t.wallet).length;
console.log(
  `markets=${markets.length} wallets=${wallets.length} trades=${trades.length} ` +
    `resolved=${Object.keys(outcomes).length} creatorTrades=${creatorTradeCount}`,
);
