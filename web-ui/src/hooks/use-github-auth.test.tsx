import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeGithubAuthStatus,
	RuntimeGithubBeginLoginResponse,
	RuntimeGithubLogoutResponse,
	RuntimeGithubPendingLoginResponse,
	RuntimeGithubPollLoginResponse,
} from "@/runtime/types";
import { type UseGithubAuthResult, useGithubAuth } from "./use-github-auth";

const queryMocks = vi.hoisted(() => ({
	fetchGithubAuthStatus: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubAuthStatus>>(),
	beginGithubLogin: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubBeginLoginResponse>>(),
	fetchGithubPendingLogin: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubPendingLoginResponse>>(),
	pollGithubLogin: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubPollLoginResponse>>(),
	cancelGithubLogin: vi.fn<(workspaceId: string | null) => Promise<void>>(),
	logoutGithub: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubLogoutResponse>>(),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchGithubAuthStatus: queryMocks.fetchGithubAuthStatus,
	beginGithubLogin: queryMocks.beginGithubLogin,
	fetchGithubPendingLogin: queryMocks.fetchGithubPendingLogin,
	pollGithubLogin: queryMocks.pollGithubLogin,
	cancelGithubLogin: queryMocks.cancelGithubLogin,
	logoutGithub: queryMocks.logoutGithub,
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: vi.fn(),
}));

const signedOut: RuntimeGithubAuthStatus = { authenticated: false, login: null, scope: null, expiresAt: null };
const signedIn: RuntimeGithubAuthStatus = {
	authenticated: true,
	login: "octocat",
	scope: "repo",
	expiresAt: null,
};

// `expiresAt` is a far-future epoch ms so normal flows never trip the client expiry guard.
const FAR_FUTURE = 1_900_000_000_000;
const grant: RuntimeGithubBeginLoginResponse = {
	userCode: "ABCD-1234",
	verificationUri: "https://github.com/login/device",
	intervalSeconds: 5,
	expiresAt: FAR_FUTURE,
};

