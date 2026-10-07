import { DurableObject } from "cloudflare:workers";
import { sendAlerts, type AlertEvent } from "./alerts";
import { addMetrics, estimateUsd, METRICS, nonZero, zeroMetrics, type Metric, type Metrics } from "./metrics";
import { DEFAULT_WINDOWS } from "./options";
import type {
  Breach,
  CostWindow,
  GuardConfig,
  GuardStatus,
  HotEntry,
  ReportPayload,
  TopUsage,
  TripRecord,
  TripSummary,
} from "./types";

const MINUTE = 60_000;
const HOT_PERSIST_PER_KIND = 20;
const HOT_MEMORY_MAX = 1_000;
const TOP_N = 5;

const DEFAULT_CONFIG: GuardConfig = {
  windows: DEFAULT_WINDOWS,
  warnAt: 0.7,
  alerts: [],
  locale: "en",
  adminPath: "/__cfguard",
};

const SUM_COLUMNS = METRICS.map((m) => `COALESCE(SUM(${m}), 0) AS ${m}`).join(", ");

function summary(t: TripRecord): TripSummary {
  return { at: t.at, manual: t.manual, reason: t.reason, breach: t.breach, usd: t.usd };
}

function breachOf(w: CostWindow, usage: Metrics, usd: number): Breach | null {
  if (w.maxUsd !== undefined && usd >= w.maxUsd) {
    return { metric: "usd", used: usd, limit: w.maxUsd, minutes: w.minutes };
  }
  for (const [m, limit] of Object.entries(w.limits ?? {}) as [Metric, number | undefined][]) {
    if (limit !== undefined && usage[m] >= limit) return { metric: m, used: usage[m], limit, minutes: w.minutes };
  }
  return null;
}

function mergeHot(into: Map<string, HotEntry>, e: HotEntry): void {
  const id = `${e.kind}\u0000${e.key}`;
  const cur = into.get(id);
  if (cur) {
    cur.rowsRead += e.rowsRead;
    cur.rowsWritten += e.rowsWritten;
    cur.calls += e.calls;
    cur.usd += e.usd;
  } else if (into.size < HOT_MEMORY_MAX) {
    into.set(id, { ...e });
  }
}

/**
 * Account-wide usage ledger and breaker. Isolates report aggregated usage every few seconds;
 * the current minute is kept in memory and persisted once per minute to keep storage writes low.
 */
