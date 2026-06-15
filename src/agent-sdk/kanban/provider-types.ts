// Shared provider types, extracted from provider-settings-store.ts.
// These are referenced by multiple modules and define the shape of
// per-agent provider configuration.

import type { ApiKeyField, ProtocolConfig } from "./provider-protocol";

/** Optional per-tier Anthropic model overrides (mapped to ANTHROPIC_DEFAULT_*_MODEL). */
export interface AnthropicDefaultModels {
	haiku?: string;
	sonnet?: string;
	opus?: string;
}

// ------------------------------------------------------------------ types

export interface ProviderSettingsReasoning {
	enabled?: boolean;
	effort?: string;
	budgetTokens?: number;
}

export interface ProviderSettingsAuth {
	accessToken?: string;
	refreshToken?: string;
	accountId?: string;
	expiresAt?: number;
	apiKey?: string;
}

export interface ProviderSettings {
	provider: string;
	model?: string;
	apiKey?: string;
	/** @deprecated Legacy single baseUrl. Use `protocols[].baseUrl` instead. Kept for migration compatibility. */
	baseUrl?: string;
	protocols?: ProtocolConfig[];
	/** Which header the Anthropic-protocol key is sent under (defaults to auth_token). */
	apiKeyField?: ApiKeyField;
	/** Optional per-tier Anthropic model overrides (ANTHROPIC_DEFAULT_*_MODEL). */
	anthropicDefaultModels?: AnthropicDefaultModels;
	reasoning?: ProviderSettingsReasoning;
	auth?: ProviderSettingsAuth;
	aws?: Record<string, unknown>;
	gcp?: { projectId?: string; region?: string };
	headers?: Record<string, string>;
	timeout?: number;
	region?: string;
	oca?: { mode: string };
	[key: string]: unknown;
}

export type ProviderTokenSource = "oauth" | "manual";

export interface SaveProviderSettingsInput {
	settings: ProviderSettings;
	tokenSource?: ProviderTokenSource;
	setLastUsed?: boolean;
}
