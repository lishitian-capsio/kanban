# Relocate Runtime Data Into Repo (.kanban) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate per-workspace Kanban runtime data from `~/.kanban` to `<repoPath>/.kanban`, draw a precise git boundary (content committed; runtime + secrets ignored), and copy-migrate existing data without touching the original — so a fresh clone + one-time credential setup yields a working board.

**Architecture:** Split the single `~/.kanban` root into two roots. A **machine root** (`~/.kanban`, unchanged) keeps the cross-repo registry (`workspaces/index.json`), secrets (`settings/`), runtime config (`config.json`), pi logs (`pi/`), and generic agent hook shims (`hooks/`). A **repo root** (`<repoPath>/.kanban`) holds each workspace's content + per-repo runtime: `workspaces/<id>/{board,requirements*,sessions,meta}.json`, `worktrees/`, `trashed-task-patches/`. The path getters in `workspace-state.ts` that produce per-workspace paths gain a `repoPath` parameter; the index getter stays machine-rooted. Startup copy-migrates `~/.kanban/workspaces/<id>` → `<repoPath>/.kanban/workspaces/<id>` once (source untouched), and readers fall back to the old location when the new one is absent.

**Tech Stack:** TypeScript (Bun runtime), Zod, vitest (`bun vitest run`), `node:fs/promises` (`cp`, `mkdir`, `stat`).

---

## Boundary — what goes in git vs not (the contract this task locks in)

Written as `<repoPath>/.kanban/.gitignore` (committed; ships with the repo). Denylist style so future committed dirs (`tasks/`, `files/` in T2–T4) are tracked by default and only known runtime/secret paths are ignored.

| Path under `<repoPath>/.kanban/` | Disposition | Why |
|---|---|---|
| `workspaces/<id>/board.json` | **commit** | task definitions + board layout (content) |
| `workspaces/<id>/requirements.json`, `requirement-versions.json`, `requirement-task-links.json` | **commit** | requirements (content) |
| `worktrees/` | ignore | machine-local checkouts, regenerated per task |
| `workspaces/**/sessions.json` | ignore | live session summaries (runtime) |
| `workspaces/**/sessions/` | ignore | transcripts / PTY buffers (runtime) |
| `workspaces/**/meta.json` | ignore | optimistic-concurrency revision counter (runtime bookkeeping) |
| `workspaces/index.json` | n/a here | lives in **machine root** `~/.kanban`, never in repo |
| `trashed-task-patches/` | ignore | transient |
| `*.lock`, `.workspaces.lock` | ignore | locks |
| `settings/`, `config.json`, `provider_settings.json`, `*_oauth_settings.json` | ignore (defensive) | secrets — primary copies stay machine-local in `~/.kanban`; defensively ignored in case anything writes them here |

Secrets stay machine-local by construction: `provider-settings-store.ts:59`, `mcp-settings-service.ts:98`, `pi-mcp-integration.ts:234`, and `runtime-config.ts` all build `join(homedir(), ".kanban", ...)` directly and are **not** repointed by this task. The defensive `.gitignore` entries are a second line of defense only.

---

## File structure

- **Modify** `src/state/workspace-state.ts` — split machine vs repo roots; add `repoPath` to per-workspace getters/readers/public wrappers; add `resolveRepoPathForWorkspaceId`; add copy-migration + read fallback.
- **Modify** `src/workspace/task-worktree.ts` — thread `repoPath` into `getWorktreesRootPath` / `getWorktreesBaseRootPath` / `getTrashedTaskPatchesRootPath` (callers already hold `repoPath`).
- **Modify** `src/terminal/claude-workspace-trust.ts` — `isTaskWorktreePath` becomes a `.kanban/worktrees/` path-segment check (drops `getTaskWorktreesHomePath` dependency; repo-agnostic).
- **Modify** `src/server/workspace-registry.ts` — pass `repoPath` to `getWorkspaceSessionMessagesDirPath`, `loadWorkspaceBoardById`, `removeWorkspaceStateFiles`.
- **Modify** `src/server/runtime-server.ts` — pass `scope.workspacePath` to `getWorkspaceSessionMessagesDirPath`.
- **Modify** `src/trpc/projects-api.ts` — `removeWorkspaceStateFiles` gains `repoPath` (caller has it via context/registry).
- **Create** `src/state/runtime-home-paths.ts` *(optional split if `workspace-state.ts` grows unwieldy; default: keep in `workspace-state.ts`)*.
- **Create** `test/runtime/workspace/runtime-home-paths.test.ts` — path resolution (machine vs repo), gitignore presence, migration copy (source untouched), read-fallback.
- **Modify** `test/integration/workspace-state.integration.test.ts` — assert workspace data now lands under `<repoPath>/.kanban` while index stays under `~/.kanban`.
- **Create** `<repoPath>/.kanban/.gitignore` — written by the migration/bootstrap step (and added as a fixture asset the runtime ensures on init).
- **NOT touched:** `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts` — hooks stay machine-rooted.

