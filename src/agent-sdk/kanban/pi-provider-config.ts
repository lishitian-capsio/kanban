// Provider and model resolution for pi agent sessions.
// Uses the omp built-in model registry (models.json) and the per-agent
// provider configuration store.
import type { RuntimeReasoningEffort } from "../../core/api-contract";
import { Effort } from "../ai/model-thinking";
import { type GeneratedProvider, getBundledModel, getBundledModels, getBundledProviders } from "../ai/models";
import type { Api, Model } from "../ai/types";
import { getAgentProviderConfig } from "./agent-provider-config";
import { type CommittedProviderLayer, resolveAgentProvider } from "./agent-provider-resolver";

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
export function resolvePiModel(
	providerId?: string | null,
	modelId?: string | null,
	baseUrl?: string | null,
): PiResolvedModel {
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

	// Final fallback: use default.
	// `getBundledModel` is typed non-null but returns `undefined` for an unknown
	// id; the default should always exist in the bundled registry, but guard it
	// so a future missing default fails with a clear error here instead of an
	// opaque crash when this model is passed into `new Agent({ model })`.
	const fallbackModel = assertResolvedPiModel(
		getBundledModel(PI_DEFAULT_PROVIDER_ID as GeneratedProvider, PI_DEFAULT_MODEL_ID),
		PI_DEFAULT_PROVIDER_ID,
		PI_DEFAULT_MODEL_ID,
	);
	return {
		provider: PI_DEFAULT_PROVIDER_ID,
		modelId: PI_DEFAULT_MODEL_ID,
		model: fallbackModel,
	};
}

/**
 * Guard the result of a bundled-model lookup. `getBundledModel` is typed to
 * return a non-null `Model` but actually returns `undefined` when the id is not
 * in the registry. Passing that `undefined` into `new Agent({ model })` crashes
 * later on a property read with no useful context. This converts that into a
 * clear, actionable error at the resolution site.
 */
export function assertResolvedPiModel(
	model: Model<Api> | undefined | null,
	provider: string,
	modelId: string,
): Model<Api> {
	if (!model) {
		throw new Error(`pi model "${provider}/${modelId}" is missing from the bundled model registry (models.json)`);
	}
	return model;
}

/**
 * Non-secret launch config contributed by the workspace's currently selected
 * committed provider. This is the "workspace layer" in the resolution chain; it
 * never carries secrets (the API key still comes from the machine-home settings
 * store by providerId).
 *
 * Alias of the agent-agnostic {@link CommittedProviderLayer} — pi resolution
 * shares the shared {@link resolveAgentProvider} entry point.
 */
export type PiCommittedProvider = CommittedProviderLayer;

export interface PiLaunchInput {
	providerIdOverride?: string | null;
	modelIdOverride?: string | null;
	reasoningEffortOverride?: RuntimeReasoningEffort | null;
	committedProvider?: PiCommittedProvider | null;
}

/**
 * Resolve the full launch configuration for a pi agent session.
 *
 * Provider/model/reasoning *selection* runs through the shared
 * {@link resolveAgentProvider} (override → committed provider → machine-home store),
 * then this adapter layers pi's two specifics on top:
 *   - the built-in defaults (`anthropic` / `claude-sonnet`) when nothing resolved,
 *   - the API key, resolved separately (env first, then the machine-home store) so
 *     committed records stay secret-free.
 *
 * pi never uses the `defaultProviderFallback` the CLI agents do: an unknown
 * explicit provider selection must not silently borrow the default provider's
 * model/endpoint. pi also never resolves to official login (it has no native
 * login), so the `official-login` result is defended against but unreachable.
 */
export function resolvePiLaunchConfig(input?: PiLaunchInput): PiLaunchConfig {
	const resolved = resolveAgentProvider({
		agentId: "pi",
		providerIdOverride: input?.providerIdOverride,
		modelIdOverride: input?.modelIdOverride,
		reasoningEffortOverride: input?.reasoningEffortOverride,
		committedProvider: input?.committedProvider,
	});

	const fields = resolved.kind === "provider" ? resolved : null;
	const resolvedProviderId = fields?.providerId ?? PI_DEFAULT_PROVIDER_ID;
	const resolvedModelId = fields?.modelId ?? PI_DEFAULT_MODEL_ID;

	return {
		providerId: resolvedProviderId,
		modelId: resolvedModelId,
		apiKey: resolvePiApiKey(resolvedProviderId),
		baseUrl: fields?.baseUrl ?? null,
		reasoningEffort: fields?.reasoningEffort ?? null,
	};
}

/**
 * Resolve API key: environment variables first, then per-agent provider config.
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
	// 2. Fall back to the machine-home per-agent provider store. Prefer the secret
	// registered under this exact providerId (so a selected committed provider finds
	// its own machine-home secret), then the agent's default provider.
	try {
		const byProviderId = getAgentProviderConfig("pi", providerId);
		const agentConfig = byProviderId ?? getAgentProviderConfig("pi");
		const apiKey = agentConfig?.apiKey?.trim() || "";
		if (apiKey) {
			return apiKey;
		}
	} catch {
		// Config layer unavailable
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
