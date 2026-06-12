import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SavedViewStore } from "../../../src/vault/saved-view-store";

let repoPath: string;
let store: SavedViewStore;

const viewsRoot = () => join(repoPath, ".kanban", "files", "views");

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-saved-view-store-"));
	store = new SavedViewStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("SavedViewStore.create", () => {
	it("writes a <id>.json shard and applies schema defaults", async () => {
		const view = await store.create({
			type: "requirement",
			name: "High priority",
			filters: { all: [{ field: "priority", op: "equals", value: "high" }] },
		});

		expect(view.id).toMatch(/^[a-z0-9]+$/);
		expect(view.type).toBe("requirement");
		expect(view.name).toBe("High priority");
		// Schema defaults fill in the unset optional fields.
		expect(view.icon).toBeNull();
		expect(view.layout).toBe("table");
		expect(view.sort).toBeNull();
		expect(view.listPropertiesDisplay).toEqual([]);

		const files = await readdir(viewsRoot());
		expect(files).toEqual([`${view.id}.json`]);
		const onDisk = JSON.parse(await readFile(join(viewsRoot(), `${view.id}.json`), "utf8"));
		expect(onDisk.filters).toEqual({ all: [{ field: "priority", op: "equals", value: "high" }] });
	});

	it("stamps created/updated timestamps from the injected clock", async () => {
		const timed = new SavedViewStore(repoPath, { now: () => 4242 });
		const view = await timed.create({ type: "requirement", name: "Now", filters: { all: [] } });
		expect(view.createdAt).toBe(4242);
		expect(view.updatedAt).toBe(4242);
	});

	it("defaults filters to an empty all-group when omitted", async () => {
		const view = await store.create({ type: "note", name: "All notes" });
		expect(view.filters).toEqual({ all: [] });
	});

	it("assigns unique ids across views", async () => {
		const a = await store.create({ type: "requirement", name: "A", filters: { all: [] } });
		const b = await store.create({ type: "requirement", name: "B", filters: { all: [] } });
		expect(a.id).not.toBe(b.id);
		expect(await store.list()).toHaveLength(2);
	});
});

describe("SavedViewStore.list", () => {
	it("lists every type, filters by a single type, and sorts by order then createdAt", async () => {
		const timed = new SavedViewStore(repoPath, { now: () => 1 });
		await timed.create({ type: "requirement", name: "Second", order: 2, filters: { all: [] } });
		await timed.create({ type: "requirement", name: "First", order: 1, filters: { all: [] } });
		await timed.create({ type: "note", name: "Note view", filters: { all: [] } });

		const all = await store.list();
		expect(all).toHaveLength(3);

		const reqs = await store.list("requirement");
		expect(reqs.map((v) => v.name)).toEqual(["First", "Second"]);
	});

	it("is empty before any view is written", async () => {
		expect(await store.list()).toEqual([]);
	});
});

describe("SavedViewStore round-trip", () => {
	it("reads back an equivalent view through a fresh store instance", async () => {
		const created = await store.create({
			type: "requirement",
			name: "Roundtrip",
			layout: "board",
			sort: { field: "updated", direction: "desc" },
			listPropertiesDisplay: ["status", "priority"],
			filters: {
				all: [
					{ field: "type", op: "equals", value: "requirement" },
					{ any: [{ field: "priority", op: "any_of", value: ["high", "urgent"] }] },
				],
			},
		});

		const reloaded = await new SavedViewStore(repoPath).get(created.id);
		expect(reloaded).toEqual(created);
	});
});

describe("SavedViewStore.update", () => {
	it("patches provided fields, bumps updatedAt, and preserves createdAt", async () => {
		let clock = 1000;
		const timed = new SavedViewStore(repoPath, { now: () => clock });
		const created = await timed.create({ type: "requirement", name: "Before", filters: { all: [] } });

		clock = 5000;
		const updated = await timed.update(created.id, {
			name: "After",
			layout: "board",
			filters: { any: [{ field: "status", op: "equals", value: "proposed" }] },
		});

		expect(updated.name).toBe("After");
		expect(updated.layout).toBe("board");
		expect(updated.filters).toEqual({ any: [{ field: "status", op: "equals", value: "proposed" }] });
		expect(updated.createdAt).toBe(1000);
		expect(updated.updatedAt).toBe(5000);
	});

	it("throws when the view does not exist", async () => {
		await expect(store.update("nope", { name: "x" })).rejects.toThrow(/not found/i);
	});
});

describe("SavedViewStore.remove", () => {
	it("deletes the shard and returns true, then false for an unknown id", async () => {
		const created = await store.create({ type: "requirement", name: "Doomed", filters: { all: [] } });
		expect(await store.remove(created.id)).toBe(true);
		expect(await store.get(created.id)).toBeNull();
		expect(await readdir(viewsRoot())).toEqual([]);
		expect(await store.remove("nope")).toBe(false);
	});
});
