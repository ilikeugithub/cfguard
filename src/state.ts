import { estimateUsd, zeroMetrics, type Metrics } from "./metrics";
import type { ResolvedOptions } from "./options";
import type { HotEntry, TripSummary } from "./types";

const MAX_HOT_KEYS = 500;
const HOT_PER_REPORT = 50;

/** Per-isolate view of one CostGuard instance: unreported usage plus the last known breaker state. */
export class IsolateState {
  pending: Metrics = zeroMetrics();
  hot = new Map<string, HotEntry>();
  tripped: TripSummary | null = null;
  lastSync = 0;
  firstSyncDone = false;
  inflight: Promise<void> | null = null;
  /** Detached realtime SaaS ping chained off the last sync; never awaited by requests. */
  telemetryInflight: Promise<unknown> | null = null;

  addHot(kind: HotEntry["kind"], key: string, delta: Partial<Metrics>, call: boolean): void {
    const id = `${kind}\u0000${key}`;
    let e = this.hot.get(id);
    if (!e) {
      if (this.hot.size >= MAX_HOT_KEYS) return;
      e = { kind, key, rowsRead: 0, rowsWritten: 0, calls: 0, usd: 0 };
      this.hot.set(id, e);
    }
    e.rowsRead += delta.d1RowsRead ?? 0;
    e.rowsWritten += delta.d1RowsWritten ?? 0;
    e.usd += estimateUsd(delta);
    if (call) e.calls++;
  }

  /** Takes the most expensive hot entries for a report and clears the map. */
  takeHot(): HotEntry[] {
    const all = [...this.hot.values()];
    this.hot.clear();
    return all.sort((a, b) => b.usd - a.usd || b.calls - a.calls).slice(0, HOT_PER_REPORT);
  }
}

const states = new Map<string, IsolateState>();

export function stateFor(o: ResolvedOptions): IsolateState {
  const key = `${o.guardBinding}/${o.name}`;
  let s = states.get(key);
  if (!s) states.set(key, (s = new IsolateState()));
  return s;
}

/** Forget all isolate-local state. Intended for tests. */
export function resetIsolateStates(): void {
  states.clear();
}
