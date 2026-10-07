import type { Invocation } from "./invocation";
import type { Metrics } from "./metrics";
import { normalizeSql } from "./normalize";
import type { BindingKind } from "./types";

type InvocationProvider = () => Invocation;
type AnyFn = (...args: any[]) => any;

/**
 * Returns a view of `env` whose listed bindings are metered. Everything else passes through untouched.
 * `current` is asked for the active invocation on every call, so one wrapped env can serve a Durable Object.
 */
export function guardEnv<E>(env: E, current: InvocationProvider, bindings: Record<string, BindingKind>): E {
  if (!env || typeof env !== "object") return env;
  const cache = new Map<string, unknown>();
  return new Proxy(env as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      const kind = typeof prop === "string" ? bindings[prop] : undefined;
      if (!kind || value == null || typeof value !== "object") return value;
      let wrapped = cache.get(prop as string);
      if (!wrapped) {
        wrapped = wrapBinding(kind, value, current);
        cache.set(prop as string, wrapped);
      }
      return wrapped;
    },
  }) as E;
}

export function wrapBinding(kind: BindingKind, binding: object, current: InvocationProvider): unknown {
  switch (kind) {
    case "d1":
      return guardD1(binding as D1Database, current);
    case "kv":
      return guardKV(binding as KVNamespace, current);
    case "r2":
      return guardR2(binding as R2Bucket, current);
  }
}

/** Proxy that serves `overrides` and binds every other method to the real object (workerd rejects foreign `this`). */
function proxyWith<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string" && Object.hasOwn(overrides, prop)) return overrides[prop];
      const v = Reflect.get(t, prop, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

function counted<F extends AnyFn>(
  fn: F,
  current: InvocationProvider,
  delta: (...args: Parameters<F>) => Partial<Metrics>,
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  return async (...args) => {
    const inv = current();
    inv.assertOpen();
    const result = await fn(...args);
    inv.record(delta(...args));
    inv.enforce();
    return result;
  };
}

// ---------------------------------------------------------------- D1

interface StatementInfo {
  inner: D1PreparedStatement;
  sql: string;
}

const statements = new WeakMap<object, StatementInfo>();

function metaDelta(meta: Partial<D1Meta> | undefined): Partial<Metrics> {
  return { d1RowsRead: meta?.rows_read ?? 0, d1RowsWritten: meta?.rows_written ?? 0, d1Queries: 1 };
}

type D1Target = Pick<D1Database, "prepare" | "batch">;

function guardStatement(inner: D1PreparedStatement, sql: string, current: InvocationProvider): D1PreparedStatement {
  const exec = async <T>(): Promise<D1Result<T>> => {
    const inv = current();
    inv.assertOpen();
    // first() and raw() don't expose meta, so everything goes through all(); D1 never adds LIMIT itself,
    // so the rows read (and billed) are the same.
    const result = await inner.all<T>();
    inv.record(metaDelta(result.meta), sql);
    inv.enforce();
    return result;
  };

  const stmt = {
    bind: (...values: unknown[]) => guardStatement(inner.bind(...values), sql, current),
    all: exec,
    run: exec,
    async first(column?: string) {
      const row = ((await exec()).results[0] ?? null) as Record<string, unknown> | null;
      if (column === undefined || row === null) return row;
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
      return row[column];
    },
    async raw(options?: { columnNames?: boolean }) {
      const results = (await exec()).results as Record<string, unknown>[];
      const rows = results.map((r) => Object.values(r));
      if (!options?.columnNames) return rows;
      return [results[0] ? Object.keys(results[0]) : [], ...rows];
    },
  } as unknown as D1PreparedStatement;

  statements.set(stmt, { inner, sql });
  return stmt;
}

async function guardedBatch<T>(
  target: D1Target,
  stmts: D1PreparedStatement[],
  current: InvocationProvider,
): Promise<D1Result<T>[]> {
  const inv = current();
  inv.assertOpen();
  const infos = stmts.map((s) => statements.get(s));
  const results = await target.batch<T>(stmts.map((s, i) => infos[i]?.inner ?? s));
  results.forEach((r, i) => inv.record(metaDelta(r.meta), infos[i]?.sql ?? "(unguarded statement)"));
  inv.enforce();
  return results;
}

function guardD1(db: D1Database, current: InvocationProvider): D1Database {
  const prepareOn = (target: D1Target) => (query: string) =>
    guardStatement(target.prepare(query), normalizeSql(query), current);

  return proxyWith(db, {
    prepare: prepareOn(db),
    batch: (stmts: D1PreparedStatement[]) => guardedBatch(db, stmts, current),
    async exec(query: string) {
      const inv = current();
      inv.assertOpen();
      const result = await db.exec(query);
      // exec() reports no row counts; only the statement count is known.
      inv.record({ d1Queries: result.count }, normalizeSql(query));
      inv.enforce();
      return result;
    },
    withSession(constraint?: D1SessionBookmark | D1SessionConstraint) {
      const session = db.withSession(constraint);
      return proxyWith(session, {
        prepare: prepareOn(session),
        batch: (stmts: D1PreparedStatement[]) => guardedBatch(session, stmts, current),
      });
    },
  });
}

// ---------------------------------------------------------------- KV

function guardKV(kv: KVNamespace, current: InvocationProvider): KVNamespace {
  const reads = (key: unknown) => ({ kvReads: Array.isArray(key) ? key.length : 1 });
  return proxyWith(kv, {
    get: counted(kv.get.bind(kv) as AnyFn, current, reads),
    getWithMetadata: counted(kv.getWithMetadata.bind(kv) as AnyFn, current, reads),
    put: counted(kv.put.bind(kv), current, () => ({ kvWrites: 1 })),
    delete: counted(kv.delete.bind(kv), current, () => ({ kvWrites: 1 })),
    list: counted(kv.list.bind(kv) as AnyFn, current, () => ({ kvLists: 1 })),
  });
}

// ---------------------------------------------------------------- R2

function guardR2(bucket: R2Bucket, current: InvocationProvider): R2Bucket {
  const classA = () => ({ r2ClassA: 1 });
  const classB = () => ({ r2ClassB: 1 });
  const multipart = (upload: R2MultipartUpload) =>
    proxyWith(upload, {
      uploadPart: counted(upload.uploadPart.bind(upload), current, classA),
      complete: counted(upload.complete.bind(upload), current, classA),
    });
  const create = counted(bucket.createMultipartUpload.bind(bucket), current, classA);

  return proxyWith(bucket, {
    head: counted(bucket.head.bind(bucket), current, classB),
    get: counted(bucket.get.bind(bucket) as AnyFn, current, classB),
    put: counted(bucket.put.bind(bucket) as AnyFn, current, classA),
    list: counted(bucket.list.bind(bucket), current, classA),
    createMultipartUpload: async (...args: Parameters<R2Bucket["createMultipartUpload"]>) =>
      multipart(await create(...args)),
    resumeMultipartUpload: (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) =>
      multipart(bucket.resumeMultipartUpload(...args)),
  });
}
