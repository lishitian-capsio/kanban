// Kanban-facing provider service.
import type {
	RuntimeKanbanAccountBalanceResponse,
	RuntimeKanbanAccountOrganizationsResponse,
	RuntimeKanbanAccountProfileResponse,
	RuntimeKanbanAccountSwitchResponse,
	RuntimeKanbanDeviceAuthCompleteResponse,
	RuntimeKanbanDeviceAuthStartResponse,
	RuntimeKanbanKanbanAccessResponse,
	RuntimeKanbanOauthLoginResponse,
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderCatalogResponse,
	RuntimeKanbanProviderModel,
	RuntimeKanbanProviderModelsResponse,
	RuntimeKanbanProviderSettings,
	RuntimeKanbanProviderSettingsSaveResponse,
	RuntimeReasoningEffort,
} from "../../core/api-contract";
import { getBundledModels, getBundledProviders, type GeneratedProvider } from "../ai/models";
import {
	type ProviderSettings,
	type ProviderSettingsReasoning,
	deleteProviderSettings,
	getAllProviders,
	getLastUsedProviderId,
	getLastUsedProviderSettings,
	getProviderSettings,
	saveProviderSettings,
} from "./provider-settings-store";

function resolveVisibleApiKey(settings: ProviderSettings | null): string | null {
	const apiKey = settings?.apiKey?.trim() || settings?.auth?.apiKey?.trim() || "";
	return apiKey.length > 0 ? apiKey : null;
}

function hasOauthAccessToken(settings: ProviderSettings | null): boolean {
	return (settings?.auth?.accessToken?.trim() ?? "").length > 0;
}

function hasOauthRefreshToken(settings: ProviderSettings | null): boolean {
	return (settings?.auth?.refreshToken?.trim() ?? "").length > 0;
}

function toRuntimeReasoningEffort(effort: string | null | undefined): RuntimeReasoningEffort | null {
	if (!effort || effort === "none") {
		return null;
	}
	return effort as RuntimeReasoningEffort;
}

function toResponseExpirySeconds(expiresAt: number | null | undefined): number | null {
	if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
		return null;
	}
	const ms = expiresAt >= 1_000_000_000_000 ? Math.floor(expiresAt) : Math.floor(expiresAt * 1000);
	return Math.max(1, Math.floor(ms / 1000));
}

function createEmptyProviderSettingsSummary(): RuntimeKanbanProviderSettings {
	return {
		providerId: null,
		modelId: null,
		baseUrl: null,
		reasoningEffort: null,
		apiKeyConfigured: false,
		oauthProvider: null,
		oauthAccessTokenConfigured: false,
		oauthRefreshTokenConfigured: false,
		oauthAccountId: null,
		oauthExpiresAt: null,
	};
}

function toProviderSettingsSummary(settings: ProviderSettings | null): RuntimeKanbanProviderSettings {
	if (!settings) {
		return createEmptyProviderSettingsSummary();
	}
	const providerId = settings.provider?.trim() || null;
	return {
		providerId,
		modelId: settings.model?.trim() || null,
		baseUrl: settings.baseUrl?.trim() || null,
		reasoningEffort: toRuntimeReasoningEffort(settings.reasoning?.effort),
		apiKeyConfigured: Boolean(resolveVisibleApiKey(settings)),
		oauthProvider: null,
		oauthAccessTokenConfigured: hasOauthAccessToken(settings),
		oauthRefreshTokenConfigured: hasOauthRefreshToken(settings),
		oauthAccountId: settings.auth?.accountId?.trim() || null,
		oauthExpiresAt: toResponseExpirySeconds(settings.auth?.expiresAt),
	};
}

function getSelectedProviderSettings(): ProviderSettings | null {
	const lastUsedSettings = getLastUsedProviderSettings();
	const resolvedProviderId = lastUsedSettings?.provider?.trim().toLowerCase();
	if (!resolvedProviderId) {
		return null;
	}
	return getProviderSettings(resolvedProviderId) ?? lastUsedSettings;
}

function toRuntimeProviderModel(model: { id: string; name: string; supportsReasoningEffort?: boolean }): RuntimeKanbanProviderModel {
	return {
		id: model.id,
		name: model.name?.trim() || model.id,
	};
}

