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
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
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
    const r = await db.query<{ tablename: string; cmd: string }>(
      `select tablename, cmd from pg_policies where schemaname = 'public'`,
    );
    expect(new Set(r.rows.map((x) => x.tablename))).toEqual(new Set(["markets", "trades", "trader_stats"]));
    expect(r.rows.every((x) => x.cmd === "SELECT")).toBe(true);
  });

  it("anon/authenticated cannot read or write private tables", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of [
        "users",
        "follows",
        "alerts",
        "copies",
        "auth_nonces",
        "telegram_link_codes",
        "rate_limits",
        "positions",
      ]) {
        await expect(
          asRole(role, () => db.query(`select * from public.${t}`)),
          `${role} ${t}`,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        asRole(role, () =>
          db.query(`insert into public.markets (id, address, title, status) values ('x','x','x','primary')`),
        ),
      ).rejects.toThrow();
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
    await expect(asRole("anon", () => db.query(`select public.consume_auth_nonce('n','w')`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asRole("anon", () => db.query(`select public.rate_limit_hit('b', 10, 60)`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("users.session_version defaults to 1 and bump_session_version increments it (service_role only)", async () => {
    const u = await asRole("service_role", () =>
      db.query<{ id: string; session_version: number }>(
        `insert into public.users (wallet) values ('svWallet') returning id, session_version`,
      ),
    );
    expect(u.rows[0].session_version).toBe(1);
    const id = u.rows[0].id;
    await expect(asRole("anon", () => db.query(`select public.bump_session_version($1)`, [id]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asRole("authenticated", () => db.query(`select public.bump_session_version($1)`, [id])),
    ).rejects.toThrow(/permission denied/);
    const bumped = await asRole("service_role", () =>
      db.query<{ v: number }>(`select public.bump_session_version($1) as v`, [id]),
    );
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
      await expect(asRole(role, () => db.query(`select public.wallets_to_refresh(10, now())`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(asRole(role, () => db.query(`select public.replace_positions('w', '[]'::jsonb)`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("replace_positions swaps a wallet's snapshot; wallets_to_refresh puts stale stats first", async () => {
    await asRole("service_role", async () => {
      await db.query(
        `insert into public.markets (id, address, title, status) values ('mSync','mSync','Sync','primary') on conflict do nothing`,
      );
      const rows = [
        {
          market_id: "mSync",
          side: "YES",
          shares: "10.5",
          phase: "primary",
          outcome: null,
          claimable: false,
          claimed: false,
        },
        {
          market_id: "mSync",
          side: "NO",
          shares: "2",
          phase: "primary",
          outcome: null,
          claimable: false,
          claimed: false,
        },
      ];
      await db.query(`select public.replace_positions('wSync', $1::jsonb)`, [JSON.stringify(rows)]);
      await db.query(`select public.replace_positions('wSync', $1::jsonb)`, [JSON.stringify(rows.slice(0, 1))]);
      const p = await db.query<{ n: number }>(`select count(*)::int as n from public.positions where wallet = 'wSync'`);
      expect(p.rows[0].n).toBe(1);
      await expect(
        db.query(`select public.replace_positions('wSync', $1::jsonb)`, [
          JSON.stringify([{ ...rows[0], side: "MAYBE" }]),
        ]),
      ).rejects.toThrow(/check/);

      await db.query(
        `insert into public.trades (signature, market_id, wallet, side, shares) values ('sSyncA','mSync','wFresh','YES',1), ('sSyncB','mSync','wStale','NO',1), ('sSyncC','mSync','wNew','NO',1)`,
      );
      await db.query(
        `insert into public.trader_stats (wallet, updated_at) values ('wFresh', now()), ('wStale', now() - interval '1 day')`,
      );
      const r = await db.query<{ w: string }>(`select w from public.wallets_to_refresh(100, now()) as w`);
      const order = r.rows.map((x) => x.w).filter((w) => ["wFresh", "wStale", "wNew"].includes(w));
      expect(order).toEqual(["wNew", "wStale", "wFresh"]);
      await expect(
        db.query(`update public.trader_stats set recent_results = 'WX' where wallet = 'wFresh'`),
      ).rejects.toThrow(/check/);
    });
  });

  it("consume_auth_nonce is single-use and bound to the wallet", async () => {
    await asRole("service_role", async () => {
      await db.query(`insert into public.auth_nonces values ('nonce1', 'walletA', now() + interval '5 minutes')`);
      const wrongWallet = await db.query<{ v: string | null }>(
        `select public.consume_auth_nonce('nonce1', 'walletB') as v`,
      );
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
      await expect(db.query(`insert into public.users (wallet, slippage_bps) values ('w1', 501)`)).rejects.toThrow(
        /check/,
      );
      await db.query(`insert into public.users (wallet, slippage_bps) values ('w1', 500)`);
      await db.query(
        `insert into public.trades (signature, market_id, wallet, side, shares) values ('sig1','m1','w1','YES',1)`,
      );
      await expect(
        db.query(
          `insert into public.trades (signature, market_id, wallet, side, shares) values ('sig1','m1','w2','NO',1)`,
        ),
      ).rejects.toThrow(/unique|duplicate/);
      const u = await db.query<{ id: string }>(`select id from public.users where wallet = 'w1'`);
      const t = await db.query<{ id: string }>(`select id from public.trades where signature = 'sig1'`);
      const ins = `insert into public.copies (user_id, leader_trade_id, market_id, side, amount_usdc, signature) values ($1, $2, 'm1', 'YES', 5, 'copysig')`;
      await db.query(ins, [u.rows[0].id, t.rows[0].id]);
      await expect(db.query(ins, [u.rows[0].id, t.rows[0].id])).rejects.toThrow(/unique|duplicate/);
    });
  });
  it("link_telegram_chat is single-use, honours expiry, keeps chats unique (service_role only)", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, () => db.query(`select public.link_telegram_chat('h', 1)`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(asRole(role, () => db.query(`select * from public.alert_subscriptions()`))).rejects.toThrow(
        /permission denied/,
      );
    }
    await asRole("service_role", async () => {
      const a = (await db.query<{ id: string }>(`insert into public.users (wallet) values ('tgA') returning id`))
        .rows[0].id;
      const b = (
        await db.query<{ id: string }>(
          `insert into public.users (wallet, alerts_enabled) values ('tgB', false) returning id`,
        )
      ).rows[0].id;
      await db.query(
        `insert into public.telegram_link_codes (code, user_id, expires_at) values ('hA', $1, now() + interval '10 minutes')`,
        [a],
      );
      await db.query(
        `insert into public.telegram_link_codes (code, user_id, expires_at) values ('hB', $1, now() + interval '10 minutes')`,
        [b],
      );
      await db.query(
        `insert into public.telegram_link_codes (code, user_id, expires_at) values ('hOld', $1, now() - interval '1 minute')`,
        [b],
      );
      const link = (h: string, chat: number) =>
        db
          .query<{ user_id: string }>(`select * from public.link_telegram_chat($1, $2)`, [h, chat])
          .then((r) => r.rows[0]?.user_id ?? null);

      expect(await link("hA", 555)).toBe(a);
      expect(await link("hA", 555)).toBeNull(); // single use
      expect(await link("hOld", 556)).toBeNull(); // expired
      expect((await db.query(`select 1 from public.telegram_link_codes where code = 'hOld'`)).rows).toHaveLength(0);
      // Same chat linked by another user moves to them; alerts are switched on.
      const moved = (
        await db.query<{
          user_id: string;
          wallet: string;
          previous_user_id: string;
          previous_wallet: string;
          previous_chat_id: string | null;
        }>(`select * from public.link_telegram_chat('hB', 555)`)
      ).rows[0];
      // B2-01: the result says who lost the chat, and that user is marked unlinked.
      expect(moved).toMatchObject({
        user_id: b,
        wallet: "tgB",
        previous_user_id: a,
        previous_wallet: "tgA",
        previous_chat_id: null,
      });
      const ua = (
        await db.query<{ t: string | null }>(`select telegram_unlinked_at as t from public.users where id = $1`, [a])
      ).rows[0];
      expect(ua.t).not.toBeNull();
      const rows = (
        await db.query<{ wallet: string; telegram_chat_id: string | null; alerts_enabled: boolean }>(
          `select wallet, telegram_chat_id, alerts_enabled from public.users where wallet in ('tgA','tgB') order by wallet`,
        )
      ).rows;
      expect(
        rows.map((r) => [r.wallet, r.telegram_chat_id === null ? null : Number(r.telegram_chat_id), r.alerts_enabled]),
      ).toEqual([
        ["tgA", null, true],
        ["tgB", 555, true],
      ]);
      await expect(db.query(`update public.users set telegram_chat_id = 555 where id = $1`, [a])).rejects.toThrow(
        /unique|duplicate/,
      );

      await db.query(`insert into public.follows (user_id, leader_wallet) values ($1, 'leaderX'), ($2, 'leaderX')`, [
        a,
        b,
      ]);
      await db.query(`update public.users set alerts_enabled = false where id = $1`, [a]);
      const subs = (
        await db.query<{ user_id: string }>(
          `select user_id from public.alert_subscriptions() where leader_wallet = 'leaderX'`,
        )
      ).rows;
      expect(subs.map((r) => r.user_id)).toEqual([b]);
    });
  });
  it("complete_order is atomic and refuses reused signatures; copy tables are private", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["pending_orders", "claims", "api_cache"]) {
        await expect(asRole(role, () => db.query(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
      }
      await expect(
        asRole(role, () => db.query(`select public.complete_order(gen_random_uuid(), gen_random_uuid(), 's', true)`)),
      ).rejects.toThrow(/permission denied/);
    }
    await asRole("service_role", async () => {
      const u = (await db.query<{ id: string }>(`insert into public.users (wallet) values ('copyW') returning id`))
        .rows[0].id;
      await db.query(
        `insert into public.markets (id, address, title, status) values ('mC','mC','t','primary') on conflict do nothing`,
      );
      const t = (
        await db.query<{ id: string }>(
          `insert into public.trades (signature, market_id, wallet, side, shares) values ('leadSig','mC','L','YES',1) returning id`,
        )
      ).rows[0].id;
      const hash = "a".repeat(64);
      const mk = async (kind: string) =>
        (
          await db.query<{ id: string }>(
            `insert into public.pending_orders (user_id, wallet, kind, leader_trade_id, market_id, side, amount_usdc, shares, message_hash, message_base64, expires_at, fee_model, max_usdc_out)
             values ($1, 'copyW', $2, $3, 'mC', 'YES', 5, 9.5, $4, 'AA==', now() + interval '90 seconds', $5, $6) returning id`,
            [u, kind, kind === "copy" ? t : null, hash, kind === "copy" ? "on_top" : null, kind === "copy" ? 5 : 0],
          )
        ).rows[0].id;
      const complete = (o: string, sig: string, user = u) =>
        db
          .query<{ r: string }>(`select public.complete_order($1, $2, $3) as r`, [o, user, sig])
          .then((r) => r.rows[0].r);

      // A copy order must carry its fee model and limit; a claim may not allow USDC out.
      const bad = (sql: string, args: unknown[]) => expect(db.query(sql, args)).rejects.toThrow(/pending_orders_/);
      await bad(
        `insert into public.pending_orders (user_id, wallet, kind, leader_trade_id, market_id, side, amount_usdc, shares, message_hash, message_base64, expires_at)
         values ($1, 'copyW', 'copy', $2, 'mC', 'YES', 5, 9.5, $3, 'AA==', now() + interval '90 seconds')`,
        [u, t, hash],
      );
      await bad(
        `insert into public.pending_orders (user_id, wallet, kind, market_id, side, amount_usdc, shares, message_hash, message_base64, expires_at, max_usdc_out)
         values ($1, 'copyW', 'claim', 'mC', 'YES', 5, 9.5, $2, 'AA==', now() + interval '90 seconds', 1)`,
        [u, hash],
      );
      await expect(
        db.query(
          `insert into public.pending_orders (user_id, wallet, kind, leader_trade_id, market_id, side, amount_usdc, shares, message_hash, message_base64, expires_at, fee_model, max_usdc_out)
           values ($1, 'copyW', 'copy', $2, 'mC', 'YES', 5, 9.5, $3, 'AA==', now() + interval '90 seconds', 'guess', 5)`,
          [u, t, hash],
        ),
      ).rejects.toThrow(/fee_model/);

      const a = await mk("copy");
      const b = await mk("copy");
      const c = await mk("claim");
      expect(await complete(a, "sigA", "00000000-0000-0000-0000-000000000000")).toBe("not_pending"); // other user
      expect(await complete(a, "sigA")).toBe("ok");
      expect(await complete(a, "sigA")).toBe("already_confirmed");
      expect(await complete(a, "sigOther")).toBe("not_pending");
      expect(await complete(b, "sigA")).toBe("signature_used");
      expect(await complete(c, "sigA")).toBe("signature_used");
      expect(await complete(c, "sigC")).toBe("ok");
      const copies = (
        await db.query<{ signature: string; status: string }>(
          `select signature, status from public.copies where user_id = $1`,
          [u],
        )
      ).rows;
      expect(copies).toEqual([{ signature: "sigA", status: "confirmed" }]);
      expect((await db.query(`select 1 from public.claims where signature = 'sigC'`)).rows).toHaveLength(1);

      // D-04: copies keep the exact 6-dp debit.
      const odd = (
        await db.query<{ id: string }>(
          `insert into public.pending_orders (user_id, wallet, kind, leader_trade_id, market_id, side, amount_usdc, fee_usdc, shares, message_hash, message_base64, expires_at, fee_model, max_usdc_out)
           values ($1, 'copyW', 'copy', $2, 'mC', 'YES', 4.995, 0.105, 9.5, $3, 'AA==', now() + interval '90 seconds', 'inclusive', 5) returning id`,
          [u, t, hash],
        )
      ).rows[0].id;
      expect(await complete(odd, "sigOdd")).toBe("ok");
      const oddRow = (
        await db.query<{ amount_usdc: string; fee_usdc: string }>(`select amount_usdc::text, fee_usdc::text from public.copies where order_id = $1`, [odd])
      ).rows[0];
      expect(oddRow).toEqual({ amount_usdc: "4.995000", fee_usdc: "0.105000" });
      await db.query(`update public.copies set reported_at = now() where order_id = $1`, [odd]);

      // B3-06: a failed order is only confirmed when the caller re-verified it (p_allow_failed).
      const f = await mk("copy");
      await db.query(`update public.pending_orders set status = 'failed' where id = $1`, [f]);
      const revive = (o: string, sig: string) =>
        db
          .query<{ r: string }>(`select public.complete_order($1, $2, $3, true) as r`, [o, u, sig])
          .then((r) => r.rows[0].r);
      expect(await complete(f, "sigF")).toBe("not_pending");
      expect(await revive(f, "sigA")).toBe("signature_used");
      // Concurrent confirms of one order: exactly one 'ok', one copies row.
      const rs = await Promise.all([revive(f, "sigF"), revive(f, "sigF"), revive(f, "sigF2"), complete(f, "sigF")]);
      expect(rs.filter((r) => r === "ok")).toHaveLength(1);
      expect(rs.filter((r) => r !== "ok").every((r) => r === "already_confirmed" || r === "not_pending")).toBe(true);
      expect((await db.query(`select 1 from public.copies where order_id = $1`, [f])).rows).toHaveLength(1);
      expect(await revive(f, "sigF3")).toBe("not_pending");

      // B3-07: report retries are claimed atomically, with backoff, a cap, and a stop code.
      const due = (gap: number, max = 5) =>
        db
          .query<{ kind: string; order_id: string; signature: string; wallet: string; attempts: number }>(
            `select * from public.claim_report_retries(50, $1, $2, 86400)`,
            [max, gap],
          )
          .then((r) => r.rows.filter((x) => x.wallet === "copyW"));
      const first = await due(0);
      expect(first.map((x) => x.signature).sort()).toEqual(["sigA", "sigC", "sigF"]);
      expect(first.every((x) => x.attempts === 1)).toBe(true);
      expect(await due(3600)).toEqual([]); // last attempt was just now: backoff
      expect((await due(0)).every((x) => x.attempts === 2)).toBe(true);
      await db.query(`select public.record_report_failure($1, 'TX_FEE_MISMATCH', true, 5)`, [a]);
      await db.query(`update public.claims set reported_at = now() where signature = 'sigC'`);
      expect((await due(0)).map((x) => x.signature)).toEqual(["sigF"]); // stopped + reported are gone
      expect((await due(0, 4)).map((x) => x.signature)).toEqual(["sigF"]); // attempt 4
      expect(await due(0, 4)).toEqual([]); // cap reached
      const errRow = (await db.query<{ report_error: string }>(`select report_error from public.copies where order_id = $1`, [a])).rows[0];
      expect(errRow.report_error).toBe("TX_FEE_MISMATCH");
      await expect(db.query(`update public.copies set report_error = 'bad code!' where order_id = $1`, [a])).rejects.toThrow(/check/);
      await expect(
        db.query(`update public.pending_orders set message_hash = 'nothex' where id = $1`, [b]),
      ).rejects.toThrow(/check/);
    });
  });
  it("report-retry functions are service_role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, () => db.query(`select * from public.claim_report_retries(1, 1, 1, 1)`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        asRole(role, () => db.query(`select public.record_report_failure(gen_random_uuid(), 'X', true, 1)`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
  it("batch 2 audit functions are service_role only", async () => {
    const calls = [
      `select * from public.peek_link_code('h')`,
      `select public.linked_wallet_for_chat(1)`,
      `select public.follow_capped(gen_random_uuid(), 'w', 50)`,
      `select public.record_sync_failure('tape', 'm', now())`,
      `select * from public.markets_needing_trades(10, now())`,
      `select public.trader_rank('w', 5)`,
      `select * from public.claim_alert_retries(1, 3, 1800, 110)`,
      `select public.set_alert_status(gen_random_uuid(), 'sent', now())`,
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const q of calls)
        await expect(
          asRole(role, () => db.query(q)),
          `${role} ${q}`,
        ).rejects.toThrow(/permission denied/);
      await expect(asRole(role, () => db.query(`select * from public.sync_failures`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("follow_capped enforces the cap in one locked step (B2-03)", async () => {
    await asRole("service_role", async () => {
      const u = (await db.query<{ id: string }>(`insert into public.users (wallet) values ('fcap') returning id`))
        .rows[0].id;
      const f = (w: string) =>
        db.query<{ r: string }>(`select public.follow_capped($1, $2, 3) as r`, [u, w]).then((x) => x.rows[0].r);
      expect([await f("a"), await f("b"), await f("c"), await f("d"), await f("a")]).toEqual([
        "followed",
        "followed",
        "followed",
        "limit",
        "already",
      ]);
      const n = await db.query<{ n: number }>(`select count(*)::int as n from public.follows where user_id = $1`, [u]);
      expect(n.rows[0].n).toBe(3);
      // The row lock is taken on users (FOR UPDATE), which serialises concurrent callers in Postgres.
      const src = await db.query<{ s: string }>(`select prosrc as s from pg_proc where proname = 'follow_capped'`);
      expect(src.rows[0].s).toMatch(/for update/i);
    });
  });

  it("peek_link_code shows the wallet without consuming the code (B2-01)", async () => {
    await asRole("service_role", async () => {
      const u = (await db.query<{ id: string }>(`insert into public.users (wallet) values ('peekW') returning id`))
        .rows[0].id;
      await db.query(
        `insert into public.telegram_link_codes (code, user_id, expires_at) values ('hPeek', $1, now() + interval '5 minutes')`,
        [u],
      );
      for (let i = 0; i < 2; i++) {
        const r = await db.query<{ user_id: string; wallet: string }>(`select * from public.peek_link_code('hPeek')`);
        expect(r.rows).toEqual([{ user_id: u, wallet: "peekW" }]);
      }
      const r = await db.query<{ user_id: string }>(`select * from public.link_telegram_chat('hPeek', 8080)`);
      expect(r.rows[0].user_id).toBe(u);
      expect((await db.query(`select * from public.peek_link_code('hPeek')`)).rows).toEqual([]);
      expect((await db.query<{ w: string }>(`select public.linked_wallet_for_chat(8080) as w`)).rows[0].w).toBe(
        "peekW",
      );
    });
  });

  it("sync failures back off per item (B2-04)", async () => {
    await asRole("service_role", async () => {
      await db.query(
        `insert into public.markets (id, address, title, status) values ('mBad','mBad','Bad','primary'), ('mOk','mOk','Ok','primary') on conflict do nothing`,
      );
      await db.query(`select public.record_sync_failure('tape', 'mBad', '2026-09-30T10:00:00Z')`);
      const due = (t: string) =>
        db
          .query<{ id: string }>(`select id from public.markets_needing_trades(1000, $1)`, [t])
          .then((r) => r.rows.map((x) => x.id));
      expect(await due("2026-09-30T10:05:00Z")).not.toContain("mBad");
      expect(await due("2026-09-30T10:05:00Z")).toContain("mOk");
      expect(await due("2026-09-30T10:11:00Z")).toContain("mBad");
      await db.query(`select public.record_sync_failure('tape', 'mBad', '2026-09-30T10:11:00Z')`); // 2nd: 20 min
      expect(await due("2026-09-30T10:25:00Z")).not.toContain("mBad");
      expect(await due("2026-09-30T10:32:00Z")).toContain("mBad");
      for (let i = 0; i < 20; i++) await db.query(`select public.record_sync_failure('wallet', 'wBad', now())`);
      const next = await db.query<{ h: number }>(
        `select extract(epoch from next_attempt_at - now()) / 3600 as h from public.sync_failures where kind = 'wallet' and key = 'wBad'`,
      );
      expect(Number(next.rows[0].h)).toBeLessThanOrEqual(24.01); // capped at a day
      await db.query(
        `insert into public.trades (signature, market_id, wallet, side, shares) values ('sBadW','mOk','wBad','YES',1)`,
      );
      const w = await db.query<{ w: string }>(`select w from public.wallets_to_refresh(1000, now()) as w`);
      expect(w.rows.map((x) => x.w)).not.toContain("wBad");
    });
  });

  it("trader_rank matches the leaderboard order (B2-07)", async () => {
    await asRole("service_role", async () => {
      await db.query(`delete from public.trader_stats`);
      await db.query(`insert into public.trader_stats (wallet, resolved_calls, correct_calls, hit_rate) values
        ('rA', 10, 9, 0.9), ('rB', 20, 18, 0.9), ('rC', 10, 9, 0.9), ('rD', 8, 4, 0.5), ('rE', 2, 2, 1.0)`);
      const rank = (w: string) =>
        db.query<{ r: number | null }>(`select public.trader_rank($1, 5) as r`, [w]).then((x) => x.rows[0].r);
      expect([
        await rank("rB"),
        await rank("rA"),
        await rank("rC"),
        await rank("rD"),
        await rank("rE"),
        await rank("nope"),
      ]).toEqual([1, 2, 3, 4, null, null]);
    });
  });

  it("claim_alert_retries is bounded by attempts, age and gap (B2-11)", async () => {
    await asRole("service_role", async () => {
      const u = (await db.query<{ id: string }>(`insert into public.users (wallet) values ('retryU') returning id`))
        .rows[0].id;
      await db.query(
        `insert into public.markets (id, address, title, status) values ('mR','mR','R','primary') on conflict do nothing`,
      );
      const t = (
        await db.query<{ id: string }>(
          `insert into public.trades (signature, market_id, wallet, side, shares) values ('sR','mR','wR','YES',1) returning id`,
        )
      ).rows[0].id;
      const a = (
        await db.query<{ id: string }>(
          `insert into public.alerts (user_id, trade_id, status, created_at) values ($1, $2, 'pending', now() - interval '5 minutes') returning id`,
          [u, t],
        )
      ).rows[0].id;
      await db.query(`select public.set_alert_status($1, 'failed', null)`, [a]);
      // Just attempted: gap not reached.
      expect((await db.query(`select * from public.claim_alert_retries(10, 3, 1800, 110)`)).rows).toEqual([]);
      await db.query(`update public.alerts set last_attempt_at = now() - interval '3 minutes' where id = $1`, [a]);
      const got = await db.query<{ id: string }>(`select id from public.claim_alert_retries(10, 3, 1800, 110)`);
      expect(got.rows.map((r) => r.id)).toEqual([a]);
      // Claimed rows get last_attempt_at = now(), so an overlapping run gets nothing.
      expect((await db.query(`select * from public.claim_alert_retries(10, 3, 1800, 110)`)).rows).toEqual([]);
      await db.query(
        `update public.alerts set attempts = 3, last_attempt_at = now() - interval '1 hour' where id = $1`,
        [a],
      );
      expect((await db.query(`select * from public.claim_alert_retries(10, 3, 1800, 110)`)).rows).toEqual([]);
      await db.query(`update public.alerts set attempts = 0, created_at = now() - interval '1 hour' where id = $1`, [
        a,
      ]);
      expect((await db.query(`select * from public.claim_alert_retries(10, 3, 1800, 110)`)).rows).toEqual([]);
    });
  });
});
