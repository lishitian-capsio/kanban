import { afterEach, describe, expect, it, vi } from "vitest";

import {
	GITHUB_GIT_OAUTH_SCOPE,
	type PollAttempt,
	pollAccessTokenOnce,
	pollForAccessToken,
	refreshAccessToken,
	requestDeviceCode,
	resolveGitHubOAuthClientId,
} from "../../../src/github-auth/github-device-flow";

function mockFetchOnce(status: number, body: unknown): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.KANBAN_GITHUB_OAUTH_CLIENT_ID;
});

describe("resolveGitHubOAuthClientId", () => {
	it("honors the KANBAN_GITHUB_OAUTH_CLIENT_ID override", () => {
		process.env.KANBAN_GITHUB_OAUTH_CLIENT_ID = "my-org-client";
		expect(resolveGitHubOAuthClientId()).toBe("my-org-client");
	});

	it("falls back to a non-empty default client id", () => {
		delete process.env.KANBAN_GITHUB_OAUTH_CLIENT_ID;
		expect(resolveGitHubOAuthClientId().length).toBeGreaterThan(0);
	});
});

describe("requestDeviceCode", () => {
	it("requests the repo scope and maps the response fields", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "DEV",
					user_code: "WXYZ-1234",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				}),
				{ status: 200 },
			),
		);
		const grant = await requestDeviceCode("client-1");
		expect(grant).toEqual({
			deviceCode: "DEV",
			userCode: "WXYZ-1234",
			verificationUri: "https://github.com/login/device",
			intervalSeconds: 5,
			expiresInSeconds: 900,
		});
		const body = JSON.parse((fetchSpy.mock.calls[0]?.[1]?.body as string) ?? "{}");
		expect(body).toMatchObject({ client_id: "client-1", scope: GITHUB_GIT_OAUTH_SCOPE });
	});

	it("throws when required fields are missing", async () => {
		mockFetchOnce(200, { device_code: "DEV" });
		await expect(requestDeviceCode("c")).rejects.toThrow(/missing required fields/i);
	});

	it("surfaces a request timeout as a clear, recoverable error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("aborted", "TimeoutError"));
		await expect(requestDeviceCode("c")).rejects.toThrow(/timed out/i);
	});

	it("passes an abort signal so a hung request cannot wedge the poll forever", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					device_code: "DEV",
					user_code: "WXYZ-1234",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				}),
				{ status: 200 },
			),
		);
		await requestDeviceCode("c");
		const init = fetchSpy.mock.calls[0]?.[1];
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("pollAccessTokenOnce", () => {
	it("returns a token on success", async () => {
		mockFetchOnce(200, { access_token: "gho_TOK", scope: "repo", expires_in: 28800, refresh_token: "ghr_R" });
		const result = await pollAccessTokenOnce("DEV", "c");
		expect(result).toEqual({
			kind: "token",
			grant: { accessToken: "gho_TOK", refreshToken: "ghr_R", expiresInSeconds: 28800, scope: "repo" },
		});
	});

	it("maps authorization_pending to pending", async () => {
		mockFetchOnce(200, { error: "authorization_pending" });
		expect(await pollAccessTokenOnce("DEV", "c")).toEqual({ kind: "pending" });
	});

	it("maps slow_down with the server interval", async () => {
		mockFetchOnce(200, { error: "slow_down", interval: 10 });
		expect(await pollAccessTokenOnce("DEV", "c")).toEqual({ kind: "slow_down", intervalSeconds: 10 });
	});

	it("maps a terminal error", async () => {
		mockFetchOnce(200, { error: "access_denied", error_description: "user denied" });
		const result = await pollAccessTokenOnce("DEV", "c");
		expect(result).toMatchObject({ kind: "error" });
		expect((result as Extract<PollAttempt, { kind: "error" }>).message).toMatch(/access_denied/);
	});
});

describe("pollForAccessToken (blocking loop)", () => {
	const grant = {
		deviceCode: "DEV",
		userCode: "WXYZ",
		verificationUri: "https://github.com/login/device",
		intervalSeconds: 1,
		expiresInSeconds: 60,
	};

	it("waits through pending, backs off on slow_down, then returns the token", async () => {
		const attempts: PollAttempt[] = [
			{ kind: "pending" },
			{ kind: "slow_down", intervalSeconds: 7 },
			{ kind: "token", grant: { accessToken: "gho_DONE" } },
		];
		let i = 0;
		const waits: number[] = [];
		const token = await pollForAccessToken(grant, "c", {
			wait: async (ms) => {
				waits.push(ms);
			},
			pollOnce: async () => attempts[i++],
		});
		expect(token.accessToken).toBe("gho_DONE");
		// The third wait reflects the slow_down back-off (>= previous interval + 5s).
		expect(waits[2]).toBeGreaterThanOrEqual(waits[1]);
	});

	it("throws on a terminal error attempt", async () => {
		await expect(
			pollForAccessToken(grant, "c", {
				wait: async () => {},
				pollOnce: async () => ({ kind: "error", message: "expired_token" }),
			}),
		).rejects.toThrow(/expired_token/);
	});

	it("throws cancelled when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			pollForAccessToken(grant, "c", {
				signal: controller.signal,
				wait: async () => {},
				pollOnce: async () => ({ kind: "pending" }),
			}),
		).rejects.toThrow(/cancelled/i);
	});
});

describe("refreshAccessToken", () => {
	it("returns the refreshed grant", async () => {
		mockFetchOnce(200, { access_token: "gho_NEW", refresh_token: "ghr_NEW", expires_in: 28800 });
		const grant = await refreshAccessToken("ghr_OLD", "c");
		expect(grant).toMatchObject({ accessToken: "gho_NEW", refreshToken: "ghr_NEW", expiresInSeconds: 28800 });
	});

	it("throws when the refresh is rejected", async () => {
		mockFetchOnce(200, { error: "bad_refresh_token" });
		await expect(refreshAccessToken("ghr_OLD", "c")).rejects.toThrow(/bad_refresh_token/);
	});
});
