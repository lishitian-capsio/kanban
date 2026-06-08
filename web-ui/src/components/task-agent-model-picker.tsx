import * as Collapsible from "@radix-ui/react-collapsible";
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
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
import { fetchKanbanProviderCatalog, fetchKanbanProviderModels } from "@/runtime/runtime-config-query";
import type {
	RuntimeAgentId,
	RuntimeKanbanProviderCatalogItem,
	RuntimeKanbanProviderModel,
	RuntimeReasoningEffort,
	RuntimeTaskAgentSettings,
} from "@/runtime/types";

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
	/** The default Kanban provider ID from runtimeConfig.kanbanProviderSettings.providerId */
	defaultProviderId?: string | null;
	/** The default Kanban model ID from runtimeConfig.kanbanProviderSettings.modelId */
	defaultModelId?: string | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: Array<{ value: string; label: string }>;
	kanbanProviderOptions: Array<{ value: string; label: string }>;
	kanbanModelOptions: Array<{ value: string; label: string }>;
	effectiveDefaultModelId: string | null;
	providerModels: RuntimeKanbanProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	/** Map of provider ID → its default model ID (from the provider catalog). */
	providerDefaultModels: Record<string, string>;
}

export function useTaskAgentModelPicker({
	active,
	workspaceId,
	agentId,
	agentSettings,
	defaultAgentId,
	defaultProviderId,
	defaultModelId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const [providerCatalog, setProviderCatalog] = useState<RuntimeKanbanProviderCatalogItem[]>([]);
	const [providerModels, setProviderModels] = useState<RuntimeKanbanProviderModel[]>([]);
	const [isLoadingProviders, setIsLoadingProviders] = useState(false);
	const [isLoadingModels, setIsLoadingModels] = useState(false);

	// Derive the effective agent: explicit override takes precedence, then the global default
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;

	useEffect(() => {
		if (!active || effectiveAgentId !== "cline") {
			return;
		}
		let cancelled = false;
		setIsLoadingProviders(true);
		void fetchKanbanProviderCatalog(workspaceId)
			.then((catalog) => {
				if (!cancelled) {
					setProviderCatalog(catalog);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setProviderCatalog([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingProviders(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, workspaceId]);

	// Derive the effective provider: explicit override takes precedence, then the global default
	const savedProviderId = agentSettings?.providerId;
	const effectiveProviderId = (savedProviderId ?? defaultProviderId ?? "").trim() || null;

	useEffect(() => {
		if (!active || effectiveAgentId !== "cline" || !effectiveProviderId) {
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
			.catch(() => {
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
		let firstLabel = "Default";
		if (defaultProviderId) {
			const defaultProvider = providerCatalog.find((p) => p.id === defaultProviderId);
			firstLabel = defaultProvider ? defaultProvider.name : defaultProviderId;
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default provider from the explicit list — it's already represented by the first option
			...providerCatalog.filter((p) => p.id !== defaultProviderId).map((p) => ({ value: p.id, label: p.name })),
		];
	}, [providerCatalog, defaultProviderId]);

	// Map of provider ID → its catalog default model ID. Used by the component to
	// auto-select the right model when the user switches providers.
	const providerDefaultModels = useMemo(() => {
		const map: Record<string, string> = {};
		for (const p of providerCatalog) {
			if (p.defaultModelId) {
				map[p.id] = p.defaultModelId;
			}
		}
		return map;
	}, [providerCatalog]);

	// When an explicit provider override is selected, the "Default" model label should
	// reflect that provider's default model — not the global settings model.
	const effectiveDefaultModelId = useMemo(() => {
		if (savedProviderId) {
			const provider = providerCatalog.find((p) => p.id === savedProviderId);
			return provider?.defaultModelId ?? null;
		}
		const inheritedProviderDefaultModelId =
			providerCatalog.find((p) => p.id === defaultProviderId)?.defaultModelId ?? null;
		return defaultModelId ?? inheritedProviderDefaultModelId;
	}, [savedProviderId, defaultModelId, defaultProviderId, providerCatalog]);

	const kanbanModelOptions = useMemo(() => {
		let defaultLabel = "Default";
		if (effectiveDefaultModelId) {
			const defaultModel = providerModels.find((m) => m.id === effectiveDefaultModelId);
			defaultLabel = defaultModel ? defaultModel.name : effectiveDefaultModelId;
		}
		return [
			{ value: "", label: defaultLabel },
			// Exclude the default model from the explicit list — it's already represented by the first option
			...providerModels.filter((m) => m.id !== effectiveDefaultModelId).map((m) => ({ value: m.id, label: m.name })),
		];
	}, [providerModels, effectiveDefaultModelId]);

	return {
		agentOptions,
		kanbanProviderOptions,
		kanbanModelOptions,
		effectiveDefaultModelId,
		providerModels,
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
	/** The default Kanban provider ID from runtimeConfig — used to decide if model picker should show by default */
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

	// Show the Kanban provider picker when the effective agent is "cline"
	// (either explicitly overridden to cline, or defaulting to cline)
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;
	const showKanbanProviderPicker = effectiveAgentId === "cline";

	// Show the Kanban model picker when a provider is effectively selected
	// (either explicitly overridden, or the global default provider is set)
	const effectiveProviderId = savedProviderId ?? defaultProviderId ?? null;
	const showKanbanModelPicker = showKanbanProviderPicker && Boolean(effectiveProviderId);
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
									if (value !== "cline") {
										onKanbanSettingsChange?.(undefined);
										setReasoningEffort("");
									}
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
