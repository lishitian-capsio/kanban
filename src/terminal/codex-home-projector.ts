// Native Codex provider projector.
//
// Codex (OpenAI's CLI) reads its settings from `$CODEX_HOME/config.toml`. Rather
// than relying solely on the flat `OPENAI_BASE_URL` / `OPENAI_API_KEY` env vars
// (which only reconfigure Codex's built-in `openai` provider), a custom provider
// for a Codex task is projected into an *isolated* CODEX_HOME so the user's
// global `~/.codex` is never touched. The generated `config.toml` carries the
// rich native settings — a named `[model_providers.<id>]` entry plus model,
// reasoning, and auth knobs — that the env vars alone can't express.
//
// SECURITY: the API key is NEVER written to the config. The provider entry uses
// Codex's `env_key` indirection (`env_key = "OPENAI_API_KEY"`) so the secret is
// read from the per-spawn environment (injected by `buildAgentProviderEnv`),
// keeping it out of any on-disk file — and out of any committed repo state.
//
// Provider *selection* runs through the shared `resolveAgentProvider`
// (task/card override → workspace committed provider → machine-home store →
// agent default / official login); this module turns the result into a CODEX_HOME
// projection. Official login (and any agent with no custom provider) projects
// nothing, preserving Codex's native login.

import { join } from "node:path";

