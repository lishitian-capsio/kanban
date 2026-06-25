import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearPersistedGitHubAuth,
	getGitHubAuthFilePath,
	readPersistedGitHubAuth,
	statGitHubAuthMtimeMs,
	writePersistedGitHubAuth,
} from "../../../src/github-auth/github-auth-store";
import { createTempDir } from "../../utilities/temp-dir";

describe("github-auth-store path resolution", () => {
	const original = process.env.KANBAN_GITHUB_AUTH_FILE;
	afterEach(() => {
		if (original === undefined) delete process.env.KANBAN_GITHUB_AUTH_FILE;
		else process.env.KANBAN_GITHUB_AUTH_FILE = original;
	});

	it("honors the KANBAN_GITHUB_AUTH_FILE override", () => {
		process.env.KANBAN_GITHUB_AUTH_FILE = "/custom/github-auth.json";
		expect(getGitHubAuthFilePath()).toBe("/custom/github-auth.json");
	});

	it("defaults to the machine-home settings dir", () => {
		delete process.env.KANBAN_GITHUB_AUTH_FILE;
		expect(getGitHubAuthFilePath().endsWith(join(".kanban", "settings", "github-auth.json"))).toBe(true);
	});
});

describe("github-auth-store persistence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "github-auth.json");
	});
	afterEach(() => cleanup());

	it("round-trips a written credential", async () => {
		await writePersistedGitHubAuth(file, { accessToken: "tok", login: "octocat", scope: "repo" });
		expect(await readPersistedGitHubAuth(file)).toMatchObject({
			accessToken: "tok",
			login: "octocat",
			scope: "repo",
		});
	});

	it("writes the secret with owner-only (0o600) permissions", async () => {
		await writePersistedGitHubAuth(file, { accessToken: "tok" });
		const { mode } = await stat(file);
		expect(mode & 0o777).toBe(0o600);
	});

	it("returns null for a missing file", async () => {
		expect(await readPersistedGitHubAuth(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for a torn/invalid file instead of throwing", async () => {
		const torn = join(dir, "torn.json");
		await writeFile(torn, "{ not json", "utf8");
		expect(await readPersistedGitHubAuth(torn)).toBeNull();
	});

	it("returns null when the schema does not match (e.g. missing accessToken)", async () => {
		const bad = join(dir, "bad.json");
		await writeFile(bad, JSON.stringify({ login: "octocat" }), "utf8");
		expect(await readPersistedGitHubAuth(bad)).toBeNull();
	});

	it("clearPersistedGitHubAuth removes the file and is idempotent", async () => {
		await writePersistedGitHubAuth(file, { accessToken: "tok" });
		await clearPersistedGitHubAuth(file);
		expect(await readPersistedGitHubAuth(file)).toBeNull();
		// Second clear on an absent file must not throw.
		await expect(clearPersistedGitHubAuth(file)).resolves.toBeUndefined();
	});

	it("statGitHubAuthMtimeMs returns a number when present and null when absent", async () => {
		expect(await statGitHubAuthMtimeMs(file)).toBeNull();
		await writePersistedGitHubAuth(file, { accessToken: "tok" });
		expect(typeof (await statGitHubAuthMtimeMs(file))).toBe("number");
	});
});
