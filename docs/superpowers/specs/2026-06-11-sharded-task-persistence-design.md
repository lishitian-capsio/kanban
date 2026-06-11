# Sharded Task Persistence (T2)

**Date:** 2026-06-11
**Status:** Implemented
**Depends on:** T1 (`.kanban` relocation into the repo — committed as `f727eca`)

## Goal

Split task/board persistence into two layers:

- **Durable definition → git.** Each task's spec lives in its own file so a fresh
  `git clone` shows the complete task list (titles, prompts, columns, ordering,
  dependency links, auto-review settings) with **no machine-local state required**.
- **Live runtime → local, gitignored.** Active sessions, PTY buffers, worktree
  paths, locks, revision counter stay out of git (already separated in T1).

A secondary goal is **conflict-free concurrent editing**: changes to different
tasks land in different files, so two branches editing two different tasks do not
produce a git merge conflict.

### Acceptance criterion

A new teammate can `git clone`, open Kanban, and see every task with its column
and dependencies — without any local state.

## Core insight: sharding is a storage-layer concern only

The wire / in-memory contract `runtimeBoardDataSchema`
(`{ columns: [{ id, title, cards[] }], dependencies[] }`) stays **unchanged**. The
storage layer *assembles* that shape from shards on read and *decomposes* it into
shards on write.

Consequences:

- **No frontend changes**, **no `api-contract.ts` changes**, **no mutations-layer
  changes**. Only `src/state/` is touched.
- `rank` (ordering) and the per-task `dependsOn` decomposition are purely internal
  to storage — they never reach the wire. The frontend keeps consuming ordered
  `cards[]` and a flat `dependencies[]` exactly as today.

## File layout

Per workspace, under `<repo>/.kanban/workspaces/<id>/`:

| Path | In git? | Contents |
|---|---|---|
| `board.json` | ✅ committed | **Repurposed as the layout manifest**: `{ version, columns: [{ id, title }] }` — no cards, no deps |
| `tasks/<taskId>.json` | ✅ committed | One durable task spec per file |
| `sessions.json`, `sessions/`, `meta.json`, `worktrees/`, `*.lock` | 🚫 gitignored | Runtime state, unchanged from T1 |

`tasks/` is committed: the repo `.kanban/.gitignore` ignore-list does not match it,
and the existing comment already anticipates it ("future tasks/"). We only update
that comment to note it shipped. No new ignore rules are required.

`board.json` keeps its filename (already committed, already named in the gitignore
comment); it slims from the full board to a column manifest. Migration distinguishes
old vs new shape by the presence of `columns[].cards`.

## Per-task file schema (durable spec)

```jsonc
{
  "id": "abc",
  "title": "…",                  // optional (falls back to first line of prompt, as today)
  "prompt": "…",
  "column": "backlog",           // was implicit (which column's cards[] held the task)
  "rank": "0|hzzzzz:",           // fractional index — ordering within the column
  "startInPlanMode": false,
  "autoReviewEnabled": true,     // optional
  "autoReviewMode": "pr",        // optional
  "images": [ … ],               // optional
  "agentId": "claude",           // optional
  "agentSettings": { … },        // optional
  "baseRef": "main",
  "dependsOn": [                 // outgoing edges; fromTaskId is implicit = this file
    { "id": "dep1", "toTaskId": "review-2", "createdAt": 0 }
  ],
  "createdAt": 0,
  "updatedAt": 0
}
```

`column` and `rank` are new persisted fields. Everything else is the existing
`runtimeBoardCardSchema` durable spec. `dependsOn` is the per-task decomposition of
the board's flat `dependencies[]` (only the from/backlog task stores its edges,
since dependencies are one-way backlog → non-backlog).

### Board layout manifest (`board.json`)

```jsonc
{
  "version": 1,
  "columns": [
    { "id": "backlog", "title": "Backlog" },
    { "id": "in_progress", "title": "In Progress" },
    { "id": "review", "title": "Review" },
    { "id": "trash", "title": "Done" }
  ]
}
```

If absent, the loader falls back to the existing hardcoded `BOARD_COLUMNS` default.
This makes board structure durable and gives column customization a home later
without requiring it now (YAGNI: no per-column grouping config beyond id/title).

## Ordering: fractional rank, minimal rewrites

