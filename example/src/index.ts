/**
 * A small Worker with three classic runaway-bill bugs, protected by cfguard:
 *   1. GET  /search          – unindexed WHERE: every request scans the whole posts table
 *   2. POST /bug/write-loop  – loop whose exit condition never becomes true
 *   3. Ticker Durable Object – alarm that re-arms itself every 10 ms, forever, with no users
 */
import { DurableObject } from "cloudflare:workers";
import { CostGuard, guardDurableObject, withGuard, type AlertTarget, type CostGuardOptions } from "../../src";
import { SCHEMA, SEED_SQL, TICK_SQL } from "./schema";

export { CostGuard };

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  JOBS: Queue<{ kind: string }>;
  CFGUARD: DurableObjectNamespace<CostGuard>;
  TICKER: DurableObjectNamespace<TickerImpl>;
  CFGUARD_ADMIN_TOKEN?: string;
  CFGUARD_MAX_USD_5M?: string;
  CFGUARD_SYNC_MS?: string;
  CFGUARD_REQ_MAX_ROWS_WRITTEN?: string;
  ALERT_TYPE?: AlertTarget["type"];
  ALERT_URL?: string;
}

const guardOptions = (env: Env): CostGuardOptions => ({
  bindings: { DB: "d1", CACHE: "kv", FILES: "r2" },
  label: "cfguard-example",
  locale: "zh",
  perInvocation: { d1RowsWritten: Number(env.CFGUARD_REQ_MAX_ROWS_WRITTEN ?? 10_000) },
  windows: [
    { minutes: 5, maxUsd: Number(env.CFGUARD_MAX_USD_5M ?? 2) },
    { minutes: 60, maxUsd: 10 },
    { minutes: 1440, maxUsd: 50 },
  ],
  syncIntervalMs: Number(env.CFGUARD_SYNC_MS ?? 5_000),
  alerts: env.ALERT_URL && env.ALERT_TYPE && env.ALERT_TYPE !== "telegram" ? [{ type: env.ALERT_TYPE, url: env.ALERT_URL }] : [],
});

export class TickerImpl extends DurableObject<Env> {
  async start(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 10);
  }

  async alarm(): Promise<void> {
    // BUG: rebuilds a 50-row leaderboard on every tick and re-arms itself 10 ms later, forever.
    await this.env.DB.prepare(TICK_SQL).bind(this.ctx.id.toString(), 50).run();
    await this.ctx.storage.setAlarm(Date.now() + 10);
  }
}

export const Ticker = guardDurableObject(TickerImpl, guardOptions, "Ticker");

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [, section, id] = url.pathname.split("/");
  const post = request.method === "POST";

  if (post && url.pathname === "/setup") {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    return Response.json({ ok: true });
  }
  if (post && url.pathname === "/seed") {
    const n = Number(url.searchParams.get("n") ?? 1_000);
    await env.DB.prepare(SEED_SQL).bind(n).run();
    return Response.json({ seeded: n });
  }
  if (section === "posts" && id) {
    const row = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(id)).first();
    return row ? Response.json(row) : new Response("not found", { status: 404 });
  }
  if (url.pathname === "/search") {
    const { results } = await env.DB.prepare("SELECT id, title FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT 10")
      .bind(url.searchParams.get("author") ?? "")
      .all();
    return Response.json(results);
  }
  if (post && url.pathname === "/bug/write-loop") {
    const cursor = 0;
    // BUG: cursor is never advanced, so this inserts until something stops it.
    while (cursor < 10) {
      await env.DB.prepare("INSERT INTO events (kind, at) VALUES ('import', ?)").bind(Date.now()).run();
    }
    return Response.json({ ok: true });
  }
  if (section === "cache" && id) {
    const hit = await env.CACHE.get(id);
    if (hit) return new Response(hit);
    await env.CACHE.put(id, `value for ${id}`, { expirationTtl: 60 });
    return new Response(`value for ${id}`);
  }
  if (section === "ticker") {
    const stub = env.TICKER.get(env.TICKER.idFromName(url.searchParams.get("room") ?? "lobby"));
    if (post) await stub.start();
    return Response.json({ ok: true });
  }
  if (post && url.pathname === "/enqueue") {
    await env.JOBS.send({ kind: "recount" });
    return Response.json({ queued: true });
  }
  return new Response("not found", { status: 404 });
}

export default withGuard<Env, { kind: string }>(
  {
    fetch: fetchHandler,
    async scheduled(_controller, env) {
      await env.DB.prepare("INSERT INTO events (kind, at) VALUES ('cron', ?)").bind(Date.now()).run();
    },
    async queue(batch, env) {
      for (const msg of batch.messages) {
        await env.DB.prepare("INSERT INTO events (kind, at) VALUES (?, ?)").bind(msg.body.kind, Date.now()).run();
        msg.ack();
      }
    },
  },
  guardOptions,
);