export interface AddCustomProviderInput {
	providerId: string;
	name: string;
	baseUrl: string;
	apiKey?: string | null;
	headers?: Record<string, string>;
	timeoutMs?: number;
	models: string[];
	defaultModelId?: string | null;
	modelsSourceUrl?: string | null;
	capabilities?: string[];
}

export interface UpdateCustomProviderInput {
	providerId: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string | null;
	headers?: Record<string, string> | null;
	timeoutMs?: number | null;
	models?: string[];
	defaultModelId?: string | null;
	modelsSourceUrl?: string | null;
	capabilities?: string[];
}

export function createProviderService() {
	const getProviderSettingsSummary = (): RuntimeKanbanProviderSettings =>
		toProviderSettingsSummary(getSelectedProviderSettings());

	return {
		getProviderSettingsSummary(): RuntimeKanbanProviderSettings {
			return getProviderSettingsSummary();
		},

		async getKanbanAccountProfile(): Promise<RuntimeKanbanAccountProfileResponse> {
			return { profile: null };
		},

		async getKanbanKanbanAccess(): Promise<RuntimeKanbanKanbanAccessResponse> {
			return { enabled: true };
		},

		async getFeaturebaseToken(): Promise<{ featurebaseJwt: string }> {
			throw new Error("Featurebase token is not supported in the omp runtime.");
		},

		async getKanbanAccountBalance(): Promise<RuntimeKanbanAccountBalanceResponse> {
			return { balance: null, activeAccountLabel: null, activeOrganizationId: null };
		},

		async getKanbanAccountOrganizations(): Promise<RuntimeKanbanAccountOrganizationsResponse> {
			return { organizations: [] };
		},

		async switchKanbanAccount(_organizationId: string | null): Promise<RuntimeKanbanAccountSwitchResponse> {
			return { ok: false, error: "Account switching is not supported in the omp runtime." };
		},

		async resolveLaunchConfig(overrides?: {
			providerIdOverride?: string;
			modelIdOverride?: string;
			reasoningEffortOverride?: RuntimeReasoningEffort | null;
		}): Promise<{
			providerId: string;
			modelId: string | null;
			apiKey: string | null;
			baseUrl: string | null;
			reasoningEffort?: RuntimeReasoningEffort | null;
		}> {
			const selectedSettings = overrides?.providerIdOverride
				? (getProviderSettings(overrides.providerIdOverride) ?? getSelectedProviderSettings())
				: getSelectedProviderSettings();

			if (!selectedSettings) {
				throw new Error(
					"No provider is configured. Open Settings, choose a provider, and then start the task again.",
				);
			}

			const providerId = selectedSettings.provider.trim().toLowerCase();
			if (!providerId) {
				throw new Error(
					"No provider is configured. Open Settings, choose a provider, and then start the task again.",
				);
			}

			const apiKey = resolveVisibleApiKey(selectedSettings);
			const modelId =
				overrides?.modelIdOverride?.trim() ||
				selectedSettings.model?.trim() ||
				null;

			return {
				providerId,
				modelId,
				apiKey,
				baseUrl: selectedSettings.baseUrl?.trim() || null,
				reasoningEffort:
					overrides && "reasoningEffortOverride" in overrides
						? (overrides.reasoningEffortOverride ?? null)
						: (toRuntimeReasoningEffort(selectedSettings.reasoning?.effort) ?? undefined),
			};
		},

		async getProviderCatalog(): Promise<RuntimeKanbanProviderCatalogResponse> {
			const selectedProviderId = getProviderSettingsSummary().providerId?.trim().toLowerCase() ?? "";
		
			const providers: RuntimeKanbanProviderCatalogItem[] = [];
			const seenIds = new Set<string>();
		
			// Add bundled providers from the omp model registry
			try {
				const bundledProviderIds = getBundledProviders();
		
				for (const id of bundledProviderIds) {
					const savedSettings = getProviderSettings(id);
					providers.push({
						id,
						name: formatProviderName(id),
						oauthSupported: false,
						enabled: selectedProviderId.length > 0 ? selectedProviderId === id : false,
						defaultModelId: savedSettings?.model?.trim() || null,
						baseUrl: savedSettings?.baseUrl?.trim() || null,
						supportsBaseUrl: (savedSettings?.baseUrl?.trim().length ?? 0) > 0,
					});
					seenIds.add(id);
				}
			} catch {
				// Fall through to empty list
			}
		
			// Add custom (non-bundled) providers from the settings store
			const allStored = getAllProviders();
			for (const [id, settings] of Object.entries(allStored)) {
				if (seenIds.has(id)) continue;
				providers.push({
					id,
					name: formatProviderName(id),
					oauthSupported: false,
					enabled: selectedProviderId.length > 0 ? selectedProviderId === id : false,
					defaultModelId: settings.model?.trim() || null,
					baseUrl: settings.baseUrl?.trim() || null,
					supportsBaseUrl: (settings.baseUrl?.trim().length ?? 0) > 0,
				});
				seenIds.add(id);
			}
		
			// If the selected provider is still not in the list, add it as a fallback
			if (selectedProviderId.length > 0 && !seenIds.has(selectedProviderId)) {
				providers.unshift({
					id: selectedProviderId,
					name: selectedProviderId,
					oauthSupported: false,
					enabled: true,
					defaultModelId: getProviderSettingsSummary().modelId,
					baseUrl: getProviderSettingsSummary().baseUrl,
					supportsBaseUrl: (getProviderSettingsSummary().baseUrl?.trim().length ?? 0) > 0,
				});
			}
		
			return {
				providers: providers.sort((a, b) => a.name.localeCompare(b.name)),
			};
		},

		async getProviderModels(providerId: string): Promise<RuntimeKanbanProviderModelsResponse> {
			const normalizedProviderId = providerId.trim().toLowerCase();
			let providerModels: RuntimeKanbanProviderModel[] = [];
		
			// Try to get models from the bundled model registry
			if (normalizedProviderId.length > 0) {
				try {
					const models = getBundledModels(normalizedProviderId as GeneratedProvider);
					providerModels = models
						.map((m) => toRuntimeProviderModel({ id: m.id, name: m.name ?? m.id }))
						.sort((a, b) => a.name.localeCompare(b.name));
				} catch {
					// Provider not found in bundled registry
				}
			}
		
			if (providerModels.length > 0) {
				return {
					providerId: normalizedProviderId,
					models: providerModels,
				};
			}
		
			// Try to discover models from the provider's /models endpoint
			const savedSettings = getProviderSettings(normalizedProviderId);
			if (savedSettings?.baseUrl) {
				const discoveredModels = await fetchModelsFromEndpoint(savedSettings.baseUrl, savedSettings.apiKey);
				if (discoveredModels.length > 0) {
					return {
						providerId: normalizedProviderId || providerId,
						models: discoveredModels,
					};
				}
			}
		
			// Fallback: return configured model if present
			const configuredModel = savedSettings?.model?.trim() ?? "";
			if (configuredModel.length > 0) {
				return {
					providerId: normalizedProviderId || providerId,
					models: [{ id: configuredModel, name: configuredModel }],
				};
			}
		
			return {
				providerId: normalizedProviderId || providerId,
				models: [],
			};
		},

		async addCustomProvider(input: AddCustomProviderInput): Promise<RuntimeKanbanProviderSettings> {
			const providerId = input.providerId.trim().toLowerCase();
			const existing = getAllProviders();
			if (providerId in existing) {
				throw new Error(`Provider "${providerId}" already exists.`);
			}

			saveProviderSettings({
				settings: {
					provider: providerId,
					baseUrl: input.baseUrl,
					...(input.apiKey ? { apiKey: input.apiKey } : {}),
					...(input.headers ? { headers: input.headers } : {}),
					...(input.timeoutMs ? { timeout: input.timeoutMs } : {}),
					...(input.defaultModelId ? { model: input.defaultModelId } : {}),
				},
				tokenSource: "manual",
				setLastUsed: true,
			});

			return toProviderSettingsSummary(getProviderSettings(providerId));
		},

		async updateCustomProvider(input: UpdateCustomProviderInput): Promise<RuntimeKanbanProviderSettings> {
			const providerId = input.providerId.trim().toLowerCase();
			if (!providerId) {
				throw new Error("Provider ID cannot be empty.");
			}

			const existing = getProviderSettings(providerId);
			if (!existing) {
				throw new Error(`Provider "${providerId}" does not exist.`);
			}

			const nextSettings: ProviderSettings = {
				...existing,
				provider: providerId,
			};

			if (input.name !== undefined) {
				// name is not stored in settings, it's derived from providerId
			}
			if (input.baseUrl !== undefined) {
				const baseUrl = input.baseUrl?.trim() ?? "";
				if (baseUrl) {
					nextSettings.baseUrl = baseUrl;
				} else {
					delete nextSettings.baseUrl;
				}
			}
			if (input.apiKey !== undefined) {
				const apiKey = input.apiKey?.trim() ?? "";
				if (apiKey) {
					nextSettings.apiKey = apiKey;
				} else {
					delete nextSettings.apiKey;
				}
			}
			if (input.headers !== undefined) {
				if (input.headers) {
					nextSettings.headers = input.headers;
				} else {
					delete nextSettings.headers;
				}
			}
			if (input.timeoutMs !== undefined) {
				if (input.timeoutMs) {
					nextSettings.timeout = input.timeoutMs;
				} else {
					delete nextSettings.timeout;
				}
			}
			if (input.defaultModelId !== undefined) {
				const modelId = input.defaultModelId?.trim() ?? "";
				if (modelId) {
					nextSettings.model = modelId;
				} else {
					delete nextSettings.model;
				}
			}

			const isLastUsed = getLastUsedProviderId() === providerId;
			saveProviderSettings({
				settings: nextSettings,
				tokenSource: hasOauthAccessToken(nextSettings) ? "oauth" : "manual",
				setLastUsed: isLastUsed,
			});

			return toProviderSettingsSummary(getProviderSettings(providerId));
		},

		async deleteCustomProvider(input: { providerId: string }): Promise<RuntimeKanbanProviderSettings> {
			const providerId = input.providerId.trim().toLowerCase();
			if (!providerId) {
				throw new Error("Provider ID cannot be empty.");
			}
			deleteProviderSettings(providerId);
			return getProviderSettingsSummary();
		},

		saveProviderSettings(input: {
			providerId: string;
			modelId?: string | null;
			apiKey?: string | null;
			baseUrl?: string | null;
			reasoningEffort?: RuntimeReasoningEffort | null;
			region?: string | null;
			aws?: Record<string, unknown>;
			gcp?: { projectId?: string | null; region?: string | null };
		}): RuntimeKanbanProviderSettingsSaveResponse {
			const providerId = input.providerId.trim().toLowerCase();
			if (!providerId) {
				throw new Error("Provider ID cannot be empty.");
			}

			const existingSettings = getProviderSettings(providerId) ?? {
				provider: providerId,
			};

			const nextSettings: ProviderSettings = {
				...existingSettings,
				provider: providerId,
			};

			if (input.modelId !== undefined) {
				const modelId = input.modelId?.trim() ?? "";
				if (modelId) {
					nextSettings.model = modelId;
				} else {
					delete nextSettings.model;
				}
			}

			if (input.baseUrl !== undefined) {
				const baseUrl = input.baseUrl?.trim() ?? "";
				if (baseUrl) {
					nextSettings.baseUrl = baseUrl;
				} else {
					delete nextSettings.baseUrl;
				}
			}

			if (input.apiKey !== undefined) {
				const apiKey = input.apiKey?.trim() ?? "";
				if (apiKey) {
					nextSettings.apiKey = apiKey;
				} else {
					delete nextSettings.apiKey;
				}
			}

			if (input.reasoningEffort !== undefined) {
				const nextReasoning: ProviderSettingsReasoning = { ...(nextSettings.reasoning ?? {}) };
				if (input.reasoningEffort) {
					nextReasoning.effort = input.reasoningEffort;
				} else {
					delete nextReasoning.effort;
				}
				if (
					nextReasoning.enabled === undefined &&
					nextReasoning.effort === undefined &&
					nextReasoning.budgetTokens === undefined
				) {
					delete nextSettings.reasoning;
				} else {
					nextSettings.reasoning = nextReasoning;
				}
			}

			if (input.region !== undefined) {
				const region = input.region?.trim() ?? "";
				if (region) {
					nextSettings.region = region;
				} else {
					delete nextSettings.region;
				}
			}

			if (input.aws !== undefined) {
				if (Object.keys(input.aws).length > 0) {
					nextSettings.aws = input.aws;
				} else {
					delete nextSettings.aws;
				}
			}

			if (input.gcp !== undefined) {
				const nextGcp: { projectId?: string; region?: string } = {};
				if (input.gcp.projectId) nextGcp.projectId = input.gcp.projectId;
				if (input.gcp.region) nextGcp.region = input.gcp.region;
				if (Object.keys(nextGcp).length > 0) {
					nextSettings.gcp = nextGcp;
				} else {
					delete nextSettings.gcp;
				}
			}

			if (providerId === "vertex") {
				const projectId = nextSettings.gcp?.projectId?.trim() ?? "";
				if (!projectId) {
					throw new Error("Vertex provider requires GCP Project ID.");
				}
			}

			saveProviderSettings({
				settings: nextSettings,
				tokenSource: hasOauthAccessToken(nextSettings) ? "oauth" : "manual",
				setLastUsed: true,
			});

			return toProviderSettingsSummary(nextSettings);
		},

		async runOauthLogin(_input: {
			providerId: string;
			baseUrl?: string | null;
		}): Promise<RuntimeKanbanOauthLoginResponse> {
			return {
				ok: false,
				provider: _input.providerId as RuntimeKanbanOauthLoginResponse["provider"],
				error: "OAuth login is not supported in the omp runtime.",
			};
		},

		async startDeviceAuth(): Promise<RuntimeKanbanDeviceAuthStartResponse> {
			throw new Error("Device auth is not supported in the omp runtime.");
		},

		async completeDeviceAuth(_input: {
			deviceCode: string;
			expiresInSeconds: number;
			pollIntervalSeconds: number;
			baseUrl?: string | null;
		}): Promise<RuntimeKanbanDeviceAuthCompleteResponse> {
			return {
				ok: false,
				provider: "cline",
				error: "Device auth is not supported in the omp runtime.",
			};
		},
	};
}

