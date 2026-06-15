// Shared provider types, extracted from provider-settings-store.ts.
// These are referenced by multiple modules and define the shape of
// per-agent provider configuration.

import type { ProtocolConfig } from "./provider-protocol";

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
