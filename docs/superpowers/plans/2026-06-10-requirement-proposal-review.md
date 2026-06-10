# Requirement Proposal Review Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a product-side review surface on the requirements side where a product owner can batch-accept/reject/re-attach the proposed task↔requirement links and draft requirements produced by coordination.

**Architecture:** All data rides the existing `useWorkspaceSync` → App state → `useWorkspacePersistence` save loop (the workspace stream already carries `requirementTaskLinks`; it just isn't wired on the web-ui side yet). A pure, fully-tested state helper replicates the core link-mirroring semantics; new presentational components live under `web-ui/src/components/requirements/review/`; a `List | Review` toggle in the Requirements header is the entry point. The Board UI is untouched.

**Tech Stack:** React + TypeScript, Tailwind v4, Radix UI (`@radix-ui/react-popover`), Lucide icons, Vitest + Testing Library (jsdom). Run tests with `npm run test`, types with `npm run typecheck` (both from `web-ui/`).

> **Commit note:** This repo's `AGENTS.md` says *never commit unless the user asks*. The `Commit` steps below are checkpoints — only run them once the user has approved committing. Otherwise leave the work staged/unstaged and move on.

---

## File Structure

- **Create** `web-ui/src/state/requirement-task-links-state.ts` — pure helpers: `confirmLink`, `rejectLink`, `reattachLink`, `selectPendingProposals`, plus the proposal/bucket types.
- **Create** `web-ui/src/state/requirement-task-links-state.test.ts` — unit tests for the above.
- **Create** `web-ui/src/components/requirements/review/requirement-review-panel.tsx` — the three-bucket batch view.
- **Create** `web-ui/src/components/requirements/review/link-proposal-row.tsx` — one proposed-link row (Accept / Reject / Re-attach), reused for the inbox bucket via a `variant`.
- **Create** `web-ui/src/components/requirements/review/draft-proposal-row.tsx` — one draft-requirement row (Accept / Reject) with a content preview via `ReadOnlyUnifiedDiff`.
- **Create** `web-ui/src/components/requirements/review/reattach-requirement-popover.tsx` — Radix popover with a searchable non-draft requirement list.
- **Create** `web-ui/src/components/requirements/review/requirement-review-panel.test.tsx` — render test for the panel.
- **Modify** `web-ui/src/hooks/use-workspace-sync.ts` — plumb `requirementTaskLinks` reads.
- **Modify** `web-ui/src/runtime/use-workspace-persistence.ts` — plumb `requirementTaskLinks` writes.
- **Modify** `web-ui/src/App.tsx` — add `requirementTaskLinks` state; wire both hooks; pass new props to `RequirementsView`.
- **Modify** `web-ui/src/components/requirements/requirements-view.tsx` — add `List | Review` toggle, accept new props, render the review panel.

> Naming note: the design spec named one `requirement-proposal-row.tsx`. We split it into `link-proposal-row.tsx` + `draft-proposal-row.tsx` for single-responsibility (link rows and draft rows have different actions and previews).

---

## Task 1: Pure state helper `requirement-task-links-state.ts`

**Files:**
- Create: `web-ui/src/state/requirement-task-links-state.ts`
- Test: `web-ui/src/state/requirement-task-links-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-ui/src/state/requirement-task-links-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
} from "@/runtime/types";
import type { BoardData } from "@/types";
import {
	confirmLink,
	reattachLink,
	rejectLink,
	selectPendingProposals,
} from "@/state/requirement-task-links-state";

function requirement(overrides: Partial<RuntimeRequirementItem> & { id: string }): RuntimeRequirementItem {
	return {
		id: overrides.id,
		title: overrides.title ?? `Req ${overrides.id}`,
		description: overrides.description ?? "",
		priority: overrides.priority ?? "medium",
		status: overrides.status ?? "active",
		linkedTaskIds: overrides.linkedTaskIds ?? [],
		order: overrides.order ?? 0,
		createdAt: overrides.createdAt ?? 1000,
		updatedAt: overrides.updatedAt ?? 1000,
	};
}

function link(overrides: Partial<RuntimeRequirementTaskLink> & { requirementId: string; taskId: string }): RuntimeRequirementTaskLink {
	return {
		requirementId: overrides.requirementId,
		taskId: overrides.taskId,
		status: overrides.status ?? "proposed",
		source: overrides.source ?? "agent",
		createdAt: overrides.createdAt ?? 1000,
	};
}

function board(cardIds: Array<{ id: string; title: string }>): BoardData {
	return {
		columns: [{ id: "backlog", title: "Backlog", cards: cardIds.map((c) => ({
			id: c.id,
			title: c.title,
			prompt: "",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1000,
			updatedAt: 1000,
		})) }],
		dependencies: [],
	};
}

describe("confirmLink", () => {
	it("flips the proposed link to confirmed and mirrors the task into linkedTaskIds", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1" })] };

		const result = confirmLink(links, requirements, "r1", "t1", 5000);

		expect(result.changed).toBe(true);
		expect(result.links.links[0].status).toBe("confirmed");
		expect(result.requirements.items[0].linkedTaskIds).toEqual(["t1"]);
		expect(result.requirements.items[0].updatedAt).toBe(5000);
	});

	it("does not duplicate an already-present linkedTaskId", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1", linkedTaskIds: ["t1"] })] };

		const result = confirmLink(links, requirements, "r1", "t1", 5000);

		expect(result.requirements.items[0].linkedTaskIds).toEqual(["t1"]);
	});

	it("returns changed=false when no matching proposed link exists", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1" })] };

		const result = confirmLink(links, requirements, "r1", "t1", 5000);

		expect(result.changed).toBe(false);
		expect(result.links).toBe(links);
		expect(result.requirements).toBe(requirements);
	});
});

describe("rejectLink", () => {
	it("removes the proposed link and leaves no residue in linkedTaskIds", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };
		const requirements: RuntimeRequirementsData = { items: [requirement({ id: "r1", linkedTaskIds: ["t1"] })] };

		const result = rejectLink(links, requirements, "r1", "t1");

		expect(result.changed).toBe(true);
		expect(result.links.links).toHaveLength(0);
		expect(result.requirements.items[0].linkedTaskIds).toEqual([]);
	});
});

describe("reattachLink", () => {
	it("moves a proposed link to another requirement", () => {
		const links: RuntimeRequirementTaskLinksData = { links: [link({ requirementId: "r1", taskId: "t1" })] };

		const result = reattachLink(links, "r1", "t1", "r2");

		expect(result.changed).toBe(true);
		expect(result.links.links).toEqual([
			expect.objectContaining({ requirementId: "r2", taskId: "t1", status: "proposed" }),
		]);
	});

	it("collapses onto an existing link instead of duplicating", () => {
		const links: RuntimeRequirementTaskLinksData = {
			links: [link({ requirementId: "r1", taskId: "t1" }), link({ requirementId: "r2", taskId: "t1" })],
		};

		const result = reattachLink(links, "r1", "t1", "r2");

		expect(result.links.links).toHaveLength(1);
		expect(result.links.links[0]).toEqual(expect.objectContaining({ requirementId: "r2", taskId: "t1" }));
	});
});

describe("selectPendingProposals", () => {
	it("buckets clean links, drafts, and inbox (dangling + draft-target)", () => {
		const requirements: RuntimeRequirementsData = {
			items: [
				requirement({ id: "r1", status: "active" }),
				requirement({ id: "r2", status: "draft" }),
			],
		};
		const links: RuntimeRequirementTaskLinksData = {
			links: [
				link({ requirementId: "r1", taskId: "t1" }), // clean
				link({ requirementId: "r2", taskId: "t1" }), // draft target -> inbox
				link({ requirementId: "r1", taskId: "missing" }), // dangling task -> inbox
				link({ requirementId: "gone", taskId: "t1" }), // dangling requirement -> inbox
				link({ requirementId: "r1", taskId: "t1", status: "confirmed" }), // ignored
			],
		};

		const result = selectPendingProposals(links, requirements, board([{ id: "t1", title: "Task One" }]));

		expect(result.links).toHaveLength(1);
		expect(result.links[0]).toMatchObject({ taskTitle: "Task One", requirement: expect.objectContaining({ id: "r1" }) });
		expect(result.drafts).toHaveLength(1);
		expect(result.drafts[0].requirement.id).toBe("r2");
		expect(result.inbox).toHaveLength(3);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-ui && npm run test -- requirement-task-links-state`
Expected: FAIL — `Cannot find module '@/state/requirement-task-links-state'`.

- [ ] **Step 3: Write the implementation**

Create `web-ui/src/state/requirement-task-links-state.ts`:

```ts
import type {
	RuntimeRequirementItem,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
} from "@/runtime/types";
import type { BoardData } from "@/types";

export interface LinkMutationResult {
	links: RuntimeRequirementTaskLinksData;
	requirements: RuntimeRequirementsData;
	changed: boolean;
}

export interface ProposedLinkProposal {
	link: RuntimeRequirementTaskLink;
	requirement: RuntimeRequirementItem | null;
	taskTitle: string | null;
	/** Why this proposal landed in the inbox, if it did. */
	inboxReason: "draft-target" | "dangling" | null;
}

export interface DraftRequirementProposal {
	requirement: RuntimeRequirementItem;
}

export interface PendingProposals {
	links: ProposedLinkProposal[];
	drafts: DraftRequirementProposal[];
	inbox: ProposedLinkProposal[];
}

function findProposed(
	links: RuntimeRequirementTaskLink[],
	requirementId: string,
	taskId: string,
): number {
	return links.findIndex(
		(item) => item.status === "proposed" && item.requirementId === requirementId && item.taskId === taskId,
	);
}

export function confirmLink(
	links: RuntimeRequirementTaskLinksData,
	requirements: RuntimeRequirementsData,
	requirementId: string,
	taskId: string,
	now: number = Date.now(),
): LinkMutationResult {
	const index = findProposed(links.links, requirementId, taskId);
	if (index === -1) {
		return { links, requirements, changed: false };
	}
	const nextLinks = links.links.map((item, itemIndex) =>
		itemIndex === index ? { ...item, status: "confirmed" as const } : item,
	);
	const nextItems = requirements.items.map((item) => {
		if (item.id !== requirementId || item.linkedTaskIds.includes(taskId)) {
			return item;
		}
		return { ...item, linkedTaskIds: [...item.linkedTaskIds, taskId], updatedAt: now };
	});
	return {
		links: { ...links, links: nextLinks },
		requirements: { ...requirements, items: nextItems },
		changed: true,
	};
}

export function rejectLink(
	links: RuntimeRequirementTaskLinksData,
	requirements: RuntimeRequirementsData,
	requirementId: string,
	taskId: string,
	now: number = Date.now(),
): LinkMutationResult {
	const index = findProposed(links.links, requirementId, taskId);
	if (index === -1) {
		return { links, requirements, changed: false };
	}
	const nextLinks = links.links.filter((_, itemIndex) => itemIndex !== index);
	const nextItems = requirements.items.map((item) => {
		if (item.id !== requirementId || !item.linkedTaskIds.includes(taskId)) {
			return item;
		}
		return { ...item, linkedTaskIds: item.linkedTaskIds.filter((id) => id !== taskId), updatedAt: now };
	});
	return {
		links: { ...links, links: nextLinks },
		requirements: { ...requirements, items: nextItems },
		changed: true,
	};
}

export function reattachLink(
	links: RuntimeRequirementTaskLinksData,
	requirementId: string,
	taskId: string,
	newRequirementId: string,
): { links: RuntimeRequirementTaskLinksData; changed: boolean } {
	const index = findProposed(links.links, requirementId, taskId);
	if (index === -1 || requirementId === newRequirementId) {
		return { links, changed: false };
	}
	const target = links.links[index];
	// Drop the old link; if a link to the new requirement already exists, keep that one.
	const withoutOld = links.links.filter((_, itemIndex) => itemIndex !== index);
	const alreadyExists = withoutOld.some(
		(item) => item.requirementId === newRequirementId && item.taskId === taskId,
	);
	const nextLinks = alreadyExists
		? withoutOld
		: [...withoutOld, { ...target, requirementId: newRequirementId }];
	return { links: { ...links, links: nextLinks }, changed: true };
}

export function selectPendingProposals(
	links: RuntimeRequirementTaskLinksData,
	requirements: RuntimeRequirementsData,
	board: BoardData,
): PendingProposals {
	const requirementById = new Map(requirements.items.map((item) => [item.id, item]));
	const taskTitleById = new Map(
		board.columns.flatMap((column) => column.cards).map((card) => [card.id, card.title]),
	);

	const cleanLinks: ProposedLinkProposal[] = [];
	const inbox: ProposedLinkProposal[] = [];

	for (const link of links.links) {
		if (link.status !== "proposed") {
			continue;
		}
		const requirement = requirementById.get(link.requirementId) ?? null;
		const taskTitle = taskTitleById.get(link.taskId) ?? null;
		if (requirement === null || taskTitle === null) {
			inbox.push({ link, requirement, taskTitle, inboxReason: "dangling" });
			continue;
		}
		if (requirement.status === "draft") {
			inbox.push({ link, requirement, taskTitle, inboxReason: "draft-target" });
			continue;
		}
		cleanLinks.push({ link, requirement, taskTitle, inboxReason: null });
	}

	const drafts: DraftRequirementProposal[] = requirements.items
		.filter((item) => item.status === "draft")
		.map((requirement) => ({ requirement }));

	return { links: cleanLinks, drafts, inbox };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web-ui && npm run test -- requirement-task-links-state`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Typecheck**

Run: `cd web-ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit** (only with user approval — see Commit note)

```bash
git add web-ui/src/state/requirement-task-links-state.ts web-ui/src/state/requirement-task-links-state.test.ts
git commit -m "feat(requirements): pure state helper for proposed link review"
```

---

## Task 2: Plumb `requirementTaskLinks` through the workspace pipeline

This single task keeps `npm run typecheck` green at its boundary by updating the sync hook, the persistence hook, and the two App call sites together. No UI yet — links now flow in and persist.

**Files:**
- Modify: `web-ui/src/hooks/use-workspace-sync.ts`
- Modify: `web-ui/src/runtime/use-workspace-persistence.ts`
- Modify: `web-ui/src/App.tsx`

- [ ] **Step 1: Extend the sync hook input + reads**

In `web-ui/src/hooks/use-workspace-sync.ts`:

Add `RuntimeRequirementTaskLinksData` to the type import (line 7-12 block):

```ts
import type {
	RuntimeGitRepositoryInfo,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";
```

Add to `UseWorkspaceSyncInput` (after the `setRequirements` line, ~line 25):

```ts
	setRequirements: Dispatch<SetStateAction<RuntimeRequirementsData>>;
	setRequirementTaskLinks: Dispatch<SetStateAction<RuntimeRequirementTaskLinksData>>;
	setCanPersistWorkspaceState: Dispatch<SetStateAction<boolean>>;
```

Add to the destructured params (after `setRequirements,` ~line 63):

```ts
		setRequirements,
		setRequirementTaskLinks,
		setCanPersistWorkspaceState,
```

In `applyWorkspaceState`, the null branch (after `setRequirements({ items: [] });` ~line 99):

```ts
				setRequirements({ items: [] });
				setRequirementTaskLinks({ links: [] });
```

In the `shouldHydrateBoard` block (after `setRequirements(nextWorkspaceState.requirements ?? { items: [] });` ~line 123):

```ts
					setRequirements(nextWorkspaceState.requirements ?? { items: [] });
					setRequirementTaskLinks(nextWorkspaceState.requirementTaskLinks ?? { links: [] });
```

Add `setRequirementTaskLinks` to the `useCallback` dependency array (~line 134):

```ts
		[currentProjectId, setBoard, setCanPersistWorkspaceState, setSessions, setRequirements, setRequirementTaskLinks],
```

- [ ] **Step 2: Extend the persistence hook**

In `web-ui/src/runtime/use-workspace-persistence.ts`:

Add the type import:

```ts
import type {
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "@/runtime/types";
```

Add to `UseWorkspacePersistenceParams` (after `requirements: RuntimeRequirementsData;`):

```ts
	requirements: RuntimeRequirementsData;
	requirementTaskLinks: RuntimeRequirementTaskLinksData;
```

Add to the destructured params (after `requirements,`):

```ts
	requirements,
	requirementTaskLinks,
```

Add a ref next to `lastPersistedRequirementsRef`:

```ts
	const lastPersistedRequirementsRef = useRef<RuntimeRequirementsData | null>(null);
	const lastPersistedRequirementTaskLinksRef = useRef<RuntimeRequirementTaskLinksData | null>(null);
```

In the project-switch reset effect (where `lastPersistedRequirementsRef.current = null;`):

```ts
			lastPersistedBoardRef.current = null;
			lastPersistedRequirementsRef.current = null;
			lastPersistedRequirementTaskLinksRef.current = null;
```

In the hydration-skip effect (where it sets `lastPersistedRequirementsRef.current = requirements;`):

```ts
		lastPersistedBoardRef.current = board;
		lastPersistedRequirementsRef.current = requirements;
		lastPersistedRequirementTaskLinksRef.current = requirementTaskLinks;
```

Update the no-change guard to also compare links:

```ts
		if (
			currentProjectId != null &&
			lastPersistedWorkspaceIdRef.current === currentProjectId &&
			lastPersistedBoardRef.current === board &&
			lastPersistedRequirementsRef.current === requirements &&
			lastPersistedRequirementTaskLinksRef.current === requirementTaskLinks
		) {
			return;
		}
```

Add to the save `payload`:

```ts
			const payload: RuntimeWorkspaceStateSaveRequest = {
				board,
				sessions: sessionsRef.current,
				requirements,
				requirementTaskLinks,
				expectedRevision: workspaceRevision,
			};
```

After a successful save (where `lastPersistedRequirementsRef.current = requirements;`):

```ts
					lastPersistedBoardRef.current = board;
					lastPersistedRequirementsRef.current = requirements;
					lastPersistedRequirementTaskLinksRef.current = requirementTaskLinks;
```

Add `requirementTaskLinks` to both the hydration-skip effect dependency array (which lists `[board, requirements, currentProjectId, hydrationNonce]`) and the main persistence effect dependency array (which lists `board, requirements, ...`):

```ts
	}, [board, requirements, requirementTaskLinks, currentProjectId, hydrationNonce]);
```

```ts
	}, [
		board,
		requirements,
		requirementTaskLinks,
		canPersistWorkspaceState,
		currentProjectId,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		onWorkspaceRevisionChange,
		persistCycle,
		persistWorkspaceState,
		refetchWorkspaceState,
		onWorkspaceStateConflict,
		workspaceRevision,
	]);
