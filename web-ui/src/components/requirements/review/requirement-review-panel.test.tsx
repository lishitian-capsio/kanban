import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
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
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("shows an empty state when there are no proposals", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<RequirementReviewPanel proposals={emptyProposals()} reattachTargets={[]} {...handlers} />
				</TooltipProvider>,
			);
		});
		expect(container.textContent).toMatch(/No proposals to review/i);
	});

	it("invokes callbacks when actions are clicked", () => {
		const onAcceptDraft = vi.fn();
		const onRejectLink = vi.fn();
		const proposals: PendingProposals = {
			links: [
				{
					link: { requirementId: "r1", taskId: "t1", status: "proposed", source: "agent", createdAt: 1 },
					requirement: {
						id: "r1",
						title: "Login",
						description: "",
						priority: "medium",
						status: "active",
						linkedTaskIds: [],
						order: 0,
						createdAt: 1,
						updatedAt: 1,
					},
					taskTitle: "Build login form",
					inboxReason: null,
				},
			],
			drafts: [
				{
					requirement: {
						id: "r2",
						title: "Audit log",
						description: "Track edits",
						priority: "medium",
						status: "draft",
						linkedTaskIds: [],
						order: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				},
			],
			inbox: [],
		};

		act(() => {
			root.render(
				<TooltipProvider>
					<RequirementReviewPanel
						proposals={proposals}
						reattachTargets={[]}
						onConfirmLink={vi.fn()}
						onRejectLink={onRejectLink}
						onReattachLink={vi.fn()}
						onAcceptDraft={onAcceptDraft}
						onRejectDraft={vi.fn()}
					/>
				</TooltipProvider>,
			);
		});

		// Click the draft Accept button — the draft section's Accept button is the one NOT inside
		// the link row (link row's Accept button calls onConfirmLink). Select all enabled Accept
		// buttons and pick the second one which belongs to the draft row.
		const allAcceptButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
			(btn) => btn.textContent?.trim() === "Accept" && !btn.disabled,
		);
		// allAcceptButtons[0] = link confirm, allAcceptButtons[1] = draft accept
		const draftAcceptButton = allAcceptButtons[1];
		expect(draftAcceptButton).toBeDefined();
		if (!draftAcceptButton) throw new Error("Draft Accept button not found");
		act(() => {
			draftAcceptButton.click();
		});
		expect(onAcceptDraft).toHaveBeenCalledWith("r2");

		// Click the link Reject button
		const rejectLinkButton = container.querySelector<HTMLButtonElement>('[aria-label="Reject link"]');
		expect(rejectLinkButton).not.toBeNull();
		act(() => {
			rejectLinkButton?.click();
		});
		expect(onRejectLink).toHaveBeenCalledWith("r1", "t1");
	});

	it("renders link, draft, and inbox sections with their items", () => {
		const proposals: PendingProposals = {
			links: [
				{
					link: { requirementId: "r1", taskId: "t1", status: "proposed", source: "agent", createdAt: 1 },
					requirement: {
						id: "r1",
						title: "Login",
						description: "",
						priority: "medium",
						status: "active",
						linkedTaskIds: [],
						order: 0,
						createdAt: 1,
						updatedAt: 1,
					},
					taskTitle: "Build login form",
					inboxReason: null,
				},
			],
			drafts: [
				{
					requirement: {
						id: "r2",
						title: "Audit log",
						description: "Track edits",
						priority: "medium",
						status: "draft",
						linkedTaskIds: [],
						order: 1,
						createdAt: 1,
						updatedAt: 1,
					},
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

		act(() => {
			root.render(
				<TooltipProvider>
					<RequirementReviewPanel proposals={proposals} reattachTargets={[]} {...handlers} />
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("Build login form");
		expect(container.textContent).toContain("Audit log");
		expect(container.textContent).toContain("Orphan task");
	});
});
