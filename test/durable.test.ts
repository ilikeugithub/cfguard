import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, count, guard, resetGuard, setupDb, sleep, testEnv } from "./helpers";

describe("guardDurableObject", () => {
  beforeAll(() => setupDb());
  beforeEach(resetGuard);

  it("breaks a self-rescheduling alarm loop that runs with zero users", async () => {
    expect((await call("/ticker?room=r1", { method: "POST" })).status).toBe(200);

    // Each tick writes 50 rows (≈ $0.00005): the $0.001 cap trips after ~20 ticks.
    const deadline = Date.now() + 20_000;
    let status = await guard().status();
    while (!status.tripped && Date.now() < deadline) {
      await sleep(50);
      status = await guard().status();
    }
    expect(status.tripped?.top.routes[0].key).toBe("alarm:Ticker");
    expect(status.tripped?.top.sql[0].key).toContain("INSERT INTO ticks");

    // The loop is broken: no more ticks, and the pending alarm is pushed an hour out.
    await sleep(300);
    const ticks = await count("ticks");
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(2_000);
    await sleep(300);
    expect(await count("ticks")).toBe(ticks);

    const stub = testEnv.TICKER.get(testEnv.TICKER.idFromName("r1"));
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 50 * 60_000);
  });
});
