import { utimes } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubAuthService } from "../../../src/github-auth/github-auth-service";
import { readPersistedGitHubAuth, writePersistedGitHubAuth } from "../../../src/github-auth/github-auth-store";
import { GITHUB_TOKEN_ENV_VAR } from "../../../src/github-auth/github-git-credentials";
import { createTempDir } from "../../utilities/temp-dir";

const grant = {
	deviceCode: "DEV",
	userCode: "WXYZ",
	verificationUri: "https://github.com/login/device",
	intervalSeconds: 1,
	expiresInSeconds: 900,
};

describe("GitHubAuthService", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;
	let nowMs: number;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "github-auth.json");
		nowMs = 1_700_000_000_000;
	});
	afterEach(() => cleanup());

	function makeService(overrides: ConstructorParameters<typeof GitHubAuthService>[0] = {}) {
		return new GitHubAuthService({ resolvePath: () => file, now: () => nowMs, ...overrides });
	}

	it("reports not authenticated and injects nothing when logged out", async () => {
		const service = makeService();
		expect(await service.getStatus()).toEqual({ authenticated: false, login: null, scope: null, expiresAt: null });
		expect(await service.getGitInjection()).toBeNull();
	});

	it("blocking login persists the credential and exposes it for git injection", async () => {
		const service = makeService({
			requestDeviceCode: async () => grant,
			pollForAccessToken: async () => ({ accessToken: "gho_TOK", scope: "repo" }),
			fetchAuthenticatedLogin: async () => "octocat",
		});
		const onPrompt = vi.fn();
		const status = await service.login({ onPrompt });
		expect(onPrompt).toHaveBeenCalledWith(grant);
		expect(status).toMatchObject({ authenticated: true, login: "octocat", scope: "repo" });

		const injection = await service.getGitInjection();
		expect(injection).not.toBeNull();
		expect(injection?.env[GITHUB_TOKEN_ENV_VAR]).toBe("gho_TOK");
		// And the secret is on disk with the resolved login.
		expect(await readPersistedGitHubAuth(file)).toMatchObject({ accessToken: "gho_TOK", login: "octocat" });
	});

	it("refreshes an expired token that has a refresh token, then injects the new one", async () => {
		await writePersistedGitHubAuth(file, {
			accessToken: "gho_OLD",
			refreshToken: "ghr_R",
			expiresAt: nowMs - 1000, // already expired
			login: "octocat",
		});
		const refreshAccessToken = vi.fn(async () => ({
			accessToken: "gho_NEW",
			refreshToken: "ghr_R2",
			expiresInSeconds: 28800,
		}));
		const service = makeService({ refreshAccessToken });

		const injection = await service.getGitInjection();
		expect(refreshAccessToken).toHaveBeenCalledWith("ghr_R", expect.any(String));
		expect(injection?.env[GITHUB_TOKEN_ENV_VAR]).toBe("gho_NEW");
		// New token persisted (with login carried over).
		expect(await readPersistedGitHubAuth(file)).toMatchObject({ accessToken: "gho_NEW", login: "octocat" });
	});

	it("treats an expired, non-refreshable token as logged out (passthrough)", async () => {
		await writePersistedGitHubAuth(file, { accessToken: "gho_OLD", expiresAt: nowMs - 1000 });
		const service = makeService();
		expect(await service.getGitInjection()).toBeNull();
		expect((await service.getStatus()).authenticated).toBe(false);
	});

	it("non-blocking device flow: beginLogin then pollLogin pending → complete", async () => {
		let polls = 0;
		const service = makeService({
			requestDeviceCode: async () => grant,
			pollAccessTokenOnce: async () =>
				polls++ === 0 ? { kind: "pending" } : { kind: "token", grant: { accessToken: "gho_UI", scope: "repo" } },
			fetchAuthenticatedLogin: async () => "octocat",
		});

		expect(await service.beginLogin()).toEqual(grant);
		expect(await service.pollLogin(grant.deviceCode)).toEqual({ state: "pending" });
		const done = await service.pollLogin(grant.deviceCode);
		expect(done).toMatchObject({ state: "complete", status: { authenticated: true, login: "octocat" } });
		expect(await readPersistedGitHubAuth(file)).toMatchObject({ accessToken: "gho_UI" });
	});

	it("pollLogin surfaces a terminal error without persisting", async () => {
		const service = makeService({
			pollAccessTokenOnce: async () => ({ kind: "error", message: "access_denied" }),
		});
		expect(await service.pollLogin("DEV")).toEqual({ state: "error", message: "access_denied" });
		expect(await readPersistedGitHubAuth(file)).toBeNull();
	});

	it("logout removes the credential and returns to passthrough", async () => {
		await writePersistedGitHubAuth(file, { accessToken: "gho_TOK" });
		const service = makeService();
		expect(await service.getGitInjection()).not.toBeNull();
		await service.logout();
		expect(await service.getGitInjection()).toBeNull();
		expect(await readPersistedGitHubAuth(file)).toBeNull();
	});

	it("picks up an out-of-process credential change (mtime reload)", async () => {
		const service = makeService();
		// First read: logged out.
		expect((await service.getStatus()).authenticated).toBe(false);
		// A separate process (the CLI) logs in by writing the file...
		await writePersistedGitHubAuth(file, { accessToken: "gho_CLI", login: "octocat" });
		// ...bump mtime forward so the reload is deterministic regardless of fs timestamp granularity.
		const future = new Date(nowMs + 60_000);
		await utimes(file, future, future);
		// The long-lived runtime service now reflects it without a restart.
		expect(await service.getStatus()).toMatchObject({ authenticated: true, login: "octocat" });
	});
});
