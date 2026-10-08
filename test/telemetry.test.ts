import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { zeroMetrics } from "../src/metrics";
import { pushTelemetry, telemetryEnabled } from "../src/telemetry";

const base = {
  bindings: {}, guardBinding: "CFGUARD", name: "global",
  perInvocation: {}, syncIntervalMs: 5000, staleAfterMs: 30000, syncTimeoutMs: 500,
  adminTokenBinding: "CFGUARD_ADMIN_TOKEN", queueRetryDelaySeconds: 3600, alarmDeferSeconds: 3600,
  urgentUsd: 1, windows: [],
} as any;

describe("telemetry", () => {
  it("disabled unless all three are set", () => {
    expect(telemetryEnabled({ ...base })).toBe(false);
    expect(telemetryEnabled({ ...base, telemetryUrl: "https://x", telemetryToken: "t" })).toBe(false);
    expect(telemetryEnabled({ ...base, telemetryUrl: "https://x", telemetryToken: "t", telemetrySecret: "s" })).toBe(true);
  });

  it("sends HMAC-signed ping matching node:crypto", async () => {
    const secret = "test-secret-123";
    const o = { ...base, telemetryUrl: "https://saas.example/api/telemetry", telemetryToken: "tok123", telemetrySecret: secret, workerName: "api" };
    const seen: { url: string; init: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      seen.push({ url, init });
      return { ok: true } as Response;
    });
    await pushTelemetry(o, { ...zeroMetrics(), d1RowsRead: 100 }, false, 5000);
    vi.unstubAllGlobals();
    expect(seen).toHaveLength(1);
    const { init } = seen[0]!;
    expect(init.headers["x-cfguard-telemetry-token"]).toBe("tok123");
    const body = JSON.parse(init.body);
    expect(body.v).toBe(1);
    expect(body.worker).toBe("api");
    expect(body.metrics.d1RowsRead).toBe(100);
    // independent HMAC check with node:crypto
    const expected = createHmac("sha256", secret).update(init.body).digest("hex");
    expect(init.headers["x-cfguard-signature"]).toBe(expected);
  });

  it("throws on non-ok so failures are visible in logs", async () => {
    const o = { ...base, telemetryUrl: "https://x", telemetryToken: "t", telemetrySecret: "s" };
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500 }) as Response);
    await expect(pushTelemetry(o, zeroMetrics(), false, 5000)).rejects.toThrow("500");
    vi.unstubAllGlobals();
  });
});
