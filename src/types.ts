import type { Metric, MetricLimits, Metrics } from "./metrics";

export type BindingKind = "d1" | "kv" | "r2";

/** A rolling spend window. The breaker trips when `maxUsd` or any metric in `limits` is reached. */
export interface CostWindow {
  minutes: number;
  maxUsd?: number;
  limits?: MetricLimits;
}

export type AlertTarget =
  | { type: "webhook" | "slack" | "discord" | "feishu" | "dingtalk" | "wecom"; url: string }
  | { type: "telegram"; botToken: string; chatId: string };

export type Locale = "en" | "zh";

/** What crossed the line: `metric: "usd"` for a dollar cap, otherwise a raw metric limit. */
export interface Breach {
  metric: Metric | "usd";
  used: number;
  limit: number;
  minutes: number;
}

export interface TripSummary {
  at: number;
  manual: boolean;
  /** Free-form reason for manual trips. */
  reason?: string;
  breach?: Breach;
  usd: number;
}

export interface HotEntry {
  kind: "sql" | "route";
  key: string;
  rowsRead: number;
  rowsWritten: number;
  calls: number;
  usd: number;
}

export interface TopUsage {
  sql: HotEntry[];
  routes: HotEntry[];
}

export interface TripRecord extends TripSummary {
  usage?: MetricLimits;
  top: TopUsage;
}

/** The part of the options the CostGuard Durable Object needs; sent along with every report. */
export interface GuardConfig {
  windows: CostWindow[];
  warnAt: number | false;
  autoResetMinutes?: number;
  alerts: AlertTarget[];
  locale: Locale;
  label?: string;
  adminPath: string | false;
}

export interface ReportPayload {
  metrics: Metrics;
  hot: HotEntry[];
  config: GuardConfig;
}

export interface WindowStatus extends CostWindow {
  usd: number;
  ratio: number | null;
  usage: MetricLimits;
}

export interface GuardStatus {
  tripped: TripRecord | null;
  windows: WindowStatus[];
  top: TopUsage;
  topWindowMinutes: number;
}
