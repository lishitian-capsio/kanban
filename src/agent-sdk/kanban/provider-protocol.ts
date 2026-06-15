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

// Agent → supported protocols
export const AGENT_PROTOCOL_COMPATIBILITY: Record<string, ProviderProtocol[]> = {
	claude: ["anthropic"],
	codex: ["openai"],
	droid: ["anthropic"],
	pi: ["openai"],
	gemini: [], // independent protocol
	opencode: ["openai", "anthropic"],
	kiro: ["anthropic"],
};

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
export function getBaseUrlForProtocol(
	configs: ProtocolConfig[],
	protocol: ProviderProtocol,
): string | undefined {
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
export function normalizeProtocols(
	raw: unknown,
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
export function isAgentCompatibleWithProvider(
	agentId: string,
	providerProtocolConfigs: ProtocolConfig[],
): boolean {
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
