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
import { maskApiKey } from "../../core/api-key-mask";
import { createLogger } from "../../logging";
import { type GeneratedProvider, getBundledModels } from "../ai/models";
import type { Api, Model } from "../ai/types";
import {
	type AgentProviderConfig,
	deleteAgentProvider,
	getAgentProviderConfig,
	getAllAgentProviderSets,
	saveAgentProvider,
} from "./agent-provider-config";
import {
	BUNDLED_PROVIDER_DEFAULT_PROTOCOLS,
	getBaseUrlForProtocol,
	getDefaultProtocolsForProvider,
	type ProtocolConfig,
} from "./provider-protocol";

const log = createLogger("agent-provider");

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

/**
 * Derive a model's capabilities from its bundled `models.json` metadata. These
 * are properties of the *individual model* (a single endpoint+key can serve many
 * models with different capabilities), so they belong here — not on the provider.
 *
 * - `supportsVision` / `supportsAttachments`: the model accepts image input
 *   (`input` includes `"image"`). Only text/image modalities exist today, so
 *   attachments tracks vision.
 * - `supportsReasoningEffort`: the model reasons (`reasoning`) and its API accepts
 *   the `reasoning_effort` param. A model that reasons natively but rejects the
 *   param (`compat.supportsReasoningEffort === false`) is excluded.
 *
 * Returns only the flags that are true so the wire payload stays lean and absent
 * = "unknown/false" for models discovered without metadata (remote `/models`).
 */
export function deriveBundledModelCapabilities(
	model: Pick<Model<Api>, "input" | "reasoning" | "compat">,
): Pick<RuntimeKanbanProviderModel, "supportsVision" | "supportsAttachments" | "supportsReasoningEffort"> {
	const supportsImageInput = Array.isArray(model.input) && model.input.includes("image");
	const reasons = model.reasoning === true;
	// `compat` is API-specific; only OpenAI-compat carries `supportsReasoningEffort`.
	// Read it through a narrow shape so an Anthropic model's `compat` doesn't error.
	const compat = model.compat as { supportsReasoningEffort?: boolean } | undefined;
	const supportsReasoningEffort = reasons && compat?.supportsReasoningEffort !== false;
	return {
		...(supportsImageInput ? { supportsVision: true, supportsAttachments: true } : {}),
		...(reasons ? { supportsReasoningEffort } : {}),
	};
}

function bundledModelToRuntimeProviderModel(model: Model<Api>): RuntimeKanbanProviderModel {
	return {
		...toRuntimeProviderModel({ id: model.id, name: model.name ?? model.id }),
		...deriveBundledModelCapabilities(model),
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
		payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
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
				log.warn("/models endpoint returned an error, retrying", {
					status: response.status,
					modelsUrl,
					attempt,
					maxAttempts,
				});
				await new Promise((r) => setTimeout(r, 1000 * attempt));
				continue;
			}
			if (!response.ok) {
				log.warn("/models endpoint returned an error", { status: response.status, modelsUrl });
				return [];
			}

			const records = extractModelRecords(await response.json());
			return records
				.map((record) => ({ id: record.id, name: record.name || record.id }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			if (attempt < maxAttempts) {
				log.warn("/models endpoint fetch failed, retrying", { modelsUrl, attempt, maxAttempts, error });
				await new Promise((r) => setTimeout(r, 1000 * attempt));
				continue;
			}
			log.warn("/models endpoint fetch failed after all attempts", { modelsUrl, maxAttempts, error });
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
			// Build a map of configured providers (keyed by provider name) across
			// every agent's registered provider set.
			const configuredProviders = new Map<string, AgentProviderConfig>();
			for (const set of Object.values(getAllAgentProviderSets())) {
				for (const config of set.providers) {
					const providerName = config.provider?.trim().toLowerCase();
					if (providerName) {
						configuredProviders.set(providerName, config);
					}
				}
			}

			const providers: RuntimeKanbanProviderCatalogItem[] = [];
			const seenProviders = new Set<string>();

			// First, add all configured providers (enabled)
			for (const [providerName, config] of configuredProviders) {
				seenProviders.add(providerName);
				const protocolConfigs: ProtocolConfig[] = config.protocols ?? getDefaultProtocolsForProvider(providerName);
				const legacyBaseUrl =
					config.baseUrl?.trim() ||
					getBaseUrlForProtocol(protocolConfigs, protocolConfigs[0]?.protocol ?? "openai") ||
					null;
				const apiKey = config.apiKey?.trim() || "";

				providers.push({
					id: providerName,
					name: formatProviderName(providerName),
					oauthSupported: false,
					enabled: true,
					defaultModelId: config.model?.trim() || null,
					baseUrl: legacyBaseUrl,
					supportsBaseUrl: (legacyBaseUrl?.trim().length ?? 0) > 0,
					protocols: protocolConfigs,
					models: config.models ?? [],
					modelsSourceUrl: config.modelsSourceUrl?.trim() || null,
					anthropic: config.anthropic,
					// Masked, non-secret hint only — the full key never leaves the runtime.
					apiKeyPreview: apiKey.length > 0 ? maskApiKey(apiKey) : null,
				});
			}

			// Then, add all bundled providers that aren't configured (disabled)
			for (const bundledProvider of Object.keys(BUNDLED_PROVIDER_DEFAULT_PROTOCOLS)) {
				if (seenProviders.has(bundledProvider)) {
					continue;
				}
				const protocolConfigs = getDefaultProtocolsForProvider(bundledProvider);
				const defaultBaseUrl =
					getBaseUrlForProtocol(protocolConfigs, protocolConfigs[0]?.protocol ?? "openai") || null;

				providers.push({
					id: bundledProvider,
					name: formatProviderName(bundledProvider),
					oauthSupported: false,
					enabled: false,
					defaultModelId: null,
					baseUrl: defaultBaseUrl,
					supportsBaseUrl: (defaultBaseUrl?.trim().length ?? 0) > 0,
					protocols: protocolConfigs,
					models: [],
					modelsSourceUrl: null,
					apiKeyPreview: null,
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
						.map((m) => bundledModelToRuntimeProviderModel(m))
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
			// Search every agent's registered providers for one matching this providerId.
			const allConfigs = Object.values(getAllAgentProviderSets()).flatMap((set) => set.providers);
			for (const config of allConfigs) {
				if (config.provider?.trim().toLowerCase() === normalizedProviderId) {
					// Prefer the persisted model list so a previously fetched/entered
					// list is served without re-hitting the remote /models endpoint.
					if (config.models && config.models.length > 0) {
						return {
							providerId: normalizedProviderId,
							models: config.models.map((id) => toRuntimeProviderModel({ id, name: id })),
						};
					}
					const openaiBaseUrl = config.protocols ? getBaseUrlForProtocol(config.protocols, "openai") : undefined;
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
