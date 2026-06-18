// OpenCode native provider projection.
//
// OpenCode is configured through a JSON config file (pointed at by the
// `OPENCODE_CONFIG` env var) rather than the generic `OPENAI_*` / `ANTHROPIC_*`
// env vars other CLI agents consume. This module turns a resolved Kanban provider
// (the shared {@link resolveAgentProvider} output) into the *native* OpenCode
// config shape:
//
//   {
//     "provider": {
//       "<id>": {
//         "npm": "@ai-sdk/openai-compatible",
//         "options": { "baseURL": "...", "apiKey": "..." },
//         "models": { "<model>": {} }
//       }
//     },
//     "model": "<id>/<model>",
//     "small_model": "<id>/<model>"
//   }
//
// The npm package is chosen by protocol/flavor so OpenCode loads the right AI SDK
// provider: the OpenAI Responses API → `@ai-sdk/openai`, an OpenAI chat-compatible
// relay → `@ai-sdk/openai-compatible`, and the Anthropic protocol → `@ai-sdk/anthropic`.
//
// This module is pure (no I/O): the adapter reads the user's base config, writes
// the merged temp file, and points `OPENCODE_CONFIG` at it. The API key only ever
// lives in that session-scoped temp file — never in committed repo state.

import type { AgentProviderConfig } from "../agent-sdk/kanban/agent-provider-config";
import type { ResolvedAgentProvider } from "../agent-sdk/kanban/agent-provider-resolver";
import {
	type ApiKeyField,
	collapseToAgentProtocol,
	DEFAULT_API_KEY_FIELD,
	type ProviderProtocol,
} from "../agent-sdk/kanban/provider-protocol";

// ------------------------------------------------------------------ types

/**
 * Which OpenAI wire API a provider speaks. The official OpenAI provider uses the
 * Responses API (`@ai-sdk/openai`); custom OpenAI-shaped relays use chat
 * completions (`@ai-sdk/openai-compatible`).
 */
export type OpenCodeOpenAiApi = "responses" | "chat";

