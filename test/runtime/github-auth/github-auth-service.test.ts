import { utimes } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubAuthService } from "../../../src/github-auth/github-auth-service";
import { readPersistedGitHubAuth, writePersistedGitHubAuth } from "../../../src/github-auth/github-auth-store";
import { GITHUB_TOKEN_ENV_VAR } from "../../../src/github-auth/github-git-credentials";
import { readPendingGitHubLogin } from "../../../src/github-auth/github-pending-login-store";
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
	let pendingFile: string;
	let nowMs: number;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "github-auth.json");
		pendingFile = join(dir, "settings", "github-login-pending.json");
		nowMs = 1_700_000_000_000;
	});
	afterEach(() => cleanup());

	function makeService(overrides: ConstructorParameters<typeof GitHubAuthService>[0] = {}) {
		return new GitHubAuthService({
			resolvePath: () => file,
			resolvePendingPath: () => pendingFile,
			now: () => nowMs,
			...overrides,
		});
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

	it("beginLogin persists the pending login server-side and returns the prompt", async () => {
		const service = makeService({ requestDeviceCode: async () => grant });
		const prompt = await service.beginLogin();
		expect(prompt).toEqual({
			userCode: "WXYZ",
			verificationUri: "https://github.com/login/device",
			intervalSeconds: 1,
			expiresAt: nowMs + 900 * 1000,
		});
		// The deviceCode is persisted (not returned) so a UI refresh can resume by polling.
		expect(await readPendingGitHubLogin(pendingFile)).toMatchObject({
			deviceCode: "DEV",
			userCode: "WXYZ",
			startedAt: nowMs,
			expiresAt: nowMs + 900 * 1000,
		});
	});

	it("getPendingLogin returns the active prompt for a UI to resume after a refresh", async () => {
		const service = makeService({ requestDeviceCode: async () => grant });
		await service.beginLogin();
		expect(await service.getPendingLogin()).toEqual({
			userCode: "WXYZ",
			verificationUri: "https://github.com/login/device",
			intervalSeconds: 1,
			expiresAt: nowMs + 900 * 1000,
		});
	});

	it("getPendingLogin clears and returns null once the code has expired", async () => {
		const service = makeService({ requestDeviceCode: async () => ({ ...grant, expiresInSeconds: 10 }) });
		await service.beginLogin();
		nowMs += 11_000; // past the 10s lifetime
		expect(await service.getPendingLogin()).toBeNull();
		expect(await readPendingGitHubLogin(pendingFile)).toBeNull();
	});

	it("stateful device flow: beginLogin then pollLogin() pending → complete clears pending", async () => {
		let polls = 0;
		const service = makeService({
			requestDeviceCode: async () => grant,
			pollAccessTokenOnce: async () =>
				polls++ === 0 ? { kind: "pending" } : { kind: "token", grant: { accessToken: "gho_UI", scope: "repo" } },
			fetchAuthenticatedLogin: async () => "octocat",
		});

		await service.beginLogin();
		expect(await service.pollLogin()).toEqual({ state: "pending" });
		const done = await service.pollLogin();
		expect(done).toMatchObject({ state: "complete", status: { authenticated: true, login: "octocat" } });
		expect(await readPersistedGitHubAuth(file)).toMatchObject({ accessToken: "gho_UI" });
		// Pending login cleared on success so it can't block a fresh sign-in.
		expect(await readPendingGitHubLogin(pendingFile)).toBeNull();
	});

	it("pollLogin() resumes from disk across a runtime restart (a fresh service instance)", async () => {
		const before = makeService({ requestDeviceCode: async () => grant });
		await before.beginLogin();

		// Simulate a runtime restart: a brand-new service instance reads the persisted pending
		// login and polls it to completion — no UI-held state required.
		const after = makeService({
			pollAccessTokenOnce: async () => ({ kind: "token", grant: { accessToken: "gho_RESUMED", scope: "repo" } }),
			fetchAuthenticatedLogin: async () => "octocat",
		});
		const done = await after.pollLogin();
		expect(done).toMatchObject({ state: "complete", status: { authenticated: true, login: "octocat" } });
		expect(await readPersistedGitHubAuth(file)).toMatchObject({ accessToken: "gho_RESUMED" });
	});

	it("pollLogin() returns idle when there is no pending login", async () => {
		const service = makeService();
		expect(await service.pollLogin()).toEqual({ state: "idle" });
	});

	it("pollLogin() surfaces a terminal error and clears the pending login", async () => {
		const service = makeService({
			requestDeviceCode: async () => grant,
			pollAccessTokenOnce: async () => ({ kind: "error", message: "access_denied" }),
		});
		await service.beginLogin();
		expect(await service.pollLogin()).toEqual({ state: "error", message: "access_denied" });
		expect(await readPersistedGitHubAuth(file)).toBeNull();
		expect(await readPendingGitHubLogin(pendingFile)).toBeNull();
	});

	it("pollLogin() surfaces an expiry error and clears the pending login", async () => {
		const service = makeService({ requestDeviceCode: async () => ({ ...grant, expiresInSeconds: 10 }) });
		await service.beginLogin();
		nowMs += 11_000;
		const result = await service.pollLogin();
		expect(result.state).toBe("error");
		expect(await readPendingGitHubLogin(pendingFile)).toBeNull();
	});

	it("cancelLogin clears the pending login", async () => {
		const service = makeService({ requestDeviceCode: async () => grant });
		await service.beginLogin();
		await service.cancelLogin();
		expect(await readPendingGitHubLogin(pendingFile)).toBeNull();
		expect(await service.getPendingLogin()).toBeNull();
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
