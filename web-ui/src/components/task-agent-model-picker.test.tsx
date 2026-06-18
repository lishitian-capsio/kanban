import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskAgentModelPickerResult } from "@/components/task-agent-model-picker";
import type {
	RuntimeAgentProviderConfig,
	RuntimeAgentProviderSetListResponse,
	RuntimeKanbanProviderModel,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";

const fetchAgentProviderSetsMock = vi.hoisted(() => vi.fn());
const fetchKanbanProviderModelsMock = vi.hoisted(() => vi.fn());

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "pi", label: "Pi", binary: "pi" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
	]),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchAgentProviderSets: fetchAgentProviderSetsMock,
	fetchKanbanProviderModels: fetchKanbanProviderModelsMock,
}));

function provider(agentId: string, name: string, model?: string, models: string[] = []): RuntimeAgentProviderConfig {
	return { agentId, provider: name, ...(model ? { model } : {}), models };
}

/** Build a `listAgentProviders` response: agentId → its provider set + default. */
function providerSets(
	agents: Record<string, { providers: RuntimeAgentProviderConfig[]; defaultProviderId?: string }>,
): RuntimeAgentProviderSetListResponse {
	const response: RuntimeAgentProviderSetListResponse = { agents: {} };
	for (const [agentId, set] of Object.entries(agents)) {
		response.agents[agentId] = {
			agentId,
			providers: set.providers,
			...(set.defaultProviderId ? { defaultProviderId: set.defaultProviderId } : {}),
		};
	}
	return response;
}

function createTaskAgentSettings(settings?: RuntimeTaskAgentSettings): RuntimeTaskAgentSettings | undefined {
	return settings;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

describe("useTaskAgentModelPicker – kanbanProviderOptions (per-agent provider set)", () => {
	it("lists the selected CLI agent's providers with its default first and offers official login", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				claude: {
					providers: [provider("claude", "anthropic"), provider("claude", "openrouter")],
					defaultProviderId: "anthropic",
				},
			}),
		);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "claude",
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		const options = snapshot!.kanbanProviderOptions;
		// The agent's default provider is the first ("") option.
		expect(options[0]).toEqual({ value: "", label: "anthropic" });
		const values = options.map((o) => o.value);
		// Official login is offered for CLI agents.
		expect(values).toContain("official");
		// The other configured provider is listed; the default is not duplicated.
		expect(values).toContain("openrouter");
		expect(values.filter((v) => v === "anthropic")).toHaveLength(0);
	});

	it("never offers official login for the main agent (pi)", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				pi: { providers: [provider("pi", "anthropic")], defaultProviderId: "anthropic" },
			}),
		);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "pi",
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.kanbanProviderOptions).toEqual([{ value: "", label: "anthropic" }]);
		expect(snapshot!.effectiveDefaultProviderId).toBe("anthropic");
	});

	it("defaults a CLI agent with no configured default to official login", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				claude: { providers: [provider("claude", "anthropic")] },
			}),
		);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "claude",
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.effectiveDefaultProviderId).toBe("official");
		const options = snapshot!.kanbanProviderOptions;
		// Official login is the implicit default → it's the first ("") option, not a duplicate.
		expect(options[0]).toEqual({ value: "", label: "Official login" });
		expect(options.filter((o) => o.value === "official")).toHaveLength(0);
		expect(options).toContainEqual({ value: "anthropic", label: "anthropic" });
	});

	it("scopes the provider list to the selected agent and re-scopes when the agent changes", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				claude: { providers: [provider("claude", "anthropic")], defaultProviderId: "anthropic" },
				pi: { providers: [provider("pi", "cline")], defaultProviderId: "cline" },
			}),
		);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness({ agentId }: { agentId: "claude" | "pi" }) {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId,
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness agentId="claude" />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(snapshot!.kanbanProviderOptions.map((o) => o.value)).not.toContain("cline");

		await act(async () => root.render(<Harness agentId="pi" />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		const piValues = snapshot!.kanbanProviderOptions.map((o) => o.value);
		expect(piValues).not.toContain("anthropic");
		expect(snapshot!.effectiveDefaultProviderId).toBe("cline");
	});
});

