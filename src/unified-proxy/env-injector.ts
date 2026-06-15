// Agent-specific provider environment variable injection.
//
// When a CLI agent has a non-official provider selected, this module builds the
// env vars needed to redirect the agent's API calls to the chosen provider.
//
// All agents (including Claude Code) use per-spawn env injection — we never write
// a global ~/.claude/settings.json. This lets multiple Claude sessions each use
// their own provider in parallel, and keeps them free of any inherited shell
// ANTHROPIC_* variables.
//
// An agent registers a *set* of providers; a session picks one by `providerId`
// at launch. When no provider is selected (or the selected one is unknown) we
// fall back to the agent's default provider, and finally to the official
// provider (no override) when the agent has none configured.
//
// Auth-gateway translation (when an extra provider speaks a different protocol)
// is planned for later.

import { type AgentProviderConfig, getAgentProviderConfig } from "../agent-sdk/kanban/agent-provider-config";
import {
	AGENT_PROTOCOL_COMPATIBILITY,
	type ProtocolConfig,
	type ProviderProtocol,
	resolveAnthropicApiKeyEnvVar,
	resolveProtocolEnvVars,
} from "../agent-sdk/kanban/provider-protocol";

// ------------------------------------------------------------------ types

export interface AgentProviderEnv {
	/** Environment variables to inject into the agent process. */
	env: Record<string, string | undefined>;
	/** Whether a non-official provider is active (for logging). */
	usesCustomProvider: boolean;
}

// ------------------------------------------------------------------ public API

/**
 * Build provider-related env vars for a CLI agent based on its agent-level
 * provider config. If the agent has a non-official provider selected and that
 * provider has a baseUrl, the env vars redirect to it.
 *
 * `providerId` selects which of the agent's registered providers to use; when
 * omitted (or unknown) the agent's default provider is used.
 *
 * Returns `{ env: {}, usesCustomProvider: false }` when the official provider
 * is selected, no custom provider config exists, or the provider's protocols
 * are incompatible with the agent.
 */
export async function buildAgentProviderEnv(agentId: string, providerId?: string): Promise<AgentProviderEnv> {
	// Selected provider, falling back to the agent's default when the selection
	// is missing or unknown.
	const config =
		(providerId !== undefined ? getAgentProviderConfig(agentId, providerId) : null) ??
		getAgentProviderConfig(agentId);

	// No per-agent config → no custom provider override.
	if (!config) {
		return { env: {}, usesCustomProvider: false };
	}

	// Resolve env vars based on provider protocols + agent compatibility.
	// When the config predates protocols, fall back to the agent's primary
	// protocol (e.g. claude → anthropic, codex → openai) carrying the legacy
	// baseUrl, rather than a blanket openai default that claude can't speak.
	const agentProtocols = AGENT_PROTOCOL_COMPATIBILITY[agentId] ?? [];
	const fallbackProtocol: ProviderProtocol = agentProtocols[0] ?? "openai";
	const protocols: ProtocolConfig[] = config.protocols ?? [{ protocol: fallbackProtocol, baseUrl: config.baseUrl }];

	const resolved = resolveProtocolEnvVars(protocols, agentId);
	if (!resolved) {
		// Agent not compatible with the provider's protocols —
		// these don't support *_BASE_URL override, so skip.
		return { env: {}, usesCustomProvider: false };
	}

	return buildDirectOverrideEnv(resolved, config);
}

/**
 * Direct URL override: the custom provider speaks the same wire protocol as
 * the official one, so we redirect *_BASE_URL to its endpoint and inject the
 * API key. For the Anthropic protocol the key goes to ANTHROPIC_AUTH_TOKEN
 * (Bearer, default) or ANTHROPIC_API_KEY (x-api-key) per `apiKeyField`, and any
 * configured model overrides are injected as ANTHROPIC_MODEL /
 * ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL.
 */
function buildDirectOverrideEnv(
	resolved: {
		baseUrlEnvVar: string;
		apiKeyEnvVar: string;
		resolvedBaseUrl: string | undefined;
		matchedProtocol: ProviderProtocol;
	},
	config: AgentProviderConfig,
): AgentProviderEnv {
	const env: Record<string, string | undefined> = {};

	// Use resolved baseUrl from protocol config, fall back to legacy config.baseUrl
	const baseUrl = resolved.resolvedBaseUrl || config.baseUrl;
	if (baseUrl) {
		env[resolved.baseUrlEnvVar] = baseUrl;
	}

	if (config.apiKey) {
		const apiKeyEnvVar =
			resolved.matchedProtocol === "anthropic"
				? resolveAnthropicApiKeyEnvVar(config.apiKeyField)
				: resolved.apiKeyEnvVar;
		env[apiKeyEnvVar] = config.apiKey;
	}

	// Anthropic-only model overrides.
	if (resolved.matchedProtocol === "anthropic") {
		if (config.model) {
			env.ANTHROPIC_MODEL = config.model;
		}
		const defaults = config.anthropicDefaultModels;
		if (defaults?.haiku) {
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaults.haiku;
		}
		if (defaults?.sonnet) {
			env.ANTHROPIC_DEFAULT_SONNET_MODEL = defaults.sonnet;
		}
		if (defaults?.opus) {
			env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaults.opus;
		}
	}

	return {
		env,
		usesCustomProvider: Object.keys(env).length > 0,
	};
}