```

- [ ] **Step 3: Wire App state + both hook calls**

In `web-ui/src/App.tsx`:

Add the type to the existing runtime types import and add state after the `requirements` state (line 86):

```ts
	const [requirements, setRequirements] = useState<RuntimeRequirementsData>({ items: [] });
	const [requirementTaskLinks, setRequirementTaskLinks] = useState<RuntimeRequirementTaskLinksData>({ links: [] });
```

(Ensure `RuntimeRequirementTaskLinksData` is imported from `@/runtime/types` alongside `RuntimeRequirementsData`.)

In the `useWorkspaceSync({ ... })` call (line 226 area):

```ts
		setRequirements,
		setRequirementTaskLinks,
		setCanPersistWorkspaceState,
```

In the `useWorkspacePersistence({ ... })` call (line 473 area):

```ts
		requirements,
		requirementTaskLinks,
		currentProjectId,
```

- [ ] **Step 4: Typecheck + tests**

Run: `cd web-ui && npm run typecheck && npm run test -- use-workspace`
Expected: typecheck clean; any existing workspace-sync/persistence tests still pass (no behavior change for callers that previously omitted links — links default to empty and round-trip).

- [ ] **Step 5: Commit** (only with user approval)

```bash
git add web-ui/src/hooks/use-workspace-sync.ts web-ui/src/runtime/use-workspace-persistence.ts web-ui/src/App.tsx
git commit -m "feat(requirements): plumb requirementTaskLinks through workspace sync + persistence"
```

---

## Task 3: Review UI components

**Files:**
- Create: `web-ui/src/components/requirements/review/link-proposal-row.tsx`
- Create: `web-ui/src/components/requirements/review/draft-proposal-row.tsx`
- Create: `web-ui/src/components/requirements/review/reattach-requirement-popover.tsx`
- Create: `web-ui/src/components/requirements/review/requirement-review-panel.tsx`
- Test: `web-ui/src/components/requirements/review/requirement-review-panel.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `web-ui/src/components/requirements/review/requirement-review-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PendingProposals } from "@/state/requirement-task-links-state";
import { RequirementReviewPanel } from "./requirement-review-panel";

const noop = vi.fn();

function emptyProposals(): PendingProposals {
	return { links: [], drafts: [], inbox: [] };
}

const handlers = {
	onConfirmLink: noop,
	onRejectLink: noop,
	onReattachLink: noop,
	onAcceptDraft: noop,
	onRejectDraft: noop,
};

describe("RequirementReviewPanel", () => {
	it("shows an empty state when there are no proposals", () => {
		render(<RequirementReviewPanel proposals={emptyProposals()} reattachTargets={[]} {...handlers} />);
		expect(screen.getByText(/No proposals to review/i)).toBeInTheDocument();
	});

	it("renders link, draft, and inbox sections with their items", () => {
		const proposals: PendingProposals = {
			links: [
				{
					link: { requirementId: "r1", taskId: "t1", status: "proposed", source: "agent", createdAt: 1 },
					requirement: { id: "r1", title: "Login", description: "", priority: "medium", status: "active", linkedTaskIds: [], order: 0, createdAt: 1, updatedAt: 1 },
					taskTitle: "Build login form",
					inboxReason: null,
				},
			],
			drafts: [
				{
					requirement: { id: "r2", title: "Audit log", description: "Track edits", priority: "medium", status: "draft", linkedTaskIds: [], order: 1, createdAt: 1, updatedAt: 1 },
				},
			],
			inbox: [
				{
					link: { requirementId: "gone", taskId: "t9", status: "proposed", source: "agent", createdAt: 1 },
					requirement: null,
					taskTitle: "Orphan task",
					inboxReason: "dangling",
				},
			],
		};

		render(<RequirementReviewPanel proposals={proposals} reattachTargets={[]} {...handlers} />);

		expect(screen.getByText("Build login form")).toBeInTheDocument();
		expect(screen.getByText("Audit log")).toBeInTheDocument();
		expect(screen.getByText("Orphan task")).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-ui && npm run test -- requirement-review-panel`