import { type CommittedProviderLayer, resolveAgentProvider } from "../agent-sdk/kanban/agent-provider-resolver";
import {
	AGENT_PROTOCOL_COMPATIBILITY,
	getAgentProtocols,
	IncompatibleAgentProviderError,
	type ProtocolConfig,
	type ProviderProtocol,
	resolveProtocolEnvVars,
} from "../agent-sdk/kanban/provider-protocol";
import { lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { getMachineKanbanHomePath } from "../state/workspace-state";

const log = createLogger("codex-home-projector");

// ------------------------------------------------------------------ types

/** The wire API Codex uses to talk to a model provider. */
export type CodexWireApi = "responses" | "chat";

/** How Codex authenticates: an API key (env_key) or a ChatGPT login (auth.json). */
export type CodexAuthMethod = "apikey" | "chatgpt";

/** Codex reasoning-summary verbosity (or `none` to disable entirely). */
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

/** A single `[model_providers.<id>]` projection. */
export interface CodexModelProviderProjection {
	/** Provider id — used as `model_provider` and the table key. */
	id: string;
	/** Human-facing provider name. */
	name: string;
	/** Provider endpoint base URL. */
	baseUrl: string;
	/** Wire API; third-party OpenAI-compatible providers default to `responses`. */
	wireApi: CodexWireApi;
	/** Env var the API key is read from (Codex `env_key` indirection — no secret on disk). */
	envKey: string;
}

/** A full `config.toml` projection for a Codex session. */
export interface CodexConfigProjection {
	provider: CodexModelProviderProjection;
	/** `model`. */
	model?: string;
	/** `model_reasoning_effort`. */
	reasoningEffort?: string;
	/** `model_context_window`. */
	contextWindow?: number;
	/** `model_auto_compact_token_limit`. */
	autoCompactTokenLimit?: number;
	/** `model_reasoning_summary`. */
	reasoningSummary?: CodexReasoningSummary;
	/** `model_supports_reasoning_summaries`. */
	supportsReasoningSummaries?: boolean;
	/** `preferred_auth_method`. */
	preferredAuthMethod?: CodexAuthMethod;
}

export interface ProjectCodexHomeInput {
	/** The launching agent (expected to be `codex`). */
	agentId: string;
	/** The task this session belongs to — the isolated CODEX_HOME is keyed by it. */
	taskId: string;
	/** Task/card-level provider override. */
	providerId?: string;
	/** The workspace's selected committed provider for this agent (secret-free). */
	committedProvider?: CommittedProviderLayer | null;
	/**
	 * Base directory the per-task CODEX_HOME is created under. Defaults to
	 * `<machine-home>/codex-home`; injected in tests to a throwaway dir.
	 */
	baseDir?: string;
}

export interface CodexHomeProjectionResult {
	/** The isolated CODEX_HOME directory the config.toml was written to. */
	codexHome: string;
	/** Env vars to merge into the spawn (CODEX_HOME). The API key env is injected separately. */
	env: Record<string, string | undefined>;
}

// ------------------------------------------------------------------ rendering

/** A TOML bare key matches this; anything else must be quoted. */
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

/** Render a TOML basic string with the minimal required escapes. */
function tomlString(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t")
		.replaceAll("\r", "\\r");
	return `"${escaped}"`;
}

/** Render a TOML table-header key segment, quoting it when it isn't a bare key. */
function tomlKeySegment(key: string): string {
	return BARE_TOML_KEY.test(key) ? key : tomlString(key);
}

/**
 * Render a Codex `config.toml` from a projection. Pure: optional fields are
 * emitted only when present, numbers as bare integers, booleans as `true`/`false`.
 */
export function renderCodexConfigToml(projection: CodexConfigProjection): string {
	const { provider } = projection;
	const lines: string[] = [];

	lines.push(`model_provider = ${tomlString(provider.id)}`);
	if (projection.model !== undefined) {
		lines.push(`model = ${tomlString(projection.model)}`);
	}
	if (projection.reasoningEffort !== undefined) {
		lines.push(`model_reasoning_effort = ${tomlString(projection.reasoningEffort)}`);
	}
	if (projection.contextWindow !== undefined) {
		lines.push(`model_context_window = ${Math.trunc(projection.contextWindow)}`);
	}
	if (projection.autoCompactTokenLimit !== undefined) {
		lines.push(`model_auto_compact_token_limit = ${Math.trunc(projection.autoCompactTokenLimit)}`);
	}
	if (projection.reasoningSummary !== undefined) {
		lines.push(`model_reasoning_summary = ${tomlString(projection.reasoningSummary)}`);
	}
	if (projection.supportsReasoningSummaries !== undefined) {
		lines.push(`model_supports_reasoning_summaries = ${projection.supportsReasoningSummaries}`);
	}
	if (projection.preferredAuthMethod !== undefined) {
		lines.push(`preferred_auth_method = ${tomlString(projection.preferredAuthMethod)}`);
	}

	lines.push("");
	lines.push(`[model_providers.${tomlKeySegment(provider.id)}]`);
	lines.push(`name = ${tomlString(provider.name)}`);
	lines.push(`base_url = ${tomlString(provider.baseUrl)}`);
	lines.push(`wire_api = ${tomlString(provider.wireApi)}`);
	lines.push(`env_key = ${tomlString(provider.envKey)}`);

	return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ projection

/** A TOML-table-safe id derived from a provider name. */
function toProviderId(name: string): string {
	const cleaned = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "custom";
}

/**
 * Project an isolated CODEX_HOME for a Codex session's selected provider.
 *
 * Returns `null` when no provider override applies — official login, or no custom
 * provider configured — so Codex's native `~/.codex` is preserved. Throws
 * {@link IncompatibleAgentProviderError} when the resolved provider's protocol is
 * one Codex cannot speak.
 */
export async function projectCodexHome(input: ProjectCodexHomeInput): Promise<CodexHomeProjectionResult | null> {
	const { agentId, taskId, providerId, committedProvider } = input;

	const resolved = resolveAgentProvider(
		{ agentId, providerIdOverride: providerId, committedProvider },
		{ defaultProviderFallback: true },
	);

	if (resolved.kind === "official-login") {
		return null;
	}

	const config = resolved.config;
	if (!config) {
		// No machine-home config → no custom provider → preserve native login.
		return null;
	}

	// Resolve the endpoint + protocol compatibility. When the config predates
	// protocols, fall back to codex's primary protocol carrying the legacy baseUrl.
	const agentProtocols = AGENT_PROTOCOL_COMPATIBILITY[agentId] ?? [];
	const fallbackProtocol: ProviderProtocol = agentProtocols[0] ?? "openai";
	const protocols: ProtocolConfig[] = config.protocols ?? [{ protocol: fallbackProtocol, baseUrl: config.baseUrl }];

	const protocolEnv = resolveProtocolEnvVars(protocols, agentId);
	if (!protocolEnv) {
		throw new IncompatibleAgentProviderError(
			agentId,
			protocols.map((p) => p.protocol),
			getAgentProtocols(agentId),
		);
	}

	const baseUrl = protocolEnv.resolvedBaseUrl || config.baseUrl;
	if (!baseUrl) {
		// Without an endpoint there is nothing to redirect; leave Codex on its
		// native/default provider (the API key env still flows via env-injector).
		return null;
	}

	const rawName = config.provider ?? resolved.providerId ?? "custom";
	const projection: CodexConfigProjection = {
		provider: {
			id: toProviderId(rawName),
			name: rawName,
			baseUrl,
			// Third-party OpenAI-compatible providers use the Responses API.
			wireApi: "responses",
			envKey: protocolEnv.apiKeyEnvVar,
		},
		model: resolved.modelId ?? config.model ?? undefined,
		reasoningEffort: resolved.reasoningEffort ?? config.reasoning?.effort ?? undefined,
		// API-key auth — the key is injected via env_key, not an auth.json login.
		preferredAuthMethod: "apikey",
		// Third-party providers generally don't implement reasoning summaries over
		// the Responses API; disable them explicitly so Codex doesn't request them.
		reasoningSummary: "none",
		supportsReasoningSummaries: false,
	};

	const codexHome = join(input.baseDir ?? join(getMachineKanbanHomePath(), "codex-home"), taskId);
	const configPath = join(codexHome, "config.toml");
	await lockedFileSystem.writeTextFileAtomic(configPath, renderCodexConfigToml(projection));

	log.debug("Projected isolated CODEX_HOME for custom provider", {
		taskId,
		agentId,
		providerId: projection.provider.id,
		codexHome,
	});

	return { codexHome, env: { CODEX_HOME: codexHome } };
}