describe("useTaskAgentModelPicker – providerDefaultModels", () => {
	it("returns a map of provider id → its configured default model", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				pi: {
					providers: [
						provider("pi", "anthropic", "claude-opus-4-20250514"),
						provider("pi", "groq", "llama-3.3-70b-versatile"),
						provider("pi", "openrouter"), // no default model
					],
					defaultProviderId: "anthropic",
				},
			}),
		);
		fetchKanbanProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "pi",
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: "claude-opus-4-20250514",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.providerDefaultModels).toEqual({
			anthropic: "claude-opus-4-20250514",
			groq: "llama-3.3-70b-versatile",
		});
	});
});

describe("useTaskAgentModelPicker – provider-aware model default label", () => {
	it("derives the agent default provider's configured default model and loads its models", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				pi: {
					providers: [
						provider("pi", "cline", "cline-sonnet"),
						provider("pi", "anthropic", "claude-opus-4-20250514"),
					],
					defaultProviderId: "cline",
				},
			}),
		);
		const clineModels = [
			{ id: "cline-sonnet", name: "Kanban Sonnet" },
			{ id: "cline-opus", name: "Kanban Opus" },
		];
		fetchKanbanProviderModelsMock.mockResolvedValue(clineModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "pi",
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(fetchKanbanProviderModelsMock).toHaveBeenCalledWith(null, "cline");
		expect(snapshot).not.toBeNull();
		expect(snapshot!.providerModels).toEqual(clineModels);
		expect(snapshot!.effectiveDefaultModelId).toBe("cline-sonnet");
	});

	it("does not borrow the global default model for an overridden provider without a configured default", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				pi: {
					providers: [provider("pi", "anthropic", "claude-opus-4-20250514"), provider("pi", "custom")],
					defaultProviderId: "anthropic",
				},
			}),
		);
		const customModels = [{ id: "custom/model-a", name: "Model A" }];
		fetchKanbanProviderModelsMock.mockResolvedValue(customModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "pi",
				agentSettings: createTaskAgentSettings({ providerId: "custom" }),
				defaultAgentId: "pi",
				defaultModelId: "claude-opus-4-20250514",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.effectiveDefaultModelId).toBeNull();
		expect(snapshot!.kanbanModelOptions[0]).toEqual({ value: "", label: "Default" });
	});

	it("shows the selected provider's default model name when provider is overridden", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				pi: {
					providers: [
						provider("pi", "anthropic", "claude-opus-4-20250514"),
						provider("pi", "groq", "llama-3.3-70b-versatile"),
					],
					defaultProviderId: "anthropic",
				},
			}),
		);
		const groqModels = [
			{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
			{ id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
		];
		fetchKanbanProviderModelsMock.mockResolvedValue(groqModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "pi",
				agentSettings: createTaskAgentSettings({ providerId: "groq" }), // explicit provider override to groq
				defaultAgentId: "pi",
				defaultModelId: "claude-opus-4-20250514", // global default is Anthropic's model
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		// The first model option should show groq's default model, not the global Anthropic model
		const defaultOption = snapshot!.kanbanModelOptions[0]!;
		expect(defaultOption.value).toBe("");
		expect(defaultOption.label).toBe("Llama 3.3 70B");
	});

	it("shows the global default model when no provider override is set", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				pi: {
					providers: [
						provider("pi", "anthropic", "claude-opus-4-20250514"),
						provider("pi", "groq", "llama-3.3-70b-versatile"),
					],
					defaultProviderId: "anthropic",
				},
			}),
		);
		const anthropicModels = [
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
		];
		fetchKanbanProviderModelsMock.mockResolvedValue(anthropicModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "pi",
				agentSettings: undefined, // no provider override
				defaultAgentId: "pi",
				defaultModelId: "claude-opus-4-20250514",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		const defaultOption = snapshot!.kanbanModelOptions[0]!;
		expect(defaultOption.value).toBe("");
		expect(defaultOption.label).toBe("Claude Opus 4");
	});

	it("uses the provider config's own models when the registry returns none", async () => {
		fetchAgentProviderSetsMock.mockResolvedValue(
			providerSets({
				claude: {
					providers: [provider("claude", "anthropic", "sonnet", ["sonnet", "opus"])],
					defaultProviderId: "anthropic",
				},
			}),
		);
		fetchKanbanProviderModelsMock.mockResolvedValue([]); // not in bundled registry

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "claude",
				agentSettings: undefined,
				defaultAgentId: "pi",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.providerModels).toEqual([
			{ id: "sonnet", name: "sonnet" },
			{ id: "opus", name: "opus" },
		]);
	});
});

