# Task→Requirement Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Repo guardrail:** AGENTS.md says *never commit unless the user asks*. The commit steps below are part of the TDD rhythm — run them only once the user has authorized committing. Otherwise stop after the "tests pass" step of each task and leave the change staged/unstaged for review.

**Goal:** Add a two-phase Task→Requirement reconciliation capability (`requirement reconcile` / `requirement reconcile apply`) that finds tasks with no requirement link and, on an agent-decided plan, lands link/new-requirement suggestions in `proposed`/`draft` (never `confirmed`) state.

**Architecture:** A new pure module `src/core/requirement-reconcile.ts` provides `analyzeReconcile` (read-only packet), `reconcilePlanSchema` (zod), and `applyReconcilePlan` (mutates by reusing the existing `proposeLink` + `addRequirement` + version layer). Two CLI subcommands in `src/commands/requirement.ts` wire those into the runtime workspace, mirroring the existing `review` / `review apply` pair. The CLI embeds no LLM; the agent is the reasoner.

**Tech Stack:** TypeScript (strict, no `any`), zod, commander, vitest.

---

## File Structure

- **Create** `src/core/requirement-reconcile.ts` — pure analyze + schema + apply. Single responsibility: reconcile domain logic.
- **Create** `test/runtime/requirement-reconcile.test.ts` — unit tests for the module.
- **Modify** `src/commands/requirement.ts` — add two handlers + register `reconcile` / `reconcile apply`.

Reused (not modified): `proposeLink` (`src/core/requirement-task-link-mutations.ts`), `addRequirement` (`src/core/requirement-mutations.ts`), `appendRequirementVersion` (`src/core/requirement-versions.ts`), `updateRuntimeWorkspaceState` + workspace helpers (`src/commands/runtime-workspace.ts`).

---

## Task 1: Pure module — `analyzeReconcile`

