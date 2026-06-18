// Provider protocol system — defines which API protocols each provider supports
// and how agents map to protocol-specific environment variables.

export type ProviderProtocol = "anthropic" | "openai";
export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ["anthropic", "openai"];

/**
 * Which header the Anthropic-protocol API key is sent under.
 *   - `"auth_token"` → `ANTHROPIC_AUTH_TOKEN` (Bearer; what most relays/gateways expect)
 *   - `"api_key"`    → `ANTHROPIC_API_KEY` (x-api-key; the official api.anthropic.com)
 *
 * Defaults to `"auth_token"` when unset.
 */
export type ApiKeyField = "auth_token" | "api_key";
export const DEFAULT_API_KEY_FIELD: ApiKeyField = "auth_token";

/**
 * Per-protocol configuration carrying the endpoint URL.
 * A provider may support multiple protocols, each with its own base URL.
 */
export interface ProtocolConfig {
	protocol: ProviderProtocol;
	baseUrl?: string;
}

// ------------------------------------------------------------------ official login

/**
 * Reserved provider id representing "official login": a CLI agent uses its own
 * native login state (e.g. claude's `~/.claude` Anthropic OAuth, codex's ChatGPT
 * login) and Kanban injects NO provider env and writes NO provider keys. It is
 * not a stored provider record — it is the explicit *absence* of an override,
 * and it is the default for CLI agents that have no custom provider configured.
 *
 * Selecting it must never fall through to a custom default; see
 * `buildAgentProviderEnv`. The id is reserved: a custom provider may not be
 * named so as to shadow it.
 */
export const OFFICIAL_LOGIN_PROVIDER_ID = "official";

/** Human-facing label for the official-login option in the provider pickers. */
export const OFFICIAL_LOGIN_LABEL = "Official login";

/** Whether a provider id (any casing/whitespace) refers to the official-login sentinel. */
export function isOfficialLoginProviderId(id: string | null | undefined): boolean {
	return (id ?? "").trim().toLowerCase() === OFFICIAL_LOGIN_PROVIDER_ID;
}

/**
 * Whether an agent supports the official-login option. CLI agents do; the main
 * in-process agent (`pi`) has no native login concept and must never be offered
 * it.
 */
export function agentSupportsOfficialLogin(agentId: string): boolean {
	return agentId.trim().toLowerCase() !== "pi";
}

// Agent → supported protocols
export const AGENT_PROTOCOL_COMPATIBILITY: Record<string, ProviderProtocol[]> = {
	claude: ["anthropic"],
	codex: ["openai"],
	// Droid speaks both via its native BYOK `customModels` form (anthropic →
	// Messages API; openai → Responses / generic Chat Completions). See
	// `droid-byok.ts` — droid does NOT use env-var injection.
	droid: ["anthropic", "openai"],
	pi: ["openai"],
	gemini: [], // independent protocol
	opencode: ["openai", "anthropic"],
	kiro: ["anthropic"],
};

/**
 * Agents that project provider config into their own native settings file
 * (e.g. Factory Droid's `customModels` array) rather than through the generic
 * `*_BASE_URL` / `*_API_KEY` environment variables. For these, the env-injector
 * is a no-op and the agent's session adapter owns provider projection.
 */
export const NATIVE_PROVIDER_PROJECTION_AGENTS: ReadonlySet<string> = new Set(["droid"]);

/** Whether an agent projects provider config natively (settings file) instead of via env vars. */
export function agentUsesNativeProviderProjection(agentId: string): boolean {
	return NATIVE_PROVIDER_PROJECTION_AGENTS.has(agentId.trim().toLowerCase());
}

/**
 * Thrown when the resolved provider's wire protocol is one the agent cannot
 * speak (e.g. a Codex session pointed at an Anthropic-only provider, or a
 * provider configured with no protocols at all). Surfaced to the user instead of
 * silently launching with no override, which would quietly use the agent's
 * native login against the wrong intent.
 *
 * Lives here (the protocol-compatibility domain) rather than in the env-injector
 * so both the env path (`env-injector.ts`) and native-projection adapters
 * (`droid-byok.ts`) can throw it without a cross-layer import.
 */
export class IncompatibleAgentProviderError extends Error {
	constructor(
		readonly agentId: string,
		readonly providerProtocols: ProviderProtocol[],
		readonly agentProtocols: ProviderProtocol[],
	) {
		const provider = providerProtocols.join("/") || "(unknown)";
		const agent = agentProtocols.join("/") || "(unrestricted)";
		super(
			`Provider speaks the "${provider}" protocol, which agent "${agentId}" cannot use (supports "${agent}"). ` +
				`Pick a compatible provider or use official login.`,
		);
		this.name = "IncompatibleAgentProviderError";
	}
}