describe("TaskAgentModelPicker – auto-reset invalid model selection", () => {
	it("resets savedModelId to the first real model when the selected model is not in the options list", async () => {
		const onKanbanSettingsChange = vi.fn();
		const modelOptions = [
			{ value: "", label: "Llama 3.3 70B" },
			{ value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
			{ value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
		];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={createTaskAgentSettings({
						providerId: "groq",
						modelId: "claude-opus-4-20250514",
					})}
					onKanbanSettingsChange={onKanbanSettingsChange}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Anthropic" }]}
					kanbanModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					defaultProviderId="anthropic"
				/>,
			),
		);

		// The effect should have fired and selected the first real model
		expect(onKanbanSettingsChange).toHaveBeenCalledWith({
			providerId: "groq",
			modelId: "llama-3.3-70b-versatile",
		});
	});

	it("does not reset when the selected model exists in the options list", async () => {
		const onKanbanSettingsChange = vi.fn();
		const modelOptions = [
			{ value: "", label: "Llama 3.3 70B" },
			{ value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
			{ value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
		];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={createTaskAgentSettings({
						providerId: "groq",
						modelId: "llama-3.3-70b-versatile",
					})}
					onKanbanSettingsChange={onKanbanSettingsChange}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Groq" }]}
					kanbanModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					defaultProviderId="anthropic"
				/>,
			),
		);

		expect(onKanbanSettingsChange).not.toHaveBeenCalled();
	});

	it("does not reset while models are still loading", async () => {
		const onKanbanSettingsChange = vi.fn();
		const modelOptions = [{ value: "", label: "Default" }];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={createTaskAgentSettings({
						providerId: "groq",
						modelId: "claude-opus-4-20250514",
					})}
					onKanbanSettingsChange={onKanbanSettingsChange}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Anthropic" }]}
					kanbanModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={true} // <-- still loading
					defaultAgentId={"pi"}
					defaultProviderId="anthropic"
				/>,
			),
		);

		expect(onKanbanSettingsChange).not.toHaveBeenCalled();
	});

	it("does not reset when model options only contain the default placeholder (race condition guard)", async () => {
		const onKanbanSettingsChange = vi.fn();
		// Only the "Default" placeholder — real models haven't loaded yet
		const modelOptions = [{ value: "", label: "Default" }];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={createTaskAgentSettings({
						providerId: "groq",
						modelId: "mixtral-8x7b-32768",
					})}
					onKanbanSettingsChange={onKanbanSettingsChange}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Groq" }]}
					kanbanModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false} // <-- false (initial state before fetch sets it to true)
					defaultAgentId={"pi"}
					defaultProviderId="anthropic"
				/>,
			),
		);

		// Should NOT clear the model — the stale/empty options list should not trigger auto-correct
		expect(onKanbanSettingsChange).not.toHaveBeenCalled();
	});
});

