// Agent-specific provider environment variable injection.
//
// When a CLI agent has a non-official provider selected, this module builds the
// env vars needed to redirect the agent's API calls to the chosen provider.
//
// For Claude Code, we write to ~/.claude/settings.json (CC Switch approach)
// instead of injecting env vars, to avoid OAuth/API key conflicts.
//
// Two injection modes:
//   1. Settings file (Claude Code) — write to ~/.claude/settings.json
//   2. Direct env var override (Codex, Droid, etc.) — set *_BASE_URL and *_API_KEY
//
// Auth-gateway translation (when extra provider speaks a different protocol)
// is planned for later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	getAgentProviderConfig,
	type AgentProviderConfig,
} from "../agent-sdk/kanban/agent-provider-config";
import { resolveProtocolEnvVars, getBaseUrlForProtocol } from "../agent-sdk/kanban/provider-protocol";

// ------------------------------------------------------------------ types

export interface AgentProviderEnv {
	/** Environment variables to inject into the agent process. */
	env: Record<string, string | undefined>;
	/** Whether a non-official provider is active (for logging). */
	usesCustomProvider: boolean;
}

interface ClaudeSettingsFile {
	env?: {
		ANTHROPIC_BASE_URL?: string;
		ANTHROPIC_API_KEY?: string;
		ANTHROPIC_MODEL?: string;
	};
}

// ------------------------------------------------------------------ Claude Code settings

function getClaudeConfigDir(): string {
	return join(homedir(), ".claude");
}

function getClaudeSettingsPath(): string {
	return join(getClaudeConfigDir(), "settings.json");
}

/**
 * Write provider config to ~/.claude/settings.json (CC Switch approach).
 *
 * When a custom provider is selected, we write both ANTHROPIC_BASE_URL and
 * ANTHROPIC_API_KEY. The API key is required because Claude Code's OAuth token
 * only works with the official api.anthropic.com endpoint — custom endpoints
 * reject it with 403. The "Both claude.ai and ANTHROPIC_API_KEY set" warning
 * is informational; the API key takes precedence and the custom endpoint works.
 *
 * When switching back to the official provider, clearClaudeSettings() removes
 * these keys so OAuth works normally again.
 */
function writeClaudeSettings(config: AgentProviderConfig): void {
	const configDir = getClaudeConfigDir();
	const settingsPath = getClaudeSettingsPath();
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	let current: ClaudeSettingsFile = {};
	if (existsSync(settingsPath)) {
		try {
			current = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettingsFile;
		} catch {
			// corrupted file, start fresh
			current = {};
		}
	}

	current.env = {
		...current.env,
	};

	// Use anthropic protocol's baseUrl if available, fall back to legacy baseUrl
	const anthropicBaseUrl = config.protocols
		? getBaseUrlForProtocol(config.protocols, "anthropic")
		: undefined;
	const baseUrl = anthropicBaseUrl || config.baseUrl;

	if (baseUrl) {
		current.env.ANTHROPIC_BASE_URL = baseUrl;
	}
	if (config.apiKey) {
		current.env.ANTHROPIC_API_KEY = config.apiKey;
	}

	writeFileSync(settingsPath, JSON.stringify(current, null, 2));
}

/**
 * Clear provider config from ~/.claude/settings.json when switching back to official.
 */
function clearClaudeSettings(): void {
	const settingsPath = getClaudeSettingsPath();
	if (!existsSync(settingsPath)) {
		return;
	}

	try {
		const current = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettingsFile;
		if (current.env) {
			delete current.env.ANTHROPIC_BASE_URL;
			delete current.env.ANTHROPIC_API_KEY;
			// If env is now empty, remove it entirely
			if (Object.keys(current.env).length === 0) {
				delete current.env;
			}
		}
		writeFileSync(settingsPath, JSON.stringify(current, null, 2));
	} catch {
		// ignore errors
	}
}

// ------------------------------------------------------------------ public API

/**
 * Build provider-related env vars for a CLI agent based on its agent-level
 * provider config. If the agent has a non-official provider selected and that
 * provider has a baseUrl, the env vars redirect to it.
 *
 * For Claude Code: writes to ~/.claude/settings.json instead of env vars.
 * For other agents: returns env vars for direct injection.
 *
 * Returns `{ env: {}, usesCustomProvider: false }` when the official provider
 * is selected or no custom provider config exists.
 */
export async function buildAgentProviderEnv(agentId: string): Promise<AgentProviderEnv> {
	const config = getAgentProviderConfig(agentId);

	// No per-agent config → no custom provider override.
	if (!config) {
		if (agentId === "claude") {
			clearClaudeSettings();
		}
		return { env: {}, usesCustomProvider: false };
	}

	// Claude Code: write to settings file (CC Switch approach)
	if (agentId === "claude") {
		writeClaudeSettings(config);
		return { env: {}, usesCustomProvider: true };
	}

	// Other agents: resolve env vars based on provider protocols + agent compatibility
	const protocols = config.protocols ?? [{ protocol: "openai" as const }];
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
 * the official one, so we just redirect *_BASE_URL to its endpoint and inject
 * the API key.
 */
function buildDirectOverrideEnv(
	resolved: { baseUrlEnvVar: string; apiKeyEnvVar: string; resolvedBaseUrl: string | undefined },
	config: AgentProviderConfig,
): AgentProviderEnv {
	const env: Record<string, string | undefined> = {};

	// Use resolved baseUrl from protocol config, fall back to legacy config.baseUrl
	const baseUrl = resolved.resolvedBaseUrl || config.baseUrl;
	if (baseUrl) {
		env[resolved.baseUrlEnvVar] = baseUrl;
	}
	if (config.apiKey) {
		env[resolved.apiKeyEnvVar] = config.apiKey;
	}

	return {
		env,
		usesCustomProvider: Object.keys(env).length > 0,
	};
}
