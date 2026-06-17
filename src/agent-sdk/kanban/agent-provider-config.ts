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
import { z } from "zod";
import {
	runtimeAgentProviderConfigSchema,
	runtimeProviderProtocolSchema,
	runtimeReasoningEffortSchema,
} from "../../core/api-contract";
import { lockedFileSystem } from "../../fs/locked-file-system";
import { createLogger } from "../../logging";
import {
	collapseToAgentProtocol,
	isOfficialLoginProviderId,
	OFFICIAL_LOGIN_PROVIDER_ID,
	type ProtocolConfig,
} from "./provider-protocol";
import type { AnthropicProviderSettings, ProviderSettingsReasoning } from "./provider-types";

const log = createLogger("agent-provider-config");

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
	/** Selected/default model id. Must be one of `models` when that list is set. */
	model?: string;
	/** Full list of models the user configured/fetched for this provider. */
	models?: string[];
	/** Remote `/models` discovery endpoint the model list was fetched from. */
	modelsSourceUrl?: string;
	/** API key for the provider. */
	apiKey?: string;
	/**
	 * @deprecated Read-time backward-compat mirror only. The endpoint's single
	 * source of truth is `protocols[0].baseUrl`; this field is re-derived from it
	 * on read and is never persisted. Do not write to it.
	 */
	baseUrl?: string;
	/**
	 * The protocol this provider speaks for this agent, with its base URL — the
	 * single source of truth for the endpoint. A per-agent provider speaks exactly
	 * one protocol (the resolver only ever injects one), so this is kept to a
	 * single entry; the array shape is retained for the wire contract.
	 */
	protocols?: ProtocolConfig[];
	/**
	 * Anthropic-protocol-specific settings (key header + per-tier model
	 * overrides). Only meaningful when the provider speaks the Anthropic
	 * protocol; grouped here rather than flattened onto the generic config so
	 * the scope is explicit and non-Anthropic providers don't carry dead fields.
	 */
	anthropic?: AnthropicProviderSettings;
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

/**
 * Validated shape of one persisted provider config (sans `agentId`, which is
 * supplied by the caller). Reuses the wire contract for the shared fields and
 * tightens the enums it leaves as free strings — notably `reasoning.effort` and
 * the protocol names — so corrupt on-disk values are caught rather than trusted.
 */
const storedProviderConfigSchema = runtimeAgentProviderConfigSchema.omit({ agentId: true }).extend({
	protocols: z.array(z.object({ protocol: runtimeProviderProtocolSchema, baseUrl: z.string().optional() })).optional(),
	reasoning: z
		.object({
			enabled: z.boolean().optional(),
			effort: runtimeReasoningEffortSchema.optional(),
			budgetTokens: z.number().optional(),
		})
		.optional(),
	// `anthropic` is inherited from the wire schema, which already validates
	// `apiKeyField` as a strict enum — no further tightening needed here.
});

/**
 * Fold the pre-namespace on-disk shape (flat top-level `apiKeyField` /
 * `anthropicDefaultModels`) into the `anthropic` namespace. Older stores — and
 * any hand-edited `agent_providers.json` — used the flat fields; lifting them on
 * read keeps those configs working with no migration step or data loss. An
 * explicit `anthropic` object always wins over the legacy fields.
 */
function liftLegacyAnthropicFields(config: Record<string, unknown>): Record<string, unknown> {
	const legacyApiKeyField = config.apiKeyField;
	const legacyDefaultModels = config.anthropicDefaultModels;
	if (legacyApiKeyField === undefined && legacyDefaultModels === undefined) {
		return config;
	}
	const { apiKeyField: _apiKeyField, anthropicDefaultModels: _anthropicDefaultModels, ...rest } = config;
	const existingAnthropic = (config.anthropic as Record<string, unknown> | undefined) ?? {};
	return {
		...rest,
		anthropic: {
			...(legacyApiKeyField !== undefined ? { apiKeyField: legacyApiKeyField } : {}),
			...(legacyDefaultModels !== undefined ? { defaultModels: legacyDefaultModels } : {}),
			...existingAnthropic,
		},
	};
}

/**
 * Lenient variant derived from the strict shape: a single malformed field
 * (e.g. an unknown `reasoning.effort`) falls back to `undefined` instead of
 * discarding the whole provider. The strict schema is still run first, purely
 * to surface *which* field was invalid via a warning — the recovery itself is
 * never silent.
 */
const lenientProviderConfigSchema = z.object(
	Object.fromEntries(
		Object.entries(storedProviderConfigSchema.shape).map(([key, schema]) => [
			key,
			(schema as z.ZodTypeAny).catch(undefined),
		]),
	),
);

type StoredProviderConfig = z.infer<typeof storedProviderConfigSchema>;

/**
 * Collapse a config's protocol fields to the single-protocol invariant: exactly
 * one `protocols` entry (the one this agent uses) and a `baseUrl` re-derived from
 * it as a read-time backward-compat mirror. Folds a legacy scalar `baseUrl` (and
 * any extra, never-used protocols on older stores) into that single entry. This
 * runs on every read so all in-memory configs are uniform and downstream readers
 * never see the dual baseUrl/protocols paths.
 */