Expected: FAIL — cannot resolve `./requirement-review-panel`.

- [ ] **Step 3: Implement `reattach-requirement-popover.tsx`**

Create `web-ui/src/components/requirements/review/reattach-requirement-popover.tsx`:

```tsx
import * as Popover from "@radix-ui/react-popover";
import { Link2 } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeRequirementItem } from "@/runtime/types";

interface ReattachRequirementPopoverProps {
	targets: RuntimeRequirementItem[];
	currentRequirementId: string;
	onReattach: (newRequirementId: string) => void;
}

export function ReattachRequirementPopover({
	targets,
	currentRequirementId,
	onReattach,
}: ReattachRequirementPopoverProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	const filtered = targets.filter(
		(item) => item.id !== currentRequirementId && item.title.toLowerCase().includes(query.trim().toLowerCase()),
	);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button variant="ghost" size="sm" icon={<Link2 size={14} />} aria-label="Re-attach to another requirement">
					Re-attach
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={4}
					className="z-50 w-72 rounded-lg border border-border bg-surface-1 p-2 shadow-xl"
				>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search requirements…"
						className="mb-2 w-full rounded-md border border-border-bright bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
					/>
					<div className="max-h-60 overflow-y-auto">
						{filtered.length === 0 ? (
							<p className="px-2 py-3 text-center text-[12px] text-text-tertiary">No matching requirements.</p>
						) : (
							filtered.map((item) => (
								<button
									key={item.id}
									type="button"
									onClick={() => {
										onReattach(item.id);
										setOpen(false);
										setQuery("");
									}}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text-secondary outline-none",
										"hover:bg-surface-3 hover:text-text-primary",
									)}
								>
									<span className="min-w-0 flex-1 truncate">{item.title}</span>
								</button>
							))
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
```