---

## New / changed signatures (the contract later tasks build on)

```ts
// workspace-state.ts — machine root (unchanged location)
function getMachineKanbanHomePath(): string;            // join(homedir(), ".kanban")
function getWorkspaceIndexPath(): string;               // join(getMachineKanbanHomePath(), "workspaces", "index.json")

// workspace-state.ts — repo root (NEW: takes repoPath)
export function getRuntimeHomePath(repoPath: string): string;          // join(repoPath, ".kanban")
export function getTaskWorktreesHomePath(repoPath: string): string;    // join(getRuntimeHomePath(repoPath), "worktrees")
export function getWorkspacesRootPath(repoPath: string): string;       // join(getRuntimeHomePath(repoPath), "workspaces")
export function getWorkspaceDirectoryPath(repoPath: string, workspaceId: string): string;
export function getWorkspaceSessionMessagesDirPath(repoPath: string, workspaceId: string): string;

// workspace-state.ts — bridge for callers that only have an id
export async function resolveRepoPathForWorkspaceId(workspaceId: string): Promise<string | null>;

// readers gain repoPath (internal)
async function readWorkspaceBoard(repoPath: string, workspaceId: string): Promise<RuntimeBoardData>;
// ...same for sessions/requirements/versions/task-links/meta...

// public wrappers
export async function loadWorkspaceBoardById(workspaceId: string): Promise<RuntimeBoardData>; // resolves repoPath via index internally
export async function removeWorkspaceStateFiles(repoPath: string, workspaceId: string): Promise<void>;

// migration + fallback
async function migrateWorkspaceDataFromMachineRoot(repoPath: string, workspaceId: string): Promise<void>;
async function readJsonFileWithFallback(primaryPath: string, fallbackPath: string | null): Promise<unknown | null>;
```

Migration semantics: `migrateWorkspaceDataFromMachineRoot` runs inside `loadWorkspaceContext` after the workspace id is resolved. If `<repoPath>/.kanban/workspaces/<id>` does **not** exist and `~/.kanban/workspaces/<id>` **does**, recursively `cp` the old dir into the new location (`recursive: true`, no overwrite). The machine-root copy is never deleted or moved. Idempotent: a second run sees the target exists and no-ops.

Read fallback: per-workspace readers compute both the repo-root path and the machine-root path for the same `<id>`, and read the machine-root path only when the repo-root file is `ENOENT`. Writes always target the repo root.

---

## Task 1: Split machine vs repo roots + repo-aware getters (unit-tested)

**Files:**
- Modify: `src/state/workspace-state.ts:170-244` (path getters + lock requests), `:307` (`parseWorkspaceIndex`), `:401-408` (index read/write).
- Test: `test/runtime/workspace/runtime-home-paths.test.ts`

- [ ] **Step 1: Write failing test** for the getter contract.

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getRuntimeHomePath,
	getTaskWorktreesHomePath,
	getWorkspaceDirectoryPath,
	getWorkspacesRootPath,
} from "../../../src/state/workspace-state";