function normalizeProtocolFields(agentId: string, config: AgentProviderConfig): AgentProviderConfig {
	const single = collapseToAgentProtocol(agentId, config.protocols, config.baseUrl);
	return { ...config, protocols: [single], baseUrl: single.baseUrl };
}

/** Validate one raw on-disk object into an AgentProviderConfig (Zod-backed). */
function validateConfig(agentId: string, rawConfig: Record<string, unknown>): AgentProviderConfig {
	const config = liftLegacyAnthropicFields(rawConfig);
	const result = storedProviderConfigSchema.safeParse(config);
	if (result.success) {
		return normalizeProtocolFields(agentId, { agentId, ...result.data });
	}
	log.warn("Dropping invalid field(s) from stored agent provider config", {
		agentId,
		issues: result.error.issues.map((issue) => ({
			path: issue.path.join(".") || "(root)",
			code: issue.code,
			message: issue.message,
		})),
	});
	return normalizeProtocolFields(agentId, {
		agentId,
		...(lenientProviderConfigSchema.parse(config) as StoredProviderConfig),
	});
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
		log.warn("Skipping malformed agent provider entry (not an object)", { agentId });
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
		log.warn("Agent provider store is missing a valid 'agents' object; ignoring", { path });
		return { agents: {} };
	} catch (error) {
		log.warn("Failed to read agent provider store; ignoring", { path, error });
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
	// The official-login sentinel is a valid default even though no provider
	// record matches it (it means "use the agent's native login, no override").
	const defaultProviderId =
		set.defaultProviderId && (isOfficialLoginProviderId(set.defaultProviderId) || ids.includes(set.defaultProviderId))
			? set.defaultProviderId
			: ids[0];
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
	if (cleaned.modelsSourceUrl !== undefined) {
		cleaned.modelsSourceUrl = cleaned.modelsSourceUrl.trim() || undefined;
	}
	if (cleaned.models !== undefined) {
		// Trim, drop empties, and de-duplicate while preserving order.
		const deduped = [...new Set(cleaned.models.map((m) => m.trim()).filter(Boolean))];
		cleaned.models = deduped.length > 0 ? deduped : undefined;
	}
	// Enforce the invariant that the default model is one of `models`.
	if (cleaned.models && cleaned.models.length > 0) {
		if (!cleaned.model || !cleaned.models.includes(cleaned.model)) {
			cleaned.model = cleaned.models[0];
		}
	}
	if (cleaned.apiKey !== undefined) {
		cleaned.apiKey = cleaned.apiKey.trim() || undefined;
	}
	if (cleaned.baseUrl !== undefined) {
		cleaned.baseUrl = cleaned.baseUrl.trim() || undefined;
	}
	// A per-agent provider speaks exactly one protocol. Collapse to that single
	// protocol — the source of truth for the endpoint — folding in any legacy
	// scalar baseUrl, and drop the scalar baseUrl from what we persist (it is
	// re-derived from `protocols[0]` on read). This is the single write path; no
	// dual-write.
	cleaned.protocols = [collapseToAgentProtocol(agentId, cleaned.protocols, cleaned.baseUrl)];
	cleaned.baseUrl = undefined;
	if (cleaned.reasoning) {
		const r = { ...cleaned.reasoning };
		if (typeof r.effort === "string") {
			r.effort = r.effort.trim() || undefined;
		}
		cleaned.reasoning =
			r.enabled === undefined && r.effort === undefined && r.budgetTokens === undefined ? undefined : r;
	}
	if (cleaned.anthropic) {
		const apiKeyField = cleaned.anthropic.apiKeyField;
		const rawModels = cleaned.anthropic.defaultModels;
		const defaultModels = rawModels
			? Object.fromEntries(
					Object.entries(rawModels)
						.map(([tier, value]) => [tier, value?.trim() || undefined] as const)
						.filter(([, value]) => value !== undefined),
				)
			: undefined;
		const hasDefaultModels = defaultModels && Object.keys(defaultModels).length > 0;
		cleaned.anthropic =
			apiKeyField === undefined && !hasDefaultModels
				? undefined
				: {
						...(apiKeyField !== undefined ? { apiKeyField } : {}),
						...(hasDefaultModels ? { defaultModels } : {}),
					};
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

	// The official-login id is reserved for the "use the agent's native login"
	// sentinel and must not be shadowed by a stored provider.
	if (isOfficialLoginProviderId(cleanedId)) {
		throw new Error(`Provider name "${OFFICIAL_LOGIN_PROVIDER_ID}" is reserved for official login`);
	}

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
	// The official-login sentinel is accepted even though no provider matches it;
	// any other id must name an existing provider.
	if (!isOfficialLoginProviderId(targetId) && !existing.providers.some((p) => providerIdOf(p) === targetId)) {
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
export function redactAgentProviderSets(sets: Record<string, AgentProviderSet>): Record<string, AgentProviderSet> {
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