- [ ] **Step 4: Implement `link-proposal-row.tsx`**

Create `web-ui/src/components/requirements/review/link-proposal-row.tsx`:

```tsx
import { Check, X } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeRequirementItem } from "@/runtime/types";
import type { ProposedLinkProposal } from "@/state/requirement-task-links-state";

import { ReattachRequirementPopover } from "./reattach-requirement-popover";

interface LinkProposalRowProps {
	proposal: ProposedLinkProposal;
	reattachTargets: RuntimeRequirementItem[];
	onConfirm: (requirementId: string, taskId: string) => void;
	onReject: (requirementId: string, taskId: string) => void;
	onReattach: (requirementId: string, taskId: string, newRequirementId: string) => void;
}

const INBOX_REASON_LABEL: Record<NonNullable<ProposedLinkProposal["inboxReason"]>, string> = {
	"draft-target": "Target requirement is still a draft",
	dangling: "Task or requirement no longer exists",
};

export function LinkProposalRow({
	proposal,
	reattachTargets,
	onConfirm,
	onReject,
	onReattach,
}: LinkProposalRowProps): React.ReactElement {
	const { link, requirement, taskTitle, inboxReason } = proposal;
	const canConfirm = inboxReason === null;

	const confirmButton = (
		<Button
			variant="primary"
			size="sm"
			icon={<Check size={14} />}
			disabled={!canConfirm}
			onClick={() => onConfirm(link.requirementId, link.taskId)}
		>
			Accept
		</Button>
	);

	return (
		<div className="flex items-start gap-3 border-b border-border px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] text-text-primary">{taskTitle ?? link.taskId}</span>
					<span
						className={cn(
							"shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
							link.source === "agent" ? "border-status-purple/40 text-status-purple" : "border-border-bright text-text-secondary",
						)}
					>
						{link.source}
					</span>
				</div>
				<p className="mt-0.5 truncate text-[12px] text-text-tertiary">
					→ {requirement?.title ?? link.requirementId}
				</p>
				{inboxReason ? (
					<p className="mt-1 text-[12px] text-status-orange">{INBOX_REASON_LABEL[inboxReason]}</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{canConfirm ? confirmButton : <Tooltip content={INBOX_REASON_LABEL[inboxReason]}>{confirmButton}</Tooltip>}
				<ReattachRequirementPopover
					targets={reattachTargets}
					currentRequirementId={link.requirementId}
					onReattach={(newRequirementId) => onReattach(link.requirementId, link.taskId, newRequirementId)}
				/>
				<Button
					variant="ghost"
					size="sm"
					icon={<X size={14} />}
					aria-label="Reject link"
					onClick={() => onReject(link.requirementId, link.taskId)}
				>
					Reject
				</Button>
			</div>
		</div>
	);
}
```

