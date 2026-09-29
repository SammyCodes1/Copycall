/**
 * Runs the real Supabase migrations in an in-process Postgres (PGlite) and
 * checks constraints, RLS/grants and the atomic nonce function.
 * Supabase's API roles are created here to mirror a Supabase project.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "..", "supabase", "migrations");
let db: PGlite;

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    -- Supabase grants table privileges to the API roles by default:
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
}, 60_000);

describe("supabase migrations", () => {
  it("enables RLS on every table", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(10);
    for (const row of r.rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it("has public SELECT policies only on markets, trades, trader_stats", async () => {
    const r = await db.query<{ tablename: string; cmd: string }>(`select tablename, cmd from pg_policies where schemaname = 'public'`);
    expect(new Set(r.rows.map((x) => x.tablename))).toEqual(new Set(["markets", "trades", "trader_stats"]));
    expect(r.rows.every((x) => x.cmd === "SELECT")).toBe(true);
  });

  it("anon/authenticated cannot read or write private tables", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["users", "follows", "alerts", "copies", "auth_nonces", "telegram_link_codes", "rate_limits", "positions"]) {
        await expect(asRole(role, () => db.query(`select * from public.${t}`)), `${role} ${t}`).rejects.toThrow(/permission denied/);
      }
      await expect(asRole(role, () => db.query(`insert into public.markets (id, address, title, status) values ('x','x','x','primary')`))).rejects.toThrow();
    }
  });

  it("anon can read public tables; service_role can write them", async () => {
    await asRole("service_role", () =>
      db.query(`insert into public.markets (id, address, title, status) values ('m1','m1','Test','primary')`),
    );
    const r = await asRole("anon", () => db.query(`select id from public.markets`));
    expect(r.rows).toHaveLength(1);
  });

  it("anon cannot call the auth RPC functions", async () => {
    await expect(asRole("anon", () => db.query(`select public.consume_auth_nonce('n','w')`))).rejects.toThrow(/permission denied/);
    await expect(asRole("anon", () => db.query(`select public.rate_limit_hit('b', 10, 60)`))).rejects.toThrow(/permission denied/);
  });

  it("users.session_version defaults to 1 and bump_session_version increments it (service_role only)", async () => {
    const u = await asRole("service_role", () =>
      db.query<{ id: string; session_version: number }>(`insert into public.users (wallet) values ('svWallet') returning id, session_version`),
    );
    expect(u.rows[0].session_version).toBe(1);
    const id = u.rows[0].id;
    await expect(asRole("anon", () => db.query(`select public.bump_session_version($1)`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asRole("authenticated", () => db.query(`select public.bump_session_version($1)`, [id]))).rejects.toThrow(/permission denied/);
    const bumped = await asRole("service_role", () => db.query<{ v: number }>(`select public.bump_session_version($1) as v`, [id]));
    expect(bumped.rows[0].v).toBe(2);
    const missing = await asRole("service_role", () =>
      db.query<{ v: number | null }>(`select public.bump_session_version('00000000-0000-0000-0000-000000000000') as v`),
    );
    expect(missing.rows[0].v).toBeNull();
    // upsert on conflict (what the app does at sign-in) keeps the bumped version
    const again = await asRole("service_role", () =>
      db.query<{ session_version: number }>(
        `insert into public.users (wallet) values ('svWallet') on conflict (wallet) do update set wallet = excluded.wallet returning session_version`,
      ),
    );
    expect(again.rows[0].session_version).toBe(2);
  });

  it("anon cannot call the sync RPC functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, () => db.query(`select public.wallets_to_refresh(10)`))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => db.query(`select public.replace_positions('w', '[]'::jsonb)`))).rejects.toThrow(/permission denied/);
    }
  });

  it("replace_positions swaps a wallet's snapshot; wallets_to_refresh puts stale stats first", async () => {
    await asRole("service_role", async () => {
      await db.query(`insert into public.markets (id, address, title, status) values ('mSync','mSync','Sync','primary') on conflict do nothing`);
      const rows = [
        { market_id: "mSync", side: "YES", shares: "10.5", phase: "primary", outcome: null, claimable: false, claimed: false },
        { market_id: "mSync", side: "NO", shares: "2", phase: "primary", outcome: null, claimable: false, claimed: false },
      ];
      await db.query(`select public.replace_positions('wSync', $1::jsonb)`, [JSON.stringify(rows)]);
      await db.query(`select public.replace_positions('wSync', $1::jsonb)`, [JSON.stringify(rows.slice(0, 1))]);
      const p = await db.query<{ n: number }>(`select count(*)::int as n from public.positions where wallet = 'wSync'`);
      expect(p.rows[0].n).toBe(1);
      await expect(
        db.query(`select public.replace_positions('wSync', $1::jsonb)`, [JSON.stringify([{ ...rows[0], side: "MAYBE" }])]),
      ).rejects.toThrow(/check/);

      await db.query(
        `insert into public.trades (signature, market_id, wallet, side, shares) values ('sSyncA','mSync','wFresh','YES',1), ('sSyncB','mSync','wStale','NO',1), ('sSyncC','mSync','wNew','NO',1)`,
      );
      await db.query(`insert into public.trader_stats (wallet, updated_at) values ('wFresh', now()), ('wStale', now() - interval '1 day')`);
      const r = await db.query<{ w: string }>(`select w from public.wallets_to_refresh(100) as w`);
      const order = r.rows.map((x) => x.w).filter((w) => ["wFresh", "wStale", "wNew"].includes(w));
      expect(order).toEqual(["wNew", "wStale", "wFresh"]);
      await expect(db.query(`update public.trader_stats set recent_results = 'WX' where wallet = 'wFresh'`)).rejects.toThrow(/check/);
    });
  });

  it("consume_auth_nonce is single-use and bound to the wallet", async () => {
    await asRole("service_role", async () => {
      await db.query(`insert into public.auth_nonces values ('nonce1', 'walletA', now() + interval '5 minutes')`);
      const wrongWallet = await db.query<{ v: string | null }>(`select public.consume_auth_nonce('nonce1', 'walletB') as v`);
      expect(wrongWallet.rows[0].v).toBeNull();
      const first = await db.query<{ v: string | null }>(`select public.consume_auth_nonce('nonce1', 'walletA') as v`);
      expect(first.rows[0].v).not.toBeNull();
      const second = await db.query<{ v: string | null }>(`select public.consume_auth_nonce('nonce1', 'walletA') as v`);
      expect(second.rows[0].v).toBeNull();
    });
  });

  it("rate_limit_hit allows N then blocks", async () => {
    await asRole("service_role", async () => {
      const results: boolean[] = [];
      for (let i = 0; i < 11; i++) {
        const r = await db.query<{ ok: boolean }>(`select public.rate_limit_hit('nonce:ip:test', 10, 60) as ok`);
        results.push(r.rows[0].ok);
      }
      expect(results.slice(0, 10).every(Boolean)).toBe(true);
      expect(results[10]).toBe(false);
    });
  });

  it("enforces slippage_bps <= 500 and unique signatures", async () => {
    await asRole("service_role", async () => {
      await expect(db.query(`insert into public.users (wallet, slippage_bps) values ('w1', 501)`)).rejects.toThrow(/check/);
      await db.query(`insert into public.users (wallet, slippage_bps) values ('w1', 500)`);
      await db.query(`insert into public.trades (signature, market_id, wallet, side, shares) values ('sig1','m1','w1','YES',1)`);
      await expect(
        db.query(`insert into public.trades (signature, market_id, wallet, side, shares) values ('sig1','m1','w2','NO',1)`),
      ).rejects.toThrow(/unique|duplicate/);
      const u = await db.query<{ id: string }>(`select id from public.users where wallet = 'w1'`);
      const t = await db.query<{ id: string }>(`select id from public.trades where signature = 'sig1'`);
      const ins = `insert into public.copies (user_id, leader_trade_id, market_id, side, amount_usdc, signature) values ($1, $2, 'm1', 'YES', 5, 'copysig')`;
      await db.query(ins, [u.rows[0].id, t.rows[0].id]);
      await expect(db.query(ins, [u.rows[0].id, t.rows[0].id])).rejects.toThrow(/unique|duplicate/);
    });
  });
});
