import { guardEnv } from "./bindings";
import { findCostGuardError } from "./errors";
import { Invocation } from "./invocation";
import { resolveOptions, type OptionsInput, type ResolvedOptions } from "./options";
import { stateFor, type IsolateState } from "./state";
import { beforeInvocation, sync, syncDue } from "./sync";

const GUARD = Symbol("cfguard");

/**
 * Tracks which invocation a Durable Object's binding calls belong to. alarm() and fetch() each start one;
 * calls that overlap share it (conservative). RPC calls outside those use a rolling one-minute invocation.
 */
class DoTracker {
  private active = 0;
  private entry: Invocation | null = null;
  private background: Invocation;
  private backgroundSince = Date.now();

  constructor(
    private readonly name: string,
    private readonly o: ResolvedOptions,
    private readonly state: IsolateState,
  ) {
    this.background = new Invocation(`do:${name}`, o.perInvocation, state);
  }

  current(): Invocation {
    if (this.entry) return this.entry;
    if (Date.now() - this.backgroundSince >= 60_000) {
      this.background = new Invocation(`do:${this.name}`, this.o.perInvocation, this.state);
      this.backgroundSince = Date.now();
    }
    return this.background;
  }

  async run<T>(route: string, fn: (inv: Invocation) => Promise<T>): Promise<T> {
    if (this.active++ === 0) this.entry = new Invocation(route, this.o.perInvocation, this.state);
    const inv = this.entry!;
    try {
      return await fn(inv);
    } finally {
      if (--this.active === 0) this.entry = null;
    }
  }
}

interface GuardSlot {
  ctx: DurableObjectState;
  tracker: DoTracker;
  env: unknown;
  o: ResolvedOptions;
  state: IsolateState;
}

type DurableObjectClass = new (ctx: DurableObjectState, env: any) => object;

/**
 * Wraps a Durable Object class: its metered bindings are guarded, and while the breaker is open
 * alarm() is deferred instead of run (which is what breaks self-rescheduling alarm loops) and fetch() returns 503.
 *
 *   export const Room = guardDurableObject(RoomImpl, options, "Room");
 */
export function guardDurableObject<C extends DurableObjectClass>(Base: C, options: OptionsInput, name?: string): C {
  const label = name ?? Base.name ?? "DurableObject";
  const proto = Base.prototype as Record<string, any>;

  class Guarded extends (Base as DurableObjectClass) {
    constructor(ctx: DurableObjectState, env: any) {
      const o = resolveOptions(options, env);
      const state = stateFor(o);
      const tracker = new DoTracker(label, o, state);
      super(ctx, guardEnv(env, () => tracker.current(), o.bindings));
      const slot: GuardSlot = { ctx, tracker, env, o, state };
      Object.defineProperty(this, GUARD, { value: slot });
    }
  }
  const g = Guarded.prototype as Record<string, any>;

  if (typeof proto.alarm === "function") {
    g.alarm = async function (this: any, alarmInfo?: AlarmInvocationInfo) {
      const { ctx, tracker, env, o, state } = this[GUARD] as GuardSlot;
      await beforeInvocation(env, o, state);
      if (state.tripped) {
        if (o.alarmDeferSeconds > 0) await ctx.storage.setAlarm(Date.now() + o.alarmDeferSeconds * 1000);
        console.warn(`[cfguard] circuit open, ${label}.alarm() deferred ${o.alarmDeferSeconds}s`);
        return;
      }
      try {
        return await tracker.run(`alarm:${label}`, async (inv) => {
          inv.record({ doAlarms: 1, doRequests: 1 });
          const started = Date.now();
          try {
            return await proto.alarm.call(this, alarmInfo);
          } finally {
            inv.record({ doWallMs: Date.now() - started });
          }
        });
      } catch (e) {
        const err = findCostGuardError(e);
        if (!err) throw e;
        // Swallow: a thrown alarm is retried by the platform, which is exactly the loop we want to stop.
        console.error(`[cfguard] ${label}.alarm() stopped: ${err.message}`);
      } finally {
        // Alarms are not latency sensitive; report inline so a loop is seen as early as possible.
        if (syncDue(o, state)) await sync(env, o, state);
      }
    };
  }

  if (typeof proto.fetch === "function") {
    g.fetch = async function (this: any, request: Request) {
      const { ctx, tracker, env, o, state } = this[GUARD] as GuardSlot;
      await beforeInvocation(env, o, state);
      if (state.tripped) {
        return new Response(JSON.stringify({ error: "cost_guard_tripped" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        return await tracker.run(`fetch:${label}`, async (inv) => {
          inv.record({ doRequests: 1 });
          const started = Date.now();
          try {
            return await proto.fetch.call(this, request);
          } finally {
            inv.record({ doWallMs: Date.now() - started });
          }
        });
      } catch (e) {
        const err = findCostGuardError(e);
        if (!err) throw e;
        return new Response(JSON.stringify({ error: "cost_guard_budget_exceeded", message: err.message }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      } finally {
        if (syncDue(o, state)) ctx.waitUntil(sync(env, o, state));
      }
    };
  }

  Object.defineProperty(Guarded, "name", { value: Base.name });
  return Guarded as unknown as C;
}
