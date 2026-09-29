import { isMockMode } from "@/lib/env";
import { getTraderProfile } from "@/lib/queries";
import { PubkeySchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/** GET /api/trader/[wallet] - public profile from our store. 400 unless wallet is a base58 pubkey. */
export async function GET(_request: Request, ctx: RouteContext<"/api/trader/[wallet]">) {
  const { wallet } = await ctx.params;
  const parsed = PubkeySchema.safeParse(wallet);
  if (!parsed.success) {
    return Response.json({ code: "INVALID_WALLET", message: "Invalid wallet address" }, { status: 400 });
  }
  try {
    const profile = await getTraderProfile(parsed.data);
    if (!profile) return Response.json({ code: "NOT_FOUND", message: "No trades seen for this wallet" }, { status: 404 });
    return Response.json(
      { sample: isMockMode(), ...profile },
      { headers: { "Cache-Control": "public, max-age=30, s-maxage=60" } },
    );
  } catch (err) {
    console.error("[api/trader]", err instanceof Error ? err.message : "error");
    return Response.json({ code: "INTERNAL_ERROR", message: "Something went wrong" }, { status: 500 });
  }
}