// ------------------------------------------------------------------ agent provider capability

/**
 * How an agent accepts a configured provider:
 *   - `"generic"` — bring-your-own-key over a wire protocol (custom endpoint +
 *     API key injected as `*_BASE_URL` / `*_API_KEY`). claude/codex/droid/
 *     opencode/pi.
 *   - `"vendor"`  — the agent only speaks its vendor's native API; there is no
 *     custom endpoint. We inject vendor-native env (or none) and constrain the
 *     model to the vendor's catalog. gemini (Google) and kiro.
 *
 * This is the single source of truth for "does this agent support a generic
 * provider", replacing the older overloaded reading of an empty
 * {@link AGENT_PROTOCOL_COMPATIBILITY} entry as "unrestricted → default openai"
 * (which silently mis-injected `OPENAI_*` for gemini).
 */
export type AgentProviderMode = "generic" | "vendor";

/** Vendor identity for a {@link AgentProviderMode} `"vendor"` agent. */
export type AgentVendorId = "google" | "kiro";

export interface AgentProviderCapability {
	mode: AgentProviderMode;
	/** Wire protocols for generic BYOK; always `[]` for vendor agents. */
	protocols: ProviderProtocol[];
	/** Whether the agent has a native login to fall back to (no injected provider). */
	officialLogin: boolean;
	/** Whether a user-supplied custom endpoint (baseUrl) is accepted. Generic only. */
	customEndpoint: boolean;
	/** Vendor identity when {@link mode} is `"vendor"`. */
	vendor?: AgentVendorId;
}

/**
 * Per-agent provider capability. Kept hand-written (not derived) so the protocol
 * primitives above stay untouched while this layer draws the generic-vs-vendor
 * boundary. `protocols` MUST equal {@link AGENT_PROTOCOL_COMPATIBILITY} for
 * generic agents and `[]` for vendor agents (asserted in tests).
 */
export const AGENT_PROVIDER_CAPABILITY: Record<string, AgentProviderCapability> = {
	claude: { mode: "generic", protocols: ["anthropic"], officialLogin: true, customEndpoint: true },
	codex: { mode: "generic", protocols: ["openai"], officialLogin: true, customEndpoint: true },
	droid: { mode: "generic", protocols: ["anthropic", "openai"], officialLogin: true, customEndpoint: true },
	opencode: { mode: "generic", protocols: ["openai", "anthropic"], officialLogin: true, customEndpoint: true },
	pi: { mode: "generic", protocols: ["openai"], officialLogin: false, customEndpoint: true },
	gemini: { mode: "vendor", protocols: [], officialLogin: true, customEndpoint: false, vendor: "google" },
	kiro: { mode: "vendor", protocols: [], officialLogin: true, customEndpoint: false, vendor: "kiro" },
};

/**
 * Capability for an unknown agent id. Treated as a generic CLI agent with no
 * protocol restriction and a native login, preserving the pre-capability
 * behavior for any future/unregistered agent.
 */
function defaultGenericCapability(agentId: string): AgentProviderCapability {
	return {
		mode: "generic",
		protocols: getAgentProtocols(agentId),
		officialLogin: true,
		customEndpoint: true,
	};
}

/** The provider capability for an agent (normalized id), synthesizing a generic default for unknown agents. */
export function getAgentProviderCapability(agentId: string): AgentProviderCapability {
	return AGENT_PROVIDER_CAPABILITY[agentId.trim().toLowerCase()] ?? defaultGenericCapability(agentId);
}

/** Whether an agent accepts a generic BYOK provider (custom endpoint over a wire protocol). */
export function agentSupportsGenericProvider(agentId: string): boolean {
	return getAgentProviderCapability(agentId).mode === "generic";
}

/** Whether an agent accepts a user-supplied custom endpoint (baseUrl). */
export function agentSupportsCustomEndpoint(agentId: string): boolean {
	return getAgentProviderCapability(agentId).customEndpoint;
}

/** The vendor identity for a vendor agent, or `undefined` for generic agents. */
export function getAgentVendorId(agentId: string): AgentVendorId | undefined {
	return getAgentProviderCapability(agentId).vendor;
}

/**
 * Validate a provider config's endpoint fields against an agent's capability.
 * Returns a human-facing error message when a vendor agent (no custom endpoint)
 * is being given a custom `baseUrl`/protocol endpoint, else `null`. Used by both
 * the API mutation layer and the add/edit dialog so an unsupported provider is
 * rejected at edit time rather than silently doing nothing at launch.
 */
