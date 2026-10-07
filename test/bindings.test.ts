import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../example/src/index";
import { guardEnv } from "../src/bindings";
import { BudgetExceededError, CircuitOpenError, isCostGuardError } from "../src/errors";
import { Invocation } from "../src/invocation";
import type { MetricLimits } from "../src/metrics";
import { normalizeSql, routeOf } from "../src/normalize";
import { IsolateState } from "../src/state";
import { count, setupDb, testEnv } from "./helpers";

function harness(limits: MetricLimits = {}) {
  const state = new IsolateState();
  const inv = new Invocation("test", limits, state);
  const env = guardEnv<Env>(testEnv, () => inv, { DB: "d1", CACHE: "kv", FILES: "r2" });
  return { state, inv, env };
}

describe("D1 wrapper", () => {
  beforeAll(() => setupDb(1_000));

  it("keeps first/all/run/raw/batch/withSession results identical to the raw binding", async () => {
    const { env: g, inv, state } = harness();
    const raw = testEnv.DB;
    const one = "SELECT id, title FROM posts WHERE id = ?";
    const two = "SELECT id, title FROM posts WHERE id <= 2";

    expect(await g.DB.prepare(one).bind(5).first()).toEqual(await raw.prepare(one).bind(5).first());
    expect(await g.DB.prepare(one).bind(5).first("title")).toBe("post 5");
    expect(await g.DB.prepare(one).bind(99_999).first()).toBeNull();
    await expect(g.DB.prepare(one).bind(5).first("nope")).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
    expect(await g.DB.prepare(two).raw()).toEqual(await raw.prepare(two).raw());
    expect(await g.DB.prepare(two).raw({ columnNames: true })).toEqual(await raw.prepare(two).raw({ columnNames: true }));

    const all = await g.DB.prepare("SELECT SUM(id) AS s FROM posts").all();
    expect(all.results).toEqual([{ s: 500_500 }]);
    expect(all.meta.rows_read).toBeGreaterThanOrEqual(1_000);

    const [a, b] = await g.DB.batch([g.DB.prepare("SELECT 1 AS x"), g.DB.prepare("SELECT 2 AS x")]);
    expect(a.results).toEqual([{ x: 1 }]);
    expect(b.results).toEqual([{ x: 2 }]);

    const session = g.DB.withSession("first-unconstrained");
    expect(await session.prepare(one).bind(7).first("title")).toBe("post 7");

    expect(inv.used.d1Queries).toBe(10);
    expect(inv.used.d1RowsRead).toBeGreaterThanOrEqual(1_000);
    expect(state.pending.d1RowsRead).toBe(inv.used.d1RowsRead);
    const sqlKeys = [...state.hot.values()].filter((h) => h.kind === "sql").map((h) => h.key);
    expect(sqlKeys).toContain("SELECT SUM(id) AS s FROM posts");
    expect(sqlKeys).toContain("SELECT id, title FROM posts WHERE id <= ?");
  });

  it("counts writes from run()", async () => {
    const { env: g, inv } = harness();
    const res = await g.DB.prepare("INSERT INTO events (kind, at) VALUES ('w', ?)").bind(1).run();
    expect(res.success).toBe(true);
    expect(res.meta.changes).toBe(1);
    expect(inv.used.d1RowsWritten).toBeGreaterThanOrEqual(1);
  });

  it("rejects the call that crosses a per-invocation budget and everything after it", async () => {
    const { env: g } = harness({ d1RowsRead: 1_500 });
    const scan = () => g.DB.prepare("SELECT SUM(id) AS s FROM posts").first();
    await scan();
    await expect(scan()).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(g.DB.prepare("SELECT 1").first()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("blocks calls before they reach D1/KV/R2 once the breaker is open", async () => {
    const { env: g, state } = harness();
    state.tripped = { at: Date.now(), manual: true, usd: 0 };
    const before = await count("events");
    await expect(g.DB.prepare("INSERT INTO events (kind, at) VALUES ('x', 1)").run()).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    await expect(g.DB.batch([g.DB.prepare("SELECT 1")])).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(g.CACHE.put("k", "v")).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(g.FILES.put("k", "v")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(await count("events")).toBe(before);
  });

  it("leaves unlisted bindings untouched", () => {
    const { env: g } = harness();
    expect(g.JOBS).toBe(testEnv.JOBS);
    expect(g.CFGUARD).toBe(testEnv.CFGUARD);
  });
});

describe("KV and R2 wrappers", () => {
  it("count KV reads, writes and lists", async () => {
    const { env: g, inv } = harness();
    await g.CACHE.put("a", "1");
    expect(await g.CACHE.get("a")).toBe("1");
    expect(await g.CACHE.getWithMetadata("a")).toMatchObject({ value: "1" });
    expect(await g.CACHE.get("missing")).toBeNull();
    await g.CACHE.list();
    await g.CACHE.delete("a");
    expect(inv.used).toMatchObject({ kvWrites: 2, kvReads: 3, kvLists: 1 });
  });

  it("count R2 Class A and Class B operations, including multipart uploads", async () => {
    const { env: g, inv } = harness();
    await g.FILES.put("f.txt", "hello");
    expect(await (await g.FILES.get("f.txt"))!.text()).toBe("hello");
    expect((await g.FILES.head("f.txt"))?.size).toBe(5);
    await g.FILES.list();
    await g.FILES.delete("f.txt");
    const upload = await g.FILES.createMultipartUpload("big.bin");
    const part = await upload.uploadPart(1, "x".repeat(16));
    await upload.complete([part]);
    expect(inv.used).toMatchObject({ r2ClassA: 5, r2ClassB: 2 });
  });
});

describe("helpers", () => {
  it("finds cfguard errors through wrapper causes", () => {
    const inner = new BudgetExceededError("d1RowsRead", 2, 1, "GET /");
    expect(isCostGuardError(new Error("DrizzleQueryError", { cause: inner }))).toBe(true);
    expect(isCostGuardError(new Error("other"))).toBe(false);
  });

  it("normalizes routes and SQL", () => {
    expect(routeOf(new Request("https://x.dev/posts/123/comments/9f0c2b7e-1a2b-4c3d-8e9f-001122334455"))).toBe(
      "GET /posts/:id/comments/:id",
    );
    expect(normalizeSql("SELECT *\n  FROM t1 WHERE a = 'x''y' AND b IN (1, 2, 3) LIMIT 10")).toBe(
      "SELECT * FROM t1 WHERE a = ? AND b IN (?, …) LIMIT ?",
    );
    expect(normalizeSql("SELECT * FROM t WHERE a = ?1 AND b < :max2 LIMIT 5")).toBe(
      "SELECT * FROM t WHERE a = ?1 AND b < :max2 LIMIT ?",
    );
  });
});