**Files:**
- Create: `src/core/requirement-reconcile.ts`
- Test: `test/runtime/requirement-reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/runtime/requirement-reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumn,
	RuntimeBoardData,
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementVersionsData,
} from "../../src/core/api-contract";
import { analyzeReconcile } from "../../src/core/requirement-reconcile";

function card(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		id: overrides.id,
		title: overrides.title ?? `Card ${overrides.id}`,
		prompt: overrides.prompt ?? "do the thing",
		startInPlanMode: overrides.startInPlanMode ?? false,
		baseRef: overrides.baseRef ?? "main",
		createdAt: overrides.createdAt ?? 0,
		updatedAt: overrides.updatedAt ?? 0,
		...overrides,
	};
}

function column(id: RuntimeBoardColumn["id"], title: string, cards: RuntimeBoardCard[]): RuntimeBoardColumn {
	return { id, title, cards };
}

function boardOf(...columns: RuntimeBoardColumn[]): RuntimeBoardData {
	return { columns, dependencies: [] };
}

function requirement(overrides: Partial<RuntimeRequirementItem> & { id: string }): RuntimeRequirementItem {
	return {
		id: overrides.id,
		title: overrides.title ?? `Requirement ${overrides.id}`,
		description: overrides.description ?? "",
		priority: overrides.priority ?? "medium",
		status: overrides.status ?? "draft",
		linkedTaskIds: overrides.linkedTaskIds ?? [],
		order: overrides.order ?? 0,
		createdAt: overrides.createdAt ?? 0,
		updatedAt: overrides.updatedAt ?? 0,
	};
}

function requirementsOf(...items: RuntimeRequirementItem[]): RuntimeRequirementsData {
	return { items };
}

function link(overrides: Partial<RuntimeRequirementTaskLink> & { requirementId: string; taskId: string }): RuntimeRequirementTaskLink {
	return {
		requirementId: overrides.requirementId,
		taskId: overrides.taskId,
		status: overrides.status ?? "proposed",
		source: overrides.source ?? "agent",
		createdAt: overrides.createdAt ?? 0,
	};
}

function linksOf(...links: RuntimeRequirementTaskLink[]): RuntimeRequirementTaskLinksData {
	return { links };
}

function emptyVersions(): RuntimeRequirementVersionsData {
	return { versions: [] };
}

describe("analyzeReconcile", () => {
	it("reports cards with no link at all as orphans, across columns", () => {
		const board = boardOf(
			column("backlog", "Backlog", [card({ id: "card-1", title: "Auth flow", prompt: "build login" })]),
			column("in_progress", "In Progress", [card({ id: "card-2" })]),
		);
		const packet = analyzeReconcile(board, requirementsOf(requirement({ id: "req-1" })), linksOf());

		expect(packet.orphanTasks).toEqual([
			{ taskId: "card-1", title: "Auth flow", prompt: "build login", columnId: "backlog", columnTitle: "Backlog" },
			{ taskId: "card-2", title: "Card card-2", prompt: "do the thing", columnId: "in_progress", columnTitle: "In Progress" },
		]);
		expect(packet.requirementCatalog).toEqual([
			{ id: "req-1", title: "Requirement req-1", description: "", status: "draft", priority: "medium" },
		]);
		expect(packet.pendingProposed).toEqual([]);
	});

	it("excludes a card with a confirmed link from orphans", () => {
		const board = boardOf(column("backlog", "Backlog", [card({ id: "card-1" }), card({ id: "card-2" })]));
		const links = linksOf(link({ requirementId: "req-1", taskId: "card-1", status: "confirmed", source: "human" }));
		const packet = analyzeReconcile(board, requirementsOf(requirement({ id: "req-1" })), links);

		expect(packet.orphanTasks.map((t) => t.taskId)).toEqual(["card-2"]);
		expect(packet.pendingProposed).toEqual([]);
	});

	it("excludes a card with a proposed link from orphans and reports it under pendingProposed", () => {
		const board = boardOf(column("backlog", "Backlog", [card({ id: "card-1" }), card({ id: "card-2" })]));
		const links = linksOf(link({ requirementId: "req-1", taskId: "card-1", status: "proposed", source: "agent" }));
		const packet = analyzeReconcile(board, requirementsOf(requirement({ id: "req-1" })), links);

		expect(packet.orphanTasks.map((t) => t.taskId)).toEqual(["card-2"]);
		expect(packet.pendingProposed).toEqual([{ taskId: "card-1", requirementId: "req-1" }]);
	});

	it("returns empty arrays for an empty board and no requirements", () => {
		const packet = analyzeReconcile(boardOf(), requirementsOf(), linksOf());
		expect(packet).toEqual({ orphanTasks: [], requirementCatalog: [], pendingProposed: [] });
	});
});

export { card, column, boardOf, requirement, requirementsOf, link, linksOf, emptyVersions };
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/requirement-reconcile.test.ts`
Expected: FAIL — cannot find module `../../src/core/requirement-reconcile` (analyzeReconcile not defined).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/requirement-reconcile.ts`:

```ts
import type {
	RuntimeBoardData,
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementTaskLinksData,
} from "./api-contract";

// ---------------------------------------------------------------------------
// Analyze (phase 1): read-only reconcile packet for the agent to reason over.
// ---------------------------------------------------------------------------

export interface ReconcileOrphanTask {
	taskId: string;
	title: string;
	prompt: string;
	columnId: string;
	columnTitle: string;
}

export interface ReconcileRequirementSummary {
	id: string;
	title: string;
	description: string;
	status: RuntimeRequirementItem["status"];
	priority: RuntimeRequirementItem["priority"];
}

export interface ReconcilePendingLink {
	taskId: string;
	requirementId: string;
}

export interface ReconcilePacket {
	orphanTasks: ReconcileOrphanTask[];
	requirementCatalog: ReconcileRequirementSummary[];
	pendingProposed: ReconcilePendingLink[];
}

