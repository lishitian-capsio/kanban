import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readShardDir, writeShardDir } from "../../src/state/sharded-json-store";
import { createTempDir } from "../utilities/temp-dir";

const itemSchema = z.object({ id: z.string(), value: z.number() });
type Item = z.infer<typeof itemSchema>;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const { path, cleanup } = createTempDir("shard-store-");
	try {
		return await run(path);
	} finally {
		cleanup();
	}
}

describe("sharded-json-store", () => {
	it("returns an empty map for a missing directory", async () => {
		await withTempDir(async (path) => {
			const map = await readShardDir(join(path, "absent"), itemSchema);
			expect(map.size).toBe(0);
		});
	});

	it("round-trips shards keyed by their file name", async () => {
		await withTempDir(async (path) => {
			const dir = join(path, "shards");
			const next = new Map<string, Item>([
				["a", { id: "a", value: 1 }],
				["b", { id: "b", value: 2 }],
			]);
			await writeShardDir(dir, next);

			const map = await readShardDir(dir, itemSchema);
			expect(map.size).toBe(2);
			expect(map.get("a")).toEqual({ id: "a", value: 1 });
			expect(map.get("b")).toEqual({ id: "b", value: 2 });
		});
	});

	it("deletes shards whose id is absent from the next set", async () => {
		await withTempDir(async (path) => {
			const dir = join(path, "shards");
			await writeShardDir(
				dir,
				new Map<string, Item>([
					["a", { id: "a", value: 1 }],
					["b", { id: "b", value: 2 }],
				]),
			);
			await writeShardDir(dir, new Map<string, Item>([["a", { id: "a", value: 1 }]]));

			const files = (await readdir(dir)).sort();
			expect(files).toEqual(["a.json"]);
		});
	});

	it("does not rewrite an unchanged shard file", async () => {
		await withTempDir(async (path) => {
			const dir = join(path, "shards");
			await writeShardDir(dir, new Map<string, Item>([["a", { id: "a", value: 1 }]]));
			const before = await stat(join(dir, "a.json"));

			await writeShardDir(dir, new Map<string, Item>([["a", { id: "a", value: 1 }]]));
			const after = await stat(join(dir, "a.json"));

			expect(after.mtimeMs).toBe(before.mtimeMs);
		});
	});

	it("reports the offending file path when a shard fails schema validation", async () => {
		await withTempDir(async (path) => {
			const dir = join(path, "shards");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "broken.json"), JSON.stringify({ id: "broken" }), "utf8");

			await expect(readShardDir(dir, itemSchema)).rejects.toThrow(/broken\.json/);
		});
	});

	it("ignores non-json entries in the directory", async () => {
		await withTempDir(async (path) => {
			const dir = join(path, "shards");
			await writeShardDir(dir, new Map<string, Item>([["a", { id: "a", value: 1 }]]));
			await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");
			await mkdir(join(dir, "nested"), { recursive: true });

			const map = await readShardDir(dir, itemSchema);
			expect([...map.keys()]).toEqual(["a"]);
		});
	});
});
