import type {
	RuntimeRequirementItem,
	RuntimeRequirementPriority,
	RuntimeRequirementStatus,
	RuntimeRequirementsData,
} from "@/runtime/types";

export interface RequirementDraft {
	title: string;
	description?: string;
	priority?: RuntimeRequirementPriority;
	status?: RuntimeRequirementStatus;
}

export interface RequirementPatch {
	title?: string;
	description?: string;
	priority?: RuntimeRequirementPriority;
	status?: RuntimeRequirementStatus;
}

interface AddRequirementOptions {
	now?: number;
	uuid?: () => string;
}

const REQUIREMENT_ID_LENGTH = 5;

function createBrowserUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return Math.random().toString(36).slice(2, 12);
}

function createRequirementId(existingIds: Set<string>, uuid: () => string): string {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = uuid().replaceAll("-", "").slice(0, REQUIREMENT_ID_LENGTH);
		if (candidate && !existingIds.has(candidate)) {
			return candidate;
		}
	}
	return Math.random().toString(36).slice(2, 2 + REQUIREMENT_ID_LENGTH);
}

function nextOrder(data: RuntimeRequirementsData): number {
	if (data.items.length === 0) {
		return 0;
	}
	return Math.max(...data.items.map((item) => item.order)) + 1;
}

export function sortRequirements(items: RuntimeRequirementItem[]): RuntimeRequirementItem[] {
	return [...items].sort((left, right) => {
		if (left.order !== right.order) {
			return left.order - right.order;
		}
		return left.createdAt - right.createdAt;
	});
}

export function addRequirement(
	data: RuntimeRequirementsData,
	draft: RequirementDraft,
	options: AddRequirementOptions = {},
): { data: RuntimeRequirementsData; requirement: RuntimeRequirementItem } {
	const title = draft.title.trim();
	if (!title) {
		throw new Error("Requirement title is required.");
	}
	const now = options.now ?? Date.now();
	const uuid = options.uuid ?? createBrowserUuid;
	const existingIds = new Set(data.items.map((item) => item.id));
	const requirement: RuntimeRequirementItem = {
		id: createRequirementId(existingIds, uuid),
		title,
		description: draft.description?.trim() ?? "",
		priority: draft.priority ?? "medium",
		status: draft.status ?? "draft",
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
	patch: RequirementPatch,
	now: number = Date.now(),
): { data: RuntimeRequirementsData; requirement: RuntimeRequirementItem | null; updated: boolean } {
	const title = patch.title === undefined ? undefined : patch.title.trim();
	if (patch.title !== undefined && !title) {
		throw new Error("Requirement title cannot be empty.");
	}
	let updatedRequirement: RuntimeRequirementItem | null = null;
	const items = data.items.map((item) => {
		if (item.id !== id) {
			return item;
		}
		updatedRequirement = {
			...item,
			...(title !== undefined ? { title } : {}),
			...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
			...(patch.priority !== undefined ? { priority: patch.priority } : {}),
			...(patch.status !== undefined ? { status: patch.status } : {}),
			updatedAt: now,
		};
		return updatedRequirement;
	});
	if (!updatedRequirement) {
		return { data, requirement: null, updated: false };
	}
	return { data: { ...data, items }, requirement: updatedRequirement, updated: true };
}

export function deleteRequirement(
	data: RuntimeRequirementsData,
	id: string,
): { data: RuntimeRequirementsData; removed: boolean } {
	const items = data.items.filter((item) => item.id !== id);
	if (items.length === data.items.length) {
		return { data, removed: false };
	}
	return { data: { ...data, items }, removed: true };
}
