import type {
	RuntimeRequirementItem,
	RuntimeRequirementPriority,
	RuntimeRequirementStatus,
	RuntimeRequirementsData,
} from "./api-contract";
import { createUniqueTaskId } from "./task-id";

export interface RuntimeCreateRequirementInput {
	title: string;
	description?: string;
	priority?: RuntimeRequirementPriority;
	status?: RuntimeRequirementStatus;
}

export interface RuntimeUpdateRequirementInput {
	title?: string;
	description?: string;
	priority?: RuntimeRequirementPriority;
	status?: RuntimeRequirementStatus;
}

export interface RuntimeCreateRequirementResult {
	data: RuntimeRequirementsData;
	requirement: RuntimeRequirementItem;
}

export interface RuntimeUpdateRequirementResult {
	data: RuntimeRequirementsData;
	requirement: RuntimeRequirementItem | null;
	updated: boolean;
}

export interface RuntimeDeleteRequirementResult {
	data: RuntimeRequirementsData;
	requirement: RuntimeRequirementItem | null;
	deleted: boolean;
}

function collectRequirementIds(data: RuntimeRequirementsData): Set<string> {
	return new Set(data.items.map((item) => item.id));
}

function nextOrder(data: RuntimeRequirementsData): number {
	if (data.items.length === 0) {
		return 0;
	}
	return Math.max(...data.items.map((item) => item.order)) + 1;
}

export function addRequirement(
	data: RuntimeRequirementsData,
	input: RuntimeCreateRequirementInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateRequirementResult {
	const title = input.title.trim();
	if (!title) {
		throw new Error("Requirement title is required.");
	}
	const requirement: RuntimeRequirementItem = {
		id: createUniqueTaskId(collectRequirementIds(data), randomUuid),
		title,
		description: input.description?.trim() ?? "",
		priority: input.priority ?? "medium",
		status: input.status ?? "draft",
		linkedTaskIds: [],
		order: nextOrder(data),
		createdAt: now,
		updatedAt: now,
	};
	return {
		data: { ...data, items: [...data.items, requirement] },
		requirement,
	};
}

export function updateRequirement(
	data: RuntimeRequirementsData,
	id: string,
	input: RuntimeUpdateRequirementInput,
	now: number = Date.now(),
): RuntimeUpdateRequirementResult {
	const normalizedId = id.trim();
	const title = input.title === undefined ? undefined : input.title.trim();
	if (input.title !== undefined && !title) {
		throw new Error("Requirement title cannot be empty.");
	}

	let updatedRequirement: RuntimeRequirementItem | null = null;
	const items = data.items.map((item) => {
		if (item.id !== normalizedId) {
			return item;
		}
		updatedRequirement = {
			...item,
			...(title !== undefined ? { title } : {}),
			...(input.description !== undefined ? { description: input.description.trim() } : {}),
			...(input.priority !== undefined ? { priority: input.priority } : {}),
			...(input.status !== undefined ? { status: input.status } : {}),
			updatedAt: now,
		};
		return updatedRequirement;
	});

	if (!updatedRequirement) {
		return { data, requirement: null, updated: false };
	}
	return {
		data: { ...data, items },
		requirement: updatedRequirement,
		updated: true,
	};
}

export function deleteRequirement(data: RuntimeRequirementsData, id: string): RuntimeDeleteRequirementResult {
	const normalizedId = id.trim();
	const removed = data.items.find((item) => item.id === normalizedId) ?? null;
	if (!removed) {
		return { data, requirement: null, deleted: false };
	}
	return {
		data: { ...data, items: data.items.filter((item) => item.id !== normalizedId) },
		requirement: removed,
		deleted: true,
	};
}
