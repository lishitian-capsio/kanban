# Requirement Items — Version History (data layer + CLI)

Date: 2026-06-09
Status: Approved (design)

## Goal

Give workspace-scoped requirement items a version history. This is the foundation
for the future web-ui version view and Requirement Review. Every create / update /
delete of a requirement records one version (full snapshot + metadata). Add CLI
`requirement history` and `requirement revert`. Thread a change `source`
(`human` | `agent`) through the mutating callers (CLI human ops default `human`).

Out of scope for this task (deferred to the web-ui version-view task):
- Recording versions for edits made in the web-ui (web-ui keeps its current
  wholesale save; the new versions file is preserved, not written, by that path).
- Reverting (un-deleting) a requirement that has already been deleted.

## Key constraints / decisions

- **Parallel data stream.** Version data is persisted as a separate
  `requirement-versions.json` file, sibling to `board.json` / `requirements.json` /
  `sessions.json`. It is NOT added to `RuntimeWorkspaceStateResponse` or the save
  request, so it never rides the `useWorkspaceSync` / `useWorkspacePersistence`
  snapshot and the web-ui's wholesale save can never overwrite it.
- **web-ui untouched.** `saveWorkspaceState` only writes board/sessions/requirements/
  meta, so it naturally leaves `requirement-versions.json` intact. No web-ui change.
- **Explicit append (not diff-on-persist).** Versions are appended at the mutation
  call site, where the caller supplies `source`. The persistence layer is
  source-agnostic: it just writes whatever versions data the mutation returns.
- **Dedicated read path.** CLI `history` reads via a new
  `workspace.getRequirementVersions` tRPC query, keeping versions out of `getState`.
- **TypeScript repo rules.** No `any`; reuse existing Zod schemas/types; top-level
  imports only.

## 1. Data model — `src/core/api-contract.ts`

```ts
export const runtimeRequirementChangeSourceSchema = z.enum(["human", "agent"]);
export type RuntimeRequirementChangeSource = z.infer<typeof runtimeRequirementChangeSourceSchema>;

export const runtimeRequirementChangeKindSchema = z.enum(["create", "update", "delete", "revert"]);
export type RuntimeRequirementChangeKind = z.infer<typeof runtimeRequirementChangeKindSchema>;

export const runtimeRequirementVersionSchema = z.object({
  requirementId: z.string(),
  version: z.number().int().positive(),      // per-requirement, monotonic, starts at 1
  changeKind: runtimeRequirementChangeKindSchema,
  snapshot: runtimeRequirementItemSchema,    // full requirement snapshot recorded by this version
  source: runtimeRequirementChangeSourceSchema,
  reason: z.string().nullable().default(null),
  createdAt: z.number(),
});
export type RuntimeRequirementVersion = z.infer<typeof runtimeRequirementVersionSchema>;

export const runtimeRequirementVersionsDataSchema = z.object({
  versions: z.array(runtimeRequirementVersionSchema).default([]),
});
export type RuntimeRequirementVersionsData = z.infer<typeof runtimeRequirementVersionsDataSchema>;
```

Read-endpoint contract:

```ts
export const runtimeRequirementVersionsRequestSchema = z.object({
  requirementId: z.string().optional(),
});
export const runtimeRequirementVersionsResponseSchema = z.object({
  requirementId: z.string().nullable(),
  versions: z.array(runtimeRequirementVersionSchema),
});
```

`snapshot` semantics: for `create`/`update`/`revert` it is the requirement state
*after* the change; for `delete` it is the item state at deletion (what was removed),
so history retains the deleted content.

## 2. Pure functions — `src/core/requirement-versions.ts` (TDD)

All pure, `now` injectable (default `Date.now()`), no uuid needed (identity is
`requirementId` + `version`).

- `nextRequirementVersionNumber(versions, requirementId): number`
  — max existing `version` for that id + 1, else 1.
- `appendRequirementVersion(versions, input): { data: RuntimeRequirementVersionsData; version: number }`
  where `input = { requirementId, snapshot, changeKind, source, reason?, now? }`.
- `listRequirementVersions(versions, requirementId): RuntimeRequirementVersion[]`
  — filtered by id, sorted by `version` ascending.
- `findRequirementVersion(versions, requirementId, version): RuntimeRequirementVersion | null`.
- `revertRequirementToVersion(data, versions, requirementId, version, opts): { data, versions, requirement }`
  where `opts = { source, now?, reason? }`. Restores the target version's snapshot
  fields onto the **currently existing** requirement item (bumping `updatedAt = now`,
  preserving `id`/`createdAt`/`order`/`linkedTaskIds` as appropriate), then appends a
  `changeKind: "revert"` version (default `reason = "Reverted to version <version>"`).
  Throws if the requirement is not in `data.items`, or the target version does not
  exist for that id.

