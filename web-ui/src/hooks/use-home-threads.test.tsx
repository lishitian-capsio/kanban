import { DEFAULT_HOME_THREAD_ID } from "@runtime-home-agent-session";
import { act, useEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseHomeThreadsResult, useHomeThreads } from "@/hooks/use-home-threads";
import type { RuntimeConfigResponse, RuntimeHomeChatThread } from "@/runtime/types";

const listHomeThreadsQueryMock = vi.hoisted(() => vi.fn());
const createHomeThreadMutateMock = vi.hoisted(() => vi.fn());
const renameHomeThreadMutateMock = vi.hoisted(() => vi.fn());
const closeHomeThreadMutateMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			listHomeThreads: { query: () => listHomeThreadsQueryMock() },
			createHomeThread: { mutate: (input: object) => createHomeThreadMutateMock(input) },
			renameHomeThread: { mutate: (input: object) => renameHomeThreadMutateMock(input) },
			closeHomeThread: { mutate: (input: object) => closeHomeThreadMutateMock(input) },
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
}));

function createRuntimeConfig(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	return {
		selectedAgentId: "pi",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: "pi",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: null,
		readyForReviewNotificationsEnabled: true,
		detectedCommands: ["pi", "claude"],
		agents: [],
		shortcuts: [],
		kanbanProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		proxyEnabled: false,
		proxyHost: "",
		proxyPort: "",
		proxyUsername: "",
		proxyPassword: "",
		noProxy: "",
		...overrides,
	};
}

function createThread(overrides: Partial<RuntimeHomeChatThread> = {}): RuntimeHomeChatThread {
	return {
		id: "thread-1",
		agentId: "claude",
		name: "Debugging",
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

function flushPromises(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

function Harness({ onResult }: { onResult: (result: UseHomeThreadsResult) => void }): null {
	const result = useHomeThreads({ currentProjectId: "workspace-1", runtimeProjectConfig: createRuntimeConfig() });
	useEffect(() => {
		onResult(result);
	});
	return null;
}

// Mirrors the real app, where `runtimeProjectConfig` is a stable reference once
// loaded (it does not churn on every render). With a stable config there is no
// effect re-run to incidentally cancel/retry an in-flight load, so a failed
// initial load is not masked — this is what exposes the restart "threads
// vanished" bug.
function StableHarness({ onResult }: { onResult: (result: UseHomeThreadsResult) => void }): null {
	const config = useMemo(() => createRuntimeConfig(), []);
	const result = useHomeThreads({ currentProjectId: "workspace-1", runtimeProjectConfig: config });
	useEffect(() => {
		onResult(result);
	});
	return null;
}

describe("useHomeThreads", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		listHomeThreadsQueryMock.mockReset();
		createHomeThreadMutateMock.mockReset();
		renameHomeThreadMutateMock.mockReset();
		closeHomeThreadMutateMock.mockReset();
		notifyErrorMock.mockReset();
		listHomeThreadsQueryMock.mockResolvedValue({ ok: true, threads: [] });
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("always prepends a synthetic default thread following the global agent", async () => {
		listHomeThreadsQueryMock.mockResolvedValue({ ok: true, threads: [createThread()] });
		let latest: UseHomeThreadsResult | null = null;

		await act(async () => {
			root.render(
				<Harness
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await flushPromises();
		});

		const result = latest as unknown as UseHomeThreadsResult;
		expect(result.threads).toHaveLength(2);
		expect(result.threads[0]).toMatchObject({ id: DEFAULT_HOME_THREAD_ID, agentId: "pi", isDefault: true });
		expect(result.threads[1]).toMatchObject({ id: "thread-1", agentId: "claude", isDefault: false });
		expect(result.activeThreadId).toBe(DEFAULT_HOME_THREAD_ID);
	});

	it("recovers persisted threads after a transient first-load failure (no permanent poisoning)", async () => {
		// On restart the very first listHomeThreads can fail transiently (workspace
		// scope not yet resolvable during boot migrations/locks, or auth not yet
		// established in --host/passcode mode). The backend still has the threads,
		// so a later attempt succeeds. The hook must NOT cache the failure as an
		// empty "loaded" result and give up — that hides every persisted thread
		// behind the synthetic Default for the whole session.
		vi.useFakeTimers();
		try {
			listHomeThreadsQueryMock
				.mockRejectedValueOnce(new Error("Unknown workspace ID: workspace-1"))
				.mockResolvedValue({ ok: true, threads: [createThread()] });
			let latest: UseHomeThreadsResult | null = null;

			await act(async () => {
				root.render(
					<StableHarness
						onResult={(result) => {
							latest = result;
						}}
					/>,
				);
				await Promise.resolve();
				await Promise.resolve();
			});

			// Let any scheduled retry fire.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});

			const result = latest as unknown as UseHomeThreadsResult;
			expect(listHomeThreadsQueryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(result.threads.map((thread) => thread.id)).toEqual([DEFAULT_HOME_THREAD_ID, "thread-1"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("creates a thread, auto-selects it, and appends it to the list", async () => {
		const created = createThread({ id: "thread-new", name: "Refactor", agentId: "codex" });
		createHomeThreadMutateMock.mockResolvedValue({ ok: true, thread: created });
		let latest: UseHomeThreadsResult | null = null;

		await act(async () => {
			root.render(
				<Harness
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			await (latest as unknown as UseHomeThreadsResult).createThread({ name: "Refactor", agentId: "codex" });
			await flushPromises();
		});

		const result = latest as unknown as UseHomeThreadsResult;
		expect(createHomeThreadMutateMock).toHaveBeenCalledWith({ name: "Refactor", agentId: "codex" });
		expect(result.activeThreadId).toBe("thread-new");
		expect(result.threads.map((thread) => thread.id)).toEqual([DEFAULT_HOME_THREAD_ID, "thread-new"]);
	});

	it("closes the active thread and falls back to the default", async () => {
		const existing = createThread({ id: "thread-1" });
		listHomeThreadsQueryMock.mockResolvedValue({ ok: true, threads: [existing] });
		closeHomeThreadMutateMock.mockResolvedValue({ ok: true, thread: existing });
		let latest: UseHomeThreadsResult | null = null;

		await act(async () => {
			root.render(
				<Harness
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			(latest as unknown as UseHomeThreadsResult).setActiveThread("thread-1");
			await flushPromises();
		});
		expect((latest as unknown as UseHomeThreadsResult).activeThreadId).toBe("thread-1");

		await act(async () => {
			await (latest as unknown as UseHomeThreadsResult).closeThread("thread-1");
			await flushPromises();
		});

		const result = latest as unknown as UseHomeThreadsResult;
		expect(closeHomeThreadMutateMock).toHaveBeenCalledWith({ id: "thread-1" });
		expect(result.threads.map((thread) => thread.id)).toEqual([DEFAULT_HOME_THREAD_ID]);
		expect(result.activeThreadId).toBe(DEFAULT_HOME_THREAD_ID);
	});

	it("never closes or renames the default thread", async () => {
		let latest: UseHomeThreadsResult | null = null;

		await act(async () => {
			root.render(
				<Harness
					onResult={(result) => {
						latest = result;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			await (latest as unknown as UseHomeThreadsResult).closeThread(DEFAULT_HOME_THREAD_ID);
			await (latest as unknown as UseHomeThreadsResult).renameThread(DEFAULT_HOME_THREAD_ID, "Nope");
			await flushPromises();
		});

		expect(closeHomeThreadMutateMock).not.toHaveBeenCalled();
		expect(renameHomeThreadMutateMock).not.toHaveBeenCalled();
	});
});