export function getProviderCapabilityError(
	agentId: string,
	input: { baseUrl?: string | null; protocols?: ProtocolConfig[] | null },
): string | null {
	if (agentSupportsCustomEndpoint(agentId)) {
		return null;
	}
	const hasBaseUrl = Boolean(input.baseUrl?.trim());
	const hasProtocolEndpoint = (input.protocols ?? []).some((p) => Boolean(p.baseUrl?.trim()));
	if (!hasBaseUrl && !hasProtocolEndpoint) {
		return null;
	}
	return (
		`Agent "${agentId}" does not support a custom provider endpoint. ` +
		`It uses its official login; configure only the fields it natively supports.`
	);
}

// Protocol → env var names
export const PROTOCOL_ENV_MAP: Record<ProviderProtocol, { baseUrl: string; apiKey: string }> = {
	anthropic: { baseUrl: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_API_KEY" },
	openai: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
};

// Bundled provider default protocols (used for migration)
export const BUNDLED_PROVIDER_DEFAULT_PROTOCOLS: Record<string, ProviderProtocol[]> = {
	anthropic: ["anthropic"],
	openai: ["openai"],
	google: [],
	"amazon-bedrock": ["anthropic"],
	"azure-openai": ["openai"],
	ollama: ["openai"],
	openrouter: ["openai", "anthropic"],
	xai: ["openai"],
	mistral: ["openai"],
	vertex: [],
	litellm: ["openai"],
	cline: ["openai"],
};

// ------------------------------------------------------------------ helpers

/**
 * Type guard for `ProtocolConfig`.
 */
export function isProtocolConfig(value: unknown): value is ProtocolConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		"protocol" in value &&
		typeof (value as ProtocolConfig).protocol === "string"
	);
}

/**
 * Extract the bare protocol name list from a `ProtocolConfig[]`.
 */
export function extractProtocolList(configs: ProtocolConfig[]): ProviderProtocol[] {
	return configs.map((c) => c.protocol);
}

/**
 * Look up the `baseUrl` for a specific protocol in a `ProtocolConfig[]`.
 */
export function getBaseUrlForProtocol(configs: ProtocolConfig[], protocol: ProviderProtocol): string | undefined {
	const match = configs.find((c) => c.protocol === protocol);
	return match?.baseUrl?.trim() || undefined;
}

/**
 * Normalize a raw `protocols` value (from disk or API) into `ProtocolConfig[]`.
 * Handles three shapes:
 *   - already `ProtocolConfig[]` → returned as-is
 *   - legacy `string[]` (e.g. `["openai"]`) → each gets `baseUrl: legacyBaseUrl`
 *   - `undefined` / invalid → `getDefaultProtocolsForProvider(id)` with `legacyBaseUrl`
 */
export function normalizeProtocols(raw: unknown, legacyBaseUrl?: string): ProtocolConfig[] {
	// Already ProtocolConfig[]
	if (Array.isArray(raw) && raw.length > 0 && isProtocolConfig(raw[0])) {
		return raw as ProtocolConfig[];
	}

	// Legacy string[]
	if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
		return (raw as ProviderProtocol[]).map((p) => ({
			protocol: p,
			baseUrl: legacyBaseUrl?.trim() || undefined,
		}));
	}

	// Missing / empty — fall back to bundled defaults
	const defaults = getDefaultProtocolsForProvider("__unknown__");
	return defaults.map((config) => ({
		...config,
		baseUrl: legacyBaseUrl?.trim() || undefined,
	}));
}

/**
 * Normalize protocols using a known provider id for default lookup.
 */
export function normalizeProtocolsForProvider(
	raw: unknown,
	providerId: string,
	legacyBaseUrl?: string,
): ProtocolConfig[] {
	// Already ProtocolConfig[]
	if (Array.isArray(raw) && raw.length > 0 && isProtocolConfig(raw[0])) {
		return raw as ProtocolConfig[];
	}

	// Legacy string[]
	if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
		return (raw as ProviderProtocol[]).map((p) => ({
			protocol: p,
			baseUrl: legacyBaseUrl?.trim() || undefined,
		}));
	}

	// Missing / empty — use bundled defaults for this provider
	const defaults = getDefaultProtocolsForProvider(providerId);
	return defaults.map((config) => ({
		...config,
		baseUrl: legacyBaseUrl?.trim() || undefined,
	}));
}

/**
 * Compatible protocols for an agent. An empty list means "no restriction"
 * (e.g. gemini speaks its own protocol). Unknown agents are unrestricted.
 */
export function getAgentProtocols(agentId: string): ProviderProtocol[] {
	return AGENT_PROTOCOL_COMPATIBILITY[agentId.trim().toLowerCase()] ?? [];
}

