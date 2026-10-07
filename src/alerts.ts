import type { Metric } from "./metrics";
import type { AlertTarget, Breach, GuardConfig, HotEntry, TopUsage, TripRecord } from "./types";

export type AlertEvent =
  | { kind: "tripped"; trip: TripRecord }
  | { kind: "warning"; minutes: number; usd: number; maxUsd: number; top: TopUsage }
  | { kind: "reset"; auto: boolean };

const METRIC_LABELS: Record<Metric, { en: string; zh: string }> = {
  d1RowsRead: { en: "D1 rows read", zh: "D1 读取行数" },
  d1RowsWritten: { en: "D1 rows written", zh: "D1 写入行数" },
  d1Queries: { en: "D1 queries", zh: "D1 查询次数" },
  kvReads: { en: "KV reads", zh: "KV 读取" },
  kvWrites: { en: "KV writes", zh: "KV 写入" },
  kvLists: { en: "KV lists", zh: "KV list" },
  r2ClassA: { en: "R2 Class A ops", zh: "R2 A 类操作" },
  r2ClassB: { en: "R2 Class B ops", zh: "R2 B 类操作" },
  workerInvocations: { en: "Worker invocations", zh: "Worker 调用" },
  doRequests: { en: "DO requests", zh: "DO 请求" },
  doAlarms: { en: "DO alarms", zh: "DO alarm 次数" },
  doWallMs: { en: "DO wall time (ms)", zh: "DO 运行时长 (ms)" },
};

export function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n * 100) / 100}`;
}

export function fmtUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd === 0) return "$0";
  return `$${usd.toPrecision(2)}`;
}

export function describeBreach(b: Breach, zh: boolean): string {
  if (b.metric === "usd") {
    return zh
      ? `最近 ${b.minutes} 分钟估算花费 ${fmtUsd(b.used)}，达到上限 ${fmtUsd(b.limit)}`
      : `estimated spend ${fmtUsd(b.used)} in the last ${b.minutes} min reached the ${fmtUsd(b.limit)} cap`;
  }
  const label = METRIC_LABELS[b.metric][zh ? "zh" : "en"];
  return zh
    ? `最近 ${b.minutes} 分钟 ${label} 达到 ${fmtNum(b.used)}，上限 ${fmtNum(b.limit)}`
    : `${label} reached ${fmtNum(b.used)} in the last ${b.minutes} min (limit ${fmtNum(b.limit)})`;
}

function topLines(entries: HotEntry[], kind: HotEntry["kind"], zh: boolean): string[] {
  return entries.slice(0, 3).map((e, i) => {
    const parts = [fmtUsd(e.usd)];
    if (kind === "sql") {
      parts.push(zh ? `读 ${fmtNum(e.rowsRead)} 行` : `${fmtNum(e.rowsRead)} rows read`);
      if (e.rowsWritten) parts.push(zh ? `写 ${fmtNum(e.rowsWritten)} 行` : `${fmtNum(e.rowsWritten)} rows written`);
    }
    parts.push(zh ? `${fmtNum(e.calls)} 次` : `${fmtNum(e.calls)} calls`);
    return `${i + 1}. ${parts.join(" · ")} · ${e.key}`;
  });
}

function topSection(top: TopUsage, zh: boolean): string[] {
  const out: string[] = [];
  if (top.sql.length) out.push(zh ? "最贵的 SQL：" : "Top SQL:", ...topLines(top.sql, "sql", zh));
  if (top.routes.length) out.push(zh ? "最贵的入口：" : "Top entry points:", ...topLines(top.routes, "route", zh));
  return out;
}

export function formatAlert(event: AlertEvent, config: Pick<GuardConfig, "locale" | "label" | "adminPath">): string {
  const zh = config.locale === "zh";
  const tag = config.label ? ` [${config.label}]` : "";
  switch (event.kind) {
    case "tripped": {
      const t = event.trip;
      const reason = t.manual
        ? (zh ? `手动熔断：` : "Manual trip: ") + (t.reason ?? "")
        : t.breach
          ? describeBreach(t.breach, zh)
          : "";
      const lines = [
        zh ? `🚨 cfguard 已熔断${tag}` : `🚨 cfguard circuit OPEN${tag}`,
        (zh ? "原因：" : "Reason: ") + reason,
        zh
          ? "已拦截：D1/KV/R2 调用、HTTP 请求、cron、queue 消费、DO alarm"
          : "Blocked: D1/KV/R2 calls, HTTP requests, cron, queue consumers, DO alarms",
        ...topSection(t.top, zh),
      ];
      if (config.adminPath) {
        lines.push(
          zh
            ? `修复后恢复：POST ${config.adminPath}/reset（Bearer 管理令牌）`
            : `After fixing, resume with: POST ${config.adminPath}/reset (Bearer admin token)`,
        );
      }
      return lines.join("\n");
    }
    case "warning": {
      const pct = Math.round((event.usd / event.maxUsd) * 100);
      return [
        zh ? `⚠️ cfguard 用量预警${tag}` : `⚠️ cfguard usage warning${tag}`,
        zh
          ? `最近 ${event.minutes} 分钟估算花费 ${fmtUsd(event.usd)}，已到上限 ${fmtUsd(event.maxUsd)} 的 ${pct}%`
          : `Estimated spend ${fmtUsd(event.usd)} in the last ${event.minutes} min is ${pct}% of the ${fmtUsd(event.maxUsd)} cap`,
        ...topSection(event.top, zh),
      ].join("\n");
    }
    case "reset":
      return event.auto
        ? zh
          ? `✅ cfguard 已自动恢复${tag}`
          : `✅ cfguard circuit closed automatically${tag}`
        : zh
          ? `✅ cfguard 熔断已解除${tag}`
          : `✅ cfguard circuit closed${tag}`;
  }
}

function request(target: AlertTarget, text: string, event: AlertEvent): { url: string; body: unknown } {
  switch (target.type) {
    case "slack":
      return { url: target.url, body: { text } };
    case "discord":
      return { url: target.url, body: { content: text.slice(0, 1900) } };
    case "feishu":
      return { url: target.url, body: { msg_type: "text", content: { text } } };
    case "dingtalk":
    case "wecom":
      return { url: target.url, body: { msgtype: "text", text: { content: text } } };
    case "telegram":
      return {
        url: `https://api.telegram.org/bot${target.botToken}/sendMessage`,
        body: { chat_id: target.chatId, text },
      };
    case "webhook":
      return { url: target.url, body: { event: `cfguard.${event.kind}`, text, ...event } };
  }
}

export async function sendAlerts(
  event: AlertEvent,
  config: Pick<GuardConfig, "alerts" | "locale" | "label" | "adminPath">,
): Promise<void> {
  const text = formatAlert(event, config);
  console.warn(text);
  const results = await Promise.allSettled(
    config.alerts.map(async (target) => {
      const { url, body } = request(target, text, event);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`${target.type} alert failed: HTTP ${res.status}`);
    }),
  );
  for (const r of results) if (r.status === "rejected") console.error("[cfguard]", r.reason);
}
