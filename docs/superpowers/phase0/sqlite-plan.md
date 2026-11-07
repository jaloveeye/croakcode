# SQLite Plan (Phase 0b)

## Inheritance from upstream (verified)
opencode v1.15.12 uses Drizzle SQLite at `~/.local/share/opencode/opencode.db` with:
`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`,
writes via `Database.transaction(behavior:"immediate")` (`storage/db.ts`, `sync/index.ts:151`).
croakcode INHERITS these settings; we add only schema_version + croakcode tables.

## croakcode DB
Path: `~/.local/share/croakcode/croakcode.db`

## Pragmas (same as upstream)
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

## Schema
```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, model TEXT, permission_mode TEXT, cwd TEXT,
  created_at INTEGER, updated_at INTEGER, status TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT, created_at INTEGER, metadata TEXT
);
CREATE TABLE parts (
  id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT, type TEXT, data TEXT, created_at INTEGER,
  invocation_id TEXT, run_state TEXT
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, session_id TEXT,
  payload TEXT, created_at INTEGER
);
```

`run_state` values: `pending` / `running` / `succeeded` / `failed` / `unknown`.

## Single-writer policy
One app process is the writer. Concurrent readers use busy_timeout. Cross-process writers retry within busy_timeout.

## Recovery (spec §4.5)
Tool part transitions use 2-phase commit: commit `running` (T1) → execute → commit result (T2).
A lingering `running` on resume becomes `unknown`; side-effect tools never auto-reexecute.

## Migration from opencode
1. Detect `~/.local/share/opencode/opencode.db`.
2. Copy to temp DB (never mutate source — non-destructive).
3. Map opencode session/message/part tables → croakcode schema; set schema_version=1.
4. Verify: session count matches; a sample session loads.
5. On mismatch, abort and keep source intact (non-destructive).

## Retention
- usage events: 90 days (`usageRetentionDays`)
- audit events: 365 days (`auditRetentionDays`), export before delete
- prompt text never stored
