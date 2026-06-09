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
