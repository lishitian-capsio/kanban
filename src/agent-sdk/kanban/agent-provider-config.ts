// Agent-level provider configuration store.
//
// Each agent (Claude Code, Codex, Pi, etc.) owns a *set* of named provider
// configs plus a default. A session can pick any one of them by `providerId`
// (the provider name) at launch, so two sessions of the same agent can each run
// a different provider in parallel. Each provider config stores its full
// settings (apiKey, baseUrl, model, protocols, etc.) — no global provider pool,
// no cross-agent sharing.
//
// Storage: ~/.kanban/settings/agent_providers.json
//
// The provider id within an agent is the (normalized) provider name, so an agent
// can register e.g. "anthropic" and "my-relay" side by side. Adding/changing a
// provider takes effect on the next session launch — no restart.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockedFileSystem } from "../../fs/locked-file-system";
import type { ApiKeyField, ProtocolConfig } from "./provider-protocol";
import type { AnthropicDefaultModels, ProviderSettingsReasoning } from "./provider-types";

// ------------------------------------------------------------------ types

/**
 * Per-agent provider configuration. Each agent stores its complete provider
 * settings independently — no global pool, no cross-agent sharing.
 */
export interface AgentProviderConfig {
	/** Agent id (e.g. "claude", "codex", "pi", "droid", "gemini", "qwen"). */
	agentId: string;
	/** Provider name/id (e.g. "anthropic", "openai", custom name). */
	provider?: string;
	/** Selected model id. */
	model?: string;
	/** API key for the provider. */
	apiKey?: string;
	/** @deprecated Legacy single baseUrl. Use `protocols[].baseUrl` instead. */
	baseUrl?: string;
	/** Per-protocol configuration with independent base URLs. */
	protocols?: ProtocolConfig[];
	/** Which header the Anthropic-protocol key is sent under (defaults to auth_token). */
	apiKeyField?: ApiKeyField;
	/** Optional per-tier Anthropic model overrides (ANTHROPIC_DEFAULT_*_MODEL). */
	anthropicDefaultModels?: AnthropicDefaultModels;
	/** Reasoning/thinking settings. */
	reasoning?: ProviderSettingsReasoning;
	/** Custom HTTP headers to include in requests. */
	headers?: Record<string, string>;
	/** Request timeout in milliseconds. */
	timeout?: number;
	/** Cloud region. */
	region?: string;
	/** AWS-specific configuration (Bedrock etc.). */
	aws?: Record<string, unknown>;
	/** GCP-specific configuration (Vertex AI etc.). */
	gcp?: { projectId?: string; region?: string };
}

/**
 * The set of provider configs an agent has registered, plus which one is the
 * default (used when a session does not explicitly select a provider).
 */
export interface AgentProviderSet {
	/** Agent id (normalized lowercase). */
	agentId: string;
	/** All registered provider configs for this agent. */
	providers: AgentProviderConfig[];
	/** Provider id (normalized provider name) of the default selection, if any. */
	defaultProviderId?: string;
}

interface AgentProvidersFile {
	agents: Record<string, AgentProviderSet>;
}

// ------------------------------------------------------------------ paths

const KANBAN_SETTINGS_DIR = join(homedir(), ".kanban", "settings");
const KANBAN_AGENT_PROVIDERS_PATH = join(KANBAN_SETTINGS_DIR, "agent_providers.json");

export function resolveAgentProvidersPath(): string {
	const envOverride = process.env.KANBAN_AGENT_PROVIDERS_PATH?.trim();
	if (envOverride) {
		return envOverride;
	}
	return KANBAN_AGENT_PROVIDERS_PATH;
}

// ------------------------------------------------------------------ store

let cachedState: AgentProvidersFile | null = null;

/** Coerce one raw on-disk object into a validated AgentProviderConfig. */
function validateConfig(agentId: string, config: Record<string, unknown>): AgentProviderConfig {
	const c = config as Partial<AgentProviderConfig>;
	return {
		agentId,
		provider: typeof c.provider === "string" ? c.provider : undefined,
		model: typeof c.model === "string" ? c.model : undefined,
		apiKey: typeof c.apiKey === "string" ? c.apiKey : undefined,
		baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : undefined,
		protocols: Array.isArray(c.protocols) ? c.protocols : undefined,
		apiKeyField: c.apiKeyField === "auth_token" || c.apiKeyField === "api_key" ? c.apiKeyField : undefined,
		anthropicDefaultModels:
			c.anthropicDefaultModels && typeof c.anthropicDefaultModels === "object"
				? c.anthropicDefaultModels
				: undefined,
		reasoning: c.reasoning,
		headers: c.headers,
		timeout: typeof c.timeout === "number" ? c.timeout : undefined,
		region: typeof c.region === "string" ? c.region : undefined,
		aws: c.aws,
		gcp: c.gcp,
	};
}