Tests: `test/runtime/requirement-versions.test.ts`, mirroring the describe/it +
fixed `now`/inputs style of `test/runtime/requirement-mutations.test.ts`. Cover:
numbering from empty + monotonic per id; append for each changeKind; list filter +
sort; find hit/miss; revert happy path (restores fields, appends revert version,
new monotonic number); revert throws on unknown requirement and unknown version.

## 3. Persistence — `src/state/workspace-state.ts`

- New constant `REQUIREMENT_VERSIONS_FILENAME = "requirement-versions.json"` +
  `getWorkspaceRequirementVersionsPath(workspaceId)`.
- New `readWorkspaceRequirementVersions(workspaceId)` using
  `parsePersistedStateFile(..., runtimeRequirementVersionsDataSchema, { versions: [] })`.
- New exported `loadWorkspaceRequirementVersions(cwd): Promise<RuntimeRequirementVersionsData>`
  (resolves context, reads file) for the read endpoint.
- `mutateWorkspaceState`:
  - Read `currentRequirementVersions` inside the locked section.
  - Pass it to the mutate callback as a second argument:
    `mutate(currentState, { requirementVersions })`.
  - Extend `RuntimeWorkspaceAtomicMutationResult<T>` with optional
    `requirementVersions?: RuntimeRequirementVersionsData`.
  - Resolve `nextRequirementVersions = mutation.requirementVersions ?? currentRequirementVersions`
    and always write it atomically (same pattern as requirements). Honor the
    existing `save === false` early-return.
- `saveWorkspaceState`: unchanged (it never writes the versions file → preserved).

## 4. CLI write path carries `source`

- `src/commands/runtime-workspace.ts`: `updateRuntimeWorkspaceState`'s callback gains
  the second arg `{ requirementVersions }`, forwarded from `mutateWorkspaceState`;
  `RuntimeWorkspaceMutationResult<T>` gains optional `requirementVersions`. Existing
  callers (e.g. `task.ts`) ignore the extra arg — backward compatible.
- `src/commands/requirement.ts` create/update/delete callbacks: after computing the
  requirements result, call `appendRequirementVersion(currentVersions, { snapshot,
  changeKind, source: "human", now })` and return `requirementVersions`. `delete`
  uses the removed item as `snapshot`.

## 5. Read endpoint — `workspace.getRequirementVersions`

- `src/trpc/workspace-api.ts`: add `loadRequirementVersions(scope, input)` →
  `loadWorkspaceRequirementVersions(scope.workspacePath)`, filter by
  `input.requirementId` when present, return `{ requirementId, versions }`.
- `src/trpc/app-router.ts`: add the method to the `workspaceApi` interface, and a
  `workspace.getRequirementVersions` `workspaceProcedure.input(...).output(...).query`.

## 6. CLI commands — `src/commands/requirement.ts`

- `requirement history --id <id> [--project-path]`:
  call `runtimeClient.workspace.getRequirementVersions.query({ requirementId })`;
  print `{ ok, workspacePath, requirementId, versions, count }`.
- `requirement revert --id <id> --version <ver> [--project-path]`:
  parse `--version` to a positive integer (reject otherwise); in the mutate callback
  use `revertRequirementToVersion(state.requirements, requirementVersions, id, ver,
  { source: "human", now })`; print `{ ok, workspacePath, requirement,
  revertedToVersion, newVersion }`. Errors flow through the existing
  `runRequirementCommand` JSON error envelope.

## Testing

- Unit (TDD): `test/runtime/requirement-versions.test.ts` for all pure functions.
- Integration: extend `test/.../workspace-state.integration.test.ts` — versions
  round-trip; old workspace (no versions file) defaults to empty; a `saveWorkspaceState`
  call leaves an existing versions file intact.
- Manual: end-to-end CLI create → history → update → history → revert → history
  against a live runtime.

## Files touched

- `src/core/api-contract.ts` (schemas/types)
- `src/core/requirement-versions.ts` (new, pure)
- `test/runtime/requirement-versions.test.ts` (new)
- `src/state/workspace-state.ts` (persistence)
- `src/commands/runtime-workspace.ts` (callback plumbing)
- `src/commands/requirement.ts` (source on writes + history/revert commands)
- `src/trpc/workspace-api.ts`, `src/trpc/app-router.ts` (read endpoint)
- integration test for workspace-state
