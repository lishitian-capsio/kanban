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

/**
 * Anthropic-protocol-specific provider settings.
 *
 * These only have meaning when a provider speaks the Anthropic protocol (claude,
 * droid, kiro, …). They are deliberately grouped into their own namespace rather
 * than sitting as flat top-level fields on the generic provider config — setting
 * them on a non-Anthropic provider is meaningless, so the type makes that scope
 * explicit instead of silently carrying dead data.
 */
export interface AnthropicProviderSettings {
	/** Which header the Anthropic-protocol key is sent under (defaults to auth_token). */
	apiKeyField?: ApiKeyField;
	/** Optional per-tier Anthropic model overrides (ANTHROPIC_DEFAULT_*_MODEL). */
	defaultModels?: AnthropicDefaultModels;
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
	/** Anthropic-protocol-specific settings (key header + model overrides). */
	anthropic?: AnthropicProviderSettings;
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
