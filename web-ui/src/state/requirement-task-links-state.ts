import type {
	RuntimeRequirementItem,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
} from "@/runtime/types";
import type { BoardData } from "@/types";

// Canonical mutation helpers for the web-ui proposal-review path. These mirror the
// server-side logic in `src/core/requirement-task-link-mutations.ts` (e.g. confirming a
// link flips status to "confirmed" and mirrors the task into the requirement's
// linkedTaskIds), but deliberately diverge in two ways: (1) they are pure and the result
// is persisted through the existing whole-document workspace save — not the versioned
// core mutation endpoint — so a human confirm/reject here intentionally does NOT write a
// requirement-version entry (unlike the agent path); (2) they omit the core's throwing
// guards since the review UI only ever offers actions on links it derived as actionable.
// Keep this file in sync with the core sibling if the mirror semantics change.

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

/**
 * Move a *proposed* link from one requirement to another. Only proposed links are
 * matched (confirmed links are left untouched); returns changed:false if no proposed
 * link matches (requirementId, taskId) or if newRequirementId equals the current one.
 */
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
	if (target === undefined) {
		return { links, changed: false };
	}
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
