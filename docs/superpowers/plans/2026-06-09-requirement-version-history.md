# Requirement Version History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give workspace-scoped requirement items a version history (snapshot + metadata) recorded on every create/update/delete, with CLI `history` and `revert`, persisted parallel to existing requirements data.

**Architecture:** A new `requirement-versions.json` file sits beside `board.json` / `requirements.json` per workspace. Versions are appended explicitly at the CLI mutation call site (caller supplies `source`), written through `mutateWorkspaceState`; the web-ui save path is untouched and naturally preserves the file. CLI reads history via a dedicated `workspace.getRequirementVersions` tRPC query, kept out of `getState` so it never rides the web-ui sync snapshot.

**Tech Stack:** TypeScript, Zod (api-contract schemas), tRPC, commander (CLI), vitest (`bun vitest run`), biome.

Spec: `docs/superpowers/specs/2026-06-09-requirement-version-history-design.md`

Repo rules: no `any`; reuse existing schemas/types; top-level imports only; **do not commit unless the user asks** (the AGENTS.md rule overrides the per-task `git commit` steps below — treat those steps as "stage + verify clean", and only commit when the user requests it).

---

## File Structure

- `src/core/api-contract.ts` — add version Zod schemas/types + read endpoint request/response schemas.
- `src/core/requirement-versions.ts` — **new** pure version logic (append / list / find / next-number / revert).
- `test/runtime/requirement-versions.test.ts` — **new** TDD unit tests for the pure functions.
- `src/state/workspace-state.ts` — persist/read `requirement-versions.json`; thread current versions into `mutateWorkspaceState`'s callback.
- `src/commands/runtime-workspace.ts` — forward the versions context + result field through `updateRuntimeWorkspaceState`.
- `src/commands/requirement.ts` — append versions (source `human`) on create/update/delete; add `history` + `revert` commands.
- `src/trpc/workspace-api.ts` + `src/trpc/app-router.ts` — `getRequirementVersions` read endpoint.
- `test/integration/workspace-state.integration.test.ts` — versions round-trip + board-save preservation.

---

## Task 1: Version schemas in api-contract

**Files:**
- Modify: `src/core/api-contract.ts` (insert after `runtimeRequirementsDataSchema`, currently line 175)

- [ ] **Step 1: Add schemas + types**

Insert immediately after the `runtimeRequirementsDataSchema` / `RuntimeRequirementsData` block (line 175):

```ts
export const runtimeRequirementChangeSourceSchema = z.enum(["human", "agent"]);
export type RuntimeRequirementChangeSource = z.infer<typeof runtimeRequirementChangeSourceSchema>;

export const runtimeRequirementChangeKindSchema = z.enum(["create", "update", "delete", "revert"]);
export type RuntimeRequirementChangeKind = z.infer<typeof runtimeRequirementChangeKindSchema>;

export const runtimeRequirementVersionSchema = z.object({
	requirementId: z.string(),
	version: z.number().int().positive(),
	changeKind: runtimeRequirementChangeKindSchema,
	snapshot: runtimeRequirementItemSchema,
	source: runtimeRequirementChangeSourceSchema,
	reason: z.string().nullable().default(null),
	createdAt: z.number(),
});
export type RuntimeRequirementVersion = z.infer<typeof runtimeRequirementVersionSchema>;

export const runtimeRequirementVersionsDataSchema = z.object({
	versions: z.array(runtimeRequirementVersionSchema).default([]),
});
export type RuntimeRequirementVersionsData = z.infer<typeof runtimeRequirementVersionsDataSchema>;

export const runtimeRequirementVersionsRequestSchema = z.object({
	requirementId: z.string().optional(),
});
export type RuntimeRequirementVersionsRequest = z.infer<typeof runtimeRequirementVersionsRequestSchema>;

export const runtimeRequirementVersionsResponseSchema = z.object({
	requirementId: z.string().nullable(),
	versions: z.array(runtimeRequirementVersionSchema),
});
export type RuntimeRequirementVersionsResponse = z.infer<typeof runtimeRequirementVersionsResponseSchema>;
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors). The new symbols are unused so far — that is fine.

- [ ] **Step 3: Commit** (stage only unless user asked to commit)

```bash
git add src/core/api-contract.ts
git commit -m "feat(requirements): add requirement version Zod schemas"
```

---

## Task 2: Pure version logic (TDD)

**Files:**
- Create: `src/core/requirement-versions.ts`
- Test: `test/runtime/requirement-versions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/requirement-versions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { RuntimeRequirementItem, RuntimeRequirementVersionsData, RuntimeRequirementsData } from "../../src/core/api-contract";
import {
	appendRequirementVersion,
	findRequirementVersion,
	listRequirementVersions,
	nextRequirementVersionNumber,
	revertRequirementToVersion,
} from "../../src/core/requirement-versions";

