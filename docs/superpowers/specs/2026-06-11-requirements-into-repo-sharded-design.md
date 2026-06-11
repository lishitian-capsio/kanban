# Requirements into repo (sharded by id) — design

Date: 2026-06-11
Task: T3 in the data-into-repo chain (depends on T1, sibling of T2 task-def sharding).

## Goal

Make a fresh `git clone` carry a workspace's requirements. Requirements data must
live under `<repo>/.kanban/` and be git-tracked, and the layout must avoid
cross-branch merge conflicts when different people edit different requirements.

## Background: what T1 already did (do NOT redo)

T1 (`f727eca`) relocated **all** per-workspace data from `~/.kanban/workspaces/<id>/`
into `<repoPath>/.kanban/workspaces/<id>/`, including the three requirement files
(`requirements.json`, `requirement-versions.json`, `requirement-task-links.json`).
It also:

- wrote the denylist-style `.kanban/.gitignore` that **commits** content (board +
  `requirements*.json`) while ignoring runtime/secrets;
- added a one-time, non-destructive copy-migration from the machine-home location
  (`migrateWorkspaceDataFromLegacyHome`, never deletes the source);
- added a repo-first, machine-home-fallback read path
  (`readJsonFileWithLegacyFallback`).

So the *relocation*, *commit boundary*, *copy-migration*, and *legacy read
fallback* (task items 1, 3, 4) already exist. The only genuinely new work in T3 is
**item 2: sharding the requirement data by requirement id**, so two branches editing
two different requirements never collide on one JSON file.

## Data facts that make sharding safe

- `RuntimeRequirementsData = { items: RuntimeRequirementItem[] }`; each item has a
  unique `id` and an `order` field → shards cleanly, list rebuilds by sorting on
  `order`.
- `RuntimeRequirementVersion` carries its own `requirementId` + `version`.
  `nextRequirementVersionNumber` / `listRequirementVersions` filter by id and sort
  by `version`, so the **global array order of the versions aggregate is cosmetic** —
  reconstructing it from per-id shards is lossless.
- A `delete` version record is appended *after* the requirement item is gone, so a
  version shard can (and must be allowed to) outlive its requirement.
- `RuntimeRequirementTaskLink` carries `requirementId` + `taskId`; the requirement's
  `linkedTaskIds` is the source of truth, links are a mirror → keying link shards by
  `requirementId` is natural.

No `api-contract` / schema changes: only the on-disk shape changes. In-memory
`RuntimeRequirementsData` / `RuntimeRequirementVersionsData` /
`RuntimeRequirementTaskLinksData` are untouched.

## Storage layout

Per workspace dir `<repoPath>/.kanban/workspaces/<id>/`, the three single files
become three directories:

```
requirements/<reqId>.json            # one RuntimeRequirementItem object
requirement-versions/<reqId>.json    # RuntimeRequirementVersion[]  (that req's full history)
requirement-task-links/<reqId>.json  # RuntimeRequirementTaskLink[] (that req's links)
```

Aggregate reconstruction:

- **requirements**: read every shard, sort by `order` then `id` → `{ items }`.
- **versions**: concat every shard → `{ versions }`, deterministically ordered
  (group by `requirementId` sorted, then by `version`).
- **links**: concat every shard → `{ links }`, deterministically ordered (group by
  `requirementId` sorted, then by `createdAt`).

Delete semantics: deleting a requirement removes `requirements/<id>.json` but
**keeps** `requirement-versions/<id>.json` (history, including the `delete` record).
Link shards for a vanished requirement are diffed away from the links aggregate as
usual (existing mutation behavior is unchanged).

## New modules (keep `workspace-state.ts` from bloating)

### `src/state/sharded-json-store.ts` (generic, single-responsibility)

- `readShardDir<T>(dir, schema): Promise<Map<string, T>>` — read every `*.json` in
  `dir`, key = filename without `.json`, value = schema-parsed. Missing dir → empty
  map. Validation errors surface with the offending path (same style as
  `parsePersistedStateFile`).
