import type { TelemetryConfig, TripRecord } from "./types";

const enc = new TextEncoder();

/** Normal pings go out at most this often; trips and resets go out at once. */
export const TELEMETRY_MIN_INTERVAL_MS = 30_000;
/** Unchanged numbers are re-sent this often so the dashboard can tell the guard is alive. */
export const TELEMETRY_HEARTBEAT_MS = 5 * 60_000;

export interface TelemetryPing {
  v: 2;
  worker: string;
  ts: number;
  /** Account-wide totals of each configured window, as the breaker sees them. */
  windows: { minutes: number; usd: number; maxUsd?: number }[];
  tripped: { at: number; manual: boolean; reason?: string; usd: number; metric?: string; minutes?: number } | null;
}

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function tripOf(t: TripRecord | null): TelemetryPing["tripped"] {
  if (!t) return null;
  return { at: t.at, manual: t.manual, reason: t.reason, usd: t.usd, metric: t.breach?.metric, minutes: t.breach?.minutes };
}

/**
 * Sends one signed ping to the CFGuard SaaS dashboard (https://cfguard-app.cfguard.workers.dev).
 * Called only by the CostGuard object, so a Worker sends at most one ping per
 * TELEMETRY_MIN_INTERVAL_MS however many isolates it runs.
 */
export async function pushTelemetry(t: TelemetryConfig, ping: TelemetryPing): Promise<void> {
  const body = JSON.stringify(ping);
  const res = await fetch(t.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cfguard-telemetry-token": t.token,
      "x-cfguard-signature": await hmacHex(t.secret, body),
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`telemetry ping failed: ${res.status}`);
}
