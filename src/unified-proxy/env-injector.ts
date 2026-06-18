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

import type { AgentProviderConfig } from "../agent-sdk/kanban/agent-provider-config";
import { type CommittedProviderLayer, resolveAgentProvider } from "../agent-sdk/kanban/agent-provider-resolver";
import {
	AGENT_PROTOCOL_COMPATIBILITY,
	type AgentVendorId,
	agentUsesNativeProviderProjection,
	getAgentProtocols,
	getAgentProviderCapability,
	IncompatibleAgentProviderError,
	type ProtocolConfig,
	type ProviderProtocol,
	resolveAnthropicApiKeyEnvVar,
	resolveProtocolEnvVars,
} from "../agent-sdk/kanban/provider-protocol";

// Re-exported for backward compatibility — the class now lives in the
// protocol-compatibility domain so native-projection adapters can throw it too.
export { IncompatibleAgentProviderError } from "../agent-sdk/kanban/provider-protocol";

// ------------------------------------------------------------------ types

export interface AgentProviderEnv {
	/** Environment variables to inject into the agent process. */
	env: Record<string, string | undefined>;
	/** Whether a non-official provider is active (for logging). */
	usesCustomProvider: boolean;
	/**
	 * The resolved model id for this launch (override → committed → store), or
	 * `null`. Adapters that apply the model via native config rather than env
	 * (e.g. Kiro's agent JSON) read this; for env-driven agents the model is
	 * already projected into {@link env}.
	 */
	resolvedModelId?: string | null;
}

// ------------------------------------------------------------------ public API

/**
 * Build provider-related env vars for a CLI agent.
 *
 * Provider *selection* runs through the shared {@link resolveAgentProvider}
 * (task/card override → workspace committed provider → machine-home store →
 * agent default / official login); this adapter turns the result into the env
 * vars that redirect the agent's API calls.
 *
 * `providerId` is the card/task-level override; `committedProvider` is the
 * workspace's selected committed provider for this agent (secret-free). When the
 * official sentinel is selected (explicitly or as the agent default), NO env is
 * injected and the chain never falls through to a custom provider, so the
 * agent's native login is preserved.
 *
 * Returns `{ env: {}, usesCustomProvider: false }` for official login or when no
 * custom provider config exists. Throws {@link IncompatibleAgentProviderError}
 * when the resolved provider's protocols are incompatible with the agent.
 */
export async function buildAgentProviderEnv(
	agentId: string,
	providerId?: string,
	committedProvider?: CommittedProviderLayer | null,
): Promise<AgentProviderEnv> {
	// Agents that project provider config into their own native settings file
	// (e.g. Factory Droid's `customModels`) don't use env-var injection — their
	// session adapter owns the projection, so this path is a deliberate no-op.
	if (agentUsesNativeProviderProjection(agentId)) {
		return { env: {}, usesCustomProvider: false };
	}

	const resolved = resolveAgentProvider(
		{ agentId, providerIdOverride: providerId, committedProvider },
		// CLI agents fall back to the agent's default provider when an explicit
		// selection is unknown (long-standing behavior).
		{ defaultProviderFallback: true },
	);

	if (resolved.kind === "official-login") {
		return { env: {}, usesCustomProvider: false };
	}

	// No machine-home config → no secret/protocol to inject → no custom override.
	const config = resolved.config;
	if (!config) {
		return { env: {}, usesCustomProvider: false };
	}

	const resolvedModelId = resolved.modelId ?? config.model ?? null;

	// Vendor agents (gemini/kiro) speak only their vendor-native API — there is no
	// generic BYOK endpoint. Branch BEFORE the protocol path so we never inject the
	// generic *_BASE_URL / *_API_KEY override (which these CLIs ignore → silent
	// failure). The UI/API gate (getProviderCapabilityError) already prevents a
	// custom endpoint from being configured here.
	const capability = getAgentProviderCapability(agentId);
	if (capability.mode === "vendor") {
		return buildVendorProviderEnv(capability.vendor, config, resolvedModelId);
	}

	// Resolve env vars based on provider protocols + agent compatibility.
	// When the config predates protocols, fall back to the agent's primary
	// protocol (e.g. claude → anthropic, codex → openai) carrying the legacy
	// baseUrl, rather than a blanket openai default that claude can't speak.
	const agentProtocols = AGENT_PROTOCOL_COMPATIBILITY[agentId] ?? [];
	const fallbackProtocol: ProviderProtocol = agentProtocols[0] ?? "openai";
	const protocols: ProtocolConfig[] = config.protocols ?? [{ protocol: fallbackProtocol, baseUrl: config.baseUrl }];

	const protocolEnv = resolveProtocolEnvVars(protocols, agentId);
	if (!protocolEnv) {
		// Agent not compatible with the provider's protocols — surface it instead
		// of silently launching with no override.
		throw new IncompatibleAgentProviderError(
			agentId,
			protocols.map((p) => p.protocol),
			getAgentProtocols(agentId),
		);
	}

	// Honor the resolved (committed/store-folded) model over the raw config model
	// so a workspace committed provider's model takes effect for the agent.
	return buildDirectOverrideEnv(protocolEnv, config, resolvedModelId);
}

