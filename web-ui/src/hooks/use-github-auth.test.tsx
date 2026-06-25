import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeGithubAuthStatus,
	RuntimeGithubBeginLoginResponse,
	RuntimeGithubLogoutResponse,
	RuntimeGithubPollLoginResponse,
} from "@/runtime/types";
import { type UseGithubAuthResult, useGithubAuth } from "./use-github-auth";

const queryMocks = vi.hoisted(() => ({
	fetchGithubAuthStatus: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubAuthStatus>>(),
	beginGithubLogin: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubBeginLoginResponse>>(),
	pollGithubLogin:
		vi.fn<(workspaceId: string | null, deviceCode: string) => Promise<RuntimeGithubPollLoginResponse>>(),
	logoutGithub: vi.fn<(workspaceId: string | null) => Promise<RuntimeGithubLogoutResponse>>(),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchGithubAuthStatus: queryMocks.fetchGithubAuthStatus,
	beginGithubLogin: queryMocks.beginGithubLogin,
	pollGithubLogin: queryMocks.pollGithubLogin,
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

const grant: RuntimeGithubBeginLoginResponse = {
	deviceCode: "device-123",
	userCode: "ABCD-1234",
	verificationUri: "https://github.com/login/device",
	intervalSeconds: 5,
	expiresInSeconds: 900,
};

describe("useGithubAuth", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		for (const mock of Object.values(queryMocks)) {
			mock.mockReset();
		}
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

	it("stops with an expired error once the code lifetime elapses", async () => {
		vi.useFakeTimers();
		queryMocks.fetchGithubAuthStatus.mockResolvedValue(signedOut);
		queryMocks.beginGithubLogin.mockResolvedValue({ ...grant, expiresInSeconds: 1 });

		const { getState } = await renderHook();

		await act(async () => {
			await getState().login();
		});
		// First tick is at +5s, already past the 1s code lifetime.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		const { flow } = getState();
		expect(flow.kind).toBe("error");
		expect(queryMocks.pollGithubLogin).not.toHaveBeenCalled();
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
