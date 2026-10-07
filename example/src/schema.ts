export const SCHEMA = [
  // BUG (on purpose): no index on posts.author, so /search reads the whole table on every request.
  `CREATE TABLE IF NOT EXISTS posts (
     id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY, room TEXT NOT NULL, at INTEGER NOT NULL)`,
];

/** Inserts ?1 posts spread over 100 authors. */
export const SEED_SQL = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < ?1)
  INSERT INTO posts (title, author) SELECT 'post ' || x, 'author-' || (x % 100) FROM s`;

/** Inserts ?2 tick rows for room ?1. */
export const TICK_SQL = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < ?2)
  INSERT INTO ticks (room, at) SELECT ?1, unixepoch() FROM s`;
