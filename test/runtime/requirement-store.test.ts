import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementTaskLink,
	RuntimeRequirementVersion,
} from "../../src/core/api-contract";
import {
	readRequirementsSharded,
	readRequirementTaskLinksSharded,
	readRequirementVersionsSharded,
	writeRequirementsSharded,
	writeRequirementTaskLinksSharded,
	writeRequirementVersionsSharded,
} from "../../src/state/requirement-store";
import { createTempDir } from "../utilities/temp-dir";

function requirement(id: string, order: number): RuntimeRequirementItem {
	return {
		id,
		title: `Requirement ${id}`,
		description: "",
		priority: "medium",
		status: "draft",
		linkedTaskIds: [],
		order,
		createdAt: 1,
		updatedAt: 1,
	};
}

function version(requirementId: string, versionNumber: number): RuntimeRequirementVersion {
	return {
		requirementId,
		version: versionNumber,
		changeKind: versionNumber === 1 ? "create" : "update",
		snapshot: requirement(requirementId, 0),
		source: "human",
		reason: null,
		createdAt: versionNumber,
	};
}

function link(requirementId: string, taskId: string): RuntimeRequirementTaskLink {
	return { requirementId, taskId, source: "human", createdAt: 1 };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const { path, cleanup } = createTempDir("req-store-");
	try {
		return await run(path);
	} finally {
		cleanup();
	}
}

describe("requirement-store", () => {
	it("round-trips requirements and reconstructs the list ordered by `order`", async () => {
		await withTempDir(async (dir) => {
			await writeRequirementsSharded(dir, {
				items: [requirement("b", 2), requirement("a", 0), requirement("c", 1)],
			});

			const loaded = await readRequirementsSharded(dir);
			expect(loaded.items.map((item) => item.id)).toEqual(["a", "c", "b"]);
		});
	});

	it("writes one requirement shard per id and deletes a removed requirement's shard", async () => {
		await withTempDir(async (dir) => {
			await writeRequirementsSharded(dir, { items: [requirement("a", 0), requirement("b", 1)] });
			expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);

			await writeRequirementsSharded(dir, { items: [requirement("a", 0)] });
			expect((await readdir(dir)).sort()).toEqual(["a.json"]);
		});
	});

	it("groups versions per requirement and reconstructs them ordered by id then version", async () => {
		await withTempDir(async (dir) => {
			await writeRequirementVersionsSharded(dir, {
				versions: [version("b", 1), version("a", 2), version("a", 1)],
			});

			expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);
			const loaded = await readRequirementVersionsSharded(dir);
			expect(loaded.versions.map((entry) => `${entry.requirementId}:${entry.version}`)).toEqual([
				"a:1",
				"a:2",
				"b:1",
			]);
		});
	});

	it("keeps a version shard even when the requirement no longer exists", async () => {
		await withTempDir(async (dir) => {
			// A delete version is recorded for a requirement that is gone from the items set.
			await writeRequirementVersionsSharded(dir, { versions: [version("ghost", 1)] });
			const loaded = await readRequirementVersionsSharded(dir);
			expect(loaded.versions).toHaveLength(1);
			expect(loaded.versions[0]?.requirementId).toBe("ghost");
		});
	});

	it("groups links per requirement and drops a shard once its links are empty", async () => {
		await withTempDir(async (dir) => {
			await writeRequirementTaskLinksSharded(dir, {
				links: [link("a", "t1"), link("a", "t2"), link("b", "t3")],
			});
			expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);

			const loaded = await readRequirementTaskLinksSharded(dir);
			expect(loaded.links.map((entry) => `${entry.requirementId}:${entry.taskId}`)).toEqual([
				"a:t1",
				"a:t2",
				"b:t3",
			]);

			// All of "a"'s links removed -> its shard should disappear.
			await writeRequirementTaskLinksSharded(dir, { links: [link("b", "t3")] });
			expect((await readdir(dir)).sort()).toEqual(["b.json"]);
		});
	});

	it("returns empty aggregates for a missing shard directory", async () => {
		await withTempDir(async (path) => {
			const dir = join(path, "absent");
			expect((await readRequirementsSharded(dir)).items).toEqual([]);
			expect((await readRequirementVersionsSharded(dir)).versions).toEqual([]);
			expect((await readRequirementTaskLinksSharded(dir)).links).toEqual([]);
		});
	});
});
