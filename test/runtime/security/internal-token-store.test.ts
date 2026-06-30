import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getInternalTokenFilePath,
	readPersistedInternalToken,
	resolveAndPersistInternalToken,
	writePersistedInternalToken,
} from "../../../src/security/internal-token-store";
import { createTempDir } from "../../utilities/temp-dir";

describe("internal-token-store path resolution", () => {
	const original = process.env.KANBAN_INTERNAL_TOKEN_FILE;
	afterEach(() => {
		if (original === undefined) delete process.env.KANBAN_INTERNAL_TOKEN_FILE;
		else process.env.KANBAN_INTERNAL_TOKEN_FILE = original;
	});

	it("honors the KANBAN_INTERNAL_TOKEN_FILE override", () => {
		process.env.KANBAN_INTERNAL_TOKEN_FILE = "/custom/internal-token.json";
		expect(getInternalTokenFilePath()).toBe("/custom/internal-token.json");
	});

	it("defaults to the machine-home settings dir", () => {
		delete process.env.KANBAN_INTERNAL_TOKEN_FILE;
		const path = getInternalTokenFilePath();
		expect(path.endsWith(join(".kanban", "settings", "internal-token.json"))).toBe(true);
	});
});

describe("internal-token-store persistence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "internal-token.json");
	});
	afterEach(() => cleanup());

	it("round-trips a written token", async () => {
		await writePersistedInternalToken(file, "a".repeat(64));
		expect(await readPersistedInternalToken(file)).toBe("a".repeat(64));
	});

	it("returns null when the file is missing", async () => {
		expect(await readPersistedInternalToken(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for a torn/invalid file instead of throwing", async () => {
		const torn = join(dir, "torn.json");
		await writeFile(torn, "{ not json", "utf8");
		expect(await readPersistedInternalToken(torn)).toBeNull();
	});

	it("writes the secret with owner-only permissions", async () => {
		await writePersistedInternalToken(file, "b".repeat(64));
		const { mode } = await stat(file);
		expect(mode & 0o777).toBe(0o600);
	});
});

describe("resolveAndPersistInternalToken precedence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "internal-token.json");
	});
	afterEach(() => cleanup());

	it("generates and persists when no persisted file exists", async () => {
		const result = await resolveAndPersistInternalToken({
			filePath: file,
			generate: () => "GENERATED_TOKEN",
		});
		expect(result).toEqual({ value: "GENERATED_TOKEN", source: "generated" });
		expect(await readPersistedInternalToken(file)).toBe("GENERATED_TOKEN");
	});

	it("reuses the persisted token across restarts (no rotation)", async () => {
		await writePersistedInternalToken(file, "REUSED_TOKEN");
		const result = await resolveAndPersistInternalToken({
			filePath: file,
			generate: () => "SHOULD_NOT_RUN",
		});
		expect(result).toEqual({ value: "REUSED_TOKEN", source: "persisted" });
		expect(await readPersistedInternalToken(file)).toBe("REUSED_TOKEN");
	});

	it("a simulated restart yields the same token value twice", async () => {
		const first = await resolveAndPersistInternalToken({ filePath: file });
		const second = await resolveAndPersistInternalToken({ filePath: file });
		expect(first.value).toBe(second.value);
		expect(first.source).toBe("generated");
		expect(second.source).toBe("persisted");
	});

	it("only stores `value` and `issuedAt` in the persisted JSON", async () => {
		await resolveAndPersistInternalToken({ filePath: file, generate: () => "TOK" });
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(parsed.value).toBe("TOK");
		expect(typeof parsed.issuedAt).toBe("number");
	});
});
