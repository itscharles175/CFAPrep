# SurrealDB Migration Strategy

## Today — Dexie as the de-facto API

All persistent state in QuantVault flows through `src/lib/progressStore.ts`. The
`db` object is a Dexie instance, and callers throughout the app (components,
pages, domain modules, AI-tutor hooks) call `db.settings.get/put/delete/toArray/
bulkDelete/clear` directly. There is no indirection layer: Dexie is the API.

## Phase 1 (this commit) — Storage Abstraction Layer

A minimal storage abstraction lands in `src/lib/storage/`. It introduces:

- **`types.ts`** — `StorageDriver`, `StorageSettingRow`, and `StorageRegistry`
  interfaces that every backend must satisfy.
- **`dexieDriver.ts`** — thin wrapper around `db.settings` from `progressStore`;
  delegates every call straight through. This is the "leave" side of the
  strangler pattern — all current behaviour is unchanged.
- **`surrealDriver.ts`** — connects to the open-notebook SurrealDB sidecar
  (`http://localhost:8000/rpc`) supervised by the Tauri shell, mapping the same
  `settings` interface to `setting:<key>` records. Disabled by default: the
  registry will only activate it if `ready()` returns `true`, which requires the
  sidecar to be reachable within 3 seconds.
- **`index.ts`** — singleton registry that exports `getStorage()`, `switchToSurreal()`,
  and `switchToDexie()`. The active driver is always `dexie` on startup.

No caller is changed in this phase. The abstraction exists but is dormant.

## Phase 2 (future) — Mechanical Callsite Migration

A purely mechanical sweep replaces every `db.settings.put(...)`, `db.settings.get(...)`,
`db.settings.delete(...)`, `db.settings.toArray(...)`, `db.settings.bulkDelete(...)`,
and `db.settings.clear(...)` in the codebase with the equivalent call on
`getStorage().settings.*`. Because `dexieDriver` proxies directly to Dexie, this
is a zero-behaviour-change refactor — every test that passes today must still pass
after Phase 2. The migration can be done file by file and reviewed incrementally.

## Phase 3 (future) — Opt-in SurrealDB via System Health Toggle

Once Phase 2 is complete, a toggle in System Health can call `switchToSurreal()`.
Before activating, a one-time migrator copies every row from `db.settings.toArray()`
into the SurrealDB `setting:*` table. If the switch fails (sidecar down, version
mismatch), the registry stays on Dexie and the user sees an actionable error. The
rollback path is always `switchToDexie()`, which is guaranteed to succeed.

## Phase 4 (future) — Full Data-Model Coverage

The same abstraction is extended to cover the remaining tables:
`sourceDocuments`, `sourceChunks`, `reviewItems`, `masterySnapshots`, and the
rest of the `VaultDataStores` schema. Each table gets the same
`StorageDriver.{table}` sub-interface treatment in turn, unlocking the eventual
goal of a fully SurrealDB-backed local datastore while keeping Dexie as the
always-available fallback for offline-first resilience.