describe("runtime home paths", () => {
	const repo = "/tmp/example-repo";
	it("roots per-workspace data at <repoPath>/.kanban", () => {
		expect(getRuntimeHomePath(repo)).toBe(join(repo, ".kanban"));
		expect(getTaskWorktreesHomePath(repo)).toBe(join(repo, ".kanban", "worktrees"));
		expect(getWorkspacesRootPath(repo)).toBe(join(repo, ".kanban", "workspaces"));
		expect(getWorkspaceDirectoryPath(repo, "proj")).toBe(join(repo, ".kanban", "workspaces", "proj"));
	});
	it("keeps the index in the machine root (~/.kanban), independent of repoPath", async () => {
		// index path is internal; assert indirectly via listWorkspaceIndexEntries reading homedir.
		// Covered by the integration test; here we only assert repo getters do NOT point at homedir.
		expect(getRuntimeHomePath(repo).startsWith(homedir())).toBe(false);
	});
});
```

- [ ] **Step 2: Run test, verify it fails** (getters still take no args / wrong arity).

Run: `bun vitest run test/runtime/workspace/runtime-home-paths.test.ts`
Expected: FAIL (type error / wrong path).

- [ ] **Step 3: Implement the split.** In `workspace-state.ts`:
  - Add `getMachineKanbanHomePath()` returning `join(homedir(), RUNTIME_HOME_DIR)`.
  - Change `getRuntimeHomePath()` → `getRuntimeHomePath(repoPath: string)` returning `join(repoPath, RUNTIME_HOME_DIR)`.
  - Change `getTaskWorktreesHomePath`, `getWorkspacesRootPath`, `getWorkspaceDirectoryPath`, `getWorkspaceSessionMessagesDirPath`, and the per-file getters (`getWorkspaceBoardPath`, `getWorkspaceSessionsPath`, `getWorkspaceRequirementsPath`, `getWorkspaceRequirementVersionsPath`, `getWorkspaceRequirementTaskLinksPath`, `getWorkspaceMetaPath`) to take `repoPath` as the first arg.
  - Repoint `getWorkspaceIndexPath()` to `join(getMachineKanbanHomePath(), WORKSPACES_DIR, INDEX_FILENAME)` (machine root) — **do not** add repoPath here.
  - Update `getWorkspaceDirectoryLockRequest(repoPath, workspaceId)`, `getWorkspacesRootLockRequest(repoPath)`, and `getWorkspaceIndexLockRequest()` (index lock stays machine-rooted).

- [ ] **Step 4: Run test, verify pass.** `bun vitest run test/runtime/workspace/runtime-home-paths.test.ts` → PASS. (Compile errors in callers are expected and fixed in later tasks; run with `--no-isolate` is unnecessary — vitest compiles per-file.)

- [ ] **Step 5: Commit.** `git add -A && git commit` (only when user asks — per AGENTS.md, defer commits).

## Task 2: Thread repoPath through readers + public wrappers + callers

**Files:** `src/state/workspace-state.ts` (readers `:325-403`, `loadWorkspaceContext` `:633-671`, `loadWorkspaceBoardById`, `loadWorkspaceRequirementVersions`, `loadWorkspaceRequirementTaskLinks`, `loadWorkspaceState`, `saveWorkspaceState`, `mutateWorkspaceState`, `removeWorkspaceStateFiles`), plus external callers.

- [ ] **Step 1:** Add `resolveRepoPathForWorkspaceId(workspaceId)` (reads machine index, returns `entry.repoPath` or null).
- [ ] **Step 2:** Give each `readWorkspaceX` a leading `repoPath` param; callers that have `context` pass `context.repoPath`; `loadWorkspaceBoardById(workspaceId)` resolves repoPath via `resolveRepoPathForWorkspaceId` (throw a clear error if unknown).
- [ ] **Step 3:** `removeWorkspaceStateFiles(repoPath, workspaceId)`; update its lock requests to repo-rooted variants.
- [ ] **Step 4:** Update external callers with the repoPath already in scope:
  - `workspace-registry.ts:262` → `getWorkspaceSessionMessagesDirPath(repoPath, workspaceId)` (repoPath available in the same closure that calls `loadWorkspaceState(repoPath)`).
  - `workspace-registry.ts:323` → `summarizeProjectTaskCounts` already receives `_repoPath`; use it: `loadWorkspaceBoardById` stays id-only (resolves internally) — no change needed, but prefer passing repoPath if a repo-aware overload is added.
  - `workspace-registry.ts:406` → `removeWorkspaceStateFiles(project.repoPath, project.workspaceId)`.
  - `runtime-server.ts:152` → `getWorkspaceSessionMessagesDirPath(scope.workspacePath, scope.workspaceId)`.
  - `trpc/projects-api.ts:189` → thread repoPath (from the resolved context / project record) into `removeWorkspaceStateFiles`.
- [ ] **Step 5:** `bun run typecheck` (or the repo's tsc script) → no errors. Then `bun vitest run test/integration/workspace-state.integration.test.ts` → still PASS (data now under `<repoPath>/.kanban`, index under `~/.kanban`; update assertions if any path is asserted).

## Task 3: Repo-root worktrees + trashed patches; repo-agnostic trust check

**Files:** `src/workspace/task-worktree.ts:118-129`, `src/terminal/claude-workspace-trust.ts:64-71`.

- [ ] **Step 1:** In `task-worktree.ts`, thread `repoPath` into `getWorktreesRootPath`, `getWorktreesBaseRootPath`, `getTrashedTaskPatchesRootPath` (all internal; callers `getTaskWorktreePath(repoPath, …)` and worktree lifecycle fns already hold `repoPath`). Map every internal caller (read the whole file's call graph) and pass `repoPath`.
- [ ] **Step 2:** In `claude-workspace-trust.ts`, rewrite `isTaskWorktreePath(path)` to test for a `/.kanban/worktrees/` path segment (normalize separators; case-insensitive on win32), removing the `getTaskWorktreesHomePath` import.
- [ ] **Step 3:** Add a unit test in `test/runtime/terminal/` covering `isTaskWorktreePath` true for `<repo>/.kanban/worktrees/<task>/<label>` and false for an arbitrary path.
- [ ] **Step 4:** `bun vitest run test/runtime/task-worktree.test.ts test/runtime/terminal/` → PASS.

## Task 4: Copy-migration + read fallback (unit-tested; source untouched)

**Files:** `src/state/workspace-state.ts`; test `test/runtime/workspace/runtime-home-paths.test.ts`.

- [ ] **Step 1: Failing test** — given an old `~/.kanban/workspaces/<id>/board.json` (via `$HOME` redirect to a temp dir) and an empty repo dir, after `loadWorkspaceContext(repoDir)` the file exists at `<repoDir>/.kanban/workspaces/<id>/board.json` **and** the original still exists at the old path.

```ts
// arrange: tmpHome with ~/.kanban/workspaces/<id>/board.json, tmpRepo = git init
// act: await loadWorkspaceContext(tmpRepo)
// assert: existsSync(join(tmpRepo, ".kanban/workspaces", id, "board.json")) === true
// assert: existsSync(join(tmpHome, ".kanban/workspaces", id, "board.json")) === true  // source intact
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3:** Implement `migrateWorkspaceDataFromMachineRoot(repoPath, workspaceId)` using `fs.cp(old, new, { recursive: true, force: false, errorOnExist: false })` guarded by a `stat` existence check on the new dir; call it inside `loadWorkspaceContext` right after the id is ensured. Implement `readJsonFileWithFallback` and use it in the per-workspace readers (primary repo path, fallback machine path for the same id).
- [ ] **Step 4: Run, verify pass** + add a fallback test (old file present, migration disabled/short-circuited → reader still returns old content).
- [ ] **Step 5:** Confirm idempotency test (second `loadWorkspaceContext` no-ops, no throw).

