import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker, { type Env } from "../example/src/index";
import { SCHEMA, SEED_SQL } from "../example/src/schema";
import { resetIsolateStates } from "../src/state";

export const testEnv = env as unknown as Env;
export const ADMIN = { authorization: "Bearer test-token" };

export async function call(path: string, init?: RequestInit, useEnv: Env = testEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`https://example.com${path}`, init) as never, useEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled!(createScheduledController({ scheduledTime: new Date(), cron: "*/30 * * * *" }), testEnv, ctx);
  await waitOnExecutionContext(ctx);
}

export async function setupDb(seed = 0): Promise<void> {
  await testEnv.DB.batch(SCHEMA.map((s) => testEnv.DB.prepare(s)));
  if (seed) await testEnv.DB.prepare(SEED_SQL).bind(seed).run();
}

export function guard() {
  return testEnv.CFGUARD.get(testEnv.CFGUARD.idFromName("global"));
}

/** Clears the shared ledger and this isolate's cached breaker state. */
export async function resetGuard(): Promise<void> {
  await guard().reset({ clearUsage: true });
  resetIsolateStates();
}

/** Unmetered row count, straight from the raw binding. */
export async function count(table: string): Promise<number> {
  return (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? 0;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
