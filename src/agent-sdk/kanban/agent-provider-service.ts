// Agent-scoped provider service — replaces the old global provider-service.ts.
//
// Each agent manages its own provider configuration independently.
// The catalog shows all bundled providers (configured ones marked as enabled).
// Model lists still query the bundled registry (stateless).

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
	RuntimeReasoningEffort,
} from "../../core/api-contract";
import { getBundledModels, type GeneratedProvider } from "../ai/models";
import {
	type AgentProviderConfig,
	deleteAgentProvider,
	getAgentProviderConfig,
	getAllAgentProviderConfigs,
	saveAgentProvider,
} from "./agent-provider-config";
import {
	BUNDLED_PROVIDER_DEFAULT_PROTOCOLS,
	type ProtocolConfig,
	getBaseUrlForProtocol,
	getDefaultProtocolsForProvider,
} from "./provider-protocol";

// ------------------------------------------------------------------ helpers

function toRuntimeReasoningEffort(effort: string | null | undefined): RuntimeReasoningEffort | null {
	if (!effort || effort === "none") {
		return null;
	}
	return effort as RuntimeReasoningEffort;
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

function toAgentProviderSummary(config: AgentProviderConfig | null): RuntimeKanbanProviderSettings {
	if (!config) {
		return createEmptyProviderSettingsSummary();
	}
	const apiKey = config.apiKey?.trim() || "";
	return {
		providerId: config.provider?.trim() || null,
		modelId: config.model?.trim() || null,
		baseUrl: config.baseUrl?.trim() || null,
		reasoningEffort: toRuntimeReasoningEffort(config.reasoning?.effort),
		apiKeyConfigured: apiKey.length > 0,
		oauthProvider: null,
		oauthAccessTokenConfigured: false,
		oauthRefreshTokenConfigured: false,
		oauthAccountId: null,
		oauthExpiresAt: null,
	};
}

function toRuntimeProviderModel(model: { id: string; name: string }): RuntimeKanbanProviderModel {
	return {
		id: model.id,
		name: model.name?.trim() || model.id,
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

// ------------------------------------------------------------------ model fetch

function extractModelRecords(payload: unknown): Array<{ id: string; name?: string }> {
	const container =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: null;
	const list = Array.isArray(payload)
		? payload
		: container
			? ((container.data ?? container.models ?? container.result ?? container.items) as unknown)
			: undefined;
	if (!Array.isArray(list)) {
		return [];
	}
	const records: Array<{ id: string; name?: string }> = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const entry = item as { id?: unknown; name?: unknown };
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (id.length === 0) {
			continue;
		}
		records.push({ id, name: typeof entry.name === "string" ? entry.name.trim() : undefined });
	}
	return records;
}

async function fetchModelsFromEndpoint(baseUrl: string, apiKey?: string): Promise<RuntimeKanbanProviderModel[]> {
	const modelsUrl = `${baseUrl.replace(/\/+$/, "")}/models`;
	const maxAttempts = 2;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (apiKey?.trim()) {
				headers.Authorization = `Bearer ${apiKey.trim()}`;
			}

			const response = await fetch(modelsUrl, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(15_000),
			});

			if (!response.ok && response.status >= 500 && attempt < maxAttempts) {
				console.warn(`[kanban] /models endpoint returned ${response.status} for ${modelsUrl}, retrying (${attempt}/${maxAttempts})...`);
				await new Promise((r) => setTimeout(r, 1000 * attempt));
				continue;
			}
			if (!response.ok) {
				console.warn(`[kanban] /models endpoint returned ${response.status} for ${modelsUrl}`);
				return [];
			}

			const records = extractModelRecords(await response.json());
			return records
				.map((record) => ({ id: record.id, name: record.name || record.id }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			if (attempt < maxAttempts) {
				console.warn(`[kanban] /models endpoint fetch failed for ${modelsUrl}, retrying (${attempt}/${maxAttempts}):`, error instanceof Error ? error.message : error);
				await new Promise((r) => setTimeout(r, 1000 * attempt));
				continue;
			}
			console.warn(`[kanban] /models endpoint fetch failed for ${modelsUrl} after ${maxAttempts} attempts:`, error instanceof Error ? error.message : error);
			return [];
		}
	}
	return [];
}

// ------------------------------------------------------------------ service

export function createAgentProviderService() {
	return {
		/**
		 * Get the provider settings summary for a specific agent.
		 */
		getAgentProviderSummary(agentId: string): RuntimeKanbanProviderSettings {
			return toAgentProviderSummary(getAgentProviderConfig(agentId));
		},

		/**
		 * Save (or overwrite) an agent's provider configuration.
		 */
		async saveAgentProvider(agentId: string, config: AgentProviderConfig): Promise<RuntimeKanbanProviderSettings> {
			await saveAgentProvider(agentId, config);
			return toAgentProviderSummary(getAgentProviderConfig(agentId));
		},

		/**
		 * Delete an agent's provider configuration.
		 */
		async deleteAgentProvider(agentId: string): Promise<RuntimeKanbanProviderSettings> {
			await deleteAgentProvider(agentId);
			return createEmptyProviderSettingsSummary();
		},

		/**
		 * Get catalog of all available providers.
		 * Shows all bundled providers, with configured ones marked as enabled.
		 */
		async getAllAgentProviderCatalog(): Promise<RuntimeKanbanProviderCatalogResponse> {
			const allConfigs = getAllAgentProviderConfigs();
			// Build a map of configured providers (keyed by provider name)
			const configuredProviders = new Map<string, AgentProviderConfig>();
			for (const config of Object.values(allConfigs)) {
				const providerName = config.provider?.trim().toLowerCase();
				if (providerName) {
					configuredProviders.set(providerName, config);
				}
			}

			const providers: RuntimeKanbanProviderCatalogItem[] = [];
			const seenProviders = new Set<string>();

			// First, add all configured providers (enabled)
			for (const [providerName, config] of configuredProviders) {
				seenProviders.add(providerName);
				const protocolConfigs: ProtocolConfig[] = config.protocols ?? getDefaultProtocolsForProvider(providerName);
				const legacyBaseUrl = config.baseUrl?.trim()
					|| getBaseUrlForProtocol(protocolConfigs, protocolConfigs[0]?.protocol ?? "openai")
					|| null;

				providers.push({
					id: providerName,
					name: formatProviderName(providerName),
					oauthSupported: false,
					enabled: true,
					defaultModelId: config.model?.trim() || null,
					baseUrl: legacyBaseUrl,
					supportsBaseUrl: (legacyBaseUrl?.trim().length ?? 0) > 0,
					protocols: protocolConfigs,
				});
			}

			// Then, add all bundled providers that aren't configured (disabled)
			for (const bundledProvider of Object.keys(BUNDLED_PROVIDER_DEFAULT_PROTOCOLS)) {
				if (seenProviders.has(bundledProvider)) {
					continue;
				}
				const protocolConfigs = getDefaultProtocolsForProvider(bundledProvider);
				const defaultBaseUrl = getBaseUrlForProtocol(protocolConfigs, protocolConfigs[0]?.protocol ?? "openai") || null;

				providers.push({
					id: bundledProvider,
					name: formatProviderName(bundledProvider),
					oauthSupported: false,
					enabled: false,
					defaultModelId: null,
					baseUrl: defaultBaseUrl,
					supportsBaseUrl: (defaultBaseUrl?.trim().length ?? 0) > 0,
					protocols: protocolConfigs,
				});
			}

			return {
				providers: providers.sort((a, b) => a.name.localeCompare(b.name)),
			};
		},

		/**
		 * Get available models for a provider (from bundled registry or remote /models endpoint).
		 */
		async getProviderModels(providerId: string): Promise<RuntimeKanbanProviderModelsResponse> {
			const normalizedProviderId = providerId.trim().toLowerCase();
			let providerModels: RuntimeKanbanProviderModel[] = [];

			// Try bundled model registry first
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

			// For non-bundled providers, try remote /models endpoint discovery.
			// Search all agent configs for one matching this providerId.
			const allConfigs = getAllAgentProviderConfigs();
			for (const config of Object.values(allConfigs)) {
				if (config.provider?.trim().toLowerCase() === normalizedProviderId) {
					const openaiBaseUrl = config.protocols
						? getBaseUrlForProtocol(config.protocols, "openai")
						: undefined;
					const discoveryBaseUrl = openaiBaseUrl || config.baseUrl;
					if (discoveryBaseUrl) {
						const discoveredModels = await fetchModelsFromEndpoint(
							discoveryBaseUrl,
							config.apiKey?.trim() || undefined,
						);
						if (discoveredModels.length > 0) {
							return {
								providerId: normalizedProviderId,
								models: discoveredModels,
							};
						}
					}
					// Fallback: return configured model
					const configuredModel = config.model?.trim() ?? "";
					if (configuredModel.length > 0) {
						return {
							providerId: normalizedProviderId,
							models: [{ id: configuredModel, name: configuredModel }],
						};
					}
				}
			}

			return {
				providerId: normalizedProviderId,
				models: [],
			};
		},

		// ----- Account / OAuth (stateless stubs) -----

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