- [ ] **Step 5: Implement `draft-proposal-row.tsx`**

Create `web-ui/src/components/requirements/review/draft-proposal-row.tsx`:

```tsx
import { Check, X } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { buildUnifiedDiffRows, ReadOnlyUnifiedDiff } from "@/components/shared/diff-renderer";
import { StatusBadge } from "@/components/requirements/requirement-meta";
import type { DraftRequirementProposal } from "@/state/requirement-task-links-state";

interface DraftProposalRowProps {
	proposal: DraftRequirementProposal;
	onAccept: (requirementId: string) => void;
	onReject: (requirementId: string) => void;
}

export function DraftProposalRow({ proposal, onAccept, onReject }: DraftProposalRowProps): React.ReactElement {
	const { requirement } = proposal;
	const rows = useMemo(
		() => buildUnifiedDiffRows(null, requirement.description || "(no description)"),
		[requirement.description],
	);

	return (
		<div className="border-b border-border px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-[13px] text-text-primary">{requirement.title}</span>
						<StatusBadge status={requirement.status} />
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button variant="primary" size="sm" icon={<Check size={14} />} onClick={() => onAccept(requirement.id)}>
						Accept
					</Button>
					<Button
						variant="ghost"
						size="sm"
						icon={<X size={14} />}
						aria-label="Reject draft requirement"
						onClick={() => onReject(requirement.id)}
					>
						Reject
					</Button>
				</div>
			</div>
			<div className="mt-2 overflow-hidden rounded-md border border-border">
				<ReadOnlyUnifiedDiff rows={rows} path={requirement.title} />
			</div>
		</div>
	);
}
```

