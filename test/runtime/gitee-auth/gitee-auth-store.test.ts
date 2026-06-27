import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearPersistedGiteeAuth,
	getGiteeAuthFilePath,
	readPersistedGiteeAuth,
	statGiteeAuthMtimeMs,
	writePersistedGiteeAuth,
} from "../../../src/gitee-auth/gitee-auth-store";
import { createTempDir } from "../../utilities/temp-dir";

describe("gitee-auth-store path resolution", () => {
	const original = process.env.KANBAN_GITEE_AUTH_FILE;
	afterEach(() => {
		if (original === undefined) delete process.env.KANBAN_GITEE_AUTH_FILE;
		else process.env.KANBAN_GITEE_AUTH_FILE = original;
	});

	it("honors the KANBAN_GITEE_AUTH_FILE override", () => {
		process.env.KANBAN_GITEE_AUTH_FILE = "/custom/gitee-auth.json";
		expect(getGiteeAuthFilePath()).toBe("/custom/gitee-auth.json");
	});

	it("defaults to the machine-home settings dir", () => {
		delete process.env.KANBAN_GITEE_AUTH_FILE;
		expect(getGiteeAuthFilePath().endsWith(join(".kanban", "settings", "gitee-auth.json"))).toBe(true);
	});
});

describe("gitee-auth-store persistence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "gitee-auth.json");
	});
	afterEach(() => cleanup());

	it("round-trips a written credential", async () => {
		await writePersistedGiteeAuth(file, { accessToken: "pat", username: "octocat", login: "octocat" });
		expect(await readPersistedGiteeAuth(file)).toMatchObject({
			accessToken: "pat",
			username: "octocat",
			login: "octocat",
		});
	});

	it("writes the secret with owner-only (0o600) permissions", async () => {
		await writePersistedGiteeAuth(file, { accessToken: "pat" });
		const { mode } = await stat(file);
		expect(mode & 0o777).toBe(0o600);
	});

	it("returns null for a missing file", async () => {
		expect(await readPersistedGiteeAuth(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for a torn/invalid file instead of throwing", async () => {
		const torn = join(dir, "torn.json");
		await writeFile(torn, "{ not json", "utf8");
		expect(await readPersistedGiteeAuth(torn)).toBeNull();
	});

	it("returns null when the schema does not match (e.g. missing accessToken)", async () => {
		const bad = join(dir, "bad.json");
		await writeFile(bad, JSON.stringify({ username: "octocat" }), "utf8");
		expect(await readPersistedGiteeAuth(bad)).toBeNull();
	});

	it("clearPersistedGiteeAuth removes the file and is idempotent", async () => {
		await writePersistedGiteeAuth(file, { accessToken: "pat" });
		await clearPersistedGiteeAuth(file);
		expect(await readPersistedGiteeAuth(file)).toBeNull();
		// Second clear on an absent file must not throw.
		await expect(clearPersistedGiteeAuth(file)).resolves.toBeUndefined();
	});

	it("statGiteeAuthMtimeMs returns a number when present and null when absent", async () => {
		expect(await statGiteeAuthMtimeMs(file)).toBeNull();
		await writePersistedGiteeAuth(file, { accessToken: "pat" });
		expect(typeof (await statGiteeAuthMtimeMs(file))).toBe("number");
	});
});
