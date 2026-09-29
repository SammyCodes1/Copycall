import { z } from "zod";
import { isMockMode } from "@/lib/env";
import { getLeaderboard } from "@/lib/queries";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

/** GET /api/leaderboard?limit= - public; ranked wallets (>= MIN_RESOLVED_CALLS) from trader_stats. */
export async function GET(request: Request) {
  const q = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) return Response.json({ code: "INVALID_REQUEST", message: "limit must be 1-100" }, { status: 400 });
  try {
    const { rows, minResolved, updatedAt } = await getLeaderboard(q.data.limit);
    return Response.json(
      { sample: isMockMode(), minResolvedCalls: minResolved, updatedAt, rows },
      { headers: { "Cache-Control": "public, max-age=30, s-maxage=60" } },
    );
  } catch (err) {
    console.error("[api/leaderboard]", err instanceof Error ? err.message : "error");
    return Response.json({ code: "INTERNAL_ERROR", message: "Something went wrong" }, { status: 500 });
  }
}