- [ ] **Step 6: Implement `requirement-review-panel.tsx`**

Create `web-ui/src/components/requirements/review/requirement-review-panel.tsx`:

```tsx
import { Inbox, Link2, ListChecks } from "lucide-react";
import type React from "react";

import type { RuntimeRequirementItem } from "@/runtime/types";
import type { PendingProposals } from "@/state/requirement-task-links-state";

import { DraftProposalRow } from "./draft-proposal-row";
import { LinkProposalRow } from "./link-proposal-row";

interface RequirementReviewPanelProps {
	proposals: PendingProposals;
	reattachTargets: RuntimeRequirementItem[];
	onConfirmLink: (requirementId: string, taskId: string) => void;
	onRejectLink: (requirementId: string, taskId: string) => void;
	onReattachLink: (requirementId: string, taskId: string, newRequirementId: string) => void;
	onAcceptDraft: (requirementId: string) => void;
	onRejectDraft: (requirementId: string) => void;
}

function Section({
	icon,
	title,
	count,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	count: number;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<section className="border-b border-border">
			<header className="flex items-center gap-2 bg-surface-1 px-4 py-2 text-text-secondary">
				{icon}
				<h3 className="text-[12px] font-semibold uppercase tracking-wide">{title}</h3>
				<span className="text-[12px] text-text-tertiary">{count}</span>
			</header>
			{children}
		</section>
	);
}

export function RequirementReviewPanel({
	proposals,
	reattachTargets,
	onConfirmLink,
	onRejectLink,
	onReattachLink,
	onAcceptDraft,
	onRejectDraft,
}: RequirementReviewPanelProps): React.ReactElement {
	const total = proposals.links.length + proposals.drafts.length + proposals.inbox.length;

	if (total === 0) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-0 px-4 text-center text-[13px] text-text-tertiary">
				No proposals to review.
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-y-auto bg-surface-0">
			{proposals.links.length > 0 ? (
				<Section icon={<Link2 size={14} />} title="Proposed links" count={proposals.links.length}>
					{proposals.links.map((proposal) => (
						<LinkProposalRow
							key={`${proposal.link.requirementId}:${proposal.link.taskId}`}
							proposal={proposal}
							reattachTargets={reattachTargets}
							onConfirm={onConfirmLink}
							onReject={onRejectLink}
							onReattach={onReattachLink}
						/>
					))}
				</Section>
			) : null}

			{proposals.drafts.length > 0 ? (
				<Section icon={<ListChecks size={14} />} title="Draft requirements" count={proposals.drafts.length}>
					{proposals.drafts.map((proposal) => (
						<DraftProposalRow
							key={proposal.requirement.id}
							proposal={proposal}
							onAccept={onAcceptDraft}
							onReject={onRejectDraft}
						/>
					))}
				</Section>
			) : null}

			{proposals.inbox.length > 0 ? (
				<Section icon={<Inbox size={14} />} title="待确认 Inbox" count={proposals.inbox.length}>
					{proposals.inbox.map((proposal) => (
						<LinkProposalRow
							key={`inbox:${proposal.link.requirementId}:${proposal.link.taskId}`}
							proposal={proposal}
							reattachTargets={reattachTargets}
							onConfirm={onConfirmLink}
							onReject={onRejectLink}
							onReattach={onReattachLink}
						/>
					))}
				</Section>
			) : null}
		</div>
	);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd web-ui && npm run test -- requirement-review-panel`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `cd web-ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit** (only with user approval)

```bash
git add web-ui/src/components/requirements/review/
git commit -m "feat(requirements): review panel + link/draft proposal rows"
```

---

## Task 4: Wire the `List | Review` toggle into RequirementsView + App

**Files:**
- Modify: `web-ui/src/components/requirements/requirements-view.tsx`
- Modify: `web-ui/src/App.tsx`

- [ ] **Step 1: Extend `RequirementsView` props + add the toggle/panel**

In `web-ui/src/components/requirements/requirements-view.tsx`:

Update imports to add the review panel, state helpers, link/board types, and `useMemo` is already imported:

```ts
import type {
	RuntimeRequirementPriority,
	RuntimeRequirementsData,
	RuntimeRequirementStatus,
	RuntimeRequirementTaskLinksData,
} from "@/runtime/types";
import type { BoardData } from "@/types";
import {
	confirmLink,
	reattachLink,
	rejectLink,
	selectPendingProposals,
} from "@/state/requirement-task-links-state";
import { RequirementReviewPanel } from "./review/requirement-review-panel";
```

Extend the props interface:

```ts
interface RequirementsViewProps {
	workspaceId: string | null;
	requirements: RuntimeRequirementsData;
	requirementTaskLinks: RuntimeRequirementTaskLinksData;
	board: BoardData;
	onRequirementsChange: (next: RuntimeRequirementsData) => void;
	onRequirementTaskLinksChange: (next: RuntimeRequirementTaskLinksData) => void;
}
```

Add to the destructured params and add a `viewMode` state (next to the other `useState` calls):

```ts
	const [viewMode, setViewMode] = useState<"list" | "review">("list");
