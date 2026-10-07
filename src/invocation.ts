import { BudgetExceededError, CircuitOpenError } from "./errors";
import { addMetrics, zeroMetrics, type Metric, type MetricLimits, type Metrics } from "./metrics";
import type { IsolateState } from "./state";

/** Usage of one request / cron run / queue batch / alarm, checked against the per-invocation limits. */
export class Invocation {
  readonly used: Metrics = zeroMetrics();

  constructor(
    readonly route: string,
    private readonly limits: MetricLimits,
    private readonly state: IsolateState,
  ) {
    state.addHot("route", route, {}, true);
  }

  /** Throws before a billable call if the breaker is open or a budget is already used up. */
  assertOpen(): void {
    if (this.state.tripped) throw new CircuitOpenError(this.state.tripped);
    this.check(true);
  }

  record(delta: Partial<Metrics>, sql?: string): void {
    addMetrics(this.used, delta);
    addMetrics(this.state.pending, delta);
    this.state.addHot("route", this.route, delta, false);
    if (sql) this.state.addHot("sql", sql, delta, true);
  }

  /** Throws after a billable call if it pushed usage over a budget. */
  enforce(): void {
    this.check(false);
  }

  private check(atLimit: boolean): void {
    for (const [m, limit] of Object.entries(this.limits) as [Metric, number | undefined][]) {
      if (limit === undefined) continue;
      const used = this.used[m];
      if (atLimit ? used >= limit : used > limit) throw new BudgetExceededError(m, used, limit, this.route);
    }
  }
}
