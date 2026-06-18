// Native Factory Droid BYOK (bring-your-own-key) provider projection.
//
// Droid's BYOK form is a `customModels` array in its settings.json (camelCase),
// NOT the generic `ANTHROPIC_*` / `OPENAI_*` environment variables that
// claude/codex rely on. Each entry carries:
//
//   { model, displayName, baseUrl, apiKey, provider, maxOutputTokens? }
//
// where `provider` is one of Droid's three wire dialects:
//   - "anthropic"                   → Anthropic Messages API
//   - "openai"                      → OpenAI Responses API (GPT-5 / Codex)
//   - "generic-chat-completion-api" → OpenAI Chat Completions (OpenRouter,
//                                     Fireworks, Together, Ollama, vLLM, most
//                                     open-source relays)
//
// This module maps a resolved Kanban per-agent provider onto that shape. It does
// not write files or touch process env — the Droid session adapter composes the
// result into the settings.json it already manages (autonomy + hooks) and injects
// the secret as a per-spawn env var that the `${...}` apiKey reference expands to,
// so the literal key never lands in committed repo state.
//
// SECURITY: the API key comes only from the machine-home provider config (never a
// committed provider record). The default apiKey strategy keeps it out of the
// settings file entirely via `${VAR}` env interpolation.

import type { AgentProviderConfig } from "./agent-provider-config";
import { type CommittedProviderLayer, resolveAgentProvider } from "./agent-provider-resolver";
import {
	getAgentProtocols,
	IncompatibleAgentProviderError,
	type ProtocolConfig,
	type ProviderProtocol,
	resolveProtocolEnvVars,
} from "./provider-protocol";

/** The agent id this projector serves. */
export const DROID_AGENT_ID = "droid";

/** Env var the default `${...}` apiKey reference expands to at spawn. */
export const DROID_BYOK_API_KEY_ENV_VAR = "KANBAN_DROID_BYOK_API_KEY";

/** Droid's three custom-model wire dialects. */
export type DroidProviderType = "anthropic" | "openai" | "generic-chat-completion-api";

/** A single `customModels` entry in Droid's settings.json. */
export interface DroidCustomModel {
	/** Model id sent to the provider API (required). */
	model: string;
	/** Human-friendly name shown in Droid's `/model` selector. */
	displayName?: string;
	/** Provider API endpoint base URL (required). */
	baseUrl: string;
	/** API key — either a `${VAR}` reference or a literal, per the apiKey strategy. */
	apiKey: string;
	/** Wire dialect Droid should speak to this endpoint (required). */
	provider: DroidProviderType;
	/** Optional cap on output tokens. */
	maxOutputTokens?: number;
}

/**
 * How the apiKey lands in the projected `customModels` entry.
 *   - `env-interpolation` (default): write `${envVar}` into the file and inject the
 *     real key as an env var — the secret never touches disk.
 *   - `literal`: write the real key into the (machine-home, gitignored) settings
 *     file; inject no env. Use when env interpolation is unavailable.
 */
export type DroidApiKeyStrategy = { kind: "env-interpolation"; envVar?: string } | { kind: "literal" };

export interface DroidByokInput {
	/** Machine-home provider config carrying the secret + protocol(s). */
	config: AgentProviderConfig;
	/** Resolved model id (override → committed → store). Falls back to `config.model`. */
	model: string | null;
	/** apiKey placement (default: env interpolation). */
	apiKeyStrategy?: DroidApiKeyStrategy;
	/**
	 * Optional output-token cap. Not currently sourced from `AgentProviderConfig`
	 * (it has no such field), so callers pass it explicitly when available.
	 */
	maxOutputTokens?: number;
}

export interface DroidByokProjection {
	/** The `customModels` entry to merge into Droid's settings.json. */
	customModel: DroidCustomModel;
	/** The model id to pass to Droid's `-m/--model` flag to select it. */
	model: string;
	/** Env vars to inject at spawn (the real apiKey behind any `${...}` reference). */
	env: Record<string, string>;
}

/**
 * Thrown when a Droid BYOK provider is selected but its config is incomplete for
 * the native `customModels` form (missing model / baseUrl / apiKey). Distinct
 * from {@link IncompatibleAgentProviderError} (a protocol mismatch).
 */
export class DroidByokConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DroidByokConfigError";
	}
}

// Providers whose OpenAI-protocol endpoint speaks the native OpenAI *Responses*
// API. Everything else on the openai protocol is the broadly compatible Chat
// Completions dialect (`generic-chat-completion-api`).
const OPENAI_RESPONSES_PROVIDERS: ReadonlySet<string> = new Set(["openai", "azure-openai"]);

/**
 * Choose Droid's wire dialect for a resolved protocol + provider name.
 *   - anthropic protocol → "anthropic"
 *   - openai protocol, native OpenAI/Azure → "openai" (Responses API)
 *   - openai protocol, anything else → "generic-chat-completion-api"
 */
export function selectDroidProviderType(
	protocol: ProviderProtocol,
	providerName: string | null | undefined,
): DroidProviderType {
	if (protocol === "anthropic") {
		return "anthropic";
	}
	const name = (providerName ?? "").trim().toLowerCase();
	return OPENAI_RESPONSES_PROVIDERS.has(name) ? "openai" : "generic-chat-completion-api";
}

