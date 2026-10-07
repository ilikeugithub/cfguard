import { handleAdmin } from "./admin";
import { guardEnv } from "./bindings";
import { BudgetExceededError, findCostGuardError, type CostGuardError } from "./errors";
import { Invocation } from "./invocation";
import { routeOf } from "./normalize";
import { resolveOptions, type OptionsInput, type ResolvedOptions } from "./options";
import { stateFor } from "./state";
import { afterInvocation, beforeInvocation } from "./sync";
import type { TripSummary } from "./types";

function trippedResponse(trip: TripSummary): Response {
  return new Response(
    JSON.stringify({
      error: "cost_guard_tripped",
      message: "Service paused by cfguard to stop runaway Cloudflare usage.",
      since: new Date(trip.at).toISOString(),
    }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "60" } },
  );
}

function errorResponse(e: CostGuardError, o: ResolvedOptions, request: Request): Response | Promise<Response> {
  if (e instanceof BudgetExceededError || e.name === "BudgetExceededError") {
    const b = e as BudgetExceededError;
    console.error(`[cfguard] ${b.message}`);
    return new Response(
      JSON.stringify({ error: "cost_guard_budget_exceeded", metric: b.metric, used: b.used, limit: b.limit }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  const trip = (e as { trip?: TripSummary }).trip ?? { at: Date.now(), manual: false, usd: 0 };
  return o.onTripped ? o.onTripped(trip, request) : trippedResponse(trip);
}

/**
 * Wraps a Worker's default export. Metered bindings are swapped for guarded ones on every
 * fetch / scheduled / queue (and any other) event, and nothing runs while the breaker is open.
 */
export function withGuard<Env = any, QueueMessage = any, CfHostMetadata = unknown>(
  handler: ExportedHandler<Env, QueueMessage, CfHostMetadata>,
  options: OptionsInput<Env>,
): ExportedHandler<Env, QueueMessage, CfHostMetadata> {
  const h = handler as Record<string, any>;
  const out: Record<string, any> = { ...h };

  // Other platform events get the same guard without an event-specific fallback. Only known event names are
  // wrapped: frameworks such as Hono expose many own function properties (get, post, use, …) on the handler.
  for (const event of ["email"]) {
    const fn = h[event];
    if (typeof fn !== "function") continue;
    out[event] = async (arg: unknown, env: Env, ctx: ExecutionContext) => {
      const o = resolveOptions(options, env);
      const state = stateFor(o);
      await beforeInvocation(env, o, state);
      if (state.tripped) throw new Error(`cfguard: circuit open, ${event} event dropped`);
      const inv = new Invocation(event, o.perInvocation, state);
      inv.record({ workerInvocations: 1 });
      try {
        return await fn.call(h, arg, guardEnv(env, () => inv, o.bindings), ctx);
      } finally {
        afterInvocation(env, o, state, (p) => ctx.waitUntil(p));
      }
    };
  }

  if (h.fetch) {
    out.fetch = async (request: Request, env: Env, ctx: ExecutionContext) => {
      const o = resolveOptions(options, env);
      const state = stateFor(o);
      const admin = await handleAdmin(request, env, o, state);
      if (admin) return admin;

      await beforeInvocation(env, o, state);
      if (state.tripped) {
        return o.onTripped ? o.onTripped(state.tripped, request) : trippedResponse(state.tripped);
      }
      const inv = new Invocation(routeOf(request), o.perInvocation, state);
      inv.record({ workerInvocations: 1 });
      try {
        return await h.fetch.call(h, request, guardEnv(env, () => inv, o.bindings), ctx);
      } catch (e) {
        const err = findCostGuardError(e);
        if (err) return errorResponse(err, o, request);
        throw e;
      } finally {
        afterInvocation(env, o, state, (p) => ctx.waitUntil(p));
      }
    };
  }

  if (h.scheduled) {
    out.scheduled = async (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
      const o = resolveOptions(options, env);
      const state = stateFor(o);
      await beforeInvocation(env, o, state);
      if (state.tripped) {
        console.warn(`[cfguard] circuit open, skipped cron "${controller.cron}"`);
        return;
      }
      const inv = new Invocation(`cron:${controller.cron}`, o.perInvocation, state);
      inv.record({ workerInvocations: 1 });
      try {
        await h.scheduled.call(h, controller, guardEnv(env, () => inv, o.bindings), ctx);
      } catch (e) {
        const err = findCostGuardError(e);
        if (!err) throw e;
        // Swallow so the platform does not count it as a failure to retry.
        console.error(`[cfguard] cron "${controller.cron}" stopped: ${err.message}`);
      } finally {
        afterInvocation(env, o, state, (p) => ctx.waitUntil(p));
      }
    };
  }

  if (h.queue) {
    out.queue = async (batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext) => {
      const o = resolveOptions(options, env);
      const state = stateFor(o);
      await beforeInvocation(env, o, state);
      if (state.tripped) {
        // Keep the messages, but come back much later instead of hot-looping through retries.
        batch.retryAll({ delaySeconds: o.queueRetryDelaySeconds });
        console.warn(`[cfguard] circuit open, deferred ${batch.messages.length} messages from "${batch.queue}"`);
        return;
      }
      const inv = new Invocation(`queue:${batch.queue}`, o.perInvocation, state);
      inv.record({ workerInvocations: 1 });
      try {
        await h.queue.call(h, batch, guardEnv(env, () => inv, o.bindings), ctx);
      } catch (e) {
        const err = findCostGuardError(e);
        if (!err) throw e;
        batch.retryAll({ delaySeconds: o.queueRetryDelaySeconds });
        console.error(`[cfguard] queue "${batch.queue}" batch deferred: ${err.message}`);
      } finally {
        afterInvocation(env, o, state, (p) => ctx.waitUntil(p));
      }
    };
  }

  return out as ExportedHandler<Env, QueueMessage, CfHostMetadata>;
}