function emptyVersions(): RuntimeRequirementVersionsData {
	return { versions: [] };
}

function makeItem(overrides: Partial<RuntimeRequirementItem> = {}): RuntimeRequirementItem {
	return {
		id: "aaaaa",
		title: "Phone login",
		description: "",
		priority: "medium",
		status: "draft",
		linkedTaskIds: [],
		order: 0,
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

describe("nextRequirementVersionNumber", () => {
	it("starts at 1 and increments per requirement id", () => {
		const empty = emptyVersions();
		expect(nextRequirementVersionNumber(empty, "aaaaa")).toBe(1);

		const after = appendRequirementVersion(empty, {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "create",
			source: "human",
			now: 1000,
		}).data;
		expect(nextRequirementVersionNumber(after, "aaaaa")).toBe(2);
		expect(nextRequirementVersionNumber(after, "bbbbb")).toBe(1);
	});
});

describe("appendRequirementVersion", () => {
	it("appends a version with monotonic numbering and null default reason", () => {
		const first = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: makeItem(),
			changeKind: "create",
			source: "human",
			now: 1000,
		});
		expect(first.version).toMatchObject({
			requirementId: "aaaaa",
			version: 1,
			changeKind: "create",
			source: "human",
			reason: null,
			createdAt: 1000,
		});

		const second = appendRequirementVersion(first.data, {
			requirementId: "aaaaa",
			snapshot: makeItem({ title: "Phone login v2" }),
			changeKind: "update",
			source: "agent",
			reason: "tweaked",
			now: 2000,
		});
		expect(second.version.version).toBe(2);
		expect(second.version.reason).toBe("tweaked");
		expect(second.data.versions.map((v) => v.version)).toEqual([1, 2]);
	});
});

describe("listRequirementVersions", () => {
	it("filters by id and sorts by version ascending", () => {
		let data = emptyVersions();
		data = appendRequirementVersion(data, { requirementId: "bbbbb", snapshot: makeItem({ id: "bbbbb" }), changeKind: "create", source: "human", now: 1 }).data;
		data = appendRequirementVersion(data, { requirementId: "aaaaa", snapshot: makeItem(), changeKind: "create", source: "human", now: 2 }).data;
		data = appendRequirementVersion(data, { requirementId: "aaaaa", snapshot: makeItem(), changeKind: "update", source: "human", now: 3 }).data;

		expect(listRequirementVersions(data, "aaaaa").map((v) => v.version)).toEqual([1, 2]);
		expect(listRequirementVersions(data, "bbbbb").map((v) => v.version)).toEqual([1]);
		expect(listRequirementVersions(data, "zzzzz")).toEqual([]);
	});
});

describe("findRequirementVersion", () => {
	it("returns the matching version or null", () => {
		const data = appendRequirementVersion(emptyVersions(), { requirementId: "aaaaa", snapshot: makeItem(), changeKind: "create", source: "human", now: 1 }).data;
		expect(findRequirementVersion(data, "aaaaa", 1)?.changeKind).toBe("create");
		expect(findRequirementVersion(data, "aaaaa", 2)).toBeNull();
		expect(findRequirementVersion(data, "zzzzz", 1)).toBeNull();
	});
});

