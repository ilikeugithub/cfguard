import { describe, expect, it } from "vitest";
import { formatAlert } from "../src/alerts";
import { assertNoFullScans, findFullScans } from "../src/testing";
import { setupDb, testEnv } from "./helpers";

describe("query plan checks", () => {
  it("flag unindexed lookups and pass once an index exists", async () => {
    await setupDb();
    const byAuthor: [string, unknown[]] = ["SELECT * FROM posts WHERE author = ?", ["x"]];

    expect(await findFullScans(testEnv.DB, ...byAuthor)).toMatchObject([{ kind: "full-scan" }]);
    expect(await findFullScans(testEnv.DB, "SELECT * FROM posts WHERE id = ?", [1])).toEqual([]);
    await expect(assertNoFullScans(testEnv.DB, [byAuthor])).rejects.toThrow(/scans a whole table/);
    await expect(assertNoFullScans(testEnv.DB, [byAuthor], { allow: [/author/] })).resolves.toBeUndefined();

    await testEnv.DB.prepare("CREATE INDEX posts_author ON posts (author)").run();
    await expect(assertNoFullScans(testEnv.DB, [byAuthor])).resolves.toBeUndefined();
  });
});

describe("alerts", () => {
  it("formats a Chinese trip alert with the culprit SQL and route", () => {
    const text = formatAlert(
      {
        kind: "tripped",
        trip: {
          at: 0,
          manual: false,
          usd: 2.13,
          breach: { metric: "usd", used: 2.13, limit: 2, minutes: 5 },
          top: {
            sql: [{ kind: "sql", key: "SELECT * FROM posts WHERE author = ?", rowsRead: 2.1e9, rowsWritten: 0, calls: 1200, usd: 2.1 }],
            routes: [{ kind: "route", key: "GET /search", rowsRead: 2.1e9, rowsWritten: 0, calls: 1200, usd: 2.11 }],
          },
        },
      },
      { locale: "zh", label: "blog", adminPath: "/__cfguard" },
    );
    expect(text).toContain("cfguard 已熔断 [blog]");
    expect(text).toContain("最近 5 分钟估算花费 $2.13，达到上限 $2.00");
    expect(text).toContain("1. $2.10 · 读 2.10B 行 · 1.2K 次 · SELECT * FROM posts WHERE author = ?");
    expect(text).toContain("GET /search");
    expect(text).toContain("POST /__cfguard/reset");
  });
});