describe("TaskAgentModelPicker – inherited default reasoning effort", () => {
	it("shows reasoning metadata for an inherited default model and opens reasoning choices immediately", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={undefined}
					onKanbanSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Kanban" }]}
					kanbanModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		expect(container.textContent).toContain("GPT-5.4 (High)");

		const trigger = document.getElementById("kanban-chat-model-picker");
		expect(trigger).not.toBeNull();
		await act(async () => {
			(trigger as HTMLElement).click();
		});

		expect(document.body.textContent).toContain("Reasoning effort");
	});

	it("retains inherited reasoning effort until model capability data is available", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		const renderPicker = async (providerModels: RuntimeKanbanProviderModel[]) => {
			await act(async () =>
				root.render(
					<TaskAgentModelPicker
						agentId={"pi"}
						onAgentIdChange={() => {}}
						agentSettings={undefined}
						onKanbanSettingsChange={() => {}}
						agentOptions={[{ value: "", label: "Kanban" }]}
						kanbanProviderOptions={[{ value: "", label: "Kanban" }]}
						kanbanModelOptions={[
							{ value: "", label: "GPT-5.4" },
							{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
						]}
						effectiveDefaultModelId="openai/gpt-5.4"
						providerModels={providerModels}
						isLoadingProviders={false}
						isLoadingModels={false}
						defaultAgentId={"pi"}
						defaultProviderId="cline"
						defaultReasoningEffort="high"
					/>,
				),
			);
		};

		await renderPicker([]);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		await renderPicker([
			{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
			{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
		]);

		expect(container.textContent).toContain("GPT-5.4 (High)");
	});

	it("persists a reasoning-only override when model stays on default", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onKanbanSettingsChange = vi.fn();

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={undefined}
					onKanbanSettingsChange={onKanbanSettingsChange}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Kanban" }]}
					kanbanModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		const modelTrigger = document.getElementById("kanban-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});

		const lowReasoningButton = Array.from(document.querySelectorAll("button")).find((button) =>
			button.textContent?.trim().toLowerCase().startsWith("low"),
		);
		expect(lowReasoningButton).not.toBeUndefined();
		await act(async () => {
			(lowReasoningButton as HTMLButtonElement).click();
		});

		expect(onKanbanSettingsChange).toHaveBeenLastCalledWith({
			reasoningEffort: "low",
		});
	});

	it("persists an explicit default reasoning override when the task inherits a global reasoning effort", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onKanbanSettingsChange = vi.fn();

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={undefined}
					onKanbanSettingsChange={onKanbanSettingsChange}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Kanban" }]}
					kanbanModelOptions={[{ value: "", label: "GPT-5.4" }]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		const modelTrigger = document.getElementById("kanban-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});

		const defaultReasoningButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Default",
		);
		expect(defaultReasoningButton).not.toBeUndefined();
		await act(async () => {
			(defaultReasoningButton as HTMLButtonElement).click();
		});

		expect(onKanbanSettingsChange).toHaveBeenLastCalledWith({});
	});

	it("does not inherit the global reasoning effort for explicit task model overrides", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"pi"}
					onAgentIdChange={() => {}}
					agentSettings={createTaskAgentSettings({
						modelId: "openai/gpt-5.3-codex",
					})}
					onKanbanSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Kanban" }]}
					kanbanProviderOptions={[{ value: "", label: "Kanban" }]}
					kanbanModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		expect(container.textContent).toContain("GPT-5.3 Codex");
		expect(container.textContent).not.toContain("GPT-5.3 Codex (High)");
	});
});

describe("TaskAgentModelPicker – official login provider", () => {
	it("shows the provider picker but hides the model picker when the provider is official login", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"claude"}
					onAgentIdChange={() => {}}
					agentSettings={undefined}
					onKanbanSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Claude Code" }]}
					kanbanProviderOptions={[
						{ value: "", label: "Official login" },
						{ value: "anthropic", label: "anthropic" },
					]}
					kanbanModelOptions={[{ value: "", label: "Default" }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"pi"}
					// The agent's effective default provider is the official-login sentinel.
					defaultProviderId="official"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		// The provider picker is shown…
		expect(container.textContent).toContain("Provider");
		// …but the model picker is not (the official-login sentinel has no models).
		expect(document.getElementById("kanban-chat-model-picker")).toBeNull();
		expect(container.textContent).not.toContain("Model");
	});
});