function formatProviderName(id: string): string {
	const names: Record<string, string> = {
		anthropic: "Anthropic",
		openai: "OpenAI",
		google: "Google",
		ollama: "Ollama",
		openrouter: "OpenRouter",
		xai: "xAI",
		mistral: "Mistral",
		"amazon-bedrock": "Amazon Bedrock",
		"azure-openai": "Azure OpenAI",
		litellm: "LiteLLM",
		vertex: "Vertex AI",
	};
	return names[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Fetch available models from an OpenAI-compatible /models endpoint.
 * Returns an empty array if the request fails or the response format is unexpected.
 */
async function fetchModelsFromEndpoint(
	baseUrl: string,
	apiKey?: string,
): Promise<RuntimeKanbanProviderModel[]> {
	// Build the models URL: ensure baseUrl doesn't have trailing slash
	const normalizedBase = baseUrl.replace(/\/+$/, "");
	const modelsUrl = `${normalizedBase}/models`;

	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
		};
		if (apiKey?.trim()) {
			headers["Authorization"] = `Bearer ${apiKey.trim()}`;
		}

		const response = await fetch(modelsUrl, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(10_000), // 10 second timeout
		});

		if (!response.ok) {
			return [];
		}

		const json = (await response.json()) as {
			data?: Array<{ id?: string; name?: string }>;
		};

		if (!json.data || !Array.isArray(json.data)) {
			return [];
		}

		const models: RuntimeKanbanProviderModel[] = [];
		for (const item of json.data) {
			const id = item.id?.trim();
			if (id) {
				models.push({
					id,
					name: item.name?.trim() || id,
				});
			}
		}

		return models.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		// Network error, timeout, or parse error — return empty
		return [];
	}
}