/**
 * Map a resolved Kanban provider config onto a Droid `customModels` projection.
 *
 * Throws {@link IncompatibleAgentProviderError} when the provider speaks no
 * protocol Droid supports, and {@link DroidByokConfigError} when a required
 * BYOK field (model / baseUrl / apiKey) is missing.
 */
export function buildDroidByokProjection(input: DroidByokInput): DroidByokProjection {
	const { config } = input;

	// Resolve which protocol Droid will speak + the matching base URL. When the
	// config predates `protocols`, fall back to Droid's primary protocol carrying
	// the legacy scalar baseUrl.
	const fallbackProtocol: ProviderProtocol = getAgentProtocols(DROID_AGENT_ID)[0] ?? "anthropic";
	const protocols: ProtocolConfig[] = config.protocols ?? [{ protocol: fallbackProtocol, baseUrl: config.baseUrl }];

	const protocolEnv = resolveProtocolEnvVars(protocols, DROID_AGENT_ID);
	if (!protocolEnv) {
		throw new IncompatibleAgentProviderError(
			DROID_AGENT_ID,
			protocols.map((p) => p.protocol),
			getAgentProtocols(DROID_AGENT_ID),
		);
	}

	const baseUrl = protocolEnv.resolvedBaseUrl || config.baseUrl;
	if (!baseUrl) {
		throw new DroidByokConfigError(`Droid BYOK provider "${config.provider ?? "(unnamed)"}" is missing a base URL.`);
	}

	const model = (input.model ?? config.model ?? "").trim();
	if (!model) {
		throw new DroidByokConfigError(`Droid BYOK provider "${config.provider ?? "(unnamed)"}" is missing a model id.`);
	}

	const apiKey = config.apiKey?.trim();
	if (!apiKey) {
		throw new DroidByokConfigError(`Droid BYOK provider "${config.provider ?? "(unnamed)"}" is missing an API key.`);
	}

	const provider = selectDroidProviderType(protocolEnv.matchedProtocol, config.provider);

	const strategy: DroidApiKeyStrategy = input.apiKeyStrategy ?? { kind: "env-interpolation" };
	let customApiKey: string;
	const env: Record<string, string> = {};
	if (strategy.kind === "literal") {
		customApiKey = apiKey;
	} else {
		const envVar = strategy.envVar?.trim() || DROID_BYOK_API_KEY_ENV_VAR;
		customApiKey = `\${${envVar}}`;
		env[envVar] = apiKey;
	}

	const displayName = config.provider?.trim() || model;

	const customModel: DroidCustomModel = {
		model,
		displayName,
		baseUrl,
		apiKey: customApiKey,
		provider,
	};
	if (typeof input.maxOutputTokens === "number") {
		customModel.maxOutputTokens = input.maxOutputTokens;
	}

	return { customModel, model, env };
}

/**
 * Merge projected `customModels` into a Droid settings object without clobbering
 * the user's own entries: existing entries that don't share a projected `model`
 * id are preserved (and listed first); a stale entry sharing our id is replaced.
 * All other settings fields (autonomyMode, hooks, …) pass through untouched.
 */
export function mergeDroidCustomModels(
	settings: Record<string, unknown>,
	customModels: DroidCustomModel[],
): Record<string, unknown> {
	const existing = Array.isArray(settings.customModels) ? (settings.customModels as unknown[]) : [];
	const ourModelIds = new Set(customModels.map((m) => m.model));
	const preserved = existing.filter(
		(entry) =>
			!(
				entry !== null &&
				typeof entry === "object" &&
				ourModelIds.has((entry as { model?: unknown }).model as string)
			),
	);
	return { ...settings, customModels: [...preserved, ...customModels] };
}

export interface ResolveDroidByokInput {
	/** Task/card-level provider override (highest priority). */
	providerIdOverride?: string | null;
	/** Task/card-level model override. */
	modelIdOverride?: string | null;
	/** The workspace's selected committed provider for Droid (secret-free). */
	committedProvider?: CommittedProviderLayer | null;
	/** apiKey placement (default: env interpolation). */
	apiKeyStrategy?: DroidApiKeyStrategy;
}

/**
 * Resolve the Droid provider selection (via the shared {@link resolveAgentProvider}
 * precedence) and project it into a Droid BYOK `customModels` entry.
 *
 * Returns `null` — meaning "no BYOK, use Droid's native login" — when official
 * login is selected or no machine-home config with a secret exists. Throws
 * {@link IncompatibleAgentProviderError} / {@link DroidByokConfigError} when a
 * custom provider IS selected but cannot be projected.
 */
export function resolveDroidByokProjection(input: ResolveDroidByokInput): DroidByokProjection | null {
	const resolved = resolveAgentProvider(
		{
			agentId: DROID_AGENT_ID,
			providerIdOverride: input.providerIdOverride,
			modelIdOverride: input.modelIdOverride,
			committedProvider: input.committedProvider,
		},
		// Match the long-standing CLI behavior: an unknown explicit selection falls
		// back to the agent's default provider config.
		{ defaultProviderFallback: true },
	);

	if (resolved.kind === "official-login") {
		return null;
	}

	const config = resolved.config;
	if (!config || !config.apiKey?.trim()) {
		// No secret on disk → cannot BYOK; let Droid use its native login.
		return null;
	}

	return buildDroidByokProjection({
		config,
		model: resolved.modelId ?? config.model ?? null,
		apiKeyStrategy: input.apiKeyStrategy,
	});
}