- `writeShardDir<T>(dir, shards: Map<string,T>): Promise<void>` — make the directory
  mirror the map exactly: atomic-write each `<id>.json`, then delete any existing
  `<id>.json` whose id is absent from the map (found by listing the dir, so no prev
  map is needed). `writeJsonFileAtomic` already skips files whose content is
  unchanged, so git sees no spurious diff. Callers already hold the workspace-dir
  lock, so per-file writes pass `lock: null`.

### `src/state/requirement-store.ts` (typed layer)

Built on the generic store; returns/accepts the existing aggregate types:

- `readRequirementsSharded(dir): Promise<RuntimeRequirementsData>`
- `readRequirementVersionsSharded(dir): Promise<RuntimeRequirementVersionsData>`
- `readRequirementTaskLinksSharded(dir): Promise<RuntimeRequirementTaskLinksData>`
- `writeRequirementsSharded(dir, prev, next): Promise<void>`
- `writeRequirementVersionsSharded(dir, prev, next): Promise<void>`
- `writeRequirementTaskLinksSharded(dir, prev, next): Promise<void>`

The write functions derive prev/next id-maps from the aggregates (requirements →
`id`→item; versions/links → `requirementId`→record[]) and delegate to `writeShardDir`.

## Wiring in `workspace-state.ts`

Add path getters for the three shard dirs (alongside the existing single-file
getters, which stay for migration/back-compat reads).

**Read** (`readWorkspaceRequirements` and the two siblings):
1. shard dir exists → read shards (`requirement-store`);
2. else repo-rooted single file exists → read it (pre-sharding repo);
3. else → existing T1 legacy machine-home single-file fallback.

**Write** (`saveWorkspaceState` and `mutateWorkspaceState`): replace the three
`writeJsonFileAtomic(<single file>)` calls with the sharded writers, passing the
previous aggregate (already read for the version diff) and the next aggregate. All
inside the already-held workspace-dir lock. The version-diff/`diffRequirementVersions`
logic is unchanged — it still operates on aggregates.

**One-time migration** `migrateRequirementsToShards(repoPath, workspaceId)`:
- run inside `prepareRepoRuntimeHome`, **after** `migrateWorkspaceDataFromLegacyHome`
  and `ensureRuntimeHomeGitignore`;
- acquire the workspace-dir lock (it mutates the same files saves touch);
- idempotent: for each of the three kinds, if the repo single file exists **and** the
  shard dir does not, split the single file into shards then delete the repo single
  file; otherwise do nothing;
- never touches `~/.kanban` originals (T1 invariant).

Net effect on a real workspace: machine-home single file → (T1 copy) → repo single
file → (this) → repo shards.

## Git boundary

`.kanban/.gitignore` is denylist-style, so the new shard dirs are tracked by
default — no functional change. Update the boundary **comment** to name the sharded
dirs (`requirements/`, `requirement-versions/`, `requirement-task-links/`) instead of
`requirements*.json`. Confirm no ignore glob (`**/sessions/`, `**/meta.json`, etc.)
catches them.

## Testing (TDD)

**Unit**

- `sharded-json-store`: empty/missing dir → empty map; `writeShardDir` creates new,
  skips unchanged (no rewrite), deletes removed; round-trip through `readShardDir`;
  schema-validation error reports the file path.
- `requirement-store`: requirements round-trip + `order` sort + tie-break;
  versions/links grouped per id; version shard survives requirement deletion;
  deterministic aggregate ordering.

**Integration** (extend `workspace-state.integration.test.ts` +
`runtime-home-relocation.integration.test.ts`)

- `saveWorkspaceState` produces shard dirs and no single `requirements.json`.
- legacy machine-home single file → after `loadWorkspaceContext`, repo has shards,
  machine-home original intact.
- `mutateWorkspaceState` round-trips links and versions; board-only save preserves
  both; create/update/delete versioning still recorded (existing tests stay green).
- `git check-ignore`: shard dirs are tracked; `sessions/`, `meta.json`, `worktrees/`
  still ignored.
- backward-compat: repo has single `requirements.json` and no shard dir → read works,
  and migration then converts it to shards and removes the single file.

## Out of scope

- T2 task-def sharding (sibling task; this design mirrors its intent but does not
  implement it).
- Files library / LFS (T5/T6).
- Agent session resume.
