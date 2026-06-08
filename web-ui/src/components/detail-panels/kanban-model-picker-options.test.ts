import { describe, expect, it } from "vitest";

import {
	buildKanbanAgentModelPickerOptions,
	buildKanbanSelectedModelButtonText,
	CLINE_RECOMMENDED_MODEL_IDS,
	formatKanbanReasoningEffortLabel,
	formatKanbanSelectedModelButtonText,
	getKanbanReasoningEnabledModelIds,
	resolveKanbanModelDisplayName,
} from "@/components/detail-panels/kanban-model-picker-options";
import type { RuntimeKanbanProviderModel } from "@/runtime/types";

function createModel(id: string, name: string): RuntimeKanbanProviderModel {
	return { id, name };
}

describe("buildKanbanAgentModelPickerOptions", () => {
	it("returns recommended models first for the cline provider", () => {
		const models: RuntimeKanbanProviderModel[] = [
			createModel("openai/gpt-5.5", "GPT-5.5"),
			createModel("openai/gpt-5.2", "GPT-5.2"),
			createModel("anthropic/claude-opus-4.7", "Claude Opus 4.7"),
			createModel("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6"),
			createModel("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"),
		];

		const result = buildKanbanAgentModelPickerOptions("cline", models);

		expect(result.options.map((option) => option.value)).toEqual([...CLINE_RECOMMENDED_MODEL_IDS, "openai/gpt-5.2"]);
		expect(result.recommendedModelIds).toEqual([...CLINE_RECOMMENDED_MODEL_IDS]);
		expect(result.shouldPinSelectedModelToTop).toBe(false);
	});

	it("keeps original ordering for non-cline providers", () => {
		const models: RuntimeKanbanProviderModel[] = [
			createModel("model-a", "Model A"),
			createModel("model-b", "Model B"),
		];

		const result = buildKanbanAgentModelPickerOptions("openrouter", models);

		expect(result.options.map((option) => option.value)).toEqual(["model-a", "model-b"]);
		expect(result.recommendedModelIds).toEqual([]);
		expect(result.shouldPinSelectedModelToTop).toBe(true);
	});
});

describe("cline model labels", () => {
	it("formats reasoning effort labels for display", () => {
		expect(formatKanbanReasoningEffortLabel("")).toBe("Default");
		expect(formatKanbanReasoningEffortLabel("xhigh")).toBe("Extra high");
	});

	it("appends non-default reasoning effort to the selected model label", () => {
		expect(
			formatKanbanSelectedModelButtonText({
				modelName: "GPT-5.4",
				reasoningEffort: "high",
				showReasoningEffort: true,
			}),
		).toBe("GPT-5.4 (High)");
	});

	it("omits reasoning effort when it is not shown", () => {
		expect(
			formatKanbanSelectedModelButtonText({
				modelName: "GPT-5.4",
				reasoningEffort: "high",
				showReasoningEffort: false,
			}),
		).toBe("GPT-5.4");
	});

	it("returns model IDs that support reasoning effort", () => {
		const models: RuntimeKanbanProviderModel[] = [
			{ id: "model-a", name: "Model A", supportsReasoningEffort: true },
			{ id: "model-b", name: "Model B", supportsReasoningEffort: false },
			{ id: "model-c", name: "Model C", supportsReasoningEffort: true },
		];

		expect(getKanbanReasoningEnabledModelIds(models)).toEqual(["model-a", "model-c"]);
	});

	it("builds selected model button text with loading and reasoning metadata", () => {
		expect(
			buildKanbanSelectedModelButtonText({
				modelOptions: [
					{ value: "openai/gpt-5.4", label: "GPT-5.4" },
					{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
				],
				selectedModelId: "openai/gpt-5.4",
				reasoningEffort: "high",
				showReasoningEffort: true,
			}),
		).toBe("GPT-5.4 (High)");

		expect(
			buildKanbanSelectedModelButtonText({
				modelOptions: [],
				selectedModelId: "",
				showReasoningEffort: false,
				isModelLoading: true,
			}),
		).toBe("Loading models...");
	});

	it("resolves known model IDs to display names", () => {
		expect(resolveKanbanModelDisplayName("openai/gpt-5.5")).toBe("GPT-5.5");
		expect(resolveKanbanModelDisplayName("deepseek/deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
		expect(resolveKanbanModelDisplayName("openai/unknown-model")).toBe("openai/unknown-model");
	});
});