/**
 * Coerce one raw on-disk agent value into an AgentProviderSet.
 *
 * Backward-compat: the legacy on-disk shape stored a *single* provider config
 * per agent (no `providers` array). Such a value is migrated in-memory into a
 * one-element set whose default is that provider.
 */
function validateSet(agentId: string, value: unknown): AgentProviderSet | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const raw = value as Record<string, unknown>;
	if (Array.isArray(raw.providers)) {
		const providers = raw.providers
			.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
			.map((p) => validateConfig(agentId, p));
		const defaultProviderId =
			typeof raw.defaultProviderId === "string" ? normalizeProviderId(raw.defaultProviderId) : undefined;
		return reconcileSet({ agentId, providers, defaultProviderId });
	}
	// Legacy single-config shape.
	const legacy = validateConfig(agentId, raw);
	return reconcileSet({ agentId, providers: [legacy], defaultProviderId: providerIdOf(legacy) });
}

function readStore(path: string): AgentProvidersFile {
	if (!existsSync(path)) {
		return { agents: {} };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<AgentProvidersFile>;
		if (parsed.agents && typeof parsed.agents === "object") {
			const validated: Record<string, AgentProviderSet> = {};
			for (const [agentId, value] of Object.entries(parsed.agents)) {
				const set = validateSet(normalizeAgentId(agentId), value);
				if (set) {
					validated[normalizeAgentId(agentId)] = set;
				}
			}
			return { agents: validated };
		}
		return { agents: {} };
	} catch {
		return { agents: {} };
	}
}

function loadState(): AgentProvidersFile {
	if (cachedState) {
		return cachedState;
	}

	const path = resolveAgentProvidersPath();
	const state = readStore(path);

	cachedState = state;
	return state;
}

async function writeStore(state: AgentProvidersFile): Promise<void> {
	const path = resolveAgentProvidersPath();
	await lockedFileSystem.writeJsonFileAtomic(path, state, {
		lock: { path, type: "file" },
	});
	cachedState = state;
}

function normalizeAgentId(agentId: string): string {
	return agentId.trim().toLowerCase();
}

/** The provider id used to address a provider within an agent (its normalized name). */
export function normalizeProviderId(providerId: string | undefined | null): string {
	return (providerId ?? "").trim().toLowerCase();
}

/** Provider id of a config (its normalized provider name, or "default" when unnamed). */
function providerIdOf(config: AgentProviderConfig): string {
	return normalizeProviderId(config.provider) || "default";
}

/**
 * Ensure a set is internally consistent: drop empty provider lists' default and
 * point `defaultProviderId` at an existing provider (the first when unset/stale).
 */
function reconcileSet(set: AgentProviderSet): AgentProviderSet {
	const providers = set.providers;
	if (providers.length === 0) {
		return { agentId: set.agentId, providers: [], defaultProviderId: undefined };
	}
	const ids = providers.map(providerIdOf);
	const defaultProviderId =
		set.defaultProviderId && ids.includes(set.defaultProviderId) ? set.defaultProviderId : ids[0];
	return { agentId: set.agentId, providers, defaultProviderId };
}

/** Trim/normalize a provider config's string fields prior to persistence. */
function cleanProviderConfig(agentId: string, config: AgentProviderConfig): AgentProviderConfig {
	const cleaned: AgentProviderConfig = { ...config, agentId };
	if (cleaned.provider !== undefined) {
		cleaned.provider = cleaned.provider.trim() || undefined;
	}
	if (cleaned.model !== undefined) {
		cleaned.model = cleaned.model.trim() || undefined;
	}
	if (cleaned.apiKey !== undefined) {
		cleaned.apiKey = cleaned.apiKey.trim() || undefined;
	}
	if (cleaned.baseUrl !== undefined) {
		cleaned.baseUrl = cleaned.baseUrl.trim() || undefined;
	}
	if (cleaned.protocols) {
		cleaned.protocols = cleaned.protocols.map((c) => {
			const trimmed: ProtocolConfig = { protocol: c.protocol };
			if (c.baseUrl) {
				const v = c.baseUrl.trim();
				if (v) trimmed.baseUrl = v;
			}
			return trimmed;
		});
		const firstBaseUrl = cleaned.protocols[0]?.baseUrl;
		if (firstBaseUrl && !cleaned.baseUrl) {
			cleaned.baseUrl = firstBaseUrl;
		}
	}
	if (cleaned.reasoning) {
		const r = { ...cleaned.reasoning };
		if (typeof r.effort === "string") {
			r.effort = r.effort.trim() || undefined;
		}
		cleaned.reasoning =
			r.enabled === undefined && r.effort === undefined && r.budgetTokens === undefined ? undefined : r;
	}
	return cleaned;
}

