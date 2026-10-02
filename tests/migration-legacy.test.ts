/**
 * E-05: pending copy orders created before migration 0008 must stay completable
 * and failable after it. Runs the migrations in two steps around legacy rows.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "..", "supabase", "migrations");
const files = readdirSync(dir)
  .filter((x) => x.endsWith(".sql"))
  .sort();
const before = files.filter((f) => f < "20261002000008");
const from8 = files.filter((f) => f >= "20261002000008");

/** The constraints exactly as the first version of 0008 added them (no backfill). */
const OLD_0008 = `
alter table public.pending_orders
  add column fee_model    text check (fee_model in ('inclusive', 'on_top', 'no_fee')),
  add column max_usdc_out numeric(18, 6) check (max_usdc_out >= 0);
alter table public.pending_orders
  add constraint pending_orders_copy_fee_model
  check (kind <> 'copy' or (fee_model is not null and max_usdc_out is not null)) not valid;
alter table public.pending_orders
  add constraint pending_orders_claim_no_outflow
  check (kind <> 'claim' or max_usdc_out is null or max_usdc_out = 0) not valid;
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const f of before) await db.exec(readFileSync(join(dir, f), "utf8"));
  return db;
}

/** Two legacy copy orders (one to complete, one to fail) and a legacy claim order. */
async function legacyRows(db: PGlite) {
  const u = (await db.query<{ id: string }>(`insert into public.users (wallet) values ('legacyW') returning id`)).rows[0].id;
  await db.query(`insert into public.markets (id, address, title, status) values ('mL','mL','t','primary')`);
  const t = (
    await db.query<{ id: string }>(
      `insert into public.trades (signature, market_id, wallet, side, shares) values ('legacyLead','mL','L','YES',1) returning id`,
    )
  ).rows[0].id;
  const mk = async (kind: string) =>
    (
      await db.query<{ id: string }>(
        `insert into public.pending_orders (user_id, wallet, kind, leader_trade_id, market_id, side, amount_usdc, shares, message_hash, message_base64, expires_at)
         values ($1, 'legacyW', $2, $3, 'mL', 'YES', 5, 9.5, $4, 'AA==', now() + interval '90 seconds') returning id`,
        [u, kind, kind === "copy" ? t : null, "b".repeat(64)],
      )
    ).rows[0].id;
  return { u, a: await mk("copy"), b: await mk("copy"), c: await mk("claim") };
}

const complete = (db: PGlite, o: string, u: string, sig: string) =>
  db.query<{ r: string }>(`select public.complete_order($1, $2, $3) as r`, [o, u, sig]).then((r) => r.rows[0].r);

describe("E-05: legacy pending copy orders across migration 0008", () => {
  it("the first 0008 (no backfill) blocked them: complete_order and failOrder errored", async () => {
    const db = await freshDb();
    const { u, a, b } = await legacyRows(db);
    await db.exec(OLD_0008);
    // complete_order at this point is the 0006 version (3 args).
    await expect(complete(db, a, u, "legacySigA")).rejects.toThrow(/pending_orders_copy_fee_model/);
    await expect(db.query(`update public.pending_orders set status = 'failed' where id = $1`, [b])).rejects.toThrow(
      /pending_orders_copy_fee_model/,
    );
    // 0012 repairs such a database.
    await db.exec(readFileSync(join(dir, "20261002000012_legacy_copy_orders.sql"), "utf8"));
    expect(await complete(db, a, u, "legacySigA")).toBe("ok");
    await db.query(`update public.pending_orders set status = 'failed' where id = $1`, [b]);
  });

  it("the current migrations backfill first: legacy orders complete and fail normally", async () => {
    const db = await freshDb();
    const { u, a, b, c } = await legacyRows(db);
    for (const f of from8) await db.exec(readFileSync(join(dir, f), "utf8"));
    const row = (
      await db.query<{ fee_model: string; max_usdc_out: string }>(
        `select fee_model, max_usdc_out::text from public.pending_orders where id = $1`,
        [a],
      )
    ).rows[0];
    expect(row).toEqual({ fee_model: "inclusive", max_usdc_out: "5.000000" });
    expect(await complete(db, a, u, "legacySigA")).toBe("ok");
    await db.query(`update public.pending_orders set status = 'failed' where id = $1 and status = 'pending'`, [b]);
    expect((await db.query<{ status: string }>(`select status from public.pending_orders where id = $1`, [b])).rows[0].status).toBe(
      "failed",
    );
    expect(await complete(db, c, u, "legacySigC")).toBe("ok"); // claims untouched (max_usdc_out null is allowed)
    // E-02: broadcast_signature must look like a base58 signature.
    await expect(db.query(`update public.pending_orders set broadcast_signature = 'x; drop' where id = $1`, [b])).rejects.toThrow(
      /check/,
    );
    // E-10: a copy's amount can't exceed its cap.
    await expect(db.query(`update public.pending_orders set amount_usdc = 6 where id = $1`, [b])).rejects.toThrow(
      /pending_orders_copy_within_cap/,
    );
  });
});
