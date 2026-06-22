import type { SearchSelectOption } from "@/components/search-select-dropdown";
import type { RuntimeKanbanProviderModel, RuntimeReasoningEffort } from "@/runtime/types";

const CLINE_PROVIDER_ID = "cline";

export const CLINE_RECOMMENDED_MODEL_IDS = [
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-opus-4.7",
	"openai/gpt-5.5",
	"deepseek/deepseek-v4-pro",
] as const;

const CLINE_MODEL_NAME_BY_ID: Record<string, string> = {
	"anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
	"anthropic/claude-opus-4.7": "Claude Opus 4.7",
	"openai/gpt-5.5": "GPT-5.5",
	"deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
};

export const CLINE_REASONING_EFFORT_OPTIONS: SearchSelectOption[] = [
	{ value: "", label: "Default" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra high" },
];

const CLINE_REASONING_EFFORT_LABEL_BY_VALUE = new Map(
	CLINE_REASONING_EFFORT_OPTIONS.map((option) => [option.value, option.label] as const),
);

export interface BuildKanbanAgentModelPickerOptionsResult {
	options: SearchSelectOption[];
	recommendedModelIds: string[];
	shouldPinSelectedModelToTop: boolean;
}

export function buildKanbanAgentModelPickerOptions(
	providerId: string,
	providerModels: readonly RuntimeKanbanProviderModel[],
): BuildKanbanAgentModelPickerOptionsResult {
	const defaultOptions = providerModels.map((model) => ({
		value: model.id,
		label: model.name,
	}));
	if (providerId.trim().toLowerCase() !== CLINE_PROVIDER_ID) {
		return {
			options: defaultOptions,
			recommendedModelIds: [],
			shouldPinSelectedModelToTop: true,
		};
	}

	const optionsById = new Map(defaultOptions.map((option) => [option.value, option] as const));
	const recommendedOptions = CLINE_RECOMMENDED_MODEL_IDS.map((modelId) => optionsById.get(modelId)).filter(
		(option): option is SearchSelectOption => option !== undefined,
	);
	const recommendedModelIds = recommendedOptions.map((option) => option.value);
	const recommendedModelIdSet = new Set(recommendedModelIds);
	const nonRecommendedOptions = defaultOptions.filter((option) => !recommendedModelIdSet.has(option.value));

	return {
		options: [...recommendedOptions, ...nonRecommendedOptions],
		recommendedModelIds,
		shouldPinSelectedModelToTop: false,
	};
}

export function formatKanbanReasoningEffortLabel(value: RuntimeReasoningEffort | "" | null | undefined): string {
	return CLINE_REASONING_EFFORT_LABEL_BY_VALUE.get(value ?? "") ?? "Default";
}

export function formatKanbanSelectedModelButtonText({
	modelName,
	reasoningEffort,
	showReasoningEffort = false,
}: {
	modelName: string;
	reasoningEffort?: RuntimeReasoningEffort | "" | null;
	showReasoningEffort?: boolean;
}): string {
	if (!showReasoningEffort || !reasoningEffort) {
		return modelName;
	}
	return `${modelName} (${formatKanbanReasoningEffortLabel(reasoningEffort)})`;
}

export function getKanbanReasoningEnabledModelIds(providerModels: readonly RuntimeKanbanProviderModel[]): string[] {
	return providerModels.filter((model) => model.supportsReasoningEffort).map((model) => model.id);
}

export function resolveKanbanModelDisplayName(modelId: string): string {
	const trimmedModelId = modelId.trim();
	if (!trimmedModelId) {
		return modelId;
	}
	return CLINE_MODEL_NAME_BY_ID[trimmedModelId] ?? trimmedModelId;
}

export function buildKanbanSelectedModelButtonText({
	modelOptions,
	selectedModelId,
	reasoningEffort,
	showReasoningEffort,
	isModelLoading = false,
	isModelSaving = false,
	loadingLabel = "Loading models...",
	savingLabel = "Saving model...",
	emptyLabel = "Select model",
}: {
	modelOptions: readonly SearchSelectOption[];
	selectedModelId: string;
	reasoningEffort?: RuntimeReasoningEffort | "" | null;
	showReasoningEffort: boolean;
	isModelLoading?: boolean;
	isModelSaving?: boolean;
	loadingLabel?: string;
	savingLabel?: string;
	emptyLabel?: string;
}): string {
	if (isModelSaving) {
		return savingLabel;
	}
	if (isModelLoading) {
		return loadingLabel;
	}
	const selectedOption = modelOptions.find((option) => option.value === selectedModelId);
	const trimmedModelId = selectedModelId.trim();
	const selectedModelName = selectedOption?.label ?? (trimmedModelId.length > 0 ? trimmedModelId : emptyLabel);
	return formatKanbanSelectedModelButtonText({
		modelName: selectedModelName,
		reasoningEffort,
		showReasoningEffort,
	});
}