```

Derive proposals + reattach targets and the action handlers (place after the existing `selected` memo):

```ts
	const proposals = useMemo(
		() => selectPendingProposals(requirementTaskLinks, requirements, board),
		[requirementTaskLinks, requirements, board],
	);
	const pendingCount = proposals.links.length + proposals.drafts.length + proposals.inbox.length;
	const reattachTargets = useMemo(
		() => requirements.items.filter((item) => item.status !== "draft"),
		[requirements.items],
	);

	function handleConfirmLink(requirementId: string, taskId: string): void {
		const result = confirmLink(requirementTaskLinks, requirements, requirementId, taskId);
		if (result.changed) {
			onRequirementTaskLinksChange(result.links);
			onRequirementsChange(result.requirements);
		}
	}

	function handleRejectLink(requirementId: string, taskId: string): void {
		const result = rejectLink(requirementTaskLinks, requirements, requirementId, taskId);
		if (result.changed) {
			onRequirementTaskLinksChange(result.links);
			onRequirementsChange(result.requirements);
		}
	}

	function handleReattachLink(requirementId: string, taskId: string, newRequirementId: string): void {
		const result = reattachLink(requirementTaskLinks, requirementId, taskId, newRequirementId);
		if (result.changed) {
			onRequirementTaskLinksChange(result.links);
		}
	}

	function handleAcceptDraft(id: string): void {
		handlePatch(id, { status: "active" });
	}

	function handleRejectDraft(id: string): void {
		handleDelete(id);
	}
