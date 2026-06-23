// Owns the Kanban-specific settings state machine inside the settings dialog.
// It loads provider data, drives model selection, and saves settings so the
// dialog component can stay presentation-focused.
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getRuntimeKanbanProviderSettings } from "@/runtime/native-agent";
import {
	fetchAgentProviderSets,
	fetchKanbanProviderCatalog,
	fetchKanbanProviderModels,
	saveAgentProviderConfig,
} from "@/runtime/runtime-config-query";
import type {
	RuntimeAgentId,
	RuntimeAgentProviderConfig,
	RuntimeConfigResponse,
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderModel,
	RuntimeKanbanProviderSettings,
	RuntimeReasoningEffort,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";
import { createLogger } from "@/utils/logger";

const log = createLogger("models");

interface UseRuntimeSettingsKanbanControllerOptions {
	open: boolean;
	workspaceId: string | null;
	config: RuntimeConfigResponse | null;
	taskKanbanSettings?: RuntimeTaskAgentSettings;
}

interface SaveResult {
	ok: boolean;
	message?: string;
}

interface SaveProviderSettingsOverrides {
	providerId?: string;
	modelId?: string | null;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
	region?: string | null;
	aws?: {
		accessKey?: string | null;
		secretKey?: string | null;
		sessionToken?: string | null;
		region?: string | null;
		profile?: string | null;
		authentication?: "iam" | "api-key" | "profile" | null;
		endpoint?: string | null;
	};
	gcp?: {
		projectId?: string | null;
		region?: string | null;
	};
}

export interface ProtocolConfigInput {
	protocol: "anthropic" | "openai";
	baseUrl?: string;
}

/** Anthropic-protocol-specific settings collected by the form (only when the
 * Anthropic protocol is enabled). */
export interface AnthropicProviderSettingsInput {
	apiKeyField?: "auth_token" | "api_key";
	defaultModels?: { haiku?: string; sonnet?: string; opus?: string };
}

export interface AddKanbanProviderInput {
	providerId: string;
	name: string;
	baseUrl?: string;
	apiKey?: string | null;
	headers?: Record<string, string>;
	timeoutMs?: number;
	models: string[];
	defaultModelId?: string | null;
	modelsSourceUrl?: string | null;
	protocols?: ProtocolConfigInput[];
	anthropic?: AnthropicProviderSettingsInput;
}

export interface UpdateKanbanProviderInput {
	providerId: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string | null;
	headers?: Record<string, string> | null;
	timeoutMs?: number | null;
	models?: string[];
	defaultModelId?: string | null;
	modelsSourceUrl?: string | null;
	protocols?: ProtocolConfigInput[];
	anthropic?: AnthropicProviderSettingsInput;
}

/**
 * Build the write-path `protocols[]` (the single source of truth for the
 * endpoint) from a provider input. Prefers an explicit `protocols`; otherwise
 * folds a legacy scalar `baseUrl` into a single entry. The protocol guess here is
 * only a placeholder — the backend coerces it to the owning agent's protocol on
 * save. Never emits a top-level `baseUrl` (no dual-write).
 */
function protocolsFromProviderInput(input: {
	protocols?: ProtocolConfigInput[];
	baseUrl?: string;
}): Array<{ protocol: string; baseUrl?: string }> | undefined {
	if (input.protocols) {
		return input.protocols.map((p) => ({ protocol: p.protocol, baseUrl: p.baseUrl?.trim() || undefined }));
	}
	const legacyBaseUrl = input.baseUrl?.trim();
	return legacyBaseUrl ? [{ protocol: "openai", baseUrl: legacyBaseUrl }] : undefined;
}

export interface UseRuntimeSettingsKanbanControllerResult {
	currentProviderSettings: RuntimeKanbanProviderSettings;
	providerId: string;
	setProviderId: Dispatch<SetStateAction<string>>;
	modelId: string;
	setModelId: Dispatch<SetStateAction<string>>;
	apiKey: string;
	setApiKey: Dispatch<SetStateAction<string>>;
	baseUrl: string;
	setBaseUrl: Dispatch<SetStateAction<string>>;
	region: string;
	setRegion: Dispatch<SetStateAction<string>>;
	reasoningEffort: RuntimeReasoningEffort | "";
	setReasoningEffort: Dispatch<SetStateAction<RuntimeReasoningEffort | "">>;
	awsAccessKey: string;
	setAwsAccessKey: Dispatch<SetStateAction<string>>;
	awsSecretKey: string;
	setAwsSecretKey: Dispatch<SetStateAction<string>>;
	awsSessionToken: string;
	setAwsSessionToken: Dispatch<SetStateAction<string>>;
	awsRegion: string;
	setAwsRegion: Dispatch<SetStateAction<string>>;
	awsProfile: string;
	setAwsProfile: Dispatch<SetStateAction<string>>;
	awsAuthentication: "" | "iam" | "api-key" | "profile";
	setAwsAuthentication: Dispatch<SetStateAction<"" | "iam" | "api-key" | "profile">>;
	awsEndpoint: string;
	setAwsEndpoint: Dispatch<SetStateAction<string>>;
	gcpProjectId: string;
	setGcpProjectId: Dispatch<SetStateAction<string>>;
	gcpRegion: string;
	setGcpRegion: Dispatch<SetStateAction<string>>;
	providerCatalog: RuntimeKanbanProviderCatalogItem[];
	providerModels: RuntimeKanbanProviderModel[];
	isLoadingProviderCatalog: boolean;
	isLoadingProviderModels: boolean;
	normalizedProviderId: string;
	apiKeyConfigured: boolean;
	selectedModelSupportsReasoningEffort: boolean;
	hasUnsavedChanges: boolean;
	saveProviderSettings: (overrides?: SaveProviderSettingsOverrides) => Promise<SaveResult>;
	refreshProviderModels: () => Promise<SaveResult>;
	addCustomProvider: (input: AddKanbanProviderInput, agentId?: RuntimeAgentId) => Promise<SaveResult>;
	updateCustomProvider: (input: UpdateKanbanProviderInput, agentId?: RuntimeAgentId) => Promise<SaveResult>;
}

function normalizeBaseUrlForProvider(_providerId: string, baseUrl: string | null | undefined): string {
	return baseUrl ?? "";
}

/**
 * Build a RuntimeKanbanProviderSettings summary from a saved RuntimeAgentProviderConfig.
 * OAuth fields are preserved from the existing settings since saveAgentProviderConfig
 * does not modify OAuth state.
 */
function buildProviderSettingsFromConfig(
	config: RuntimeAgentProviderConfig,
	existing: RuntimeKanbanProviderSettings | null,
): RuntimeKanbanProviderSettings {
	return {
		providerId: config.provider?.trim() || null,
		modelId: config.model?.trim() || null,
		baseUrl: config.baseUrl?.trim() || null,
		reasoningEffort: (config.reasoning?.effort as RuntimeReasoningEffort | undefined) ?? null,
		apiKeyConfigured: !!config.apiKey?.trim(),
		oauthProvider: existing?.oauthProvider ?? null,
		oauthAccessTokenConfigured: existing?.oauthAccessTokenConfigured ?? false,
		oauthRefreshTokenConfigured: existing?.oauthRefreshTokenConfigured ?? false,
		oauthAccountId: existing?.oauthAccountId ?? null,
		oauthExpiresAt: existing?.oauthExpiresAt ?? null,
	};
}

function getDefaultBaseUrlForProvider(providers: RuntimeKanbanProviderCatalogItem[], providerId: string): string {
	const normalizedProviderId = providerId.trim().toLowerCase();
	if (!normalizedProviderId) {
		return "";
	}
	return (
		providers.find((provider) => provider.id.trim().toLowerCase() === normalizedProviderId)?.baseUrl?.trim() ?? ""
	);
}

function resolveBaseUrlForProvider(
	providers: RuntimeKanbanProviderCatalogItem[],
	providerId: string,
	baseUrl: string | null | undefined,
): string {
	const normalizedBaseUrl = normalizeBaseUrlForProvider(providerId, baseUrl).trim();
	if (normalizedBaseUrl.length > 0) {
		return normalizedBaseUrl;
	}
	return normalizeBaseUrlForProvider(providerId, getDefaultBaseUrlForProvider(providers, providerId));
}

function getEffectiveProviderSettings(
	config: RuntimeConfigResponse | null,
	override: RuntimeKanbanProviderSettings | null,
): RuntimeKanbanProviderSettings | null {
	return override ?? getRuntimeKanbanProviderSettings(config);
}

function getDefaultModelIdForProvider(providers: RuntimeKanbanProviderCatalogItem[], providerId: string): string {
	const normalizedProviderId = providerId.trim().toLowerCase();
	if (!normalizedProviderId) {
		return "";
	}

	return (
		providers.find((provider) => provider.id.trim().toLowerCase() === normalizedProviderId)?.defaultModelId?.trim() ??
		""
	);
}

export function useRuntimeSettingsKanbanController(
	options: UseRuntimeSettingsKanbanControllerOptions,
): UseRuntimeSettingsKanbanControllerResult {
	const { open, workspaceId, config, taskKanbanSettings } = options;
	// This controller's own reactive state (model picker, OAuth/account, refresh)
	// is pi-scoped — pi is the only agent with an in-process model registry and
	// managed OAuth. Per-agent provider CRUD is NOT pinned here: addCustomProvider /
	// updateCustomProvider take an explicit `agentId` so the Settings → Providers
	// section can define providers for any agent (claude/codex/gemini/...).
	const selectedAgentId = "pi" as const;
	const [providerId, setProviderId] = useState("");
	const [modelId, setModelId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [region, setRegion] = useState("");
	const [reasoningEffort, setReasoningEffort] = useState<RuntimeReasoningEffort | "">("");
	const [awsAccessKey, setAwsAccessKey] = useState("");
	const [awsSecretKey, setAwsSecretKey] = useState("");
	const [awsSessionToken, setAwsSessionToken] = useState("");
	const [awsRegion, setAwsRegion] = useState("");
	const [awsProfile, setAwsProfile] = useState("");
	const [awsAuthentication, setAwsAuthentication] = useState<"" | "iam" | "api-key" | "profile">("");
	const [awsEndpoint, setAwsEndpoint] = useState("");
	const [gcpProjectId, setGcpProjectId] = useState("");
	const [gcpRegion, setGcpRegion] = useState("");
	const [providerSettingsOverride, setProviderSettingsOverride] = useState<RuntimeKanbanProviderSettings | null>(null);
	const [providerCatalog, setProviderCatalog] = useState<RuntimeKanbanProviderCatalogItem[]>([]);
	const [providerModels, setProviderModels] = useState<RuntimeKanbanProviderModel[]>([]);
	const [isLoadingProviderCatalog, setIsLoadingProviderCatalog] = useState(false);
	const [isLoadingProviderModels, setIsLoadingProviderModels] = useState(false);
	const providerModelsRequestIdRef = useRef(0);

	const effectiveProviderSettings = getEffectiveProviderSettings(config, providerSettingsOverride);
	const configProviderSettings = getRuntimeKanbanProviderSettings(config);
	const hasTaskKanbanSettingsOverride = taskKanbanSettings !== undefined;
	const initialProviderId =
		taskKanbanSettings?.providerId ||
		effectiveProviderSettings?.providerId ||
		effectiveProviderSettings?.oauthProvider ||
		"";
	const initialModelId = taskKanbanSettings?.modelId || effectiveProviderSettings?.modelId || "";
	const initialBaseUrl = resolveBaseUrlForProvider(
		providerCatalog,
		initialProviderId,
		effectiveProviderSettings?.baseUrl,
	);
	const initialReasoningEffort = hasTaskKanbanSettingsOverride
		? (taskKanbanSettings?.reasoningEffort ?? "")
		: (effectiveProviderSettings?.reasoningEffort ?? "");
	const normalizedProviderId = providerId.trim().toLowerCase();
	const apiKeyConfigured = effectiveProviderSettings?.apiKeyConfigured ?? false;
	const currentProviderSettings = useMemo<RuntimeKanbanProviderSettings>(() => {
		const baseSettings = effectiveProviderSettings ?? getRuntimeKanbanProviderSettings(null);
		return {
			...baseSettings,
			providerId: providerId.trim() || null,
			modelId: modelId.trim() || null,
			baseUrl: baseUrl.trim() || null,
			reasoningEffort: reasoningEffort || null,
			apiKeyConfigured: baseSettings.apiKeyConfigured,
			oauthProvider: baseSettings.oauthProvider,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		};
	}, [baseUrl, effectiveProviderSettings, modelId, providerId, reasoningEffort]);
	const selectedModelSupportsReasoningEffort = useMemo(() => {
		return providerModels.find((model) => model.id === modelId)?.supportsReasoningEffort ?? false;
	}, [modelId, providerModels]);

	const hasUnsavedChanges = useMemo(() => {
		if (!config) {
			return false;
		}
		if (providerId.trim() !== initialProviderId.trim()) {
			return true;
		}
		if (modelId.trim() !== initialModelId.trim()) {
			return true;
		}
		if (baseUrl.trim() !== initialBaseUrl.trim()) {
			return true;
		}
		if (reasoningEffort !== initialReasoningEffort) {
			return true;
		}
		if (region.trim().length > 0) {
			return true;
		}
		if (awsAccessKey.trim().length > 0 || awsSecretKey.trim().length > 0 || awsSessionToken.trim().length > 0) {
			return true;
		}
		if (awsRegion.trim().length > 0 || awsProfile.trim().length > 0 || awsAuthentication.trim().length > 0) {
			return true;
		}
		if (awsEndpoint.trim().length > 0 || gcpProjectId.trim().length > 0 || gcpRegion.trim().length > 0) {
			return true;
		}
		return apiKey.trim().length > 0;
	}, [
		apiKey,
		awsAccessKey,
		awsAuthentication,
		awsEndpoint,
		awsProfile,
		awsRegion,
		awsSecretKey,
		awsSessionToken,
		baseUrl,
		config,
		gcpProjectId,
		gcpRegion,
		initialBaseUrl,
		initialModelId,
		initialProviderId,
		initialReasoningEffort,
		modelId,
		providerId,
		region,
		reasoningEffort,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const nextProviderId =
			taskKanbanSettings?.providerId ||
			(configProviderSettings.providerId ?? configProviderSettings.oauthProvider ?? "");
		setProviderId(nextProviderId);
		setModelId(taskKanbanSettings?.modelId || (configProviderSettings.modelId ?? ""));
		setApiKey("");
		setBaseUrl(resolveBaseUrlForProvider(providerCatalog, nextProviderId, configProviderSettings.baseUrl));
		setRegion("");
		setReasoningEffort(
			hasTaskKanbanSettingsOverride
				? (taskKanbanSettings?.reasoningEffort ?? "")
				: (configProviderSettings.reasoningEffort ?? ""),
		);
		setAwsAccessKey("");
		setAwsSecretKey("");
		setAwsSessionToken("");
		setAwsRegion("");
		setAwsProfile("");
		setAwsAuthentication("");
		setAwsEndpoint("");
		setGcpProjectId("");
		setGcpRegion("");
		setProviderSettingsOverride(null);
	}, [
		configProviderSettings.baseUrl,
		configProviderSettings.modelId,
		configProviderSettings.oauthProvider,
		configProviderSettings.providerId,
		configProviderSettings.reasoningEffort,
		hasTaskKanbanSettingsOverride,
		open,
		taskKanbanSettings,
	]);

	useEffect(() => {
		if (!open) {
			setProviderCatalog([]);
			setIsLoadingProviderCatalog(false);
			return;
		}
		let cancelled = false;
		setIsLoadingProviderCatalog(true);
		void fetchKanbanProviderCatalog(workspaceId)
			.then((nextCatalog) => {
				if (cancelled) {
					return;
				}
				setProviderCatalog(nextCatalog);
			})
			.catch(() => {
				if (!cancelled) {
					setProviderCatalog([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingProviderCatalog(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [open, workspaceId]);

	useEffect(() => {
		if (!open) {
			return;
		}
		if (providerId.trim().length > 0) {
			return;
		}
		const defaultProvider =
			providerCatalog.find((provider) => provider.id.trim().toLowerCase() === "cline") ?? providerCatalog[0] ?? null;
		if (!defaultProvider) {
			return;
		}
		const nextProviderId = defaultProvider.id.trim();
		if (!nextProviderId) {
			return;
		}
		setProviderId(nextProviderId);
		setModelId(defaultProvider.defaultModelId?.trim() ?? "");
		setBaseUrl(resolveBaseUrlForProvider(providerCatalog, nextProviderId, null));
	}, [open, providerCatalog, providerId]);

	useEffect(() => {
		if (!open) {
			return;
		}
		if (providerId.trim().length === 0 || modelId.trim().length > 0) {
			return;
		}
		const defaultModelId = getDefaultModelIdForProvider(providerCatalog, providerId);
		if (!defaultModelId) {
			return;
		}
		setModelId(defaultModelId);
	}, [modelId, open, providerCatalog, providerId]);

	useEffect(() => {
		if (!open) {
			return;
		}
		if (providerId.trim().length === 0 || baseUrl.trim().length > 0) {
			return;
		}
		const defaultBaseUrl = getDefaultBaseUrlForProvider(providerCatalog, providerId);
		if (!defaultBaseUrl) {
			return;
		}
		setBaseUrl(normalizeBaseUrlForProvider(providerId, defaultBaseUrl));
	}, [baseUrl, open, providerCatalog, providerId]);

	const nextProviderModelsRequestId = useCallback((): number => {
		providerModelsRequestIdRef.current += 1;
		return providerModelsRequestIdRef.current;
	}, []);

	const loadProviderModelsForProvider = useCallback(
		async (nextProviderId: string, requestId = nextProviderModelsRequestId()): Promise<void> => {
			setIsLoadingProviderModels(true);
			try {
				const nextModels = await fetchKanbanProviderModels(workspaceId, nextProviderId);
				if (providerModelsRequestIdRef.current === requestId) {
					setProviderModels(nextModels);
				}
			} catch (error) {
				log.warn("Failed to load models for provider", { providerId: nextProviderId, error });
				if (providerModelsRequestIdRef.current === requestId) {
					setProviderModels([]);
					showAppToast({
						intent: "warning",
						message: `Could not load models for "${nextProviderId}". Check the base URL and API key, or try the refresh button.`,
						timeout: 6000,
					});
				}
				throw error;
			} finally {
				if (providerModelsRequestIdRef.current === requestId) {
					setIsLoadingProviderModels(false);
				}
			}
		},
		[nextProviderModelsRequestId, workspaceId],
	);

	useEffect(() => {
		if (!open) {
			nextProviderModelsRequestId();
			setProviderModels([]);
			setIsLoadingProviderModels(false);
			return;
		}
		const trimmedProviderId = providerId.trim();
		if (trimmedProviderId.length === 0) {
			nextProviderModelsRequestId();
			setProviderModels([]);
			setIsLoadingProviderModels(false);
			return;
		}
		void loadProviderModelsForProvider(trimmedProviderId).catch(() => {});
		return () => {
			nextProviderModelsRequestId();
		};
	}, [loadProviderModelsForProvider, nextProviderModelsRequestId, open, providerId]);

	const saveProviderSettingsDraft = useCallback(
		async (overrides?: SaveProviderSettingsOverrides): Promise<SaveResult> => {
			if (!overrides && !hasUnsavedChanges) {
				return { ok: true };
			}
			const trimmedProviderId = (overrides?.providerId ?? providerId).trim();
			if (trimmedProviderId.length === 0) {
				return {
					ok: false,
					message: "Choose a Kanban provider before saving.",
				};
			}
			const trimmedBaseUrl =
				overrides && "baseUrl" in overrides ? overrides.baseUrl?.trim() || null : baseUrl.trim() || null;
			const trimmedModelId =
				overrides && "modelId" in overrides ? overrides.modelId?.trim() || null : modelId.trim() || null;
			const trimmedApiKey =
				overrides && "apiKey" in overrides ? overrides.apiKey?.trim() || null : apiKey.trim() || undefined;
			const nextReasoningEffort =
				overrides && "reasoningEffort" in overrides ? (overrides.reasoningEffort ?? null) : reasoningEffort || null;
			const nextRegion =
				overrides && "region" in overrides ? overrides.region?.trim() || null : region.trim() || null;
			const normalizedProviderId = trimmedProviderId.toLowerCase();
			const isBedrockProvider = normalizedProviderId === "bedrock";
			const isVertexProvider = normalizedProviderId === "vertex";
			const nextAws =
				overrides && "aws" in overrides
					? overrides.aws
					: isBedrockProvider
						? {
								accessKey: awsAccessKey.trim() || null,
								secretKey: awsSecretKey.trim() || null,
								sessionToken: awsSessionToken.trim() || null,
								region: awsRegion.trim() || null,
								profile: awsProfile.trim() || null,
								authentication: awsAuthentication || null,
								endpoint: awsEndpoint.trim() || null,
							}
						: undefined;
			const rawGcp =
				overrides && "gcp" in overrides
					? overrides.gcp
					: isVertexProvider
						? { projectId: gcpProjectId.trim(), region: gcpRegion.trim() }
						: undefined;
			const nextGcp = rawGcp
				? {
						projectId: rawGcp.projectId?.trim() || undefined,
						region: rawGcp.region?.trim() || undefined,
					}
				: undefined;
			const payloadRegion = isVertexProvider ? nextRegion : null;
			try {
				const agentConfig: RuntimeAgentProviderConfig = {
					agentId: selectedAgentId,
					provider: trimmedProviderId,
					model: trimmedModelId ?? undefined,
					baseUrl: trimmedBaseUrl ?? undefined,
					reasoning: nextReasoningEffort ? { effort: nextReasoningEffort } : undefined,
					...(trimmedApiKey !== undefined && trimmedApiKey !== null ? { apiKey: trimmedApiKey } : {}),
					...(isVertexProvider ? { region: payloadRegion ?? undefined } : {}),
					...(nextAws !== undefined ? { aws: nextAws as Record<string, unknown> } : {}),
					...(nextGcp !== undefined ? { gcp: nextGcp } : {}),
				};
				const result = await saveAgentProviderConfig(workspaceId, selectedAgentId, agentConfig);
				if (!result.ok) {
					return { ok: false, message: result.error ?? "Failed to save provider settings." };
				}
				const savedConfig = result.config;
				if (savedConfig) {
					const savedSettings = buildProviderSettingsFromConfig(savedConfig, effectiveProviderSettings);
					setProviderId(savedSettings.providerId ?? savedSettings.oauthProvider ?? trimmedProviderId);
					setModelId(savedSettings.modelId ?? "");
					setApiKey("");
					setBaseUrl(savedSettings.baseUrl ?? "");
					setReasoningEffort(savedSettings.reasoningEffort ?? "");
					setProviderSettingsOverride(savedSettings);
				} else {
					// Fallback: use form state to update local settings.
					setProviderId(trimmedProviderId);
					setModelId(trimmedModelId ?? "");
					setApiKey("");
					setBaseUrl(trimmedBaseUrl ?? "");
					setReasoningEffort(nextReasoningEffort ?? "");
				}
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		[
			apiKey,
			awsAccessKey,
			awsAuthentication,
			awsEndpoint,
			awsProfile,
			awsRegion,
			awsSecretKey,
			awsSessionToken,
			baseUrl,
			effectiveProviderSettings,
			gcpProjectId,
			gcpRegion,
			hasUnsavedChanges,
			modelId,
			providerId,
			region,
			reasoningEffort,
			workspaceId,
		],
	);

	const refreshProviderModels = useCallback(async (): Promise<SaveResult> => {
		const trimmedProviderId = providerId.trim();
		if (trimmedProviderId.length === 0) {
			return {
				ok: false,
				message: "Choose a Kanban provider before refreshing models.",
			};
		}

		setIsLoadingProviderModels(true);
		const requestId = nextProviderModelsRequestId();
		try {
			const saveResult = await saveProviderSettingsDraft({
				providerId: trimmedProviderId,
				modelId: modelId.trim() || null,
				baseUrl: baseUrl.trim() || null,
			});
			if (!saveResult.ok) {
				return saveResult;
			}

			await loadProviderModelsForProvider(trimmedProviderId, requestId);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (providerModelsRequestIdRef.current === requestId) {
				setIsLoadingProviderModels(false);
			}
		}
	}, [
		baseUrl,
		loadProviderModelsForProvider,
		modelId,
		nextProviderModelsRequestId,
		providerId,
		saveProviderSettingsDraft,
	]);

	const addCustomProvider = useCallback(
		async (input: AddKanbanProviderInput, agentId: RuntimeAgentId = "pi"): Promise<SaveResult> => {
			try {
				const agentConfig: RuntimeAgentProviderConfig = {
					agentId,
					provider: input.providerId,
					apiKey: input.apiKey?.trim() || undefined,
					// The endpoint lives in `protocols[].baseUrl` (single source of truth);
					// the legacy scalar `baseUrl` is no longer written.
					model: input.defaultModelId?.trim() || undefined,
					models: input.models.length > 0 ? input.models : undefined,
					modelsSourceUrl: input.modelsSourceUrl?.trim() || undefined,
					protocols: protocolsFromProviderInput(input),
					anthropic: input.anthropic,
					headers: input.headers,
					timeout: input.timeoutMs,
				};
				const result = await saveAgentProviderConfig(workspaceId, agentId, agentConfig);
				if (!result.ok) {
					return { ok: false, message: result.error ?? "Failed to add provider." };
				}
				if (agentId === "pi") {
					const savedConfig = result.config;
					if (savedConfig) {
						const savedSettings = buildProviderSettingsFromConfig(savedConfig, effectiveProviderSettings);
						const nextProviderId = savedSettings.providerId ?? input.providerId.trim().toLowerCase();
						setProviderId(nextProviderId);
						setModelId(savedSettings.modelId ?? input.defaultModelId?.trim() ?? input.models[0] ?? "");
						setApiKey("");
						setBaseUrl(savedSettings.baseUrl ?? input.baseUrl ?? "");
						setReasoningEffort(savedSettings.reasoningEffort ?? "");
						setProviderSettingsOverride(savedSettings);
						await loadProviderModelsForProvider(nextProviderId);
					} else {
						const nextProviderId = input.providerId.trim().toLowerCase();
						setProviderId(nextProviderId);
						setModelId(input.defaultModelId?.trim() ?? input.models[0] ?? "");
						setApiKey("");
						setBaseUrl(input.baseUrl ?? "");
						setProviderSettingsOverride(null);
						await loadProviderModelsForProvider(nextProviderId);
					}
				}
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		[effectiveProviderSettings, loadProviderModelsForProvider, workspaceId],
	);

	const updateCustomProvider = useCallback(
		async (input: UpdateKanbanProviderInput, agentId: RuntimeAgentId = "pi"): Promise<SaveResult> => {
			try {
				// Fetch the existing config to merge updates into. The edit dialog only
				// sends the fields that changed, so untouched fields must come from the
				// *provider being edited* — locate it in the agent's full provider set by
				// id. (Using the default-provider-only view here silently merged edits
				// onto the agent's default provider, clobbering the edited provider's own
				// fields.) The set is secret-free; the omitted apiKey is preserved server-side.
				let existingConfig: RuntimeAgentProviderConfig | null = null;
				try {
					const sets = await fetchAgentProviderSets(workspaceId);
					const normalizedId = input.providerId.trim().toLowerCase();
					existingConfig =
						sets.agents[agentId]?.providers.find(
							(provider) => provider.provider?.trim().toLowerCase() === normalizedId,
						) ?? null;
				} catch {
					// If fetch fails, start from empty.
				}
				// Drop any stale legacy scalar baseUrl carried by the fetched config —
				// the endpoint's single source of truth is `protocols[].baseUrl`.
				const { baseUrl: _legacyBaseUrl, ...existingRest } = existingConfig ?? { agentId };
				const mergedConfig: RuntimeAgentProviderConfig = {
					...existingRest,
					agentId,
					provider: input.providerId,
					...(input.apiKey !== undefined ? { apiKey: input.apiKey?.trim() || undefined } : {}),
					...(input.defaultModelId !== undefined ? { model: input.defaultModelId?.trim() || undefined } : {}),
					...(input.models !== undefined ? { models: input.models.length > 0 ? input.models : undefined } : {}),
					...(input.modelsSourceUrl !== undefined
						? { modelsSourceUrl: input.modelsSourceUrl?.trim() || undefined }
						: {}),
					...(input.protocols !== undefined || input.baseUrl !== undefined
						? { protocols: protocolsFromProviderInput(input) }
						: {}),
					...(input.anthropic !== undefined ? { anthropic: input.anthropic } : {}),
					...(input.headers !== undefined ? { headers: input.headers ?? undefined } : {}),
					...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs ?? undefined } : {}),
				};
				const result = await saveAgentProviderConfig(workspaceId, agentId, mergedConfig);
				if (!result.ok) {
					return { ok: false, message: result.error ?? "Failed to update provider." };
				}
				if (agentId === "pi") {
					const savedConfig = result.config;
					if (savedConfig) {
						const savedSettings = buildProviderSettingsFromConfig(savedConfig, effectiveProviderSettings);
						const nextProviderId = savedSettings.providerId ?? input.providerId.trim().toLowerCase();
						setProviderId(nextProviderId);
						setModelId(savedSettings.modelId ?? input.defaultModelId?.trim() ?? modelId);
						setApiKey("");
						setBaseUrl(savedSettings.baseUrl ?? input.baseUrl ?? baseUrl);
						setReasoningEffort(savedSettings.reasoningEffort ?? "");
						setProviderSettingsOverride(savedSettings);
						await loadProviderModelsForProvider(nextProviderId);
					} else {
						const nextProviderId = input.providerId.trim().toLowerCase();
						setProviderId(nextProviderId);
						setModelId(input.defaultModelId?.trim() ?? modelId);
						setApiKey("");
						setBaseUrl(input.baseUrl ?? baseUrl);
						setProviderSettingsOverride(null);
						await loadProviderModelsForProvider(nextProviderId);
					}
				}
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		[baseUrl, effectiveProviderSettings, loadProviderModelsForProvider, modelId, workspaceId],
	);

	return {
		currentProviderSettings,
		providerId,
		setProviderId,
		modelId,
		setModelId,
		apiKey,
		setApiKey,
		baseUrl,
		setBaseUrl,
		region,
		setRegion,
		reasoningEffort,
		setReasoningEffort,
		awsAccessKey,
		setAwsAccessKey,
		awsSecretKey,
		setAwsSecretKey,
		awsSessionToken,
		setAwsSessionToken,
		awsRegion,
		setAwsRegion,
		awsProfile,
		setAwsProfile,
		awsAuthentication,
		setAwsAuthentication,
		awsEndpoint,
		setAwsEndpoint,
		gcpProjectId,
		setGcpProjectId,
		gcpRegion,
		setGcpRegion,
		providerCatalog,
		providerModels,
		isLoadingProviderCatalog,
		isLoadingProviderModels,
		normalizedProviderId,
		apiKeyConfigured,
		selectedModelSupportsReasoningEffort,
		hasUnsavedChanges,
		saveProviderSettings: saveProviderSettingsDraft,
		refreshProviderModels,
		addCustomProvider,
		updateCustomProvider,
	};
}
