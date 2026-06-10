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

/** Render a requirement version number in the user-facing `v1` / `v2` form. */
export function formatRequirementVersionLabel(version: number): string {
	return `v${version}`;
}

export interface DiffRequirementVersionsOptions {
	source: RuntimeRequirementChangeSource;
	now?: number;
}

/**
 * Fields whose change is meaningful enough to record a new version. These mirror what
 * {@link revertRequirementToVersion} restores, so versioning and reverting stay in sync.
 * Non-content fields like `order` and `updatedAt` are intentionally excluded so reordering
 * never spawns a version.
 */
const VERSIONED_FIELDS = ["title", "description", "priority", "status"] as const;

function hasVersionedChange(previous: RuntimeRequirementItem, next: RuntimeRequirementItem): boolean {
	return VERSIONED_FIELDS.some((field) => previous[field] !== next[field]);
}

/**
 * Compare a previous and next requirement snapshot set and append version records for every
 * create / update / delete, so whole-snapshot saves (e.g. from the web UI) stay versioned the
 * same way the per-operation CLI commands are. Returns the original `versions` reference
 * untouched when nothing meaningful changed.
 */
export function diffRequirementVersions(
	previous: RuntimeRequirementsData,
	next: RuntimeRequirementsData,
	versions: RuntimeRequirementVersionsData,
	options: DiffRequirementVersionsOptions,
): RuntimeRequirementVersionsData {
	const now = options.now ?? Date.now();
	const previousById = new Map(previous.items.map((item) => [item.id, item]));
	const nextById = new Map(next.items.map((item) => [item.id, item]));

	let result = versions;
	const append = (snapshot: RuntimeRequirementItem, changeKind: RuntimeRequirementChangeKind): void => {
		result = appendRequirementVersion(result, {
			requirementId: snapshot.id,
			snapshot,
			changeKind,
			source: options.source,
			now,
		}).data;
	};

	// Creates and updates, in next's order so numbering is deterministic.
	for (const item of next.items) {
		const prior = previousById.get(item.id);
		if (!prior) {
			append(item, "create");
		} else if (hasVersionedChange(prior, item)) {
			append(item, "update");
		}
	}

	// Deletes, in previous's order.
	for (const item of previous.items) {
		if (!nextById.has(item.id)) {
			append(item, "delete");
		}
	}

	return result;
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
