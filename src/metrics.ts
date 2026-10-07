/** Every billable signal cfguard meters. Counts are raw units (rows, operations, milliseconds). */
export const METRICS = [
  "d1RowsRead",
  "d1RowsWritten",
  "d1Queries",
  "kvReads",
  "kvWrites",
  "kvLists",
  "r2ClassA",
  "r2ClassB",
  "workerInvocations",
  "doRequests",
  "doAlarms",
  "doWallMs",
] as const;

export type Metric = (typeof METRICS)[number];
export type Metrics = Record<Metric, number>;
export type MetricLimits = Partial<Metrics>;

/**
 * USD per unit at Workers Paid overage list prices (October 2026).
 * Included monthly allowances are ignored, so estimates are an upper bound — the safe direction for a breaker.
 */
export const PRICES_USD: Metrics = {
  d1RowsRead: 0.001 / 1e6,
  d1RowsWritten: 1 / 1e6,
  d1Queries: 0,
  kvReads: 0.5 / 1e6,
  kvWrites: 5 / 1e6, // writes and deletes
  kvLists: 5 / 1e6,
  r2ClassA: 4.5 / 1e6,
  r2ClassB: 0.36 / 1e6,
  workerInvocations: 0.3 / 1e6,
  doRequests: 0.15 / 1e6,
  doAlarms: 0, // billed as doRequests
  doWallMs: ((12.5 / 1e6) * 0.125) / 1000, // $12.50 per million GB-s at 128 MB
};

export function zeroMetrics(): Metrics {
  return Object.fromEntries(METRICS.map((m) => [m, 0])) as Metrics;
}

export function addMetrics(target: Metrics, delta: Partial<Metrics>): Metrics {
  for (const m of METRICS) {
    const v = delta[m];
    if (v) target[m] += v;
  }
  return target;
}

export function isZero(m: Partial<Metrics>): boolean {
  return METRICS.every((k) => !m[k]);
}

export function nonZero(m: Partial<Metrics>): MetricLimits {
  const out: MetricLimits = {};
  for (const k of METRICS) if (m[k]) out[k] = m[k];
  return out;
}

export function estimateUsd(m: Partial<Metrics>): number {
  let usd = 0;
  for (const k of METRICS) usd += (m[k] ?? 0) * PRICES_USD[k];
  return usd;
}
