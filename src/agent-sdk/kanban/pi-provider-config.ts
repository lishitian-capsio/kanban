// Provider and model resolution for pi agent sessions.
// Uses the omp built-in model registry (models.json) and the per-agent
// provider configuration store.
import type { RuntimeReasoningEffort } from "../../core/api-contract";
import { Effort } from "../ai/model-thinking";
import { type GeneratedProvider, getBundledModel, getBundledModels, getBundledProviders } from "../ai/models";
import type { Api, Model } from "../ai/types";
import { getAgentProviderConfig } from "./agent-provider-config";

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
 */
export interface PiCommittedProvider {
	providerId?: string | null;
	modelId?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
}

export interface PiLaunchInput {
	providerIdOverride?: string | null;
	modelIdOverride?: string | null;
	reasoningEffortOverride?: RuntimeReasoningEffort | null;
	committedProvider?: PiCommittedProvider | null;
}

/**
 * One source's contribution to the launch config. `null` means "this source did
 * not supply this field" — it never carries empty strings, so merging is a plain
 * nullish-coalescing fold (first non-null wins, highest-priority source first).
 */
interface PiLaunchLayer {
	providerId: string | null;
	modelId: string | null;
	baseUrl: string | null;
	reasoningEffort: RuntimeReasoningEffort | null;
}

/** Trim a possibly-null string and collapse empty/whitespace-only values to `null`. */
function normalizeOptional(value?: string | null): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Layer 1 — explicit per-session overrides (the card's `agentSettings`). There is
 * no per-session override for `baseUrl`, so it is always absent at this layer.
 */
function resolveOverrideLayer(input: PiLaunchInput): PiLaunchLayer {
	return {
		providerId: normalizeOptional(input.providerIdOverride),
		modelId: normalizeOptional(input.modelIdOverride),
		baseUrl: null,
		reasoningEffort: input.reasoningEffortOverride ?? null,
	};
}

/** Layer 2 — the workspace's selected committed provider (always secret-free). */
function resolveCommittedProviderLayer(provider: PiCommittedProvider | null): PiLaunchLayer {
	return {
		providerId: normalizeOptional(provider?.providerId),
		modelId: normalizeOptional(provider?.modelId),
		baseUrl: normalizeOptional(provider?.baseUrl),
		reasoningEffort: provider?.reasoningEffort ?? null,
	};
}

/**
 * Layer 3 — the user's saved per-agent provider settings (machine-home store).
 * Returns an all-`null` layer when the store is unavailable, throws, or has no
 * pi config, so callers never need a try/catch of their own.
 */
function resolveStoreLayer(): PiLaunchLayer {
	const empty: PiLaunchLayer = { providerId: null, modelId: null, baseUrl: null, reasoningEffort: null };
	try {
		const agentConfig = getAgentProviderConfig("pi");
		if (!agentConfig) {
			return empty;
		}
		return {
			providerId: normalizeOptional(agentConfig.provider),
			modelId: normalizeOptional(agentConfig.model),
			baseUrl: normalizeOptional(agentConfig.baseUrl),
			// The store value is not validated against the effort enum here, matching
			// historical behavior — it is cast and passed through as-is.
			reasoningEffort: normalizeOptional(agentConfig.reasoning?.effort) as RuntimeReasoningEffort | null,
		};
	} catch {
		// Config layer unavailable.
		return empty;
	}
}

/**
 * Resolve the full launch configuration for a pi agent session.
 *
 * Resolution chain (highest priority first):
 *   1. explicit per-session overrides (`*Override` — the card's agentSettings),
 *   2. the workspace's selected committed provider (`committedProvider`),
 *   3. the user's saved provider settings (machine-home Settings store),
 *   4. built-in defaults.
 *
 * The store layer is consulted only when a *core* field (provider/model/baseUrl)
 * is still unresolved after the override and committed-provider layers. This is
 * deliberate and load-bearing: the store's `reasoningEffort` is filled in that same
 * pass, so when override/committed-provider already supply all three core fields the
 * store's reasoningEffort is intentionally not applied.
 *
 * Secrets are never part of a committed provider: the API key is resolved separately
 * from the machine-home store (by providerId), so committed records stay secret-free.
 */
export function resolvePiLaunchConfig(input?: PiLaunchInput): PiLaunchConfig {
	const override = resolveOverrideLayer(input ?? {});
	const committed = resolveCommittedProviderLayer(input?.committedProvider ?? null);

	// Layers 1 + 2 (in-memory): override wins, then the committed provider.
	let providerId = override.providerId ?? committed.providerId;
	let modelId = override.modelId ?? committed.modelId;
	let baseUrl = override.baseUrl ?? committed.baseUrl;
	let reasoningEffort = override.reasoningEffort ?? committed.reasoningEffort;

	// Layer 3 (machine-home store): only when a core field still needs it.
	if (providerId === null || modelId === null || baseUrl === null) {
		const store = resolveStoreLayer();
		providerId ??= store.providerId;
		modelId ??= store.modelId;
		baseUrl ??= store.baseUrl;
		reasoningEffort ??= store.reasoningEffort;
	}

	// Layer 4 (built-in defaults): provider/model only — baseUrl/reasoning stay null.
	const resolvedProviderId = providerId ?? PI_DEFAULT_PROVIDER_ID;
	const resolvedModelId = modelId ?? PI_DEFAULT_MODEL_ID;

	return {
		providerId: resolvedProviderId,
		modelId: resolvedModelId,
		apiKey: resolvePiApiKey(resolvedProviderId),
		baseUrl,
		reasoningEffort,
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