/**
 * Collapse a per-agent provider's protocol config(s) to the SINGLE protocol the
 * agent will actually use at runtime.
 *
 * Providers are stored per-agent and {@link resolveProtocolEnvVars} only ever
 * injects one protocol (the first the agent is compatible with), so a per-agent
 * provider speaks exactly one protocol — storing more is dead config. This picks
 * that one protocol deterministically and folds the legacy scalar `baseUrl` into
 * it when no per-protocol URL is present, so `protocols[]` stays the single
 * source of truth for the endpoint and `baseUrl` is only ever a read-time
 * migration input.
 *
 * Selection mirrors the resolver:
 *   - restricted agent: the first compatible protocol present, else the agent's
 *     primary protocol;
 *   - unrestricted agent: the first protocol present, else `"openai"`.
 */
export function collapseToAgentProtocol(
	agentId: string,
	protocols: ProtocolConfig[] | undefined,
	legacyBaseUrl?: string,
): ProtocolConfig {
	const agentProtocols = getAgentProtocols(agentId);
	const present = protocols ?? [];
	const presentNames = extractProtocolList(present);

	const chosen: ProviderProtocol =
		agentProtocols.length > 0
			? (agentProtocols.find((p) => presentNames.includes(p)) ?? agentProtocols[0] ?? "openai")
			: (presentNames[0] ?? "openai");

	// Prefer the chosen protocol's own URL; otherwise carry any configured URL
	// (e.g. when coercing a mis-declared legacy protocol) and finally the legacy
	// scalar baseUrl, so the user's endpoint is never silently dropped.
	const baseUrl =
		getBaseUrlForProtocol(present, chosen) ??
		present.find((c) => c.baseUrl?.trim())?.baseUrl?.trim() ??
		legacyBaseUrl?.trim() ??
		undefined;
	return baseUrl ? { protocol: chosen, baseUrl } : { protocol: chosen };
}

// ------------------------------------------------------------------ resolvers

/**
 * Resolve protocol-specific env var names AND the matching base URL value
 * based on provider protocol configs and agent compatibility.
 *
 * Returns `null` if no compatible protocol is found.
 */
export function resolveProtocolEnvVars(
	providerProtocols: ProtocolConfig[],
	agentId: string,
): {
	baseUrlEnvVar: string;
	apiKeyEnvVar: string;
	resolvedBaseUrl: string | undefined;
	matchedProtocol: ProviderProtocol;
} | null {
	const agentProtocols = AGENT_PROTOCOL_COMPATIBILITY[agentId] ?? [];
	const protocolNames = extractProtocolList(providerProtocols);

	// If agent has no protocol restrictions, use the first provider protocol
	if (agentProtocols.length === 0) {
		const proto = protocolNames[0] ?? "openai";
		const envMap = PROTOCOL_ENV_MAP[proto];
		const baseUrl = getBaseUrlForProtocol(providerProtocols, proto);
		return {
			baseUrlEnvVar: envMap.baseUrl,
			apiKeyEnvVar: envMap.apiKey,
			resolvedBaseUrl: baseUrl,
			matchedProtocol: proto,
		};
	}

	// Find the first matching protocol
	const matchedProtocol = agentProtocols.find((p) => protocolNames.includes(p)) ?? null;

	if (!matchedProtocol) {
		return null;
	}

	const envMap = PROTOCOL_ENV_MAP[matchedProtocol];
	const baseUrl = getBaseUrlForProtocol(providerProtocols, matchedProtocol);

	return {
		baseUrlEnvVar: envMap.baseUrl,
		apiKeyEnvVar: envMap.apiKey,
		resolvedBaseUrl: baseUrl,
		matchedProtocol,
	};
}

/**
 * Resolve the env var name the Anthropic-protocol API key should be injected
 * under, based on the provider's `apiKeyField`. Defaults to `ANTHROPIC_AUTH_TOKEN`.
 */
export function resolveAnthropicApiKeyEnvVar(
	apiKeyField: ApiKeyField | undefined,
): "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" {
	const field = apiKeyField ?? DEFAULT_API_KEY_FIELD;
	return field === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
}

/**
 * Check if an agent is compatible with a provider's protocol configs.
 */
export function isAgentCompatibleWithProvider(agentId: string, providerProtocolConfigs: ProtocolConfig[]): boolean {
	const agentProtocols = AGENT_PROTOCOL_COMPATIBILITY[agentId] ?? [];
	if (agentProtocols.length === 0) {
		return true; // no restrictions (e.g., gemini)
	}
	const protocolNames = extractProtocolList(providerProtocolConfigs);
	return agentProtocols.some((p) => protocolNames.includes(p));
}

/**
 * Get default protocol configs for a provider ID during migration.
 */
export function getDefaultProtocolsForProvider(providerId: string): ProtocolConfig[] {
	const bundled = BUNDLED_PROVIDER_DEFAULT_PROTOCOLS[providerId.toLowerCase()];
	if (bundled) {
		return bundled.map((p) => ({ protocol: p }));
	}
	// Default to openai for unknown providers
	return [{ protocol: "openai" }];
}
