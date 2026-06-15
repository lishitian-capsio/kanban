// Agent-level provider configuration store.
//
// Each agent (Claude Code, Codex, Pi, etc.) has its own independent provider
// configuration. An agent stores the full provider settings (apiKey, baseUrl,
// model, protocols, etc.) directly — no global provider pool, no shared config.
//
// Storage: ~/.kanban/settings/agent_providers.json
//
// Switching the provider takes effect on the next request — no session restart.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockedFileSystem } from "../../fs/locked-file-system";
import type { ProtocolConfig } from "./provider-protocol";
import type { ProviderSettingsReasoning } from "./provider-types";

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

interface AgentProvidersFile {
	agents: Record<string, AgentProviderConfig>;
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

function readStore(path: string): AgentProvidersFile {
	if (!existsSync(path)) {
		return { agents: {} };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<AgentProvidersFile>;
		if (parsed.agents && typeof parsed.agents === "object") {
			const validated: Record<string, AgentProviderConfig> = {};
			for (const [agentId, config] of Object.entries(parsed.agents)) {
				if (config && typeof config === "object") {
					validated[agentId] = {
						agentId,
						provider: typeof config.provider === "string" ? config.provider : undefined,
						model: typeof config.model === "string" ? config.model : undefined,
						apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
						baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
						protocols: Array.isArray(config.protocols) ? config.protocols : undefined,
						reasoning: config.reasoning,
						headers: config.headers,
						timeout: typeof config.timeout === "number" ? config.timeout : undefined,
						region: typeof config.region === "string" ? config.region : undefined,
						aws: config.aws,
						gcp: config.gcp,
					};
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

// ------------------------------------------------------------------ public API

/**
 * Get the provider config for a specific agent. Returns `null` if the agent
 * has not been configured yet.
 */
export function getAgentProviderConfig(agentId: string): AgentProviderConfig | null {
	const state = loadState();
	const id = normalizeAgentId(agentId);
	return state.agents[id] ?? null;
}

/**
 * Save (overwrite) the full provider config for an agent.
 */
export async function saveAgentProvider(agentId: string, config: AgentProviderConfig): Promise<void> {
	const state = loadState();
	const id = normalizeAgentId(agentId);

	// Clean string fields
	const cleaned: AgentProviderConfig = { ...config, agentId: id };
	if (cleaned.provider !== undefined) {
		const v = cleaned.provider.trim();
		cleaned.provider = v || undefined;
	}
	if (cleaned.model !== undefined) {
		const v = cleaned.model.trim();
		cleaned.model = v || undefined;
	}
	if (cleaned.apiKey !== undefined) {
		const v = cleaned.apiKey.trim();
		cleaned.apiKey = v || undefined;
	}
	if (cleaned.baseUrl !== undefined) {
		const v = cleaned.baseUrl.trim();
		cleaned.baseUrl = v || undefined;
	}
	// Clean protocol configs: trim each baseUrl
	if (cleaned.protocols) {
		cleaned.protocols = cleaned.protocols.map((c) => {
			const trimmed: ProtocolConfig = { protocol: c.protocol };
			if (c.baseUrl) {
				const v = c.baseUrl.trim();
				if (v) trimmed.baseUrl = v;
			}
			return trimmed;
		});
		// Sync legacy baseUrl from first protocol config
		const firstBaseUrl = cleaned.protocols[0]?.baseUrl;
		if (firstBaseUrl && !cleaned.baseUrl) {
			cleaned.baseUrl = firstBaseUrl;
		}
	}
	if (cleaned.reasoning) {
		const r = { ...cleaned.reasoning };
		if (typeof r.effort === "string") {
			const v = r.effort.trim();
			r.effort = v || undefined;
		}
		if (r.enabled === undefined && r.effort === undefined && r.budgetTokens === undefined) {
			cleaned.reasoning = undefined;
		} else {
			cleaned.reasoning = r;
		}
	}

	state.agents[id] = cleaned;
	await writeStore(state);
}

/**
 * Delete the provider config for an agent.
 */
export async function deleteAgentProvider(agentId: string): Promise<void> {
	const state = loadState();
	const id = normalizeAgentId(agentId);
	delete state.agents[id];
	await writeStore(state);
}

/**
 * Get all configured agent providers (for listing in UI).
 * Only returns agents that have been explicitly configured — no defaults.
 */
export function getAllAgentProviderConfigs(): Record<string, AgentProviderConfig> {
	const state = loadState();
	return { ...state.agents };
}

/** Reset the in-memory cache (useful for tests). */
export function resetAgentProviderConfigCache(): void {
	cachedState = null;
}

// ------------------------------------------------------------------ deprecated stubs
// Kept for backward compatibility until runtime-api.ts / app-router.ts are updated.

/** @deprecated Use saveAgentProvider() instead. */
export async function saveAgentProviderConfig(config: AgentProviderConfig): Promise<void> {
	await saveAgentProvider(config.agentId, config);
}

/** @deprecated Will be removed. */
export async function addProviderToAgent(_agentId: string, _providerId: string): Promise<void> {
	// No-op in per-agent model.
}

/** @deprecated Will be removed. */
export async function removeProviderFromAgent(_agentId: string, _providerId: string): Promise<void> {
	// No-op in per-agent model.
}

/** @deprecated Will be removed. */
export async function selectAgentProvider(_agentId: string, _providerId: string): Promise<void> {
	// No-op in per-agent model.
}