New `src/state/task-rank.ts` wraps the maintained
[`fractional-indexing`](https://www.npmjs.com/package/fractional-indexing) package
(per AGENTS.md: prefer a maintained library over custom utility code).

`reconcileRanks(orderedTaskIds, existingRankMap) → Map<taskId, rank>`:

- Walk the desired order, tracking the last kept rank.
- If a task already has a stored rank that is strictly greater than the last kept
  rank, keep it.
- Otherwise (new task, or a task whose stored rank now breaks monotonicity because
  it moved), mint a fresh rank between the previous kept rank and the next kept rank
  via `generateKeyBetween`.

Common-case write amplification:

- **Append a task** → 1 task file written.
- **Move one task** → 1 task file written.
- **No-op save** (read then write same order) → 0 task files written.

This minimal-rewrite property is what delivers conflict-free git behavior for the
common operations.

## Read / write flow

New module `src/state/task-shard-store.ts`:

- **`loadShardedBoard(repoPath, workspaceId) → RuntimeBoardData`**
  1. Read `board.json` layout (fallback to default `BOARD_COLUMNS` if absent).
  2. Read all `tasks/*.json`.
  3. Group tasks by `column`, sort each column by `rank`.
  4. Aggregate every task's `dependsOn` into the flat `dependencies[]`
     (`fromTaskId` = owning task id).
  5. Return a normal `RuntimeBoardData`.

- **`saveShardedBoard(repoPath, workspaceId, board)`**
  1. `reconcileRanks` per column against the existing on-disk rank map.
  2. Decompose `dependencies[]` onto their from-task files as `dependsOn`.
  3. Write only task files whose serialized content changed; delete files for
     tasks no longer present; write `board.json` layout.
  4. All under the **existing workspace-directory lock**; per-file atomic
     temp-write + rename (existing `lockedFileSystem` helper).

`workspace-state.ts`'s `readWorkspaceBoard` and the board-write portion of
`saveWorkspaceState` delegate to this store. Everything else — sessions,
requirements, `meta.json` revision, optimistic-concurrency conflict detection —
is untouched. The revision counter still guards in-process concurrent saves.

## Migration: old single-file board → shards

`migrateBoardToSharded(repoPath, workspaceId)` runs lazily in the load path,
**after** the existing T1 legacy-home copy-migration (so legacy `~/.kanban` data is
copied into the repo first, then sharded).

- **Idempotent.** If `tasks/` already exists, return.
- Otherwise, if `board.json` has the old shape (`columns[].cards` present):
  1. Explode each card into `tasks/<id>.json`, assigning sequential initial ranks
     per column (array order preserved).
  2. Map the board's `dependencies[]` onto the from-task files as `dependsOn`.
  3. Rewrite `board.json` to the layout-only shape.
- Legacy single `board.json` remains read-compatible until migration runs.

## Testing

vitest throughout; a Bun round-trip only where importing the agent-sdk would block
vitest (per the existing pattern noted in AGENTS.md).

1. **`task-rank` unit** — ordering, insert-between, append, stability / minimal change.
2. **Shard store round-trip** — `save → load` deep-equals: column membership, order,
   every spec field, dependencies.
3. **Dependency persistence** — edges live on the from-task file, survive round-trip,
   aggregate back into the flat `dependencies[]`.
4. **Minimal rewrite** — moving one task changes exactly one task file (asserts the
   conflict-free property).
5. **Migration** — old single `board.json` → shards; reconstruction deep-equals the
   original board; `board.json` reduced to layout; re-running is a no-op.
6. **Integration** — reuse `workspace-state.integration.test.ts` patterns:
   `saveWorkspaceState` / `loadWorkspaceState` round-trip, plus the acceptance check
   (a fresh load with no runtime files present yields the full board with columns and
   dependencies).

## Blast radius

**New files**

- `src/state/task-shard-store.ts` — assemble/decompose board ↔ shards.
- `src/state/task-rank.ts` — fractional-rank helpers.
- migration function (`migrateBoardToSharded`, colocated with the shard store or in a
  dedicated migration module).
- path getters: `getWorkspaceTasksDirPath`, `getWorkspaceTaskFilePath`.

**Edited files**

- `src/state/workspace-state.ts` — board read/write delegate to the shard store; wire
  the migration into the load path.
- `<repo>/.kanban/.gitignore` content comment — note `tasks/` shipped.
- `package.json` — add `fractional-indexing`.

**Not touched**

- `src/core/api-contract.ts` (wire contract unchanged)
- task mutations layer (`task-board-mutations.ts`)
- server / runtime hub
- `web-ui`

## Non-goals (YAGNI)

- Per-column grouping/config beyond `id` + `title`.
- Exposing `rank` or `dependsOn` on the wire contract.
- Agent session resume (separate task).
- Sharding requirements (they stay single-file per the existing pattern).