## Task 5: `.kanban/.gitignore` boundary (ensured on init)

**Files:** `src/state/workspace-state.ts` (ensure-gitignore on repo-root creation); test in `runtime-home-paths.test.ts`.

- [ ] **Step 1: Failing test** — after `loadWorkspaceContext(repoDir)`, `<repoDir>/.kanban/.gitignore` exists and contains `worktrees/`, `sessions/`, `*.lock`, `settings/`, and `**/sessions.json`, `**/meta.json`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3:** Add `RUNTIME_HOME_GITIGNORE` constant (the denylist from the Boundary section) and `ensureRuntimeHomeGitignore(repoPath)` that writes it if absent (never overwrites a user-edited one). Call it when the repo root is first created.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5:** Manually verify with `git check-ignore` in a scratch repo: `git -C <repo> check-ignore .kanban/worktrees/x .kanban/workspaces/p/sessions.json` returns the paths; `.kanban/workspaces/p/board.json` is NOT ignored.

## Task 6: Full verification

- [ ] `bun vitest run` (full suite) → PASS. Watch for Node 22 hang (see AGENTS.md note) — if it hangs after tests finish, suspect a live subprocess, not a slow test.
- [ ] `npm run lint` clean on touched files.
- [ ] Manual: in a throwaway git repo, point the runtime at it, confirm board/requirements appear under `<repo>/.kanban/workspaces/<id>/`, worktrees under `<repo>/.kanban/worktrees/`, index still under `~/.kanban/workspaces/index.json`, and `~/.kanban` original data untouched.

---

## Self-review notes

- **Spec coverage:** (1) location migration → Tasks 1–3; (2) git boundary + .gitignore → Task 5 + Boundary table; (3) copy-not-move migration + old-location fallback → Task 4; (4) tests → Tasks 1,3,4,5,6. ✓
- **Out of scope (later tasks):** task-def sharding (T2), requirements-into-repo specifics (T3), Files library (T4–T6). This task keeps the existing `workspaces/<id>/*.json` structure, just re-rooted.
- **Known limitation (documented):** worktrees now live inside the repo working tree under the gitignored `.kanban/worktrees/`; git won't traverse the ignored dir so `git status` is unaffected. Multi-workspace is per-repo by design now (each repo owns its `.kanban`); the machine index remains the cross-repo registry.
