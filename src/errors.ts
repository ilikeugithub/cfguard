import type { Metric } from "./metrics";
import type { TripSummary } from "./types";

export class CostGuardError extends Error {
  /** Survives duplicated module copies and wrapping by ORMs, unlike `instanceof`. */
  readonly __cfguard = true as const;
}

/** A single request / cron run / alarm used more than its per-invocation budget. */
export class BudgetExceededError extends CostGuardError {
  constructor(
    readonly metric: Metric,
    readonly used: number,
    readonly limit: number,
    readonly route: string,
  ) {
    super(`cfguard: per-invocation budget exceeded on "${route}": ${metric}=${used} > ${limit}`);
    this.name = "BudgetExceededError";
  }
}

/** The global breaker is open; no billable binding calls are allowed. */
export class CircuitOpenError extends CostGuardError {
  constructor(readonly trip: TripSummary) {
    super("cfguard: circuit open, billable calls are blocked until reset");
    this.name = "CircuitOpenError";
  }
}

/** Finds a cfguard error in `e` or its `cause` chain (Drizzle and friends wrap driver errors). */
export function findCostGuardError(e: unknown): CostGuardError | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    if ((cur as { __cfguard?: unknown }).__cfguard === true) return cur as CostGuardError;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function isCostGuardError(e: unknown): e is CostGuardError {
  return findCostGuardError(e) !== null;
}