// ------------------------------------------------------------------ public API

/**
 * Get a single provider config for an agent.
 *
 * - With `providerId`: returns that exact provider, or `null` if the agent has
 *   not registered it.
 * - Without `providerId`: returns the agent's default provider, or `null` when
 *   the agent has no providers configured.
 */
export function getAgentProviderConfig(agentId: string, providerId?: string): AgentProviderConfig | null {
	const set = getAgentProviderSet(agentId);
	if (!set || set.providers.length === 0) {
		return null;
	}
	const targetId = providerId !== undefined ? normalizeProviderId(providerId) : set.defaultProviderId;
	if (!targetId) {
		return null;
	}
	return set.providers.find((p) => providerIdOf(p) === targetId) ?? null;
}

/** Get the full provider set (all registered providers + default) for an agent. */
export function getAgentProviderSet(agentId: string): AgentProviderSet | null {
	const state = loadState();
	return state.agents[normalizeAgentId(agentId)] ?? null;
}

/**
 * Add or update a provider for an agent, keyed by its (normalized) provider
 * name. The first provider registered for an agent becomes its default.
 */
export async function saveAgentProvider(agentId: string, config: AgentProviderConfig): Promise<void> {
	const state = loadState();
	const id = normalizeAgentId(agentId);
	const cleaned = cleanProviderConfig(id, config);
	const cleanedId = providerIdOf(cleaned);

	const existing = state.agents[id];
	const providers = existing ? existing.providers.filter((p) => providerIdOf(p) !== cleanedId) : [];
	providers.push(cleaned);
	const defaultProviderId = existing?.defaultProviderId ?? cleanedId;

	state.agents[id] = reconcileSet({ agentId: id, providers, defaultProviderId });
	await writeStore(state);
}

/**
 * Delete a provider config.
 *
 * - With `providerId`: removes just that provider (re-pointing the default to
 *   another provider when the removed one was the default).
 * - Without `providerId`: removes the agent's entire provider set.
 */
export async function deleteAgentProvider(agentId: string, providerId?: string): Promise<void> {
	const state = loadState();
	const id = normalizeAgentId(agentId);

	if (providerId === undefined) {
		delete state.agents[id];
		await writeStore(state);
		return;
	}

	const existing = state.agents[id];
	if (!existing) {
		return;
	}
	const targetId = normalizeProviderId(providerId);
	const providers = existing.providers.filter((p) => providerIdOf(p) !== targetId);
	const defaultProviderId = existing.defaultProviderId === targetId ? undefined : existing.defaultProviderId;
	if (providers.length === 0) {
		delete state.agents[id];
	} else {
		state.agents[id] = reconcileSet({ agentId: id, providers, defaultProviderId });
	}
	await writeStore(state);
}

/** Set which registered provider is the agent's default. No-op if unknown. */
export async function setDefaultAgentProvider(agentId: string, providerId: string): Promise<void> {
	const state = loadState();
	const id = normalizeAgentId(agentId);
	const existing = state.agents[id];
	if (!existing) {
		return;
	}
	const targetId = normalizeProviderId(providerId);
	if (!existing.providers.some((p) => providerIdOf(p) === targetId)) {
		return;
	}
	state.agents[id] = reconcileSet({ ...existing, defaultProviderId: targetId });
	await writeStore(state);
}

/**
 * Get the default provider config for every configured agent (back-compat shape
 * for the legacy single-provider list view). Agents with no providers are
 * omitted.
 */
export function getAllAgentProviderConfigs(): Record<string, AgentProviderConfig> {
	const state = loadState();
	const result: Record<string, AgentProviderConfig> = {};
	for (const [agentId, set] of Object.entries(state.agents)) {
		const config = getAgentProviderConfig(agentId);
		if (config) {
			result[agentId] = config;
		} else if (set.providers[0]) {
			result[agentId] = set.providers[0];
		}
	}
	return result;
}

/** Get the full provider set for every configured agent. */
export function getAllAgentProviderSets(): Record<string, AgentProviderSet> {
	const state = loadState();
	return { ...state.agents };
}

/** Return provider sets with every `apiKey` stripped — safe to send over the wire. */
export function redactAgentProviderSets(
	sets: Record<string, AgentProviderSet>,
): Record<string, AgentProviderSet> {
	const out: Record<string, AgentProviderSet> = {};
	for (const [agentId, set] of Object.entries(sets)) {
		out[agentId] = {
			...set,
			providers: set.providers.map(({ apiKey, ...rest }) => ({ ...rest })),
		};
	}
	return out;
}

/** Reset the in-memory cache (useful for tests). */
export function resetAgentProviderConfigCache(): void {
	cachedState = null;
}