export function analyzeReconcile(
	board: RuntimeBoardData,
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
): ReconcilePacket {
	const linkedTaskIds = new Set(links.links.map((entry) => entry.taskId));
	const orphanTasks: ReconcileOrphanTask[] = [];
	for (const col of board.columns) {
		for (const card of col.cards) {
			if (linkedTaskIds.has(card.id)) {
				continue;
			}
			orphanTasks.push({
				taskId: card.id,
				title: card.title,
				prompt: card.prompt,
				columnId: col.id,
				columnTitle: col.title,
			});
		}
	}
	const requirementCatalog = requirements.items.map(
		(item): ReconcileRequirementSummary => ({
			id: item.id,
			title: item.title,
			description: item.description,
			status: item.status,
			priority: item.priority,
		}),
	);
	const pendingProposed = links.links
		.filter((entry) => entry.status === "proposed")
		.map((entry): ReconcilePendingLink => ({ taskId: entry.taskId, requirementId: entry.requirementId }));
	return { orphanTasks, requirementCatalog, pendingProposed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/requirement-reconcile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** *(only if the user has authorized committing)*

```bash
git add src/core/requirement-reconcile.ts test/runtime/requirement-reconcile.test.ts
git commit -m "feat(requirement-reconcile): pure analyze pass for orphan tasks"
```

---

## Task 2: Pure module — `reconcilePlanSchema`

**Files:**
- Modify: `src/core/requirement-reconcile.ts`
- Test: `test/runtime/requirement-reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/runtime/requirement-reconcile.test.ts` (add `reconcilePlanSchema` to the import from the module):

```ts
import { analyzeReconcile, reconcilePlanSchema } from "../../src/core/requirement-reconcile";

describe("reconcilePlanSchema", () => {
	it("accepts a valid link entry", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "matches req-1" }],
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts a valid create-draft entry", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [
				{
					action: "create-draft",
					taskId: "card-1",
					requirement: { title: "Offline sync", description: "...", priority: "high" },
					reason: "no requirement covers this",
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects an unknown action", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [{ action: "reassign", taskId: "card-1", requirementId: "req-1", reason: "x" }],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a create-draft entry that smuggles a status field", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [
				{
					action: "create-draft",
					taskId: "card-1",
					requirement: { title: "X", status: "active" },
					reason: "x",
				},
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an empty entries array", () => {
		const parsed = reconcilePlanSchema.safeParse({ entries: [] });
		expect(parsed.success).toBe(false);
	});

	it("rejects a link entry missing requirementId", () => {
		const parsed = reconcilePlanSchema.safeParse({
			entries: [{ action: "link", taskId: "card-1", reason: "x" }],
		});
		expect(parsed.success).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/requirement-reconcile.test.ts`
Expected: FAIL — `reconcilePlanSchema` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/core/requirement-reconcile.ts`:

```ts
import { z } from "zod";

import { runtimeRequirementPrioritySchema } from "./api-contract";
```

(Keep the existing `import type { ... } from "./api-contract"` block.)

Append to `src/core/requirement-reconcile.ts`:

```ts
// ---------------------------------------------------------------------------
// Apply (phase 2): execute an agent-decided reconcile plan.
// ---------------------------------------------------------------------------

const newDraftRequirementSchema = z
	.object({
		title: z.string().min(1),
		description: z.string().optional(),
		priority: runtimeRequirementPrioritySchema.optional(),
	})
	.strict();

const linkEntrySchema = z
	.object({
		action: z.literal("link"),
		taskId: z.string().min(1),
		requirementId: z.string().min(1),
		reason: z.string().min(1),
	})
	.strict();

const createDraftEntrySchema = z
	.object({
		action: z.literal("create-draft"),
		taskId: z.string().min(1),
		requirement: newDraftRequirementSchema,
		reason: z.string().min(1),
	})
	.strict();

export const reconcileEntrySchema = z.discriminatedUnion("action", [linkEntrySchema, createDraftEntrySchema]);
export type ReconcileEntry = z.infer<typeof reconcileEntrySchema>;

export const reconcilePlanSchema = z
	.object({
		entries: z.array(reconcileEntrySchema).min(1),
	})
	.strict();
export type ReconcilePlan = z.infer<typeof reconcilePlanSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/requirement-reconcile.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit** *(only if the user has authorized committing)*

```bash
git add src/core/requirement-reconcile.ts test/runtime/requirement-reconcile.test.ts
git commit -m "feat(requirement-reconcile): zod plan schema (link | create-draft)"
```

---

## Task 3: Pure module — `applyReconcilePlan`

**Files:**
- Modify: `src/core/requirement-reconcile.ts`
- Test: `test/runtime/requirement-reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Update the module import line in the test and append the describe block:

```ts
import { analyzeReconcile, applyReconcilePlan, reconcilePlanSchema } from "../../src/core/requirement-reconcile";

describe("applyReconcilePlan", () => {
	const deps = { randomUuid: () => "new-req-id", now: 5000 };

	it("turns a link entry into a proposed agent link with one version", () => {
		const result = applyReconcilePlan(
			requirementsOf(requirement({ id: "req-1" })),
			linksOf(),
			emptyVersions(),
			{ entries: [{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "matches" }] },
			deps,
		);

		expect(result.links.links).toEqual([
			{ requirementId: "req-1", taskId: "card-1", status: "proposed", source: "agent", createdAt: 5000 },
		]);
		expect(result.versions.versions).toHaveLength(1);
		expect(result.versions.versions[0]).toMatchObject({ requirementId: "req-1", source: "agent", changeKind: "update" });
		expect(result.report.summary).toEqual({ link: 1, createDraft: 0, versionsWritten: 1 });
		expect(result.report.entries).toEqual([
			{ action: "link", taskId: "card-1", requirementId: "req-1", why: "matches" },
		]);
	});

	it("creates a draft requirement and proposes a link for create-draft, writing two versions", () => {
		const result = applyReconcilePlan(
			requirementsOf(),
			linksOf(),
			emptyVersions(),
			{
				entries: [
					{
						action: "create-draft",
						taskId: "card-1",
						requirement: { title: "Offline sync", description: "sync offline", priority: "high" },
						reason: "uncovered",
					},
				],
			},
			deps,
		);

		const created = result.requirements.items.find((item) => item.id === "new-req-id");
		expect(created).toMatchObject({ title: "Offline sync", description: "sync offline", priority: "high", status: "draft" });
		expect(result.links.links).toEqual([
			{ requirementId: "new-req-id", taskId: "card-1", status: "proposed", source: "agent", createdAt: 5000 },
		]);
		const versions = result.versions.versions.filter((v) => v.requirementId === "new-req-id");
		expect(versions.map((v) => v.changeKind)).toEqual(["create", "update"]);
		expect(versions.every((v) => v.source === "agent")).toBe(true);
		expect(result.report.summary).toEqual({ link: 0, createDraft: 1, versionsWritten: 2 });
		expect(result.report.entries).toEqual([
			{ action: "create-draft", taskId: "card-1", requirementId: "new-req-id", why: "uncovered" },
		]);
	});

	it("threads state across multiple entries", () => {
		let counter = 0;
		const result = applyReconcilePlan(
			requirementsOf(requirement({ id: "req-1" })),
			linksOf(),
			emptyVersions(),
			{
				entries: [
					{ action: "link", taskId: "card-1", requirementId: "req-1", reason: "a" },
					{ action: "create-draft", taskId: "card-2", requirement: { title: "New thing" }, reason: "b" },
				],
			},
			{ randomUuid: () => `gen-${++counter}`, now: 7000 },
		);

		expect(result.links.links.map((l) => l.taskId).sort()).toEqual(["card-1", "card-2"]);
		expect(result.report.summary).toEqual({ link: 1, createDraft: 1, versionsWritten: 3 });
	});

	it("throws when a link entry targets a missing requirement", () => {
		expect(() =>
			applyReconcilePlan(
				requirementsOf(),
				linksOf(),
				emptyVersions(),
				{ entries: [{ action: "link", taskId: "card-1", requirementId: "missing", reason: "x" }] },
				deps,
			),
		).toThrow(/not found/i);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/requirement-reconcile.test.ts`
Expected: FAIL — `applyReconcilePlan` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the imports of `src/core/requirement-reconcile.ts`:

```ts
import { addRequirement } from "./requirement-mutations";
import { proposeLink } from "./requirement-task-link-mutations";
import { appendRequirementVersion } from "./requirement-versions";
```

Also add `RuntimeRequirementVersionsData` to the existing `import type { ... } from "./api-contract"` block.

Append to `src/core/requirement-reconcile.ts`:

```ts
export interface ApplyReconcilePlanDeps {
	randomUuid: () => string;
	now?: number;
}

export type ReconcileEntryReport =
	| { action: "link"; taskId: string; requirementId: string; why: string }
	| { action: "create-draft"; taskId: string; requirementId: string; why: string };

export interface ReconcileSummary {
	link: number;
	createDraft: number;
	versionsWritten: number;
}

export interface ReconcileReport {
	entries: ReconcileEntryReport[];
	summary: ReconcileSummary;
}

export interface ApplyReconcileResult {
	requirements: RuntimeRequirementsData;
	links: RuntimeRequirementTaskLinksData;
	versions: RuntimeRequirementVersionsData;
	report: ReconcileReport;
}

export function applyReconcilePlan(
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
	versions: RuntimeRequirementVersionsData,
	plan: ReconcilePlan,
	deps: ApplyReconcilePlanDeps,
): ApplyReconcileResult {
	const now = deps.now ?? Date.now();
	let requirementsData = requirements;
	let linksData = links;
	let versionsData = versions;
	const entries: ReconcileEntryReport[] = [];
	const summary: ReconcileSummary = { link: 0, createDraft: 0, versionsWritten: 0 };

	for (const entry of plan.entries) {
		if (entry.action === "link") {
			const result = proposeLink(requirementsData, linksData, versionsData, entry.requirementId, entry.taskId, {
				source: "agent",
				reason: entry.reason,
				now,
			});
			requirementsData = result.requirements;
			linksData = result.links;
			versionsData = result.versions;
			// proposeLink always appends exactly one version.
			summary.versionsWritten += 1;
			entries.push({ action: "link", taskId: entry.taskId, requirementId: entry.requirementId, why: entry.reason });
			summary.link += 1;
			continue;
		}

		// create-draft: status is forced to "draft" — the schema never lets the agent set it.
		const created = addRequirement(
			requirementsData,
			{
				title: entry.requirement.title,
				description: entry.requirement.description,
				priority: entry.requirement.priority,
				status: "draft",
			},
			deps.randomUuid,
			now,
		);
		requirementsData = created.data;
		versionsData = appendRequirementVersion(versionsData, {
			requirementId: created.requirement.id,
			snapshot: created.requirement,
			changeKind: "create",
			source: "agent",
			reason: entry.reason,
			now,
		}).data;
		summary.versionsWritten += 1;

		const linked = proposeLink(requirementsData, linksData, versionsData, created.requirement.id, entry.taskId, {
			source: "agent",
			reason: entry.reason,
			now,
		});
		requirementsData = linked.requirements;
		linksData = linked.links;
		versionsData = linked.versions;
		summary.versionsWritten += 1;

		entries.push({ action: "create-draft", taskId: entry.taskId, requirementId: created.requirement.id, why: entry.reason });
		summary.createDraft += 1;
	}

	return { requirements: requirementsData, links: linksData, versions: versionsData, report: { entries, summary } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/requirement-reconcile.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck the module**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms no `any`, all types resolve.)

- [ ] **Step 6: Commit** *(only if the user has authorized committing)*

```bash
git add src/core/requirement-reconcile.ts test/runtime/requirement-reconcile.test.ts
git commit -m "feat(requirement-reconcile): apply plan to proposed links + draft requirements"
```

---

## Task 4: CLI wiring — `requirement reconcile` / `reconcile apply`

**Files:**
- Modify: `src/commands/requirement.ts`

- [ ] **Step 1: Add the import**

In `src/commands/requirement.ts`, add this import (next to the existing `requirement-review` import on line 12):

```ts
import { analyzeReconcile, applyReconcilePlan, reconcilePlanSchema } from "../core/requirement-reconcile";
```

- [ ] **Step 2: Add the two handlers**

Add these functions after `applyRequirementReviewCommand` (before `runRequirementCommand`, ~line 424):

```ts
async function reconcileRequirements(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const packet = analyzeReconcile(state.board, state.requirements, state.requirementTaskLinks);
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		orphanTasks: packet.orphanTasks,
		requirementCatalog: packet.requirementCatalog,
		pendingProposed: packet.pendingProposed,
		orphanCount: packet.orphanTasks.length,
		requirementCount: packet.requirementCatalog.length,
	};
}

async function applyRequirementReconcileCommand(input: {
	cwd: string;
	planPath?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const raw = await readReviewPlanInput(input.planPath);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Reconcile plan is not valid JSON: ${toErrorMessage(error)}`);
	}
	const parsed = reconcilePlanSchema.safeParse(parsedJson);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
		throw new Error(`Invalid reconcile plan: ${issues}`);
	}
	const plan = parsed.data;

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const report = await updateRuntimeWorkspaceState(
		runtimeClient,
		workspaceRepoPath,
		(state, { requirementTaskLinks, requirementVersions }) => {
			const result = applyReconcilePlan(state.requirements, requirementTaskLinks, requirementVersions, plan, {
				randomUuid: () => globalThis.crypto.randomUUID(),
			});
			return {
				board: state.board,
				requirements: result.requirements,
				requirementTaskLinks: result.links,
				requirementVersions: result.versions,
				value: result.report,
			};
		},
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		entries: report.entries,
		summary: report.summary,
	};
}
```

- [ ] **Step 3: Register the subcommands**

In `registerRequirementCommand`, after the `review` / `review apply` block (after line ~606, before the `revert` command), add:

```ts
	const reconcile = requirement
		.command("reconcile")
		.description("Analyze tasks with no requirement link and emit a reconcile packet for an agent to reason over.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await reconcileRequirements({
						cwd: process.cwd(),
						projectPath: options.projectPath,
					}),
			);
		});

	reconcile
		.command("apply")
		.description("Apply an agent reconcile plan; links land as proposed and new requirements as draft (source=agent).")
		.option("--plan <file>", "Path to a JSON reconcile plan. Reads from stdin when omitted.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async function (this: Command) {
			const options = this.optsWithGlobals() as { plan?: string; projectPath?: string };
			await runRequirementCommand(
				async () =>
					await applyRequirementReconcileCommand({
						cwd: process.cwd(),
						planPath: options.plan,
						projectPath: options.projectPath,
					}),
			);
		});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint the touched files**

