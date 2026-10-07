import type { MetricLimits } from "./metrics";
import type { TripSummary } from "./types";
import type { AlertTarget, BindingKind, CostWindow, GuardConfig, Locale } from "./types";

export interface CostGuardOptions {
  /** Which env bindings to meter, e.g. `{ DB: "d1", CACHE: "kv", FILES: "r2" }`. */
  bindings: Record<string, BindingKind>;
  /** Durable Object namespace binding for the CostGuard class. Default `"CFGUARD"`. */
  guardBinding?: string;
  /** CostGuard instance name; use different names to give independent budgets. Default `"global"`. */
  name?: string;
  /** Hard cap for a single request / cron run / queue batch / alarm. Merged over the defaults. */
  perInvocation?: MetricLimits;
  /** Rolling windows for the global breaker. Default 5 min $2, 1 h $10, 24 h $50. */
  windows?: CostWindow[];
  /** Send a warning when a window reaches this fraction of `maxUsd`. Default 0.7; `false` disables. */
  warnAt?: number | false;
  /** Close the breaker automatically after this many minutes. Default: manual reset only. */
  autoResetMinutes?: number;
  alerts?: AlertTarget[];
  locale?: Locale;
  /** Shown in alerts, e.g. the Worker name. */
  label?: string;
  /** How often an isolate reports usage. Default 5000 ms. */
  syncIntervalMs?: number;
  /** An isolate that has not synced for this long syncs before handling the next event. Default 30000 ms. */
  staleAfterMs?: number;
  /** Give up waiting on the CostGuard object after this long and fail open. Default 1000 ms. */
  syncTimeoutMs?: number;
  /** Admin endpoints (status / reset / trip). Default `"/__cfguard"`; `false` disables. */
  adminPath?: string | false;
  /** Secret holding the admin bearer token. Admin endpoints answer 404 when it is unset. Default `"CFGUARD_ADMIN_TOKEN"`. */
  adminTokenBinding?: string;
  /** Delay for queue batches retried while the breaker is open. Default 3600, max 43200. */
  queueRetryDelaySeconds?: number;
  /** Durable Object alarms that fire while open are pushed back by this much. 0 drops them. Default 3600. */
  alarmDeferSeconds?: number;
  /** Custom response while the breaker is open. */
  onTripped?: (trip: TripSummary, request: Request) => Response | Promise<Response>;
}

export type OptionsInput<Env = any> = CostGuardOptions | ((env: Env) => CostGuardOptions);

export const DEFAULT_PER_INVOCATION: MetricLimits = {
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  kvReads: 10_000,
  kvWrites: 1_000,
  kvLists: 1_000,
  r2ClassA: 1_000,
  r2ClassB: 10_000,
};

export const DEFAULT_WINDOWS: CostWindow[] = [
  { minutes: 5, maxUsd: 2 },
  { minutes: 60, maxUsd: 10 },
  { minutes: 1440, maxUsd: 50 },
];

export interface ResolvedOptions extends GuardConfig {
  bindings: Record<string, BindingKind>;
  guardBinding: string;
  name: string;
  perInvocation: MetricLimits;
  syncIntervalMs: number;
  staleAfterMs: number;
  syncTimeoutMs: number;
  adminTokenBinding: string;
  queueRetryDelaySeconds: number;
  alarmDeferSeconds: number;
  onTripped?: CostGuardOptions["onTripped"];
  /** Pending spend that triggers an immediate report instead of waiting for the interval. */
  urgentUsd: number;
}

const byInput = new WeakMap<object, ResolvedOptions>();
const byEnv = new WeakMap<object, WeakMap<object, ResolvedOptions>>();

export function resolveOptions<Env>(input: OptionsInput<Env>, env: Env): ResolvedOptions {
  if (typeof input !== "function") {
    let r = byInput.get(input);
    if (!r) byInput.set(input, (r = resolve(input)));
    return r;
  }
  // Options derived from env: cache per (function, env) since env is stable within an isolate.
  const envKey = (env ?? {}) as object;
  let perEnv = byEnv.get(input);
  if (!perEnv) byEnv.set(input, (perEnv = new WeakMap()));
  let r = perEnv.get(envKey);
  if (!r) perEnv.set(envKey, (r = resolve(input(env))));
  return r;
}

function resolve(o: CostGuardOptions): ResolvedOptions {
  const windows = (o.windows ?? DEFAULT_WINDOWS).filter((w) => w.minutes > 0);
  const caps = windows.map((w) => w.maxUsd).filter((v): v is number => typeof v === "number" && v > 0);
  return {
    bindings: o.bindings,
    guardBinding: o.guardBinding ?? "CFGUARD",
    name: o.name ?? "global",
    perInvocation: { ...DEFAULT_PER_INVOCATION, ...o.perInvocation },
    windows,
    warnAt: o.warnAt === undefined ? 0.7 : o.warnAt,
    autoResetMinutes: o.autoResetMinutes,
    alerts: o.alerts ?? [],
    locale: o.locale ?? "en",
    label: o.label,
    adminPath: o.adminPath === undefined ? "/__cfguard" : o.adminPath,
    syncIntervalMs: o.syncIntervalMs ?? 5_000,
    staleAfterMs: o.staleAfterMs ?? 30_000,
    syncTimeoutMs: o.syncTimeoutMs ?? 1_000,
    adminTokenBinding: o.adminTokenBinding ?? "CFGUARD_ADMIN_TOKEN",
    queueRetryDelaySeconds: Math.min(o.queueRetryDelaySeconds ?? 3_600, 43_200),
    alarmDeferSeconds: o.alarmDeferSeconds ?? 3_600,
    onTripped: o.onTripped,
    urgentUsd: caps.length ? Math.min(...caps) * 0.1 : Infinity,
  };
}

export function guardConfigOf(o: ResolvedOptions): GuardConfig {
  return {
    windows: o.windows,
    warnAt: o.warnAt,
    autoResetMinutes: o.autoResetMinutes,
    alerts: o.alerts,
    locale: o.locale,
    label: o.label,
    adminPath: o.adminPath,
  };
}
