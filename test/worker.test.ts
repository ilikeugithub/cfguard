import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../example/src/index";
import { resetIsolateStates } from "../src/state";
import { ADMIN, call, count, guard, resetGuard, runCron, setupDb, testEnv } from "./helpers";

describe("withGuard", () => {
  beforeAll(() => setupDb(20_000));
  beforeEach(resetGuard);

  it("passes normal traffic through and attributes usage to routes and SQL", async () => {
    const res = await call("/posts/42");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 42, title: "post 42" });

    const status = await guard().status();
    expect(status.tripped).toBeNull();
    expect(status.top.routes.map((r) => r.key)).toContain("GET /posts/:id");
    expect(status.top.sql.map((s) => s.key)).toContain("SELECT * FROM posts WHERE id = ?");
    expect(status.windows[0].usage.d1RowsRead).toBeGreaterThan(0);
  });

  it("stops an infinite write loop inside a single request", async () => {
    const before = await count("events");
    const res = await call("/bug/write-loop", { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "cost_guard_budget_exceeded", metric: "d1RowsWritten", limit: 200 });
    expect((await count("events")) - before).toBe(200);
  });

  it("trips on full-scan traffic, blocks everything, names the culprit, and recovers after reset", async () => {
    let trippedAt = -1;
    for (let i = 0; i < 100; i++) {
      const res = await call("/search?author=author-7");
      if (res.status === 503) {
        trippedAt = i;
        break;
      }
      expect(res.status).toBe(200);
    }
    // 20,000 rows per search ≈ $0.00002, so the $0.001 / 5 min cap is hit after ~50 requests.
    expect(trippedAt).toBeGreaterThan(40);
    expect(trippedAt).toBeLessThan(60);

    const status = await guard().status();
    expect(status.tripped?.breach).toMatchObject({ metric: "usd", minutes: 5, limit: 0.001 });
    expect(status.tripped?.top.sql[0].key).toBe(
      "SELECT id, title FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT ?",
    );
    expect(status.tripped?.top.routes[0].key).toBe("GET /search");

    const blocked = await call("/posts/1");
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: "cost_guard_tripped" });

    // Reset without clearing history: the old burst must not re-trip the breaker.
    expect((await call("/__cfguard/reset", { method: "POST", headers: ADMIN })).status).toBe(200);
    expect((await call("/search?author=author-7")).status).toBe(200);
    expect((await guard().status()).tripped).toBeNull();
  });

  it("protects admin endpoints with the token and supports manual trips", async () => {
    expect((await call("/__cfguard/status")).status).toBe(401);
    expect((await call("/__cfguard/status", { headers: { authorization: "Bearer nope" } })).status).toBe(401);

    const trip = await call("/__cfguard/trip?reason=deploy%20gone%20wrong", { method: "POST", headers: ADMIN });
    expect(trip.status).toBe(200);
    expect((await call("/posts/1")).status).toBe(503);

    const status = await call("/__cfguard/status", { headers: ADMIN });
    expect(await status.json()).toMatchObject({ tripped: { manual: true, reason: "deploy gone wrong" } });

    expect((await call("/__cfguard/reset", { method: "POST", headers: ADMIN })).status).toBe(200);
    expect((await call("/posts/1")).status).toBe(200);
  });

  it("skips cron runs while the breaker is open", async () => {
    const before = await count("events");
    await runCron();
    expect(await count("events")).toBe(before + 1);

    await guard().trip("test");
    resetIsolateStates(); // a fresh isolate checks the breaker before running
    await runCron();
    expect(await count("events")).toBe(before + 1);
  });

  it("defers queue batches while open instead of hot-looping through retries", async () => {
    const msg = (id: string) => ({ id, timestamp: new Date(), attempts: 1, body: { kind: "recount" } });

    const ok = createMessageBatch<{ kind: string }>("cfguard-jobs", [msg("m1")]);
    let ctx = createExecutionContext();
    await worker.queue!(ok, testEnv, ctx);
    expect((await getQueueResult(ok, ctx)).explicitAcks).toEqual(["m1"]);

    await guard().trip("test");
    resetIsolateStates();
    const deferred = createMessageBatch<{ kind: string }>("cfguard-jobs", [msg("m2")]);
    const retryAll = vi.spyOn(deferred, "retryAll");
    ctx = createExecutionContext();
    await worker.queue!(deferred, testEnv, ctx);
    const result = await getQueueResult(deferred, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryBatch.retry).toBe(true);
    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 3600 });
  });

  it("fails open without the CostGuard binding but still enforces per-request budgets", async () => {
    const noGuard = { ...testEnv, CFGUARD: undefined } as unknown as Env;
    expect((await call("/posts/1", undefined, noGuard)).status).toBe(200);
    expect((await call("/bug/write-loop", { method: "POST" }, noGuard)).status).toBe(503);
  });
});