Run: `npm run lint` (or the repo's configured linter, e.g. `npx biome check src/core/requirement-reconcile.ts src/commands/requirement.ts`)
Expected: no errors on the changed files.

- [ ] **Step 6: Manual smoke (optional but recommended)**

With a workspace that has at least one unlinked card, run:

```bash
node dist/cli.js requirement reconcile --project-path /path/to/workspace
```

(Adjust to the repo's CLI entrypoint / `npm run` script.) Expected: JSON with `orphanTasks` populated and `ok: true`. Then pipe a small plan:

```bash
echo '{"entries":[{"action":"create-draft","taskId":"<card-id>","requirement":{"title":"Smoke"},"reason":"smoke"}]}' \
  | node dist/cli.js requirement reconcile apply --project-path /path/to/workspace
```

Expected: `ok: true`, `summary.createDraft: 1`; a follow-up `requirement reconcile` no longer lists that card as an orphan (it now has a proposed link) and shows it under `pendingProposed`.

- [ ] **Step 7: Run the full runtime test suite**

Run: `npx vitest run test/runtime`
Expected: PASS (including the new `requirement-reconcile.test.ts`).

- [ ] **Step 8: Commit** *(only if the user has authorized committing)*

```bash
git add src/commands/requirement.ts
git commit -m "feat(requirement-reconcile): wire reconcile + reconcile apply CLI subcommands"
```

---

## Self-Review notes

- **Spec coverage:** analyze packet (Task 1) ✓; orphan = no link at all + `pendingProposed` (Task 1) ✓; zod plan with `link` / `create-draft`, status structurally absent (Task 2) ✓; apply → proposed links + draft requirements, `source=agent`, version reuse (Task 3) ✓; CLI pair with `optsWithGlobals()` (Task 4) ✓; tests mirror `requirement-review.test.ts` (Tasks 1-3) ✓. Out-of-scope items (gate 5, web-ui, auto-confirm) intentionally have no tasks.
- **Type consistency:** module exports used by the CLI — `analyzeReconcile`, `applyReconcilePlan`, `reconcilePlanSchema`, and result fields `result.requirements` / `result.links` / `result.versions` / `result.report.{entries,summary}` — match across Tasks 1-4. The mutation callback writes `requirementTaskLinks` (the state/context field name confirmed in `runtime-workspace.ts:90`) from `result.links`.
- **Deviation from spec:** `analyzeReconcile` drops the unused `AnalyzeReconcileOptions { now? }` (YAGNI — reconcile has no time-based signal, unlike review's staleness). Signature is `(board, requirements, links)`.