```

Add the toggle to the header, before the `RequirementSelect` filters (inside the `ml-auto` flex container). Replace the opening of that container so the toggle sits first:

```tsx
				<div className="ml-auto flex items-center gap-2">
					<div className="flex items-center rounded-md border border-border-bright bg-surface-2 p-0.5">
						<button
							type="button"
							onClick={() => setViewMode("list")}
							className={cn(
								"rounded-sm px-2.5 py-1 text-[12px] font-medium outline-none",
								viewMode === "list" ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:text-text-primary",
							)}
						>
							List
						</button>
						<button
							type="button"
							onClick={() => setViewMode("review")}
							className={cn(
								"flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[12px] font-medium outline-none",
								viewMode === "review" ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:text-text-primary",
							)}
						>
							Review
							{pendingCount > 0 ? (
								<span className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
									{pendingCount}
								</span>
							) : null}
						</button>
					</div>
					<RequirementSelect
```

Note: keep the filters/`New` button as-is (they remain visible in both modes; harmless). Replace the body split so the review panel renders in review mode. Change the `<div className="flex flex-1 min-h-0">` block:

```tsx
			{viewMode === "review" ? (
				<RequirementReviewPanel
					proposals={proposals}
					reattachTargets={reattachTargets}
					onConfirmLink={handleConfirmLink}
					onRejectLink={handleRejectLink}
					onReattachLink={handleReattachLink}
					onAcceptDraft={handleAcceptDraft}
					onRejectDraft={handleRejectDraft}
				/>
			) : (
				<div className="flex flex-1 min-h-0">
					{/* existing list + detail split unchanged */}
				</div>
			)}
```

(Preserve the existing list/detail JSX verbatim inside the `else` branch's `<div className="flex flex-1 min-h-0">`.)

- [ ] **Step 2: Pass the new props from App**

In `web-ui/src/App.tsx`, update the `<RequirementsView ... />` usage (line 931):

```tsx
											<RequirementsView
												workspaceId={currentProjectId}
												requirements={requirements}
												requirementTaskLinks={requirementTaskLinks}
												board={board}
												onRequirementsChange={setRequirements}
												onRequirementTaskLinksChange={setRequirementTaskLinks}
											/>
```

- [ ] **Step 3: Typecheck + full test run**

Run: `cd web-ui && npm run typecheck && npm run test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 4: Lint**

Run: `cd web-ui && npm run lint`
Expected: no new lint errors in touched files.

- [ ] **Step 5: Commit** (only with user approval)

```bash
git add web-ui/src/components/requirements/requirements-view.tsx web-ui/src/App.tsx
git commit -m "feat(requirements): List/Review toggle wiring proposal review into the requirements view"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- PR-style batch review (accept/reject/re-attach proposed links; accept/reject draft requirements) → Tasks 1, 3, 4. ✓
- Accept link → confirmed + mirror into `linkedTaskIds`; reject → remove → `confirmLink`/`rejectLink` (Task 1). ✓
- Accept draft → active; reject → delete → `handleAcceptDraft`/`handleRejectDraft` reusing existing helpers (Task 4). ✓
- Re-attach to another requirement → `reattachLink` + `ReattachRequirementPopover` (Tasks 1, 3, 4). ✓
- Reuse version-history diff renderer + draft status → `ReadOnlyUnifiedDiff`/`buildUnifiedDiffRows` + `StatusBadge` in `DraftProposalRow` (Task 3). ✓
- "待确认" inbox fallback for scattered/uncertain proposals → `selectPendingProposals` inbox bucket (dangling + draft-target) + inbox section (Tasks 1, 3). ✓
- Read from existing `useWorkspaceSync`, no new channel → Task 2 (sync + persistence + App wiring). ✓
- Decision: all draft-status requirements are the pending bucket → `selectPendingProposals` drafts filter. ✓
- Decision: `List | Review` tab inside RequirementsView → Task 4. ✓
- Board UI untouched → no board files modified. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The list/detail JSX preserved in Task 4 Step 1 is explicitly "unchanged" (the engineer keeps the existing block verbatim) — not a placeholder for new code.

**Type consistency:** `confirmLink`/`rejectLink` return `LinkMutationResult` (`{ links, requirements, changed }`); `reattachLink` returns `{ links, changed }`. Callers in Task 4 use exactly these shapes. `PendingProposals` (`links`/`drafts`/`inbox`) and `ProposedLinkProposal` (`link`/`requirement`/`taskTitle`/`inboxReason`) match between Task 1, the panel props (Task 3), and the test fixtures. Component prop names (`onConfirmLink`, `onRejectLink`, `onReattachLink`, `onAcceptDraft`, `onRejectDraft`, `reattachTargets`, `proposals`) are consistent across Tasks 3 and 4.
