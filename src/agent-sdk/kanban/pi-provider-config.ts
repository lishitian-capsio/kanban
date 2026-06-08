// Provider and model resolution for pi agent sessions.
// Uses the omp built-in model registry (models.json) and the kanban
// provider settings store.
import type { RuntimeReasoningEffort } from "../../core/api-contract";
import { getBundledModel, getBundledModels, getBundledProviders, type GeneratedProvider } from "../ai/models";
import type { Api, Model } from "../ai/types";
import { Effort } from "../ai/model-thinking";
import { getProviderSettings, getLastUsedProviderSettings } from "./provider-settings-store";

export const PI_DEFAULT_PROVIDER_ID = "anthropic";
export const PI_DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";

export interface PiResolvedModel {
	provider: string;
	modelId: string;
	model: Model<Api>;
}

export interface PiLaunchConfig {
	providerId: string;
	modelId: string;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
}

/**
 * Resolve a model from the omp bundled model registry.
 * Falls back to a generic model descriptor if not found.
 * When a custom baseUrl is provided, it overrides the model's baseUrl.
 */
export function resolvePiModel(providerId?: string | null, modelId?: string | null, baseUrl?: string | null): PiResolvedModel {
	const provider = (providerId?.trim() || PI_DEFAULT_PROVIDER_ID) as GeneratedProvider;
	const id = modelId?.trim() || PI_DEFAULT_MODEL_ID;

	// Try to find the model in the bundled registry
	let foundModel: Model<Api> | null = null;
	let foundProvider: string = provider;

	try {
		const model = getBundledModel(provider, id);
		if (model) {
			foundModel = model;
		}
	} catch {
		// Model not found in registry
	}

	// Try to find any model matching the id across providers
	if (!foundModel) {
		const allProviders = getBundledProviders();
		for (const p of allProviders) {
			try {
				const model = getBundledModel(p as GeneratedProvider, id);
				if (model) {
					foundModel = model;
					foundProvider = p;
					break;
				}
			} catch {
				// Continue searching
			}
		}
	}

	// If we found a model and have a custom baseUrl, override it
	if (foundModel && baseUrl?.trim()) {
		return {
			provider: foundProvider,
			modelId: id,
			model: { ...foundModel, baseUrl: baseUrl.trim() },
		};
	}

	// If we found a model without custom baseUrl, use as-is
	if (foundModel) {
		return { provider: foundProvider, modelId: id, model: foundModel };
	}

	// Model not found in registry
	// If we have a custom baseUrl, create a generic OpenAI-compatible model
	if (baseUrl?.trim()) {
		const genericModel: Model<Api> = {
			id,
			name: id,
			api: "openai-completions" as Api,
			provider: provider as any,
			baseUrl: baseUrl.trim(),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		};
		return { provider, modelId: id, model: genericModel };
	}

	// Final fallback: use default
	const fallbackModel = getBundledModel(PI_DEFAULT_PROVIDER_ID as GeneratedProvider, PI_DEFAULT_MODEL_ID);
	return {
		provider: PI_DEFAULT_PROVIDER_ID,
		modelId: PI_DEFAULT_MODEL_ID,
		model: fallbackModel,
	};
}

/**
 * Resolve the full launch configuration for a pi agent session.
 * When no explicit overrides are provided, reads providerId and modelId
 * from the user's saved provider settings (via Settings UI).
 */
export function resolvePiLaunchConfig(input?: {
	providerIdOverride?: string | null;
	modelIdOverride?: string | null;
	reasoningEffortOverride?: RuntimeReasoningEffort | null;
}): PiLaunchConfig {
	let providerId = input?.providerIdOverride?.trim() || null;
	let modelId = input?.modelIdOverride?.trim() || null;
	let baseUrl: string | null = null;

	// Read missing values from saved provider settings
	if (!providerId || !modelId) {
		try {
			const lastUsed = getLastUsedProviderSettings();
			const selected = lastUsed?.provider
				? (getProviderSettings(lastUsed.provider.trim().toLowerCase()) ?? lastUsed)
				: null;
			if (selected) {
				providerId = providerId || selected.provider?.trim() || null;
				modelId = modelId || selected.model?.trim() || null;
				baseUrl = selected.baseUrl?.trim() || null;
			}
		} catch {
			// Settings layer unavailable
		}
	}

	const resolvedProviderId = providerId || PI_DEFAULT_PROVIDER_ID;
	const resolvedModelId = modelId || PI_DEFAULT_MODEL_ID;
	const apiKey = resolvePiApiKey(resolvedProviderId);

	return {
		providerId: resolvedProviderId,
		modelId: resolvedModelId,
		apiKey,
		baseUrl,
		reasoningEffort: input?.reasoningEffortOverride ?? null,
	};
}

/**
 * Resolve API key: environment variables first, then saved provider settings.
 */
export function resolvePiApiKey(providerId: string): string | null {
	// 1. Environment variables take priority
	const envVarNames = getApiKeyEnvVars(providerId);
	for (const envVar of envVarNames) {
		const value = process.env[envVar];
		if (value?.trim()) {
			return value.trim();
		}
	}
	// 2. Fall back to saved provider settings
	try {
		const settings = getProviderSettings(providerId) ?? getLastUsedProviderSettings();
		const apiKey = settings?.apiKey?.trim() || settings?.auth?.apiKey?.trim() || "";
		if (apiKey) {
			return apiKey;
		}
	} catch {
		// Settings layer unavailable
	}
	return null;
}

function getApiKeyEnvVars(providerId: string): string[] {
	switch (providerId.toLowerCase()) {
		case "anthropic":
			return ["ANTHROPIC_API_KEY"];
		case "openai":
			return ["OPENAI_API_KEY"];
		case "google":
		case "gemini":
			return ["GOOGLE_API_KEY", "GEMINI_API_KEY"];
		case "ollama":
			return [];
		case "openrouter":
			return ["OPENROUTER_API_KEY"];
		case "xai":
			return ["XAI_API_KEY"];
		case "mistral":
			return ["MISTRAL_API_KEY"];
		default:
			return [`${providerId.toUpperCase()}_API_KEY`];
	}
}

/**
 * Map Kanban reasoning effort to omp Effort type.
 */
export function toOmpEffort(effort?: RuntimeReasoningEffort | null): Effort | undefined {
	if (!effort || effort === "low") return Effort.Low;
	if (effort === "medium") return Effort.Medium;
	if (effort === "high") return Effort.High;
	if (effort === "xhigh") return Effort.XHigh;
	return undefined;
}

/**
 * List available providers from the bundled model registry.
 */
export function listPiProviders(): Array<{ id: string; name: string; modelCount: number }> {
	const providers = getBundledProviders();
	return providers.map((id) => {
		const models = getBundledModels(id as GeneratedProvider);
		return {
			id,
			name: formatProviderName(id),
			modelCount: models.length,
		};
	});
}

function formatProviderName(id: string): string {
	const names: Record<string, string> = {
		anthropic: "Anthropic",
		openai: "OpenAI",
		google: "Google",
		ollama: "Ollama",
		openrouter: "OpenRouter",
		xai: "xAI",
		mistral: "Mistral",
		"amazon-bedrock": "Amazon Bedrock",
		"azure-openai": "Azure OpenAI",
	};
	return names[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