/**
 * Build env for a vendor agent (gemini/kiro), which speaks only its vendor-native
 * API — no generic `*_BASE_URL`/`*_API_KEY` override.
 *
 *   - `"google"` (gemini): injects the official Gemini CLI vars. With a GCP
 *     project configured it goes the Vertex AI route
 *     (`GOOGLE_GENAI_USE_VERTEXAI` + `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`
 *     + `GOOGLE_API_KEY`); otherwise the AI-Studio route (`GEMINI_API_KEY`). The
 *     model is `GEMINI_MODEL`.
 *   - `"kiro"` (v1): official login only — the model is applied via Kiro's native
 *     agent config (see the kiro adapter), not env, and the custom API-key env
 *     contract is deferred, so NO env is injected here. `resolvedModelId` is still
 *     returned so the adapter can apply it.
 */
function buildVendorProviderEnv(
	vendor: AgentVendorId | undefined,
	config: AgentProviderConfig,
	model: string | null,
): AgentProviderEnv {
	if (vendor === "google") {
		return buildGoogleVendorEnv(config, model);
	}
	// kiro (and any future vendor without env projection): no env, model via native config.
	return { env: {}, usesCustomProvider: false, resolvedModelId: model };
}

function buildGoogleVendorEnv(config: AgentProviderConfig, model: string | null): AgentProviderEnv {
	const env: Record<string, string | undefined> = {};
	const projectId = config.gcp?.projectId?.trim();
	if (projectId) {
		// Vertex AI route.
		env.GOOGLE_GENAI_USE_VERTEXAI = "true";
		env.GOOGLE_CLOUD_PROJECT = projectId;
		const region = config.gcp?.region?.trim() || config.region?.trim();
		if (region) {
			env.GOOGLE_CLOUD_LOCATION = region;
		}
		if (config.apiKey) {
			env.GOOGLE_API_KEY = config.apiKey;
		}
	} else if (config.apiKey) {
		// AI-Studio route.
		env.GEMINI_API_KEY = config.apiKey;
	}
	if (model) {
		env.GEMINI_MODEL = model;
	}
	return {
		env,
		usesCustomProvider: Object.keys(env).length > 0,
		resolvedModelId: model,
	};
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
	model: string | null,
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
				? resolveAnthropicApiKeyEnvVar(config.anthropic?.apiKeyField)
				: resolved.apiKeyEnvVar;
		env[apiKeyEnvVar] = config.apiKey;
	}

	// Anthropic-only model overrides + opt-in gateway model discovery.
	if (resolved.matchedProtocol === "anthropic") {
		if (model) {
			env.ANTHROPIC_MODEL = model;
		}
		const defaults = config.anthropic?.defaultModels;
		if (defaults?.haiku) {
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaults.haiku;
		}
		if (defaults?.sonnet) {
			env.ANTHROPIC_DEFAULT_SONNET_MODEL = defaults.sonnet;
		}
		if (defaults?.opus) {
			env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaults.opus;
		}
		if (config.anthropic?.enableGatewayModelDiscovery) {
			env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
		}
	}

	return {
		env,
		usesCustomProvider: Object.keys(env).length > 0,
		resolvedModelId: model,
	};
}