describe("revertRequirementToVersion", () => {
	function seed(): { data: RuntimeRequirementsData; versions: RuntimeRequirementVersionsData } {
		const v1 = appendRequirementVersion(emptyVersions(), {
			requirementId: "aaaaa",
			snapshot: makeItem({ title: "Original", priority: "low", status: "draft" }),
			changeKind: "create",
			source: "human",
			now: 1000,
		});
		const current = makeItem({ title: "Changed", priority: "urgent", status: "active", updatedAt: 2000 });
		const v2 = appendRequirementVersion(v1.data, {
			requirementId: "aaaaa",
			snapshot: current,
			changeKind: "update",
			source: "human",
			now: 2000,
		});
		return { data: { items: [current] }, versions: v2.data };
	}

	it("restores snapshot fields, preserves identity, and records a revert version", () => {
		const { data, versions } = seed();
		const result = revertRequirementToVersion(data, versions, "aaaaa", 1, { source: "human", now: 3000 });

		expect(result.requirement).toMatchObject({
			id: "aaaaa",
			title: "Original",
			priority: "low",
			status: "draft",
			createdAt: 1000,
			updatedAt: 3000,
		});
		expect(result.data.items[0]?.title).toBe("Original");

		const history = listRequirementVersions(result.versions, "aaaaa");
		expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
		expect(history[2]).toMatchObject({ changeKind: "revert", source: "human", reason: "Reverted to version 1" });
		expect(history[2]?.snapshot.title).toBe("Original");
	});

	it("throws when the requirement does not currently exist", () => {
		const { versions } = seed();
		expect(() => revertRequirementToVersion({ items: [] }, versions, "aaaaa", 1, { source: "human", now: 3000 })).toThrow(/not found/i);
	});

	it("throws when the target version does not exist", () => {
		const { data, versions } = seed();
		expect(() => revertRequirementToVersion(data, versions, "aaaaa", 99, { source: "human", now: 3000 })).toThrow(/version/i);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun vitest run test/runtime/requirement-versions.test.ts`
Expected: FAIL — cannot resolve `../../src/core/requirement-versions` (module does not exist yet).

- [ ] **Step 3: Implement the pure functions**

Create `src/core/requirement-versions.ts`:

```ts
import type {
	RuntimeRequirementChangeKind,
	RuntimeRequirementChangeSource,
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementVersion,
	RuntimeRequirementVersionsData,
} from "./api-contract";

export interface AppendRequirementVersionInput {
	requirementId: string;
	snapshot: RuntimeRequirementItem;
	changeKind: RuntimeRequirementChangeKind;
	source: RuntimeRequirementChangeSource;
	reason?: string | null;
	now?: number;
}

export interface AppendRequirementVersionResult {
	data: RuntimeRequirementVersionsData;
	version: RuntimeRequirementVersion;
}

export interface RevertRequirementOptions {
	source: RuntimeRequirementChangeSource;
	now?: number;
	reason?: string | null;
}

export interface RevertRequirementResult {
	data: RuntimeRequirementsData;
	versions: RuntimeRequirementVersionsData;
	requirement: RuntimeRequirementItem;
}

export function nextRequirementVersionNumber(data: RuntimeRequirementVersionsData, requirementId: string): number {
	let max = 0;
	for (const version of data.versions) {
		if (version.requirementId === requirementId && version.version > max) {
			max = version.version;
		}
	}
	return max + 1;
}

export function appendRequirementVersion(
	data: RuntimeRequirementVersionsData,
	input: AppendRequirementVersionInput,
): AppendRequirementVersionResult {
	const now = input.now ?? Date.now();
	const version: RuntimeRequirementVersion = {
		requirementId: input.requirementId,
		version: nextRequirementVersionNumber(data, input.requirementId),
		changeKind: input.changeKind,
		snapshot: input.snapshot,
		source: input.source,
		reason: input.reason ?? null,
		createdAt: now,
	};
	return {
		data: { ...data, versions: [...data.versions, version] },
		version,
	};
}

export function listRequirementVersions(
	data: RuntimeRequirementVersionsData,
	requirementId: string,
): RuntimeRequirementVersion[] {
	return data.versions
		.filter((version) => version.requirementId === requirementId)
		.sort((left, right) => left.version - right.version);
}

export function findRequirementVersion(
	data: RuntimeRequirementVersionsData,
	requirementId: string,
	version: number,
): RuntimeRequirementVersion | null {
	return data.versions.find((entry) => entry.requirementId === requirementId && entry.version === version) ?? null;
}

export function revertRequirementToVersion(
	data: RuntimeRequirementsData,
	versions: RuntimeRequirementVersionsData,
	requirementId: string,
	version: number,
	options: RevertRequirementOptions,
): RevertRequirementResult {
	const now = options.now ?? Date.now();
	const existing = data.items.find((item) => item.id === requirementId);
	if (!existing) {
		throw new Error(`Requirement "${requirementId}" was not found.`);
	}
	const target = findRequirementVersion(versions, requirementId, version);
	if (!target) {
		throw new Error(`Version ${version} was not found for requirement "${requirementId}".`);
	}
	const reverted: RuntimeRequirementItem = {
		...existing,
		title: target.snapshot.title,
		description: target.snapshot.description,
		priority: target.snapshot.priority,
		status: target.snapshot.status,
		updatedAt: now,
	};
	const nextData: RuntimeRequirementsData = {
		...data,
		items: data.items.map((item) => (item.id === requirementId ? reverted : item)),
	};
	const appended = appendRequirementVersion(versions, {
		requirementId,
		snapshot: reverted,
		changeKind: "revert",
		source: options.source,
		reason: options.reason ?? `Reverted to version ${version}`,
		now,
	});
	return {
		data: nextData,
		versions: appended.data,
		requirement: reverted,
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun vitest run test/runtime/requirement-versions.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit** (stage only unless user asked to commit)

```bash
git add src/core/requirement-versions.ts test/runtime/requirement-versions.test.ts
git commit -m "feat(requirements): pure requirement version logic (append/list/find/revert)"
```

---

## Task 3: Persist requirement-versions.json + thread into mutateWorkspaceState

**Files:**
- Modify: `src/state/workspace-state.ts`

- [ ] **Step 1: Add the import + filename + path helper**

In the `../core/api-contract` import block (lines 8-20), add the type `RuntimeRequirementVersionsData` and the value `runtimeRequirementVersionsDataSchema`:

```ts
	type RuntimeRequirementVersionsData,
```
(add alongside the other `type ...` entries) and:
```ts
	runtimeRequirementVersionsDataSchema,
```
(add alongside the other schema value imports).

After `const REQUIREMENTS_FILENAME = "requirements.json";` (line 31) add:
```ts
const REQUIREMENT_VERSIONS_FILENAME = "requirement-versions.json";
```

After `getWorkspaceRequirementsPath` (lines 191-193) add:
```ts
function getWorkspaceRequirementVersionsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), REQUIREMENT_VERSIONS_FILENAME);
}
```

- [ ] **Step 2: Add the reader functions**

After `readWorkspaceRequirements` (lines 319-325) add:
```ts
async function readWorkspaceRequirementVersions(workspaceId: string): Promise<RuntimeRequirementVersionsData> {
	const versionsPath = getWorkspaceRequirementVersionsPath(workspaceId);
	const rawVersions = await readJsonFile(versionsPath);
	return parsePersistedStateFile(
		versionsPath,
		REQUIREMENT_VERSIONS_FILENAME,
		rawVersions,
		runtimeRequirementVersionsDataSchema,
		{ versions: [] },
	);
}

export async function loadWorkspaceRequirementVersions(cwd: string): Promise<RuntimeRequirementVersionsData> {
	const context = await loadWorkspaceContext(cwd);
	return await readWorkspaceRequirementVersions(context.workspaceId);
}
```

- [ ] **Step 3: Extend the mutation result type + callback context**

Replace the `RuntimeWorkspaceAtomicMutationResult<T>` interface (lines 711-717) with:
```ts
export interface RuntimeWorkspaceAtomicMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	requirements?: RuntimeRequirementsData;
	requirementVersions?: RuntimeRequirementVersionsData;
	value: T;
	save?: boolean;
}

export interface RuntimeWorkspaceMutationContext {
	requirementVersions: RuntimeRequirementVersionsData;
}
```

- [ ] **Step 4: Read current versions, pass to callback, write them back**

In `mutateWorkspaceState` (lines 725-780), change the signature so `mutate` takes a second arg:
```ts
export async function mutateWorkspaceState<T>(
	cwd: string,
	mutate: (
		state: RuntimeWorkspaceStateResponse,
		context: RuntimeWorkspaceMutationContext,
	) => RuntimeWorkspaceAtomicMutationResult<T>,
): Promise<RuntimeWorkspaceAtomicMutationResponse<T>> {
```

After `const currentRequirements = await readWorkspaceRequirements(context.workspaceId);` (line 733) add:
```ts
		const currentRequirementVersions = await readWorkspaceRequirementVersions(context.workspaceId);
```

Change the mutate call (line 743) to pass the context:
```ts
		const mutation = mutate(currentState, { requirementVersions: currentRequirementVersions });
```

After `const nextRequirements = mutation.requirements ?? currentRequirements;` (line 754) add:
```ts
		const nextRequirementVersions = mutation.requirementVersions ?? currentRequirementVersions;
```

After the requirements atomic write (lines 767-769) add a versions write:
```ts
		await lockedFileSystem.writeJsonFileAtomic(
			getWorkspaceRequirementVersionsPath(context.workspaceId),
			nextRequirementVersions,
			{ lock: null },
		);
```

(`saveWorkspaceState` is intentionally left unchanged — it never writes the versions file, so it is preserved.)

- [ ] **Step 5: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS. (If `task.ts` callbacks error, they should not — they use `(state) =>` and ignoring the extra param is allowed. Fix only genuine type errors.)

- [ ] **Step 6: Commit** (stage only unless user asked to commit)

```bash
git add src/state/workspace-state.ts
git commit -m "feat(requirements): persist requirement-versions.json via mutateWorkspaceState"
```

---

## Task 4: Forward versions through updateRuntimeWorkspaceState

**Files:**
- Modify: `src/commands/runtime-workspace.ts`

- [ ] **Step 1: Import the new types**

In the `../core/api-contract` import (lines 3-8) add:
```ts
	RuntimeRequirementVersionsData,
```
In the `../state/workspace-state` import (line 11) add `RuntimeWorkspaceMutationContext`:
```ts
import { loadWorkspaceContext, mutateWorkspaceState, type RuntimeWorkspaceMutationContext } from "../state/workspace-state";
```

- [ ] **Step 2: Add the result field + forward the context**

Replace `RuntimeWorkspaceMutationResult<T>` (lines 80-85) with:
```ts
export interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	requirements?: RuntimeRequirementsData;
	requirementVersions?: RuntimeRequirementVersionsData;
	value: T;
}
```

Replace `updateRuntimeWorkspaceState` (lines 87-107) with:
```ts
export async function updateRuntimeWorkspaceState<T>(
	runtimeClient: RuntimeTrpcClient,
	workspaceRepoPath: string,
	mutate: (
		state: RuntimeWorkspaceStateResponse,
		context: RuntimeWorkspaceMutationContext,
	) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state, context) => {
		const mutation = mutate(state, context);
		return {
			board: mutation.board,
			...(mutation.sessions !== undefined ? { sessions: mutation.sessions } : {}),
			...(mutation.requirements !== undefined ? { requirements: mutation.requirements } : {}),
			...(mutation.requirementVersions !== undefined ? { requirementVersions: mutation.requirementVersions } : {}),
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit** (stage only unless user asked to commit)

```bash
git add src/commands/runtime-workspace.ts
git commit -m "feat(requirements): forward requirement versions through updateRuntimeWorkspaceState"
```

---

## Task 5: getRequirementVersions read endpoint

**Files:**
- Modify: `src/trpc/workspace-api.ts`
- Modify: `src/trpc/app-router.ts`

- [ ] **Step 1: Add the workspace-api method**

In `src/trpc/workspace-api.ts`, add to the `../core/api-contract` type import (lines 3-13):
```ts
	RuntimeRequirementVersionsRequest,
	RuntimeRequirementVersionsResponse,
```
Add `loadWorkspaceRequirementVersions` to the `../state/workspace-state` import (line 19):
```ts
import { loadWorkspaceRequirementVersions, saveWorkspaceState, WorkspaceStateConflictError } from "../state/workspace-state";
```

Inside the object returned by `createWorkspaceApi` (after `loadState`, around line 359), add:
```ts
		loadRequirementVersions: async (workspaceScope, input) => {
			const data = await loadWorkspaceRequirementVersions(workspaceScope.workspacePath);
			const requirementId = input.requirementId?.trim() ? input.requirementId.trim() : null;
			const versions = requirementId
				? data.versions.filter((version) => version.requirementId === requirementId)
				: data.versions;
			return {
				requirementId,
				versions,
			} satisfies RuntimeRequirementVersionsResponse;
		},
```

Note the `input` parameter type is inferred from the `workspaceApi` interface (Step 2). If TS needs an explicit annotation, type it `(workspaceScope, input: RuntimeRequirementVersionsRequest)`.

- [ ] **Step 2: Declare it on the workspaceApi interface**

In `src/trpc/app-router.ts`, add to the `../core/api-contract` type imports (the block ending at line 98):
```ts
	RuntimeRequirementVersionsRequest,
	RuntimeRequirementVersionsResponse,
```
and to the schema value imports (near lines 183-184):
```ts
	runtimeRequirementVersionsRequestSchema,
	runtimeRequirementVersionsResponseSchema,
```

In the `workspaceApi` interface, after `loadState` (line 337) add:
```ts
		loadRequirementVersions: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRequirementVersionsRequest,
		) => Promise<RuntimeRequirementVersionsResponse>;
```

- [ ] **Step 3: Register the procedure**

In the `workspace: t.router({ ... })` block, after the `getState` procedure (lines 657-659) add:
```ts
		getRequirementVersions: workspaceProcedure
			.input(runtimeRequirementVersionsRequestSchema)
			.output(runtimeRequirementVersionsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadRequirementVersions(ctx.workspaceScope, input);
			}),
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** (stage only unless user asked to commit)

```bash
git add src/trpc/workspace-api.ts src/trpc/app-router.ts
git commit -m "feat(requirements): add workspace.getRequirementVersions tRPC query"
```

---

## Task 6: CLI create/update/delete record versions with source

**Files:**
- Modify: `src/commands/requirement.ts`

- [ ] **Step 1: Import the append helper**

After the existing `requirement-mutations` import (line 8) add:
```ts
import { appendRequirementVersion } from "../core/requirement-versions";
```

- [ ] **Step 2: Record a version on create**

In `createRequirementCommand`, replace the `updateRuntimeWorkspaceState` callback (lines 114-130) with:
```ts
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state, { requirementVersions }) => {
		const result = addRequirement(
			state.requirements,
			{
				title: input.title,
				description: input.description,
				priority: input.priority,
				status: input.status,
			},
			() => globalThis.crypto.randomUUID(),
		);
		const appended = appendRequirementVersion(requirementVersions, {
			requirementId: result.requirement.id,
			snapshot: result.requirement,
			changeKind: "create",
			source: "human",
		});
		return {
			board: state.board,
			requirements: result.data,
			requirementVersions: appended.data,
			value: result.requirement,
		};
	});
```

- [ ] **Step 3: Record a version on update**

In `updateRequirementCommand`, replace the callback (lines 161-176) with:
```ts
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state, { requirementVersions }) => {
		const result = updateRequirement(state.requirements, input.id, {
			title: input.title,
			description: input.description,
			priority: input.priority,
			status: input.status,
		});
		if (!result.updated || !result.requirement) {
			throw new Error(`Requirement "${input.id}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const appended = appendRequirementVersion(requirementVersions, {
			requirementId: result.requirement.id,
			snapshot: result.requirement,
			changeKind: "update",
			source: "human",
		});
		return {
			board: state.board,
			requirements: result.data,
			requirementVersions: appended.data,
			value: formatRequirementRecord(result.requirement),
		};
	});
