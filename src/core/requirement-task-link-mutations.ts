import type {
	RuntimeRequirementChangeSource,
	RuntimeRequirementItem,
	RuntimeRequirementsData,
	RuntimeRequirementTaskLink,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementVersionsData,
} from "./api-contract";
import { appendRequirementVersion } from "./requirement-versions";

export interface RequirementTaskLinkChangeOptions {
	source: RuntimeRequirementChangeSource;
	now?: number;
	reason?: string | null;
}

export interface RequirementTaskLinkMutationResult {
	requirements: RuntimeRequirementsData;
	links: RuntimeRequirementTaskLinksData;
	versions: RuntimeRequirementVersionsData;
	/** The link affected by the mutation (added, updated, or removed). */
	link: RuntimeRequirementTaskLink;
}

function findRequirement(data: RuntimeRequirementsData, requirementId: string): RuntimeRequirementItem {
	const requirement = data.items.find((item) => item.id === requirementId);
	if (!requirement) {
		throw new Error(`Requirement "${requirementId}" was not found.`);
	}
	return requirement;
}

function findLink(
	links: RuntimeRequirementTaskLinksData,
	requirementId: string,
	taskId: string,
): RuntimeRequirementTaskLink | null {
	return links.links.find((link) => link.requirementId === requirementId && link.taskId === taskId) ?? null;
}

function replaceRequirement(data: RuntimeRequirementsData, next: RuntimeRequirementItem): RuntimeRequirementsData {
	return { ...data, items: data.items.map((item) => (item.id === next.id ? next : item)) };
}

function recordVersion(
	versions: RuntimeRequirementVersionsData,
	snapshot: RuntimeRequirementItem,
	options: RequirementTaskLinkChangeOptions,
	now: number,
	defaultReason: string,
): RuntimeRequirementVersionsData {
	return appendRequirementVersion(versions, {
		requirementId: snapshot.id,
		snapshot,
		changeKind: "update",
		source: options.source,
		reason: options.reason ?? defaultReason,
		now,
	}).data;
}

export function proposeLink(
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
	versions: RuntimeRequirementVersionsData,
	requirementId: string,
	taskId: string,
	options: RequirementTaskLinkChangeOptions,
): RequirementTaskLinkMutationResult {
	const now = options.now ?? Date.now();
	const requirement = findRequirement(requirements, requirementId);
	if (findLink(links, requirementId, taskId)) {
		throw new Error(`A link between requirement "${requirementId}" and task "${taskId}" already exists.`);
	}
	const link: RuntimeRequirementTaskLink = {
		requirementId,
		taskId,
		status: "proposed",
		source: options.source,
		createdAt: now,
	};
	return {
		requirements,
		links: { ...links, links: [...links.links, link] },
		versions: recordVersion(versions, requirement, options, now, `Proposed link to task ${taskId}`),
		link,
	};
}

export function confirmLink(
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
	versions: RuntimeRequirementVersionsData,
	requirementId: string,
	taskId: string,
	options: RequirementTaskLinkChangeOptions,
): RequirementTaskLinkMutationResult {
	const now = options.now ?? Date.now();
	const requirement = findRequirement(requirements, requirementId);
	const existing = findLink(links, requirementId, taskId);
	if (existing?.status === "confirmed") {
		throw new Error(`The link between requirement "${requirementId}" and task "${taskId}" is already confirmed.`);
	}

	// Preserve the originating source (e.g. an agent proposal) while flipping to confirmed.
	const link: RuntimeRequirementTaskLink = existing
		? { ...existing, status: "confirmed" }
		: { requirementId, taskId, status: "confirmed", source: options.source, createdAt: now };
	const nextLinks: RuntimeRequirementTaskLink[] = existing
		? links.links.map((entry) => (entry === existing ? link : entry))
		: [...links.links, link];

	const linkedTaskIds = requirement.linkedTaskIds.includes(taskId)
		? requirement.linkedTaskIds
		: [...requirement.linkedTaskIds, taskId];
	const nextRequirement: RuntimeRequirementItem = { ...requirement, linkedTaskIds, updatedAt: now };

	return {
		requirements: replaceRequirement(requirements, nextRequirement),
		links: { ...links, links: nextLinks },
		versions: recordVersion(versions, nextRequirement, options, now, `Confirmed link to task ${taskId}`),
		link,
	};
}

export function rejectLink(
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
	versions: RuntimeRequirementVersionsData,
	requirementId: string,
	taskId: string,
	options: RequirementTaskLinkChangeOptions,
): RequirementTaskLinkMutationResult {
	const now = options.now ?? Date.now();
	const requirement = findRequirement(requirements, requirementId);
	const existing = findLink(links, requirementId, taskId);
	if (!existing) {
		throw new Error(`A link between requirement "${requirementId}" and task "${taskId}" was not found.`);
	}
	if (existing.status === "confirmed") {
		throw new Error(`Cannot reject a confirmed link between "${requirementId}" and "${taskId}"; use unlink instead.`);
	}
	return {
		requirements,
		links: { ...links, links: links.links.filter((entry) => entry !== existing) },
		versions: recordVersion(versions, requirement, options, now, `Rejected proposed link to task ${taskId}`),
		link: existing,
	};
}

export function unlink(
	requirements: RuntimeRequirementsData,
	links: RuntimeRequirementTaskLinksData,
	versions: RuntimeRequirementVersionsData,
	requirementId: string,
	taskId: string,
	options: RequirementTaskLinkChangeOptions,
): RequirementTaskLinkMutationResult {
	const now = options.now ?? Date.now();
	const requirement = findRequirement(requirements, requirementId);
	const existing = findLink(links, requirementId, taskId);
	if (!existing) {
		throw new Error(`A link between requirement "${requirementId}" and task "${taskId}" was not found.`);
	}
	if (existing.status === "proposed") {
		throw new Error(`Cannot unlink a proposed link between "${requirementId}" and "${taskId}"; use reject instead.`);
	}
	const nextRequirement: RuntimeRequirementItem = {
		...requirement,
		linkedTaskIds: requirement.linkedTaskIds.filter((id) => id !== taskId),
		updatedAt: now,
	};
	return {
		requirements: replaceRequirement(requirements, nextRequirement),
		links: { ...links, links: links.links.filter((entry) => entry !== existing) },
		versions: recordVersion(versions, nextRequirement, options, now, `Unlinked task ${taskId}`),
		link: existing,
	};
}
