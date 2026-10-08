import { estimateUsd, type Metrics } from "./metrics";
import type { ResolvedOptions } from "./options";

const enc = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function telemetryEnabled(o: ResolvedOptions): boolean {
  return !!(o.telemetryUrl && o.telemetryToken && o.telemetrySecret);
}

/**
 * Best-effort realtime ping to the CFGuard SaaS (see cfguard-app docs/sdk-linkage.md).
 * Never throws; the SaaS verifies the HMAC and keeps ~24h of pings for the dashboard.
 */
export async function pushTelemetry(
  o: ResolvedOptions,
  totals: Metrics,
  tripped: boolean,
  windowMs: number,
): Promise<void> {
  if (!telemetryEnabled(o)) return;
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(totals)) {
    if (typeof v === "number" && v > 0) metrics[k] = v;
  }
  const body = JSON.stringify({
    v: 1,
    worker: o.workerName ?? "default",
    ts: Date.now(),
    windowMs,
    usd: estimateUsd(totals),
    metrics,
    tripped,
  });
  const res = await fetch(o.telemetryUrl!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cfguard-telemetry-token": o.telemetryToken!,
      "x-cfguard-signature": await hmacHex(o.telemetrySecret!, body),
    },
    body,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`telemetry ping failed: ${res.status}`);
}
