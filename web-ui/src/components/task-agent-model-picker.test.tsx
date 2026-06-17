import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskAgentModelPickerResult } from "@/components/task-agent-model-picker";
import type {
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderModel,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";

const fetchKanbanProviderCatalogMock = vi.hoisted(() => vi.fn());
const fetchKanbanProviderModelsMock = vi.hoisted(() => vi.fn());

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "pi", label: "Pi", binary: "pi" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
	]),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchKanbanProviderCatalog: fetchKanbanProviderCatalogMock,
	fetchKanbanProviderModels: fetchKanbanProviderModelsMock,
}));

function createProvider(
	id: string,
	name: string,
	enabled: boolean,
	defaultModelId: string | null = null,
): RuntimeKanbanProviderCatalogItem {
	return { id, name, oauthSupported: false, enabled, defaultModelId, baseUrl: null, supportsBaseUrl: false, protocols: [{ protocol: "openai" }], models: [], modelsSourceUrl: null, apiKeyPreview: null };
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

describe("useTaskAgentModelPicker – kanbanProviderOptions", () => {
	it("shows all providers except the default, regardless of enabled flag", async () => {
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("cline", "Kanban", true),
			createProvider("openrouter", "OpenRouter", false),
			createProvider("anthropic", "Anthropic", false),
		];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "cline",
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
		expect(options[0]).toEqual({ value: "", label: "Kanban" });
		const nonDefault = options.slice(1);
		expect(nonDefault).toEqual([
			{ value: "openrouter", label: "OpenRouter" },
			{ value: "anthropic", label: "Anthropic" },
		]);
	});
	it("excludes the default provider from the explicit list", async () => {
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("cline", "Kanban", true),
			createProvider("anthropic", "Anthropic", true),
		];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "anthropic",
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
		expect(options[0]).toEqual({ value: "", label: "Anthropic" });
		const values = options.slice(1).map((o) => o.value);
		expect(values).toContain("cline");
		expect(values).not.toContain("anthropic");
	});

	it("returns only the default option when catalog is empty", async () => {
		fetchKanbanProviderCatalogMock.mockResolvedValue([]);
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
				defaultProviderId: "cline",
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
		expect(snapshot!.kanbanProviderOptions).toEqual([{ value: "", label: "cline" }]);
	});
});

describe("useTaskAgentModelPicker – providerDefaultModels", () => {
	it("returns a map of provider ID → default model ID", async () => {
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
			createProvider("openrouter", "OpenRouter", true), // no default model
		];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "anthropic",
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
	it("loads inherited models for managed OAuth providers and derives their catalog default model", async () => {
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("cline", "Kanban", true, "cline-sonnet"),
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
		];
		const clineModels = [
			{ id: "cline-sonnet", name: "Kanban Sonnet" },
			{ id: "cline-opus", name: "Kanban Opus" },
		];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "cline",
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

	it("does not borrow the global default model for an overridden provider without a catalog default", async () => {
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("custom", "Custom Provider", true),
		];
		const customModels = [{ id: "custom/model-a", name: "Model A" }];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "anthropic",
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
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
		];
		const groqModels = [
			{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
			{ id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
		];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "anthropic",
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
		const catalog: RuntimeKanbanProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
		];
		const anthropicModels = [
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
		];
		fetchKanbanProviderCatalogMock.mockResolvedValue(catalog);
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
				defaultProviderId: "anthropic",
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
