import { afterEach, describe, expect, it, vi } from "vitest";

import { zeroMetrics } from "../src/metrics";
import { guardConfigOf, resolveOptions } from "../src/options";
import { hmacHex, type TelemetryPing } from "../src/telemetry";
import type { GuardConfig } from "../src/types";
import { sleep, testEnv } from "./helpers";

const TELEMETRY = { url: "https://saas.example/api/telemetry", token: "tok123", secret: "s3cret", worker: "api" };
const CONFIG: GuardConfig = {
  windows: [{ minutes: 5, maxUsd: 100 }],
  warnAt: false,
  alerts: [],
  locale: "en",
  adminPath: false,
  telemetry: TELEMETRY,
};

function captureFetch() {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return new Response("{}");
  });
  return seen;
}

describe("telemetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is configured only when url, token and secret are all set", () => {
    const opts = (extra: object) => guardConfigOf(resolveOptions({ bindings: {}, label: "shop", ...extra }, {}));
    expect(opts({ telemetryUrl: "https://x", telemetryToken: "t" }).telemetry).toBeUndefined();
    expect(opts({ telemetryUrl: "https://x", telemetryToken: "t", telemetrySecret: "s" }).telemetry).toEqual({
      url: "https://x",
      token: "t",
      secret: "s",
      worker: "shop",
    });
  });

  it("signs with HMAC-SHA256 (RFC 4231 test case 2)", async () => {
    expect(await hmacHex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("the CostGuard object pings at most every 30 s, and at once on trip and reset", async () => {
    const seen = captureFetch();
    const stub = testEnv.CFGUARD.get(testEnv.CFGUARD.idFromName("telemetry-test"));
    const report = (rows: number) =>
      stub.report({ metrics: { ...zeroMetrics(), d1RowsWritten: rows }, hot: [], config: CONFIG });

    for (let i = 0; i < 5; i++) await report(1_000);
    await sleep(100);
    expect(seen).toHaveLength(1);

    const first = seen[0]!;
    expect(first.url).toBe(TELEMETRY.url);
    expect(first.headers["x-cfguard-telemetry-token"]).toBe("tok123");
    expect(first.headers["x-cfguard-signature"]).toBe(await hmacHex("s3cret", first.body));
    const ping = JSON.parse(first.body) as TelemetryPing;
    expect(ping).toMatchObject({ v: 2, worker: "api", tripped: null });
    expect(ping.windows[0]).toMatchObject({ minutes: 5, maxUsd: 100 });
    expect(ping.windows[0]!.usd).toBeCloseTo(0.001, 6);

    await stub.trip("test");
    await sleep(100);
    expect(seen).toHaveLength(2);
    expect((JSON.parse(seen[1]!.body) as TelemetryPing).tripped).toMatchObject({ manual: true, reason: "test" });

    await stub.reset({ clearUsage: true });
    await sleep(100);
    expect(seen).toHaveLength(3);
    expect((JSON.parse(seen[2]!.body) as TelemetryPing).tripped).toBeNull();
  });
});