```

- [ ] **Step 4: Record a version on delete**

In `deleteRequirementCommand`, replace the callback (lines 191-201) with:
```ts
	const removed = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state, { requirementVersions }) => {
		const result = deleteRequirement(state.requirements, input.id);
		if (!result.deleted || !result.requirement) {
			throw new Error(`Requirement "${input.id}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const appended = appendRequirementVersion(requirementVersions, {
			requirementId: result.requirement.id,
			snapshot: result.requirement,
			changeKind: "delete",
			source: "human",
		});
		return {
			board: state.board,
			requirements: result.data,
			requirementVersions: appended.data,
			value: formatRequirementRecord(result.requirement),
		};
	});
```

- [ ] **Step 5: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit** (stage only unless user asked to commit)

```bash
git add src/commands/requirement.ts
git commit -m "feat(requirements): record human versions on CLI create/update/delete"
```

---

## Task 7: CLI history + revert commands

**Files:**
- Modify: `src/commands/requirement.ts`

- [ ] **Step 1: Import revert helper + add version parser + formatter**

Update the `requirement-versions` import added in Task 6 to:
```ts
import { appendRequirementVersion, revertRequirementToVersion } from "../core/requirement-versions";
```
Also import the version type from api-contract — add `RuntimeRequirementVersion` to the existing `../core/api-contract` type import (lines 3-7):
```ts
	RuntimeRequirementVersion,
```

After `parseStatus` (ends line 42) add a version parser and a version formatter:
```ts
function parseVersionNumber(value: string): number {
	const trimmed = value.trim();
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
		throw new Error(`Invalid version "${value}". Expected a positive integer.`);
	}
	return parsed;
}

function formatVersionRecord(version: RuntimeRequirementVersion): JsonRecord {
	return {
		requirementId: version.requirementId,
		version: version.version,
		changeKind: version.changeKind,
		source: version.source,
		reason: version.reason,
		createdAt: version.createdAt,
		snapshot: formatRequirementRecord(version.snapshot),
	};
}
```

- [ ] **Step 2: Add the history + revert handlers**

After `deleteRequirementCommand` (ends line 208) add:
```ts
async function listRequirementHistory(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const response = await runtimeClient.workspace.getRequirementVersions.query({ requirementId: input.id });
	const versions = [...response.versions]
		.sort((left, right) => left.version - right.version)
		.map(formatVersionRecord);
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		requirementId: input.id,
		versions,
		count: versions.length,
	};
}

async function revertRequirementCommand(input: {
	cwd: string;
	id: string;
	version: number;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const reverted = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state, { requirementVersions }) => {
		const result = revertRequirementToVersion(state.requirements, requirementVersions, input.id, input.version, {
			source: "human",
		});
		const latest = result.versions.versions[result.versions.versions.length - 1];
		return {
			board: state.board,
			requirements: result.data,
			requirementVersions: result.versions,
			value: {
				requirement: formatRequirementRecord(result.requirement),
				revertedToVersion: input.version,
				newVersion: latest ? latest.version : null,
			},
		};
	});

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		...reverted,
	};
}
```

- [ ] **Step 3: Register the two commands**

In `registerRequirementCommand`, after the `delete` command registration (ends line 342, before the closing `}`) add:
```ts
	requirement
		.command("history")
		.description("List the version history of a requirement item.")
		.requiredOption("--id <id>", "Requirement ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await listRequirementHistory({
						cwd: process.cwd(),
						id: options.id,
						projectPath: options.projectPath,
					}),
			);
		});

	requirement
		.command("revert")
		.description("Revert a requirement item to a previous version (recorded as a new version).")
		.requiredOption("--id <id>", "Requirement ID.")
		.requiredOption("--version <number>", "Version number to revert to.", parseVersionNumber)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; version: number; projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await revertRequirementCommand({
						cwd: process.cwd(),
						id: options.id,
						version: options.version,
						projectPath: options.projectPath,
					}),
			);
		});
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** (stage only unless user asked to commit)

```bash
git add src/commands/requirement.ts
git commit -m "feat(requirements): add CLI requirement history + revert commands"
```

---

## Task 8: Integration test — round-trip + board-save preservation

**Files:**
- Modify: `test/integration/workspace-state.integration.test.ts`

- [ ] **Step 1: Add imports**

Add to the `../../src/core/api-contract` type import (line 7):
```ts
import type { RuntimeBoardData, RuntimeRequirementItem, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
```
Add to the `../../src/state/workspace-state` import (lines 9-17) the symbols `loadWorkspaceRequirementVersions` and `mutateWorkspaceState`:
```ts
	loadWorkspaceRequirementVersions,
	mutateWorkspaceState,
```
Add a new import for the append helper:
```ts
import { appendRequirementVersion } from "../../src/core/requirement-versions";
```

- [ ] **Step 2: Write the failing test**

Add this test inside the `describe.sequential("workspace-state integration", ...)` block, after the "preserves existing requirements" test (after line 236):
```ts
	it("records and preserves requirement versions independently of board saves", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-req-versions-");
			try {
				const workspacePath = join(sandboxRoot, "project-versions");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				// Old workspace: no versions file yet → empty.
				expect(await loadWorkspaceRequirementVersions(workspacePath)).toEqual({ versions: [] });

				const snapshot: RuntimeRequirementItem = {
					id: "req-1",
					title: "Phone login",
					description: "",
					priority: "high",
					status: "active",
					linkedTaskIds: [],
					order: 0,
					createdAt: 1000,
					updatedAt: 1000,
				};

				await mutateWorkspaceState(workspacePath, (state, { requirementVersions }) => {
					const appended = appendRequirementVersion(requirementVersions, {
						requirementId: "req-1",
						snapshot,
						changeKind: "create",
						source: "human",
						now: 1000,
					});
					return {
						board: state.board,
						requirements: { items: [snapshot] },
						requirementVersions: appended.data,
						value: null,
					};
				});

				const stored = await loadWorkspaceRequirementVersions(workspacePath);
				expect(stored.versions).toHaveLength(1);
				expect(stored.versions[0]).toMatchObject({
					requirementId: "req-1",
					version: 1,
					changeKind: "create",
					source: "human",
				});

				// A board-only saveWorkspaceState must NOT wipe the versions file.
				const current = await loadWorkspaceState(workspacePath);
				await saveWorkspaceState(workspacePath, {
					board: createBoard("Task Two"),
					sessions: {},
					expectedRevision: current.revision,
				});
				const afterSave = await loadWorkspaceRequirementVersions(workspacePath);
				expect(afterSave.versions).toHaveLength(1);
			} finally {
				cleanup();
			}
		});
	});
```

- [ ] **Step 3: Run the integration test**

Run: `bun vitest run test/integration/workspace-state.integration.test.ts`
Expected: PASS (the new test plus all existing ones).

- [ ] **Step 4: Commit** (stage only unless user asked to commit)

```bash
git add test/integration/workspace-state.integration.test.ts
git commit -m "test(requirements): integration test for version round-trip + preservation"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the complete check suite**

Run: `npm run check`
Expected: PASS — biome (lint/format) clean, typecheck clean, all vitest suites green.

- [ ] **Step 2: Manual end-to-end (optional, against a live runtime)**

With the Kanban runtime running, from a registered git workspace:
```bash
kanban requirement create --title "Phone login" --priority high
# copy the returned id, e.g. abcde
kanban requirement history --id abcde            # → 1 version, changeKind "create"
kanban requirement update --id abcde --status active
kanban requirement history --id abcde            # → 2 versions
kanban requirement revert --id abcde --version 1 # → requirement restored, newVersion 3
kanban requirement history --id abcde            # → 3 versions, last changeKind "revert"
```
Expected: JSON envelopes with `ok: true`; history grows by one per mutating op; revert restores the version-1 snapshot fields and appends a `revert` version.

---

## Self-Review notes (already reconciled against the spec)

- Spec §1 data model → Task 1. §2 pure fns → Task 2 (TDD). §3 persistence → Task 3 (+ `saveWorkspaceState` deliberately untouched). §4 source on writes → Task 6. §5 read endpoint → Task 5. §6 CLI history/revert → Task 7. Testing → Tasks 2, 8, 9.
- Naming consistency verified across tasks: `appendRequirementVersion` / `revertRequirementToVersion` / `loadWorkspaceRequirementVersions` / `RuntimeWorkspaceMutationContext` / `getRequirementVersions` used identically everywhere.
- web-ui is intentionally not modified (deferred per the approved design); the versions file is preserved by the web-ui save path because `saveWorkspaceState` never writes it.
