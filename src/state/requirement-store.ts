import { z } from "zod";

import {
	type RuntimeRequirementItem,
	type RuntimeRequirementsData,
	type RuntimeRequirementTaskLink,
	type RuntimeRequirementTaskLinksData,
	type RuntimeRequirementVersion,
	type RuntimeRequirementVersionsData,
	runtimeRequirementItemSchema,
	runtimeRequirementTaskLinkSchema,
	runtimeRequirementVersionSchema,
} from "../core/api-contract";
import { readShardDir, writeShardDir } from "./sharded-json-store";

// Per-shard on-disk shapes. requirements store one item per file; versions and
// links store the per-requirement slice (an array) so each requirement's history
// and link set live in their own file, keyed by requirement id.
const requirementVersionsShardSchema = z.array(runtimeRequirementVersionSchema);
const requirementTaskLinksShardSchema = z.array(runtimeRequirementTaskLinkSchema);

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function groupByRequirementId<T extends { requirementId: string }>(records: readonly T[]): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const record of records) {
		const bucket = grouped.get(record.requirementId);
		if (bucket) {
			bucket.push(record);
		} else {
			grouped.set(record.requirementId, [record]);
		}
	}
	return grouped;
}

/** Read requirement item shards and rebuild the list ordered by `order` then `id`. */
export async function readRequirementsSharded(dir: string): Promise<RuntimeRequirementsData> {
	const shards = await readShardDir(dir, runtimeRequirementItemSchema);
	const items = [...shards.values()].sort((left, right) => {
		if (left.order !== right.order) {
			return left.order - right.order;
		}
		return compareStrings(left.id, right.id);
	});
	return { items };
}

/** Persist one requirement item per `<id>.json` shard, mirroring the items set. */
export async function writeRequirementsSharded(dir: string, data: RuntimeRequirementsData): Promise<void> {
	const shards = new Map<string, RuntimeRequirementItem>(data.items.map((item) => [item.id, item]));
	await writeShardDir(dir, shards);
}

/**
 * Read requirement-version shards and rebuild the flat aggregate, ordered by
 * requirement id then version. Global order is cosmetic (lookups filter by id and
 * sort by version), so this only needs to be deterministic.
 */
export async function readRequirementVersionsSharded(dir: string): Promise<RuntimeRequirementVersionsData> {
	const shards = await readShardDir(dir, requirementVersionsShardSchema);
	const versions: RuntimeRequirementVersion[] = [];
	for (const requirementId of [...shards.keys()].sort(compareStrings)) {
		const shard = shards.get(requirementId) ?? [];
		const ordered = [...shard].sort((left, right) => left.version - right.version);
		versions.push(...ordered);
	}
	return { versions };
}

/** Persist each requirement's version history into its own `<id>.json` shard. */
export async function writeRequirementVersionsSharded(
	dir: string,
	data: RuntimeRequirementVersionsData,
): Promise<void> {
	const grouped = groupByRequirementId(data.versions);
	const shards = new Map<string, RuntimeRequirementVersion[]>();
	for (const [requirementId, records] of grouped) {
		shards.set(
			requirementId,
			[...records].sort((left, right) => left.version - right.version),
		);
	}
	await writeShardDir(dir, shards);
}

/**
 * Read requirement-task-link shards and rebuild the flat aggregate, ordered by
 * requirement id then link creation time.
 */
export async function readRequirementTaskLinksSharded(dir: string): Promise<RuntimeRequirementTaskLinksData> {
	const shards = await readShardDir(dir, requirementTaskLinksShardSchema);
	const links: RuntimeRequirementTaskLink[] = [];
	for (const requirementId of [...shards.keys()].sort(compareStrings)) {
		const shard = shards.get(requirementId) ?? [];
		const ordered = [...shard].sort((left, right) => left.createdAt - right.createdAt);
		links.push(...ordered);
	}
	return { links };
}

/**
 * Persist each requirement's links into its own `<id>.json` shard. A requirement
 * with no links has no shard (an emptied link set deletes the file).
 */
export async function writeRequirementTaskLinksSharded(
	dir: string,
	data: RuntimeRequirementTaskLinksData,
): Promise<void> {
	const grouped = groupByRequirementId(data.links);
	const shards = new Map<string, RuntimeRequirementTaskLink[]>(grouped);
	await writeShardDir(dir, shards);
}
