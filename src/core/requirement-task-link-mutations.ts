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
	/** The link affected by the mutation (added or removed). */
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

export function linkTask(
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
		source: options.source,
		createdAt: now,
	};
	const linkedTaskIds = requirement.linkedTaskIds.includes(taskId)
		? requirement.linkedTaskIds
		: [...requirement.linkedTaskIds, taskId];
	const nextRequirement: RuntimeRequirementItem = { ...requirement, linkedTaskIds, updatedAt: now };

	return {
		requirements: replaceRequirement(requirements, nextRequirement),
		links: { ...links, links: [...links.links, link] },
		versions: recordVersion(versions, nextRequirement, options, now, `Linked task ${taskId}`),
		link,
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
