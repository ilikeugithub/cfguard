const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;

/** `GET /posts/123/comments` → `GET /posts/:id/comments`, so hot-route stats group by endpoint. */
export function routeOf(request: Request): string {
  const url = new URL(request.url);
  const path = url.pathname
    .split("/")
    .map((s) => (ID_SEGMENT.test(s) ? ":id" : s))
    .join("/");
  return `${request.method} ${path}`.slice(0, 200);
}

/** Collapses literals and whitespace so the same query shape is counted under one key. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/(?<![\w?$:@])\d+(?:\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?, …)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
