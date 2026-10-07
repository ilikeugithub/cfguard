import type { CostGuard } from "./guard-do";
import { addMetrics, estimateUsd, isZero, zeroMetrics } from "./metrics";
import { guardConfigOf, type ResolvedOptions } from "./options";
import type { IsolateState } from "./state";

let warnedMissingBinding = false;

export function guardStub(env: unknown, o: ResolvedOptions): DurableObjectStub<CostGuard> | null {
  const ns = (env as Record<string, unknown> | undefined)?.[o.guardBinding] as
    | DurableObjectNamespace<CostGuard>
    | undefined;
  if (!ns || typeof ns.idFromName !== "function") return null;
  return ns.get(ns.idFromName(o.name));
}

/** Sends pending usage to the CostGuard object and learns the breaker state. Never throws (fails open). */
export function sync(env: unknown, o: ResolvedOptions, state: IsolateState): Promise<void> {
  if (state.inflight) return state.inflight;

  const stub = guardStub(env, o);
  if (!stub) {
    if (!warnedMissingBinding) {
      warnedMissingBinding = true;
      console.warn(
        `[cfguard] Durable Object binding "${o.guardBinding}" not found: only per-invocation limits are enforced.`,
      );
    }
    state.lastSync = Date.now();
    state.firstSyncDone = true;
    state.pending = zeroMetrics();
    state.hot.clear();
    return Promise.resolve();
  }

  const metrics = state.pending;
  const hot = state.takeHot();
  state.pending = zeroMetrics();

  state.inflight = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), o.syncTimeoutMs);
      });
      const res = await Promise.race([stub.report({ metrics, hot, config: guardConfigOf(o) }), timeout]);
      state.tripped = res.tripped;
    } catch (e) {
      // Keep the counts for the next attempt unless the report may already have landed.
      if (!(e instanceof Error && e.message === "timeout")) addMetrics(state.pending, metrics);
      console.warn("[cfguard] usage report failed, failing open:", e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      state.lastSync = Date.now();
      state.firstSyncDone = true;
      state.inflight = null;
    }
  })();
  return state.inflight;
}

/** Called before handling an event: makes sure a fresh or stale isolate knows whether the breaker is open. */
export async function beforeInvocation(env: unknown, o: ResolvedOptions, state: IsolateState): Promise<void> {
  const age = Date.now() - state.lastSync;
  if (!state.firstSyncDone || age >= o.staleAfterMs || (state.tripped && age >= o.syncIntervalMs)) {
    await sync(env, o, state);
  }
}

export function syncDue(o: ResolvedOptions, state: IsolateState): boolean {
  if (isZero(state.pending) && state.hot.size === 0) return Date.now() - state.lastSync >= o.staleAfterMs;
  return Date.now() - state.lastSync >= o.syncIntervalMs || estimateUsd(state.pending) >= o.urgentUsd;
}

export function afterInvocation(
  env: unknown,
  o: ResolvedOptions,
  state: IsolateState,
  waitUntil: (p: Promise<unknown>) => void,
): void {
  if (syncDue(o, state)) waitUntil(sync(env, o, state));
}