describe("useGithubAuth", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		for (const mock of Object.values(queryMocks)) {
			mock.mockReset();
		}
		// Sensible defaults: no in-flight login to resume, cancel succeeds. Tests that exercise
		// resume / cancel override these.
		queryMocks.fetchGithubPendingLogin.mockResolvedValue({ pending: null });
		queryMocks.cancelGithubLogin.mockResolvedValue();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function renderHook(): Promise<{ getState: () => UseGithubAuthResult }> {
		let hookResult: UseGithubAuthResult | null = null;

		function HookHarness(): null {
			hookResult = useGithubAuth(null);
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		return {
			getState: () => {
				if (!hookResult) {
					throw new Error("Hook state not available");
				}
				return hookResult;
			},
		};
	}

	it("loads and surfaces the signed-in status", async () => {
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedIn);

		const { getState } = await renderHook();

		expect(getState().status).toEqual(signedIn);
		expect(getState().statusError).toBeNull();
		expect(getState().flow.kind).toBe("idle");
	});

	it("exposes statusError without blanking when the status query fails", async () => {
		queryMocks.fetchGithubAuthStatus.mockRejectedValue(new Error("offline"));

		const { getState } = await renderHook();

		expect(getState().status).toBeNull();
		expect(getState().statusError).not.toBeNull();
	});

	it("login() enters the awaiting state carrying the device-flow prompt", async () => {
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});

		const { flow } = getState();
		expect(flow.kind).toBe("awaiting");
		if (flow.kind === "awaiting") {
			expect(flow.prompt.userCode).toBe("ABCD-1234");
			expect(flow.prompt.verificationUri).toBe("https://github.com/login/device");
		}
	});

	it("surfaces a begin-login failure as a flow error (remote unreachable)", async () => {
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockRejectedValue(new Error("network down"));

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});

		const { flow } = getState();
		expect(flow.kind).toBe("error");
		if (flow.kind === "error") {
			expect(flow.message).toBe("network down");
		}
	});

	it("polls until completion, then stores the status and returns to idle", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);
		queryMocks.pollGithubLogin
			.mockResolvedValueOnce({ state: "pending" })
			.mockResolvedValueOnce({ state: "complete", status: signedIn });

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});
		expect(getState().flow.kind).toBe("awaiting");

		// First tick → pending, still awaiting.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(getState().flow.kind).toBe("awaiting");

		// Second tick → complete.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		expect(getState().flow.kind).toBe("idle");
		expect(getState().status).toEqual(signedIn);
		expect(queryMocks.pollGithubLogin).toHaveBeenCalledTimes(2);
	});

	it("surfaces a poll error as a terminal flow error", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);
		queryMocks.pollGithubLogin.mockResolvedValue({ state: "error", message: "access_denied" });

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		const { flow } = getState();
		expect(flow.kind).toBe("error");
		if (flow.kind === "error") {
			expect(flow.message).toBe("access_denied");
		}
	});

	it("tolerates a single transient poll failure, then completes", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);
		queryMocks.pollGithubLogin
			.mockRejectedValueOnce(new Error("transient blip"))
			.mockResolvedValueOnce({ state: "complete", status: signedIn });

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});

		// First tick throws — a lone blip must NOT abort the flow.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(getState().flow.kind).toBe("awaiting");

		// Second tick succeeds → completes.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(getState().flow.kind).toBe("idle");
		expect(getState().status).toEqual(signedIn);
	});

	it("surfaces a flow error after repeated consecutive poll failures (no silent infinite spin)", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);
		queryMocks.pollGithubLogin.mockRejectedValue(new Error("proxy refused connection"));

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});

		// Three consecutive failures must flip the flow to a visible error.
		for (let i = 0; i < 3; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});
		}

		const { flow } = getState();
		expect(flow.kind).toBe("error");
		if (flow.kind === "error") {
			expect(flow.message).toContain("proxy refused connection");
		}
	});

	it("stops with an expired error once the code lifetime elapses", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		// Code expires 1s from now; the first poll tick (at +5s) is already past it.
		queryMocks.beginGithubLogin.mockResolvedValue({ ...grant, expiresAt: Date.now() + 1000 });

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		const { flow } = getState();
		expect(flow.kind).toBe("error");
		expect(queryMocks.pollGithubLogin).not.toHaveBeenCalled();
	});

	it("resumes an in-flight login after a refresh, then completes once authorized", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		// A login was started before this mount (e.g. the page was refreshed mid-flow); the
		// backend still holds the pending device-flow login.
		queryMocks.fetchGithubPendingLogin.mockResolvedValue({
			pending: {
				userCode: "WXYZ-9999",
				verificationUri: "https://github.com/login/device",
				intervalSeconds: 5,
				expiresAt: FAR_FUTURE,
			},
		});
		queryMocks.pollGithubLogin.mockResolvedValue({ state: "complete", status: signedIn });

		const { getState } = await renderHook();

		// Without the user touching anything, the hook picks the login back up.
		const resumed = getState().flow;
		expect(resumed.kind).toBe("awaiting");
		if (resumed.kind === "awaiting") {
			expect(resumed.prompt.userCode).toBe("WXYZ-9999");
		}

		// It polls the server-held login (no device code needed) and completes.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(getState().flow.kind).toBe("idle");
		expect(getState().status).toEqual(signedIn);
		expect(queryMocks.pollGithubLogin).toHaveBeenCalled();
	});

	it("does not resume when there is no pending login (stays idle)", async () => {
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.fetchGithubPendingLogin.mockResolvedValue({ pending: null });

		const { getState } = await renderHook();

		expect(getState().flow.kind).toBe("idle");
	});

	it("resets to idle when the server reports no pending login mid-poll", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);
		// The pending login was completed/cancelled elsewhere (e.g. another tab) → idle.
		queryMocks.pollGithubLogin.mockResolvedValue({ state: "idle" });

		const { getState } = await renderHook();
		await act(async () => {
			await getState().login();
		});
		expect(getState().flow.kind).toBe("awaiting");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(getState().flow.kind).toBe("idle");
	});

	it("cancelLogin() returns to idle and halts polling", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue(grant);
		queryMocks.pollGithubLogin.mockResolvedValue({ state: "pending" });

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});
		await act(() => {
			getState().cancelLogin();
		});
		expect(getState().flow.kind).toBe("idle");
		// Cancel must clear the server-held pending login so it can't be resumed later.
		expect(queryMocks.cancelGithubLogin).toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(15000);
		});
		expect(queryMocks.pollGithubLogin).not.toHaveBeenCalled();
	});

	it("logout() clears the status to signed-out", async () => {
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedIn);
		queryMocks.logoutGithub.mockResolvedValue({ status: signedOut });

		const { getState } = await renderHook();
		expect(getState().status?.authenticated).toBe(true);

		await act(async () => {
			await getState().logout();
		});

		expect(getState().status).toEqual(signedOut);
	});
});