export interface OpenCodeProviderOptions {
	baseURL?: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface OpenCodeProviderEntry {
	npm: string;
	name?: string;
	options?: OpenCodeProviderOptions;
	models?: Record<string, Record<string, unknown>>;
}

/**
 * A partial OpenCode config document. Only the fields Kanban projects/merges are
 * typed; unknown user keys (theme, keybinds, …) ride through `mergeOpenCodeConfig`
 * via the index signature so a user's base config is never dropped.
 */
export interface OpenCodeConfig {
	plugin?: string[];
	provider?: Record<string, OpenCodeProviderEntry>;
	model?: string;
	small_model?: string;
	[key: string]: unknown;
}

export interface OpenCodeProviderProjectionInput {
	protocol: ProviderProtocol;
	/** Provider id used as the OpenCode `provider.<id>` key (and model prefix). */
	providerId: string;
	/** Primary model id (bare or already `<providerId>/`-prefixed). */
	modelId: string | null;
	/** Full configured model list, used to populate `provider.<id>.models`. */
	models?: string[];
	baseUrl: string | null;
	apiKey: string | null;
	/** Anthropic key header style; controls x-api-key vs Bearer for relays. */
	apiKeyField?: ApiKeyField;
	/** Explicit OpenAI API flavor override; derived from provider id/baseUrl when unset. */
	openaiApi?: OpenCodeOpenAiApi;
}

// ------------------------------------------------------------------ selectors

/**
 * Decide which OpenAI API a provider speaks. The canonical OpenAI provider (the
 * `openai` id with no custom relay endpoint) uses the Responses API; anything
 * with a custom base URL is treated as a chat-completions relay unless overridden.
 */
export function selectOpenAiApi(
	providerId: string,
	baseUrl: string | null | undefined,
	explicit?: OpenCodeOpenAiApi,
): OpenCodeOpenAiApi {
	if (explicit) {
		return explicit;
	}
	const isOfficialOpenAi = providerId.trim().toLowerCase() === "openai" && !baseUrl?.trim();
	return isOfficialOpenAi ? "responses" : "chat";
}

/** Map a protocol + OpenAI flavor to the AI SDK npm package OpenCode should load. */
export function selectOpenCodeProviderNpm(
	protocol: ProviderProtocol,
	openaiApi: OpenCodeOpenAiApi | undefined,
): string {
	if (protocol === "anthropic") {
		return "@ai-sdk/anthropic";
	}
	return openaiApi === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
}

// ------------------------------------------------------------------ model id helpers

function qualifyModel(providerId: string, modelId: string): string {
	return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

function bareModel(providerId: string, modelId: string): string {
	const prefix = `${providerId}/`;
	return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

// ------------------------------------------------------------------ projection

/**
 * Project a single provider into its native OpenCode config fragment. Returns
 * `null` when there is nothing meaningful to inject (no key, base URL, or model,
 * or a blank provider id) so callers never write an empty/erroneous config.
 */
export function projectOpenCodeProvider(input: OpenCodeProviderProjectionInput): OpenCodeConfig | null {
	const providerId = input.providerId.trim();
	if (!providerId) {
		return null;
	}
	const baseUrl = input.baseUrl?.trim() || null;
	const apiKey = input.apiKey?.trim() || null;
	const modelId = input.modelId?.trim() || null;
	if (!baseUrl && !apiKey && !modelId) {
		return null;
	}

	const openaiApi = input.protocol === "openai" ? selectOpenAiApi(providerId, baseUrl, input.openaiApi) : undefined;
	const npm = selectOpenCodeProviderNpm(input.protocol, openaiApi);

	const options: OpenCodeProviderOptions = {};
	if (baseUrl) {
		options.baseURL = baseUrl;
	}
	if (apiKey) {
		// Anthropic relays that authenticate with a Bearer token (the Kanban default
		// `auth_token` field) need an Authorization header — `@ai-sdk/anthropic`'s
		// `apiKey` is sent as `x-api-key`, which Bearer relays ignore.
		const useBearer = input.protocol === "anthropic" && (input.apiKeyField ?? DEFAULT_API_KEY_FIELD) === "auth_token";
		if (useBearer) {
			options.headers = { Authorization: `Bearer ${apiKey}` };
		} else {
			options.apiKey = apiKey;
		}
	}

	const models: Record<string, Record<string, unknown>> = {};
	const modelIds = [...(input.models ?? []), ...(modelId ? [modelId] : [])];
	for (const raw of modelIds) {
		const id = bareModel(providerId, raw.trim());
		if (id) {
			models[id] = {};
		}
	}

	const entry: OpenCodeProviderEntry = { npm };
	if (Object.keys(options).length > 0) {
		entry.options = options;
	}
	if (Object.keys(models).length > 0) {
		entry.models = models;
	}

	const config: OpenCodeConfig = { provider: { [providerId]: entry } };
	if (modelId) {
		const qualified = qualifyModel(providerId, modelId);
		config.model = qualified;
		// Keep the lightweight title/summary model on the configured provider too,
		// so OpenCode does not fall back to an unauthenticated built-in default.
		config.small_model = qualified;
	}
	return config;
}

/**
 * Map a shared resolver result into a native OpenCode projection. Returns `null`
 * for official login or when no machine-home provider config exists — neither
 * should produce an OpenCode config override.
 */
export function buildOpenCodeProviderProjection(
	agentId: string,
	resolved: ResolvedAgentProvider,
): OpenCodeConfig | null {
	if (resolved.kind === "official-login") {
		return null;
	}
	const config: AgentProviderConfig | null = resolved.config;
	if (!config) {
		return null;
	}

	const single = collapseToAgentProtocol(agentId, config.protocols, config.baseUrl);
	const providerId = (resolved.providerId ?? config.provider ?? single.protocol).trim();

	return projectOpenCodeProvider({
		protocol: single.protocol,
		providerId,
		modelId: resolved.modelId ?? config.model ?? null,
		models: config.models,
		baseUrl: resolved.baseUrl ?? single.baseUrl ?? config.baseUrl ?? null,
		apiKey: config.apiKey ?? null,
		apiKeyField: config.anthropic?.apiKeyField,
	});
}

// ------------------------------------------------------------------ merge

function mergeProviderEntry(base: OpenCodeProviderEntry, overlay: OpenCodeProviderEntry): OpenCodeProviderEntry {
	return {
		...base,
		...overlay,
		...(base.options || overlay.options ? { options: { ...base.options, ...overlay.options } } : {}),
		...(base.models || overlay.models ? { models: { ...base.models, ...overlay.models } } : {}),
	};
}

/**
 * Shallow-merge OpenCode config fragments left-to-right (later wins), with two
 * targeted exceptions so composing the user's base config, the hooks plugin
 * fragment, and the provider projection never loses data:
 *   - `plugin` arrays are concatenated and de-duplicated,
 *   - `provider` maps merge per-id (and per-id `options`/`models` merge), so a
 *     base provider's extra fields survive an overlay that only sets credentials.
 * Unrelated top-level keys (theme, model, …) are overlaid wholesale. Null/undefined
 * fragments are ignored.
 */
export function mergeOpenCodeConfig(...fragments: Array<OpenCodeConfig | null | undefined>): OpenCodeConfig {
	const result: OpenCodeConfig = {};
	for (const fragment of fragments) {
		if (!fragment) {
			continue;
		}
		for (const [key, value] of Object.entries(fragment)) {
			if (key === "plugin" && Array.isArray(value)) {
				const existing = Array.isArray(result.plugin) ? result.plugin : [];
				result.plugin = [...new Set([...existing, ...value])];
				continue;
			}
			if (key === "provider" && value && typeof value === "object") {
				const overlay = value as Record<string, OpenCodeProviderEntry>;
				const merged: Record<string, OpenCodeProviderEntry> = { ...result.provider };
				for (const [providerId, entry] of Object.entries(overlay)) {
					const prior = merged[providerId];
					merged[providerId] = prior ? mergeProviderEntry(prior, entry) : entry;
				}
				result.provider = merged;
				continue;
			}
			result[key] = value;
		}
	}
	return result;
}
