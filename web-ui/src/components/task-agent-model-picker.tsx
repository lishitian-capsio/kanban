import * as Collapsible from "@radix-ui/react-collapsible";
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import {
	agentSupportsOfficialLogin,
	isOfficialLoginProviderId,
	OFFICIAL_LOGIN_LABEL,
	OFFICIAL_LOGIN_PROVIDER_ID,
} from "@runtime-provider-protocol";
import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { KanbanChatModelSelector } from "@/components/detail-panels/kanban-chat-model-selector";
import {
	buildKanbanAgentModelPickerOptions,
	buildKanbanSelectedModelButtonText,
	getKanbanReasoningEnabledModelIds,
} from "@/components/detail-panels/kanban-model-picker-options";
import { SearchSelectDropdown } from "@/components/search-select-dropdown";
import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import { providerIdOfConfig, useAgentProviderSet } from "@/hooks/use-agent-provider-set";
import { fetchKanbanProviderModels } from "@/runtime/runtime-config-query";
import type {
	RuntimeAgentId,
	RuntimeKanbanProviderModel,
	RuntimeReasoningEffort,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";
import { createLogger } from "@/utils/logger";

const log = createLogger("models");

// ---------------------------------------------------------------------------
// Hook: manages fetch state for Kanban provider catalog + model lists
// ---------------------------------------------------------------------------

export interface UseTaskAgentModelPickerInput {
	active: boolean;
	workspaceId: string | null;
	agentId: RuntimeAgentId | undefined;
	agentSettings?: RuntimeTaskAgentSettings;
	/** The default agent ID from runtimeConfig.selectedAgentId — used to build the first option label */
	defaultAgentId?: RuntimeAgentId | null;
	/** The default Kanban model ID from runtimeConfig.kanbanProviderSettings.modelId */
	defaultModelId?: string | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: Array<{ value: string; label: string }>;
	kanbanProviderOptions: Array<{ value: string; label: string }>;
	kanbanModelOptions: Array<{ value: string; label: string }>;
	effectiveDefaultModelId: string | null;
	/**
	 * The effective default provider id for the selected agent: the agent's own
	 * default provider (its provider name), or the "official login" sentinel for a
	 * CLI agent with no configured default, or null when none applies. This is what
	 * the picker selects when the task carries no explicit `agentSettings.providerId`.
	 */
	effectiveDefaultProviderId: string | null;
	providerModels: RuntimeKanbanProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	/** Map of provider id → its default model id (from the agent's provider set). */
	providerDefaultModels: Record<string, string>;
}

export function useTaskAgentModelPicker({
	active,
	workspaceId,
	agentId,
	agentSettings,
	defaultAgentId,
	defaultModelId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const [providerModels, setProviderModels] = useState<RuntimeKanbanProviderModel[]>([]);
	const [isLoadingModels, setIsLoadingModels] = useState(false);

	// Derive the effective agent: explicit override takes precedence, then the global default
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;

	// The single source of truth for "this agent's providers + default" — the same
	// per-agent provider set that Settings → Providers and the composer's session
	// provider switch consume (via `listAgentProviders`). Refetches on open (`active`
	// toggles) and whenever the selected agent changes, so newly added/edited
	// providers appear without a stale cache.
	const {
		providers,
		defaultProviderId: agentDefaultProviderId,
		isLoading: isLoadingProviders,
	} = useAgentProviderSet({
		workspaceId,
		agentId: effectiveAgentId,
		enabled: active && effectiveAgentId !== null,
	});

	// CLI agents can run on their own native login ("official login"); the main
	// agent (pi) cannot and is never offered it.
	const supportsOfficial = effectiveAgentId !== null && agentSupportsOfficialLogin(effectiveAgentId);

	// The agent's effective default provider: its stored default, else official
	// login for a CLI agent with no configured default.
	const effectiveDefaultProviderId =
		agentDefaultProviderId?.trim() || (supportsOfficial ? OFFICIAL_LOGIN_PROVIDER_ID : "") || null;

	// Derive the effective provider: explicit task override takes precedence, then
	// the agent's default. The official-login sentinel has no models.
	const savedProviderId = agentSettings?.providerId;
	const effectiveProviderId = (savedProviderId ?? effectiveDefaultProviderId ?? "").trim() || null;

	const selectedProviderConfig = useMemo(
		() => providers.find((p) => providerIdOfConfig(p) === effectiveProviderId) ?? null,
		[providers, effectiveProviderId],
	);

	useEffect(() => {
		if (!active || !effectiveAgentId || !effectiveProviderId || isOfficialLoginProviderId(effectiveProviderId)) {
			setProviderModels([]);
			return;
		}
		let cancelled = false;
		setIsLoadingModels(true);
		void fetchKanbanProviderModels(workspaceId, effectiveProviderId)
			.then((models) => {
				if (!cancelled) {
					setProviderModels(models);
				}
			})
			.catch((error) => {
				log.warn("Failed to load models for provider", { providerId: effectiveProviderId, error });
				if (!cancelled) {
					setProviderModels([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingModels(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, effectiveProviderId, workspaceId]);

	// Model list for the selected provider: the registry/remote models (which carry
	// reasoning-capability metadata) when available, else the provider config's own
	// configured model ids (for custom CLI providers not in the bundled registry).
	const effectiveProviderModels = useMemo<RuntimeKanbanProviderModel[]>(() => {
		if (providerModels.length > 0) {
			return providerModels;
		}
		return (selectedProviderConfig?.models ?? []).map((id) => ({ id, name: id }));
	}, [providerModels, selectedProviderConfig]);

	const agentOptions = useMemo(() => {
		const catalog = getRuntimeLaunchSupportedAgentCatalog();
		let firstLabel = "Default";
		if (defaultAgentId) {
			const defaultAgent = catalog.find((a) => a.id === defaultAgentId);
			if (defaultAgent) {
				firstLabel = defaultAgent.label;
			}
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default agent from the explicit list — it's already represented by the first option
			...catalog
				.filter((agent) => agent.id !== defaultAgentId)
				.map((agent) => ({ value: agent.id, label: agent.label })),
		];
	}, [defaultAgentId]);

	const kanbanProviderOptions = useMemo(() => {
		const defaultId = effectiveDefaultProviderId;
		const firstLabel = defaultId
			? isOfficialLoginProviderId(defaultId)
				? OFFICIAL_LOGIN_LABEL
				: defaultId
			: "Default";
		const options = [{ value: "", label: firstLabel }];
		// Offer official login explicitly for CLI agents, unless it's already the
		// agent default (already represented by the first option).
		if (supportsOfficial && !isOfficialLoginProviderId(defaultId)) {
			options.push({ value: OFFICIAL_LOGIN_PROVIDER_ID, label: OFFICIAL_LOGIN_LABEL });
		}
		// Exclude the default provider from the explicit list — it's already the first option.
		for (const provider of providers) {
			const id = providerIdOfConfig(provider);
			if (!id || id === defaultId) {
				continue;
			}
			options.push({ value: id, label: id });
		}
		return options;
	}, [providers, effectiveDefaultProviderId, supportsOfficial]);

	// Map of provider id → its configured default model id. Used by the component to
	// auto-select the right model when the user switches providers.
	const providerDefaultModels = useMemo(() => {
		const map: Record<string, string> = {};
		for (const provider of providers) {
			const id = providerIdOfConfig(provider);
			const model = provider.model?.trim();
			if (id && model) {
				map[id] = model;
			}
		}
		return map;
	}, [providers]);

	// When an explicit provider override is selected, the "Default" model label should
	// reflect that provider's configured default model — not the global settings model.
	const effectiveDefaultModelId = useMemo(() => {
		if (savedProviderId) {
			return providerDefaultModels[savedProviderId] ?? null;
		}
		const inheritedProviderDefaultModelId = effectiveDefaultProviderId
			? (providerDefaultModels[effectiveDefaultProviderId] ?? null)
			: null;
		return defaultModelId ?? inheritedProviderDefaultModelId;
	}, [savedProviderId, defaultModelId, effectiveDefaultProviderId, providerDefaultModels]);

	const kanbanModelOptions = useMemo(() => {
		let defaultLabel = "Default";
		if (effectiveDefaultModelId) {
			const defaultModel = effectiveProviderModels.find((m) => m.id === effectiveDefaultModelId);
			defaultLabel = defaultModel ? defaultModel.name : effectiveDefaultModelId;
		}
		return [
			{ value: "", label: defaultLabel },
			// Exclude the default model from the explicit list — it's already represented by the first option
			...effectiveProviderModels
				.filter((m) => m.id !== effectiveDefaultModelId)
				.map((m) => ({ value: m.id, label: m.name })),
		];
	}, [effectiveProviderModels, effectiveDefaultModelId]);

	return {
		agentOptions,
		kanbanProviderOptions,
		kanbanModelOptions,
		effectiveDefaultModelId,
		effectiveDefaultProviderId,
		providerModels: effectiveProviderModels,
		isLoadingProviders,
		isLoadingModels,
		providerDefaultModels,
	};
}

function cloneTaskAgentSettings(settings?: RuntimeTaskAgentSettings): RuntimeTaskAgentSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

// ---------------------------------------------------------------------------
// Component: renders Agent, Kanban provider, and Kanban model pickers
// ---------------------------------------------------------------------------

export function TaskAgentModelPicker({
	agentId,
	onAgentIdChange,
	agentSettings,
	onKanbanSettingsChange,
	agentOptions,
	kanbanProviderOptions,
	kanbanModelOptions,
	effectiveDefaultModelId = null,
	providerModels = [],
	isLoadingProviders,
	isLoadingModels,
	onPopoverOpenChange,
	defaultAgentId,
	defaultProviderId,
	defaultReasoningEffort,
	providerDefaultModels,
}: {
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	agentSettings?: RuntimeTaskAgentSettings | undefined;
	onKanbanSettingsChange?: (value: RuntimeTaskAgentSettings | undefined) => void;
	agentOptions: Array<{ value: string; label: string }>;
	kanbanProviderOptions: Array<{ value: string; label: string }>;
	kanbanModelOptions: Array<{ value: string; label: string }>;
	effectiveDefaultModelId?: string | null;
	providerModels?: RuntimeKanbanProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	onPopoverOpenChange?: (open: boolean) => void;
	/** The default agent ID from runtimeConfig — used to decide if Kanban pickers should show by default */
	defaultAgentId?: RuntimeAgentId | null;
	/** The agent's effective default provider id (from `useTaskAgentModelPicker`) — the provider used when the task carries no explicit override; decides the default-selected provider and whether the model picker shows */
	defaultProviderId?: string | null;
	/** The global default reasoning effort from runtimeConfig.kanbanProviderSettings.reasoningEffort */
	defaultReasoningEffort?: RuntimeReasoningEffort | null;
	/** Map of provider ID → its default model ID (from the provider catalog). */
	providerDefaultModels?: Record<string, string>;
}): ReactElement {
	const savedProviderId = agentSettings?.providerId;
	const savedModelId = agentSettings?.modelId;
	const savedReasoningEffort = agentSettings?.reasoningEffort;

	const updateTaskKanbanSettings = useCallback(
		(updater: (current: RuntimeTaskAgentSettings | undefined) => RuntimeTaskAgentSettings | undefined) => {
			onKanbanSettingsChange?.(updater(cloneTaskAgentSettings(agentSettings)));
		},
		[agentSettings, onKanbanSettingsChange],
	);

	// Show the Kanban provider picker for any agent (each agent manages its own provider)
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;
	const showKanbanProviderPicker = effectiveAgentId !== null;

	// Show the Kanban model picker when a real provider is effectively selected
	// (either explicitly overridden, or the agent's default provider). The
	// official-login sentinel has no models, so it never shows the model picker.
	const effectiveProviderId = savedProviderId ?? defaultProviderId ?? null;
	const showKanbanModelPicker =
		showKanbanProviderPicker && Boolean(effectiveProviderId) && !isOfficialLoginProviderId(effectiveProviderId);
	const hasTaskKanbanSettingsOverride = agentSettings !== undefined;
	const selectedTaskReasoningEffort = savedReasoningEffort ?? "";
	const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);
	const [isProviderPopoverOpen, setIsProviderPopoverOpen] = useState(false);
	const [isModelPopoverOpen, setIsModelPopoverOpen] = useState(false);
	const [reasoningEffort, setReasoningEffort] = useState<RuntimeReasoningEffort | "">(
		hasTaskKanbanSettingsOverride ? selectedTaskReasoningEffort : (defaultReasoningEffort ?? ""),
	);
	const setReasoningEffortWithOverride = useCallback(
		(nextReasoningEffort: RuntimeReasoningEffort | "") => {
			setReasoningEffort(nextReasoningEffort);
			updateTaskKanbanSettings((currentSettings) => {
				const nextSettings = cloneTaskAgentSettings(currentSettings) ?? {};
				if (nextReasoningEffort) {
					nextSettings.reasoningEffort = nextReasoningEffort;
					return nextSettings;
				}
				delete nextSettings.reasoningEffort;
				if (
					nextSettings.providerId ||
					nextSettings.modelId ||
					currentSettings !== undefined ||
					Boolean(defaultReasoningEffort)
				) {
					return nextSettings;
				}
				return undefined;
			});
		},
		[defaultReasoningEffort, updateTaskKanbanSettings],
	);

	const modelPickerOptions = useMemo(() => {
		const defaultOption = kanbanModelOptions.find((option) => option.value === "");
		const explicitOptions = kanbanModelOptions.filter((option) => option.value !== "");
		const providerId = (effectiveProviderId ?? "").trim();

		if (!providerId || explicitOptions.length === 0) {
			return {
				options: defaultOption ? [defaultOption, ...explicitOptions] : explicitOptions,
				recommendedModelIds: [] as string[],
				shouldPinSelectedModelToTop: true,
			};
		}

		const orderedOptions = buildKanbanAgentModelPickerOptions(providerId, providerModels);
		const explicitOptionByValue = new Map(explicitOptions.map((option) => [option.value, option] as const));
		const orderedExplicit = orderedOptions.options
			.map((option) => explicitOptionByValue.get(option.value))
			.filter((option): option is { value: string; label: string } => option !== undefined);
		const orderedExplicitValueSet = new Set(orderedExplicit.map((option) => option.value));
		const remainingExplicit = explicitOptions.filter((option) => !orderedExplicitValueSet.has(option.value));

		return {
			options: defaultOption ? [defaultOption, ...orderedExplicit, ...remainingExplicit] : orderedExplicit,
			recommendedModelIds: orderedOptions.recommendedModelIds,
			shouldPinSelectedModelToTop: orderedOptions.shouldPinSelectedModelToTop,
		};
	}, [kanbanModelOptions, effectiveProviderId, providerModels]);

	const reasoningEnabledModelIds = useMemo(() => getKanbanReasoningEnabledModelIds(providerModels), [providerModels]);
	const reasoningEnabledModelIdSet = useMemo(() => new Set(reasoningEnabledModelIds), [reasoningEnabledModelIds]);
	const effectiveSelectedModelId = (savedModelId ?? effectiveDefaultModelId ?? "").trim();
	const selectedModelCapabilityKnown = useMemo(
		() => providerModels.some((model) => model.id === effectiveSelectedModelId),
		[effectiveSelectedModelId, providerModels],
	);
	const selectedModelSupportsReasoningEffort = reasoningEnabledModelIdSet.has(effectiveSelectedModelId);

	useEffect(() => {
		if (!hasTaskKanbanSettingsOverride) {
			return;
		}
		if (selectedTaskReasoningEffort !== reasoningEffort) {
			setReasoningEffort(selectedTaskReasoningEffort);
		}
	}, [hasTaskKanbanSettingsOverride, reasoningEffort, selectedTaskReasoningEffort]);

	useEffect(() => {
		if (hasTaskKanbanSettingsOverride) {
			return;
		}
		const inheritedReasoningEffort = defaultReasoningEffort ?? "";
		if (reasoningEffort !== inheritedReasoningEffort) {
			setReasoningEffort(inheritedReasoningEffort);
		}
	}, [defaultReasoningEffort, hasTaskKanbanSettingsOverride, reasoningEffort]);

	useEffect(() => {
		if (!isSettingsExpanded) {
			setIsProviderPopoverOpen(false);
			setIsModelPopoverOpen(false);
		}
	}, [isSettingsExpanded]);

	useEffect(() => {
		onPopoverOpenChange?.(isProviderPopoverOpen || isModelPopoverOpen);
	}, [isModelPopoverOpen, isProviderPopoverOpen, onPopoverOpenChange]);

	useEffect(() => {
		if (!selectedModelCapabilityKnown) {
			return;
		}
		if (!selectedModelSupportsReasoningEffort && reasoningEffort) {
			setReasoningEffortWithOverride("");
		}
	}, [
		reasoningEffort,
		selectedModelCapabilityKnown,
		selectedModelSupportsReasoningEffort,
		setReasoningEffortWithOverride,
	]);

	const selectedModelButtonText = useMemo(
		() =>
			buildKanbanSelectedModelButtonText({
				modelOptions: modelPickerOptions.options,
				selectedModelId: savedModelId ?? "",
				reasoningEffort,
				showReasoningEffort: selectedModelSupportsReasoningEffort,
				isModelLoading: isLoadingModels,
			}),
		[
			savedModelId,
			isLoadingModels,
			modelPickerOptions.options,
			reasoningEffort,
			selectedModelSupportsReasoningEffort,
		],
	);

	// When models finish loading and the currently selected model isn't in the
	// options list, auto-select the first real model so the button never shows
	// "No models available". Pick the first non-empty option (skipping the
	// "Default" placeholder) so the user immediately sees a concrete model name.
	//
	// Guard: also skip when model options only contains the "Default"
	// placeholder (length <= 1). This prevents a race condition where the
	// effect fires on the initial render before models have been fetched —
	// at that point isLoadingModels is still false (hasn't been set to true
	// yet by the fetch effect) and the stale/empty options list would
	// incorrectly clear a valid saved modelId.
	useEffect(() => {
		if (isLoadingModels || !savedModelId || modelPickerOptions.options.length <= 1) {
			return;
		}
		const modelExists = modelPickerOptions.options.some((opt) => opt.value === savedModelId);
		if (!modelExists) {
			const firstRealModel = modelPickerOptions.options.find((opt) => opt.value !== "");
			updateTaskKanbanSettings((currentSettings) => {
				const nextSettings = cloneTaskAgentSettings(currentSettings) ?? {};
				if (firstRealModel?.value) {
					nextSettings.modelId = firstRealModel.value;
					return nextSettings;
				}
				delete nextSettings.modelId;
				const preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;
				return nextSettings.providerId || nextSettings.reasoningEffort || preserveEmptyOverride
					? nextSettings
					: undefined;
			});
		}
	}, [savedModelId, isLoadingModels, modelPickerOptions.options, updateTaskKanbanSettings]);

	return (
		<div className="flex flex-col gap-2">
			<Collapsible.Root open={isSettingsExpanded} onOpenChange={setIsSettingsExpanded}>
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="inline-flex w-fit items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer bg-transparent border-none p-0"
					>
						<ChevronDown
							size={12}
							className={cn("transition-transform", isSettingsExpanded ? "rotate-0" : "-rotate-90")}
						/>
						Override Agent Settings
					</button>
				</Collapsible.Trigger>
				<Collapsible.Content className="pt-2">
					<div className="flex flex-col gap-2">
						<div className="w-full sm:w-1/2 min-w-0">
							<span className="text-[11px] text-text-secondary block mb-1">Agent</span>
							<NativeSelect
								size="sm"
								fill
								value={agentId ?? ""}
								onChange={(e) => {
									const value = e.currentTarget.value;
									onAgentIdChange(value ? (value as RuntimeAgentId) : undefined);
								}}
							>
								{agentOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
						</div>
						{showKanbanProviderPicker ? (
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<div className="min-w-0">
									<span className="text-[11px] text-text-secondary block mb-1">
										Provider{isLoadingProviders ? " (loading\u2026)" : ""}
									</span>
									<SearchSelectDropdown
										options={kanbanProviderOptions}
										selectedValue={savedProviderId ?? ""}
										onSelect={(value) => {
											const newProviderId = value || undefined;
											const newDefaultModel =
												newProviderId && providerDefaultModels
													? providerDefaultModels[newProviderId]
													: undefined;
											updateTaskKanbanSettings((currentSettings) => {
												const nextSettings = cloneTaskAgentSettings(currentSettings) ?? {};
												if (newProviderId) {
													nextSettings.providerId = newProviderId;
												} else {
													delete nextSettings.providerId;
												}
												if (newDefaultModel) {
													nextSettings.modelId = newDefaultModel;
												} else {
													delete nextSettings.modelId;
												}
												delete nextSettings.reasoningEffort;
												const preserveEmptyOverride =
													newProviderId !== undefined ||
													(currentSettings !== undefined && Object.keys(currentSettings).length === 0);
												return nextSettings.providerId || nextSettings.modelId || preserveEmptyOverride
													? nextSettings
													: undefined;
											});
											setReasoningEffort(
												newProviderId ||
													(agentSettings !== undefined && Object.keys(agentSettings).length === 0)
													? ""
													: (defaultReasoningEffort ?? ""),
											);
										}}
										disabled={isLoadingProviders}
										fill
										size="sm"
										placeholder="Search providers..."
										emptyText="No providers available"
										noResultsText="No matching providers"
										showSelectedIndicator
										onPopoverOpenChange={setIsProviderPopoverOpen}
									/>
								</div>
								{showKanbanModelPicker ? (
									<div className="min-w-0">
										<span className="text-[11px] text-text-secondary block mb-1">
											Model{isLoadingModels ? " (loading\u2026)" : ""}
										</span>
										<KanbanChatModelSelector
											modelOptions={modelPickerOptions.options}
											recommendedModelIds={modelPickerOptions.recommendedModelIds}
											pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
											selectedModelId={savedModelId ?? ""}
											selectedModelButtonText={selectedModelButtonText}
											onSelectModel={(value) => {
												updateTaskKanbanSettings((currentSettings) => {
													const nextSettings = cloneTaskAgentSettings(currentSettings) ?? {};
													if (value) {
														nextSettings.modelId = value;
													} else {
														delete nextSettings.modelId;
													}
													if (!value || !reasoningEnabledModelIdSet.has(value)) {
														delete nextSettings.reasoningEffort;
													}
													const preserveEmptyOverride =
														currentSettings !== undefined && Object.keys(currentSettings).length === 0;
													return nextSettings.providerId ||
														nextSettings.modelId ||
														nextSettings.reasoningEffort ||
														preserveEmptyOverride
														? nextSettings
														: undefined;
												});
												if (!value && !savedProviderId) {
													setReasoningEffort(
														agentSettings !== undefined && Object.keys(agentSettings).length === 0
															? ""
															: (defaultReasoningEffort ?? ""),
													);
													return;
												}
												if (!value || !reasoningEnabledModelIdSet.has(value)) {
													setReasoningEffortWithOverride("");
												}
											}}
											reasoningEnabledModelIds={reasoningEnabledModelIds}
											defaultOptionSupportsReasoningEffort={
												!savedModelId && selectedModelSupportsReasoningEffort
											}
											selectedReasoningEffort={reasoningEffort}
											onSelectReasoningEffort={(nextReasoningEffort) =>
												setReasoningEffortWithOverride(nextReasoningEffort)
											}
											disabled={isLoadingModels}
											isModelLoading={isLoadingModels}
											fill
											triggerVariant="default"
											onPopoverOpenChange={setIsModelPopoverOpen}
										/>
									</div>
								) : null}
							</div>
						) : null}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	);
}
