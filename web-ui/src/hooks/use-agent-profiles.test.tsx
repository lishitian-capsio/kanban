import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseAgentProfilesResult, useAgentProfiles } from "@/hooks/use-agent-profiles";
import type { RuntimeAgentProfile, RuntimeAgentProfileMutationResponse } from "@/runtime/types";

const fetchAgentProfilesMock = vi.hoisted(() => vi.fn());
const createAgentProfileMock = vi.hoisted(() => vi.fn());
const updateAgentProfileMock = vi.hoisted(() => vi.fn());
const deleteAgentProfileMock = vi.hoisted(() => vi.fn());
const selectAgentProfileMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/agent-profile-query", () => ({
	fetchAgentProfiles: (...args: unknown[]) => fetchAgentProfilesMock(...args),
	createAgentProfile: (...args: unknown[]) => createAgentProfileMock(...args),
	updateAgentProfile: (...args: unknown[]) => updateAgentProfileMock(...args),
	deleteAgentProfile: (...args: unknown[]) => deleteAgentProfileMock(...args),
	selectAgentProfile: (...args: unknown[]) => selectAgentProfileMock(...args),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
}));

function profile(overrides: Partial<RuntimeAgentProfile> & Pick<RuntimeAgentProfile, "id" | "name">): RuntimeAgentProfile {
	return {
		agentId: "pi",
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		baseUrl: null,
		reasoningEffort: null,
		region: null,
		gcpProjectId: null,
		gcpRegion: null,
		apiKeyConfigured: false,
		...overrides,
	};
}

function snapshot(
	profiles: RuntimeAgentProfile[],
	selectedByAgent: Record<string, string>,
	affected: RuntimeAgentProfile | null = null,
): RuntimeAgentProfileMutationResponse {
	return { profiles, selectedByAgent, profile: affected };
}

function flushPromises(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

function Harness({ onResult }: { onResult: (result: UseAgentProfilesResult) => void }): null {
	const result = useAgentProfiles({ workspaceId: "workspace-1", agentId: "pi", enabled: true });
	useEffect(() => {
		onResult(result);
	});
	return null;
}

describe("useAgentProfiles", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchAgentProfilesMock.mockReset();
		createAgentProfileMock.mockReset();
		updateAgentProfileMock.mockReset();
		deleteAgentProfileMock.mockReset();
		selectAgentProfileMock.mockReset();
		notifyErrorMock.mockReset();
		fetchAgentProfilesMock.mockResolvedValue({ profiles: [], selectedByAgent: {} });
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
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function mount(onResult: (result: UseAgentProfilesResult) => void): Promise<void> {
		await act(async () => {
			root.render(<Harness onResult={onResult} />);
			await flushPromises();
		});
	}

	it("loads the agent's profiles and derives the selected profile", async () => {
		fetchAgentProfilesMock.mockResolvedValue({
			profiles: [profile({ id: "a", name: "A" }), profile({ id: "b", name: "B" })],
			selectedByAgent: { pi: "b" },
		});
		let latest: UseAgentProfilesResult | null = null;
		await mount((result) => {
			latest = result;
		});

		const result = latest as unknown as UseAgentProfilesResult;
		expect(fetchAgentProfilesMock).toHaveBeenCalledWith("workspace-1", "pi");
		expect(result.profiles).toHaveLength(2);
		expect(result.selectedProfileId).toBe("b");
		expect(result.selectedProfile?.name).toBe("B");
	});

	it("keeps only the active agent's profiles after a mutation snapshot", async () => {
		let latest: UseAgentProfilesResult | null = null;
		await mount((result) => {
			latest = result;
		});
		selectAgentProfileMock.mockResolvedValue(
			snapshot(
				[profile({ id: "a", name: "A", agentId: "pi" }), profile({ id: "x", name: "X", agentId: "claude" })],
				{ pi: "a" },
			),
		);
		await act(async () => {
			await (latest as unknown as UseAgentProfilesResult).selectProfile("a");
			await flushPromises();
		});

		const result = latest as unknown as UseAgentProfilesResult;
		expect(selectAgentProfileMock).toHaveBeenCalledWith("workspace-1", "pi", "a");
		expect(result.profiles.map((item) => item.id)).toEqual(["a"]);
		expect(result.selectedProfileId).toBe("a");
	});

	it("injects the agent id into createProfile", async () => {
		let latest: UseAgentProfilesResult | null = null;
		await mount((result) => {
			latest = result;
		});
		const created = profile({ id: "new", name: "Custom" });
		createAgentProfileMock.mockResolvedValue(snapshot([created], { pi: "new" }, created));
		await act(async () => {
			await (latest as unknown as UseAgentProfilesResult).createProfile({ name: "Custom", providerId: "openai" });
			await flushPromises();
		});

		expect(createAgentProfileMock).toHaveBeenCalledWith("workspace-1", {
			agentId: "pi",
			name: "Custom",
			providerId: "openai",
		});
	});

	it("duplicates a profile by copying its fields under a copy name", async () => {
		fetchAgentProfilesMock.mockResolvedValue({
			profiles: [profile({ id: "a", name: "Fast", modelId: "m1", reasoningEffort: "high" })],
			selectedByAgent: { pi: "a" },
		});
		let latest: UseAgentProfilesResult | null = null;
		await mount((result) => {
			latest = result;
		});
		createAgentProfileMock.mockResolvedValue(
			snapshot([profile({ id: "a", name: "Fast" }), profile({ id: "b", name: "Fast (copy)" })], { pi: "b" }),
		);
		await act(async () => {
			await (latest as unknown as UseAgentProfilesResult).duplicateProfile("a");
			await flushPromises();
		});

		expect(createAgentProfileMock).toHaveBeenCalledWith(
			"workspace-1",
			expect.objectContaining({
				agentId: "pi",
				name: "Fast (copy)",
				modelId: "m1",
				reasoningEffort: "high",
				select: true,
			}),
		);
	});

	it("surfaces and toasts mutation failures without throwing", async () => {
		let latest: UseAgentProfilesResult | null = null;
		await mount((result) => {
			latest = result;
		});
		selectAgentProfileMock.mockRejectedValue(new Error("boom"));
		let actionResult: { ok: boolean; message?: string } | null = null;
		await act(async () => {
			actionResult = await (latest as unknown as UseAgentProfilesResult).selectProfile("a");
			await flushPromises();
		});

		expect(actionResult).toEqual({ ok: false, message: "boom" });
		expect(notifyErrorMock).toHaveBeenCalledWith("boom");
	});
});