export class CostGuard extends DurableObject {
  private minute = -1;
  private bucket = zeroMetrics();
  private hot = new Map<string, HotEntry>();
  /** Persisted totals per window length, covering the window minus the current minute. */
  private past = new Map<number, Metrics>();
  private opened: TripRecord | null = null;
  private config: GuardConfig = DEFAULT_CONFIG;
  private configJson = "";
  /** Usage before this minute is ignored after a reset, so the breaker does not re-trip on old traffic. */
  private since = 0;
  private warned = new Map<number, number>();
  private lastReport = 0;
  private alarmArmed = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.opened = (await ctx.storage.get<TripRecord>("trip")) ?? null;
      this.since = (await ctx.storage.get<number>("since")) ?? 0;
      const config = await ctx.storage.get<GuardConfig>("config");
      if (config) {
        this.config = config;
        this.configJson = JSON.stringify(config);
      }
    });
  }

  // ------------------------------------------------------------ RPC

  async report(p: ReportPayload): Promise<{ tripped: TripSummary | null }> {
    const now = Date.now();
    this.lastReport = now;
    await this.applyConfig(p.config);
    this.roll(now);
    addMetrics(this.bucket, p.metrics);
    for (const e of p.hot) mergeHot(this.hot, e);
    if (this.opened) await this.maybeAutoReset(now);
    if (!this.opened) await this.evaluate(now);
    await this.armAlarm(now);
    return { tripped: this.opened ? summary(this.opened) : null };
  }

  async status(windowMinutes?: number): Promise<GuardStatus> {
    this.roll(Date.now());
    const topWindowMinutes = windowMinutes ?? this.config.windows[0]?.minutes ?? 60;
    return {
      tripped: this.opened,
      windows: this.config.windows.map((w) => {
        const usage = this.windowUsage(w.minutes);
        const usd = estimateUsd(usage);
        return { ...w, usd, ratio: w.maxUsd ? usd / w.maxUsd : null, usage: nonZero(usage) };
      }),
      top: this.top(topWindowMinutes),
      topWindowMinutes,
    };
  }

  /** Close the breaker. Usage recorded before now no longer counts toward the windows. */
  async reset(opts: { clearUsage?: boolean } = {}): Promise<{ ok: true }> {
    await this.closeBreaker(false, opts.clearUsage ?? false);
    return { ok: true };
  }

  /** Open the breaker by hand, e.g. from an external watchdog. */
  async trip(reason: string): Promise<TripSummary> {
    if (!this.opened) await this.tripNow({ at: Date.now(), manual: true, reason, usd: 0 }, 60);
    return summary(this.opened!);
  }

  // ------------------------------------------------------------ alarm: persist + prune

  async alarm(): Promise<void> {
    this.alarmArmed = false;
    const now = Date.now();
    this.roll(now);
    this.prune();
    await this.maybeAutoReset(now);
    // Keep ticking only while there is traffic; the next report re-arms otherwise.
    if (now - this.lastReport < 3 * MINUTE) await this.armAlarm(now);
  }

  // ------------------------------------------------------------ internals

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS usage (minute INTEGER PRIMARY KEY)");
    const have = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(usage)")
        .toArray()
        .map((r) => r.name),
    );
    for (const m of METRICS) {
      if (!have.has(m)) sql.exec(`ALTER TABLE usage ADD COLUMN ${m} REAL NOT NULL DEFAULT 0`);
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS hot (
      minute INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      rows_read REAL NOT NULL, rows_written REAL NOT NULL, calls REAL NOT NULL, usd REAL NOT NULL,
      PRIMARY KEY (minute, kind, key))`);
  }

  private async applyConfig(config: GuardConfig): Promise<void> {
    const json = JSON.stringify(config);
    if (json === this.configJson) return;
    this.config = config;
    this.configJson = json;
    await this.ctx.storage.put("config", config);
    if (this.minute >= 0) this.recomputePast();
  }

  private roll(now: number): void {
    const m = Math.floor(now / MINUTE);
    if (m === this.minute) return;
    if (this.minute >= 0) this.persist();
    this.minute = m;
    this.bucket = zeroMetrics();
    this.hot.clear();
    this.recomputePast();
  }

  private persist(): void {
    const sql = this.ctx.storage.sql;
    if (METRICS.some((k) => this.bucket[k])) {
      sql.exec(
        `INSERT INTO usage (minute, ${METRICS.join(", ")}) VALUES (?, ${METRICS.map(() => "?").join(", ")})
         ON CONFLICT(minute) DO UPDATE SET ${METRICS.map((k) => `${k} = ${k} + excluded.${k}`).join(", ")}`,
        this.minute,
        ...METRICS.map((k) => this.bucket[k]),
      );
    }
    for (const kind of ["sql", "route"] as const) {
      const entries = [...this.hot.values()]
        .filter((e) => e.kind === kind)
        .sort((a, b) => b.usd - a.usd || b.calls - a.calls)
        .slice(0, HOT_PERSIST_PER_KIND);
      for (const e of entries) {
        sql.exec(
          `INSERT INTO hot (minute, kind, key, rows_read, rows_written, calls, usd) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(minute, kind, key) DO UPDATE SET rows_read = rows_read + excluded.rows_read,
             rows_written = rows_written + excluded.rows_written, calls = calls + excluded.calls, usd = usd + excluded.usd`,
          this.minute,
          e.kind,
          e.key,
          e.rowsRead,
          e.rowsWritten,
          e.calls,
          e.usd,
        );
      }
    }
  }

  private windowStart(minutes: number): number {
    return Math.max(this.minute - minutes + 1, this.since);
  }

  private recomputePast(): void {
    this.past.clear();
    for (const w of this.config.windows) {
      if (this.past.has(w.minutes)) continue;
      const row = this.ctx.storage.sql
        .exec<Metrics>(
          `SELECT ${SUM_COLUMNS} FROM usage WHERE minute >= ? AND minute < ?`,
          this.windowStart(w.minutes),
          this.minute,
        )
        .one();
      this.past.set(w.minutes, addMetrics(zeroMetrics(), row));
    }
  }

  private windowUsage(minutes: number): Metrics {
    const usage = zeroMetrics();
    const past = this.past.get(minutes);
    if (past) addMetrics(usage, past);
    return addMetrics(usage, this.bucket);
  }

  private top(minutes: number): TopUsage {
    const merged = new Map<string, HotEntry>();
    const rows = this.ctx.storage.sql
      .exec<{ kind: HotEntry["kind"]; key: string; rr: number; rw: number; c: number; u: number }>(
        `SELECT kind, key, SUM(rows_read) AS rr, SUM(rows_written) AS rw, SUM(calls) AS c, SUM(usd) AS u
         FROM hot WHERE minute >= ? AND minute < ? GROUP BY kind, key`,
        this.windowStart(minutes),
        this.minute,
      )
      .toArray();
    for (const r of rows) {
      mergeHot(merged, { kind: r.kind, key: r.key, rowsRead: r.rr, rowsWritten: r.rw, calls: r.c, usd: r.u });
    }
    for (const e of this.hot.values()) mergeHot(merged, e);
    const pick = (kind: HotEntry["kind"]) =>
      [...merged.values()]
        .filter((e) => e.kind === kind)
        .sort((a, b) => b.usd - a.usd || b.calls - a.calls)
        .slice(0, TOP_N);
    return { sql: pick("sql"), routes: pick("route") };
  }

  private async evaluate(now: number): Promise<void> {
    const { windows, warnAt } = this.config;
    for (const [i, w] of windows.entries()) {
      const usage = this.windowUsage(w.minutes);
      const usd = estimateUsd(usage);
      const breach = breachOf(w, usage, usd);
      if (breach) {
        await this.tripNow({ at: now, manual: false, breach, usd }, w.minutes, usage);
        return;
      }
      if (warnAt && w.maxUsd && usd >= w.maxUsd * warnAt) {
        const last = this.warned.get(i) ?? 0;
        if (now - last >= w.minutes * MINUTE) {
          this.warned.set(i, now);
          this.notify({ kind: "warning", minutes: w.minutes, usd, maxUsd: w.maxUsd, top: this.top(w.minutes) });
        }
      }
    }
  }

  private async tripNow(s: TripSummary, topMinutes: number, usage?: Metrics): Promise<void> {
    this.opened = { ...s, usage: usage ? nonZero(usage) : undefined, top: this.top(topMinutes) };
    await this.ctx.storage.put("trip", this.opened);
    this.notify({ kind: "tripped", trip: this.opened });
  }

  private async maybeAutoReset(now: number): Promise<void> {
    const minutes = this.config.autoResetMinutes;
    if (this.opened && !this.opened.manual && minutes && now - this.opened.at >= minutes * MINUTE) {
      await this.closeBreaker(true, false);
    }
  }

  private async closeBreaker(auto: boolean, clearUsage: boolean): Promise<void> {
    const wasOpen = this.opened !== null;
    this.opened = null;
    this.warned.clear();
    this.roll(Date.now());
    if (clearUsage) {
      this.ctx.storage.sql.exec("DELETE FROM usage");
      this.ctx.storage.sql.exec("DELETE FROM hot");
    }
    this.since = this.minute;
    this.bucket = zeroMetrics();
    this.hot.clear();
    await this.ctx.storage.delete("trip");
    await this.ctx.storage.put("since", this.since);
    this.recomputePast();
    if (wasOpen) this.notify({ kind: "reset", auto });
  }

  private prune(): void {
    const keep = Math.max(1_440, ...this.config.windows.map((w) => w.minutes)) + 5;
    this.ctx.storage.sql.exec("DELETE FROM usage WHERE minute < ?", this.minute - keep);
    this.ctx.storage.sql.exec("DELETE FROM hot WHERE minute < ?", this.minute - keep);
  }

  private async armAlarm(now: number): Promise<void> {
    if (this.alarmArmed) return;
    this.alarmArmed = true;
    await this.ctx.storage.setAlarm((Math.floor(now / MINUTE) + 1) * MINUTE + 1_000);
  }

  private notify(event: AlertEvent): void {
    this.ctx.waitUntil(sendAlerts(event, this.config));
  }
}
