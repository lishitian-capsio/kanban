import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PendingGitHubLogin } from "../../../src/github-auth/github-auth-types";
import {
	clearPendingGitHubLogin,
	readPendingGitHubLogin,
	writePendingGitHubLogin,
} from "../../../src/github-auth/github-pending-login-store";
import { createTempDir } from "../../utilities/temp-dir";

const pending: PendingGitHubLogin = {
	deviceCode: "DEV-CODE",
	userCode: "WXYZ-1234",
	verificationUri: "https://github.com/login/device",
	intervalSeconds: 5,
	startedAt: 1_700_000_000_000,
	expiresAt: 1_700_000_900_000,
};

describe("github-pending-login-store", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "github-login-pending.json");
	});
	afterEach(() => cleanup());

	it("returns null when no pending login is on disk", async () => {
		expect(await readPendingGitHubLogin(file)).toBeNull();
	});

	it("round-trips a pending login and restricts file permissions", async () => {
		await writePendingGitHubLogin(file, pending);
		expect(await readPendingGitHubLogin(file)).toEqual(pending);
		const mode = (await stat(file)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("treats a corrupt file as no pending login", async () => {
		await writePendingGitHubLogin(file, pending);
		const { writeFile } = await import("node:fs/promises");
		await writeFile(file, "{not json", "utf8");
		expect(await readPendingGitHubLogin(file)).toBeNull();
	});

	it("clear removes the record and is idempotent when already absent", async () => {
		await writePendingGitHubLogin(file, pending);
		await clearPendingGitHubLogin(file);
		expect(await readPendingGitHubLogin(file)).toBeNull();
		// A second clear (file already gone) must not throw.
		await clearPendingGitHubLogin(file);
		expect(await readPendingGitHubLogin(file)).toBeNull();
	});
});
