/**
 * Helpers for catching expensive queries before they ship. Run them in your test suite against a
 * D1 database that has your real schema and indexes (e.g. inside @cloudflare/vitest-plugin).
 */

export interface ScanFinding {
  sql: string;
  /** `full-scan`: every row of a table is read. `index-scan`: a whole index is walked. */
  kind: "full-scan" | "index-scan";
  detail: string;
}

const SCAN = /^SCAN (\S+)(.*)$/;

/** Runs EXPLAIN QUERY PLAN and reports table or index scans (the usual cause of runaway "rows read"). */
export async function findFullScans(db: D1Database, sql: string, params: unknown[] = []): Promise<ScanFinding[]> {
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  const findings: ScanFinding[] = [];
  for (const { detail } of results) {
    const m = SCAN.exec(detail);
    if (!m || m[1] === "CONSTANT") continue;
    findings.push({ sql, detail, kind: /USING (COVERING )?INDEX/.test(m[2]) ? "index-scan" : "full-scan" });
  }
  return findings;
}

/**
 * Throws if any query does a full table scan. Pass `[sql, params]` tuples when a query has placeholders.
 * Use `allow` for scans you accept on purpose (e.g. small lookup tables).
 */
export async function assertNoFullScans(
  db: D1Database,
  queries: (string | [string, unknown[]])[],
  options: { allow?: RegExp[]; includeIndexScans?: boolean } = {},
): Promise<void> {
  const problems: ScanFinding[] = [];
  for (const q of queries) {
    const [sql, params] = typeof q === "string" ? [q, []] : q;
    for (const f of await findFullScans(db, sql, params)) {
      if (f.kind === "index-scan" && !options.includeIndexScans) continue;
      if (options.allow?.some((re) => re.test(f.sql))) continue;
      problems.push(f);
    }
  }
  if (problems.length) {
    const lines = problems.map((p) => `  • ${p.detail}\n    ${p.sql}`);
    throw new Error(`cfguard: ${problems.length} quer${problems.length === 1 ? "y scans" : "ies scan"} a whole table:\n${lines.join("\n")}`);
  }
}
