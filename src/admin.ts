import type { ResolvedOptions } from "./options";
import type { IsolateState } from "./state";
import { guardStub } from "./sync";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  // Compare digests so lengths always match and timing does not leak the token.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Serves `<adminPath>/status`, `<adminPath>/reset` and `<adminPath>/trip`. Returns null for other paths.
 * Admin requests bypass the breaker so a tripped Worker can still be inspected and reset.
 */
export async function handleAdmin(
  request: Request,
  env: unknown,
  o: ResolvedOptions,
  state: IsolateState,
): Promise<Response | null> {
  if (!o.adminPath) return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${o.adminPath}/`)) return null;

  const expected = (env as Record<string, unknown>)?.[o.adminTokenBinding];
  if (typeof expected !== "string" || !expected) return new Response("Not found", { status: 404 });
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await tokenMatches(given, expected))) return json({ error: "unauthorized" }, 401);

  const stub = guardStub(env, o);
  if (!stub) return json({ error: `Durable Object binding "${o.guardBinding}" not configured` }, 500);

  const action = url.pathname.slice(o.adminPath.length + 1);
  if (action === "status" && request.method === "GET") {
    const window = Number(url.searchParams.get("window")) || undefined;
    return json(await stub.status(window));
  }
  if (action === "reset" && request.method === "POST") {
    const result = await stub.reset({ clearUsage: url.searchParams.get("clear") === "1" });
    state.tripped = null;
    state.lastSync = Date.now();
    return json(result);
  }
  if (action === "trip" && request.method === "POST") {
    const reason = url.searchParams.get("reason") ?? "manual trip via admin endpoint";
    state.tripped = await stub.trip(reason);
    return json({ ok: true, tripped: state.tripped });
  }
  return json({ error: "not found" }, 404);
}
