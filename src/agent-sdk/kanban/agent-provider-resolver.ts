// Shared agent provider *selection* resolver.
//
// pi (in-process omp; needs a model object + native OAuth) and the external CLI
// agents (separate binaries; env-only) are intentionally DIFFERENT launch
// mechanisms — this module does NOT merge them. What it unifies is the one thing
// they genuinely share: the *selection* of which provider/model/reasoning a
// session launches with, folding the same layered precedence:
//
//   1. task/card-level overrides (`*Override`),
//   2. the workspace's selected committed provider (secret-free, git-tracked),
//   3. the machine-home per-agent provider store (carries the secret + protocols),
//   4. the agent's default / official login.
//
// The per-kind specifics stay in the adapters: `pi-provider-config` turns the
// result into an omp model object (+ built-in pi defaults); `env-injector` turns
// it into env vars (+ protocol-compatibility validation). This is the
// "thin shared contract + per-kind typed specifics" boundary, not a unified
// provider service.
//
// SECURITY: the API key is never part of the returned non-secret fields. It lives
// on the machine-home `config` (resolved here) and in environment variables; it is
// never read from a committed provider record (which is git-tracked).

import type { RuntimeReasoningEffort } from "../../core/api-contract";
import { type AgentProviderConfig, getAgentProviderConfig, getAgentProviderSet } from "./agent-provider-config";
import { agentSupportsOfficialLogin, isOfficialLoginProviderId } from "./provider-protocol";

/**
 * Non-secret launch fields contributed by the workspace's currently selected
 * committed provider. Always secret-free: the API key still comes from the
 * machine-home store (by providerId), never from here.
 */
export interface CommittedProviderLayer {
	providerId?: string | null;
	modelId?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
}

export interface AgentProviderResolveInput {
	/** The agent runtime the session will launch (e.g. "pi", "claude", "codex"). */
	agentId: string;
	/** Task/card-level provider override (highest priority). */
	providerIdOverride?: string | null;
	/** Task/card-level model override (highest priority). */
	modelIdOverride?: string | null;
	/** Task/card-level reasoning-effort override (highest priority). */
	reasoningEffortOverride?: RuntimeReasoningEffort | null;
	/** The workspace's selected committed provider for this agent, already loaded. */
	committedProvider?: CommittedProviderLayer | null;
}

export interface AgentProviderResolveOptions {
	/**
	 * When an explicit provider is selected (override/committed) but the
	 * machine-home store has no config for it, fall back to the agent's default
	 * provider config. CLI agents do this (preserving long-standing behavior);
	 * pi does not (an unknown explicit selection must not silently borrow the
	 * default provider's model/endpoint).
	 */
	defaultProviderFallback?: boolean;
}

/** A resolved provider selection, agent-agnostic. */
export type ResolvedAgentProvider =
	| { kind: "official-login" }
	| {
			kind: "provider";
			/**
			 * The resolved provider id (override → committed → machine-home config's
			 * provider). `null` when nothing resolved — the adapter applies its own
			 * default (pi: built-in defaults; CLI: no env override / native login).
			 */
			providerId: string | null;
			/** Folded non-secret model id (override → committed → store). */
			modelId: string | null;
			/** Folded non-secret base URL (committed → store). */
			baseUrl: string | null;
			/** Folded non-secret reasoning effort (override → committed → store). */
			reasoningEffort: RuntimeReasoningEffort | null;
			/**
			 * The machine-home provider config for the resolved provider, or `null`.
			 * This is the ONLY carrier of the secret (`apiKey`) and the provider's
			 * protocol(s); adapters read the key/protocol from here.
			 */
			config: AgentProviderConfig | null;
	  };

/** Trim a possibly-null string and collapse empty/whitespace-only values to `null`. */
function normalizeOptional(value?: string | null): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Look up the machine-home provider config for the selected provider. Wrapped so
 * a malformed/unavailable store degrades to `null` (no config) rather than
 * throwing out of the resolver.
 */
function lookupProviderConfig(
	agentId: string,
	selectedProviderId: string | null,
	defaultProviderFallback: boolean,
): AgentProviderConfig | null {
	try {
		if (selectedProviderId === null) {
			return getAgentProviderConfig(agentId);
		}
		const exact = getAgentProviderConfig(agentId, selectedProviderId);
		if (exact) {
			return exact;
		}
		return defaultProviderFallback ? getAgentProviderConfig(agentId) : null;
	} catch {
		return null;
	}
}

/** The agent's machine-home default provider id, or `null` when unavailable. */
function defaultProviderIdOf(agentId: string): string | null {
	try {
		return getAgentProviderSet(agentId)?.defaultProviderId ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve which provider/model/reasoning an agent session should launch with.
 *
 * This is the single entry point for provider *selection* shared by pi and the
 * CLI agents. It performs the layered precedence fold, the official-login
 * short-circuit, and the machine-home config lookup; it does NOT build env vars,
 * resolve API keys from the environment, or validate protocol compatibility —
 * those are per-kind adapter concerns.
 */
export function resolveAgentProvider(
	input: AgentProviderResolveInput,
	options: AgentProviderResolveOptions = {},
): ResolvedAgentProvider {
	const { agentId } = input;
	const overrideProviderId = normalizeOptional(input.providerIdOverride);
	const committed = input.committedProvider ?? null;
	const committedProviderId = normalizeOptional(committed?.providerId);

	// The explicit selection from the two highest-priority layers.
	const selectedProviderId = overrideProviderId ?? committedProviderId;

	// Official login: only for agents that support it (never pi). Honored when the
	// explicit selection — or, absent one, the agent's machine-home default — is
	// the official sentinel. We return BEFORE any config lookup so this can never
	// fall through to a custom/default provider, which would clobber the agent's
	// native login.
	if (agentSupportsOfficialLogin(agentId)) {
		const effectiveProviderId = selectedProviderId ?? defaultProviderIdOf(agentId);
		if (isOfficialLoginProviderId(effectiveProviderId)) {
			return { kind: "official-login" };
		}
	}

	// Fold layers 1 + 2 (in-memory): override wins, then the committed provider.
	// There is no per-session baseUrl override, so it only comes from the
	// committed provider here.
	let providerId = selectedProviderId;
	let modelId = normalizeOptional(input.modelIdOverride) ?? normalizeOptional(committed?.modelId);
	let baseUrl = normalizeOptional(committed?.baseUrl);
	let reasoningEffort = input.reasoningEffortOverride ?? committed?.reasoningEffort ?? null;

	// Layer 3 (machine-home store): read the config for the resolved provider (or
	// the agent default when nothing was selected). Fill any still-missing
	// non-secret field from it — gated on a *core* field (provider/model/baseUrl)
	// being unresolved so an explicit provider+model+baseUrl selection isn't
	// diluted by the store's reasoning effort.
	const config = lookupProviderConfig(agentId, selectedProviderId, options.defaultProviderFallback ?? false);
	if (providerId === null || modelId === null || baseUrl === null) {
		if (config) {
			providerId ??= normalizeOptional(config.provider);
			modelId ??= normalizeOptional(config.model);
			baseUrl ??= normalizeOptional(config.baseUrl);
			// The store value is not validated against the effort enum here, matching
			// historical behavior — it is cast and passed through as-is.
			reasoningEffort ??= normalizeOptional(config.reasoning?.effort) as RuntimeReasoningEffort | null;
		}
	}

	return { kind: "provider", providerId, modelId, baseUrl, reasoningEffort, config };
}
