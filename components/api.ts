/** Browser-side JSON helper for our own API routes (same origin; the browser sends Origin). */
export async function sendJson<T = Record<string, unknown>>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(data.message ?? "Request failed");
  return data as T;
}
