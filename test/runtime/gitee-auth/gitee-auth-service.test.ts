import { utimes } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GiteeAuthService } from "../../../src/gitee-auth/gitee-auth-service";
import { readPersistedGiteeAuth, writePersistedGiteeAuth } from "../../../src/gitee-auth/gitee-auth-store";
import { GITEE_TOKEN_ENV_VAR, GITEE_USERNAME_ENV_VAR } from "../../../src/gitee-auth/gitee-git-credentials";
import { createTempDir } from "../../utilities/temp-dir";

describe("GiteeAuthService", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;
	let nowMs: number;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "gitee-auth.json");
		nowMs = 1_700_000_000_000;
	});
	afterEach(() => cleanup());

	function makeService(overrides: ConstructorParameters<typeof GiteeAuthService>[0] = {}) {
		return new GiteeAuthService({
			resolvePath: () => file,
			now: () => nowMs,
			fetchUserLogin: async () => null,
			...overrides,
		});
	}

	it("reports not authenticated and injects nothing when logged out", async () => {
		const service = makeService();
		expect(await service.getStatus()).toEqual({ authenticated: false, login: null, username: null });
		expect(await service.getGitInjection()).toBeNull();
	});

	it("login persists the PAT and exposes it for git injection (with resolved login)", async () => {
		const service = makeService({ fetchUserLogin: async () => "octocat" });
		const status = await service.login({ token: "  gitee_pat  " });
		expect(status).toEqual({ authenticated: true, login: "octocat", username: "octocat" });

		const injection = await service.getGitInjection();
		expect(injection).not.toBeNull();
		expect(injection?.env[GITEE_TOKEN_ENV_VAR]).toBe("gitee_pat");
		// Resolved login is used as the basic-auth username when none was supplied.
		expect(injection?.env[GITEE_USERNAME_ENV_VAR]).toBe("octocat");
		expect(await readPersistedGiteeAuth(file)).toMatchObject({ accessToken: "gitee_pat", login: "octocat" });
	});

	it("prefers an explicitly supplied username over the resolved login", async () => {
		const service = makeService({ fetchUserLogin: async () => "resolved" });
		const status = await service.login({ token: "pat", username: "explicit" });
		expect(status).toMatchObject({ username: "explicit", login: "resolved" });
		const injection = await service.getGitInjection();
		expect(injection?.env[GITEE_USERNAME_ENV_VAR]).toBe("explicit");
	});

	it("still logs in when the API login lookup fails (best-effort, token-only)", async () => {
		const service = makeService({ fetchUserLogin: async () => null });
		const status = await service.login({ token: "pat" });
		expect(status).toEqual({ authenticated: true, login: null, username: null });
		const injection = await service.getGitInjection();
		// No username captured ⇒ helper env falls back to the oauth2 sentinel.
		expect(injection?.env[GITEE_USERNAME_ENV_VAR]).toBe("oauth2");
	});

	it("rejects an empty token", async () => {
		const service = makeService();
		await expect(service.login({ token: "   " })).rejects.toThrow();
		expect(await readPersistedGiteeAuth(file)).toBeNull();
	});

	it("resolves the display login best-effort even when a username is supplied", async () => {
		const fetchUserLogin = vi.fn(async () => "resolved");
		const service = makeService({ fetchUserLogin });
		await service.login({ token: "pat", username: "explicit" });
		// Best-effort resolution still runs (for display), but never blocks the result.
		expect(fetchUserLogin).toHaveBeenCalledWith("pat");
	});

	it("logout removes the credential and returns to passthrough", async () => {
		await writePersistedGiteeAuth(file, { accessToken: "pat", username: "octocat" });
		const service = makeService();
		expect(await service.getGitInjection()).not.toBeNull();
		await service.logout();
		expect(await service.getGitInjection()).toBeNull();
		expect(await readPersistedGiteeAuth(file)).toBeNull();
	});

	it("picks up an out-of-process credential change (mtime reload)", async () => {
		const service = makeService();
		expect((await service.getStatus()).authenticated).toBe(false);
		// A separate process (the CLI) logs in by writing the file...
		await writePersistedGiteeAuth(file, { accessToken: "pat_cli", login: "octocat", username: "octocat" });
		// ...bump mtime forward so the reload is deterministic regardless of fs timestamp granularity.
		const future = new Date(nowMs + 60_000);
		await utimes(file, future, future);
		expect(await service.getStatus()).toMatchObject({ authenticated: true, login: "octocat", username: "octocat" });
	});
});
