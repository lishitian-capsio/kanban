// Loads the provider catalog and the model list for one provider, scoped to a
// workspace, and shapes them into the options the model picker consumes.
//
// This is the read-only data the profile editor (and the inline quick model
// switch) need. It deliberately avoids the global-settings side effects in
// use-runtime-settings-kanban-controller — a profile edits its own record, not
// the machine-home provider settings.
import { useEffect, useMemo, useRef, useState } from "react";

import {
	buildKanbanAgentModelPickerOptions,
	getKanbanReasoningEnabledModelIds,
} from "@/components/detail-panels/kanban-model-picker-options";
import type { SearchSelectOption } from "@/components/search-select-dropdown";
import { fetchKanbanProviderCatalog, fetchKanbanProviderModels } from "@/runtime/runtime-config-query";
import type { RuntimeKanbanProviderCatalogItem, RuntimeKanbanProviderModel } from "@/runtime/types";

export interface UseAgentProfileModelDataOptions {
	workspaceId: string | null;
	providerId: string;
	enabled?: boolean;
}

export interface UseAgentProfileModelDataResult {
	providerCatalog: RuntimeKanbanProviderCatalogItem[];
	providerModels: RuntimeKanbanProviderModel[];
	isLoadingCatalog: boolean;
	isLoadingModels: boolean;
	modelOptions: SearchSelectOption[];
	recommendedModelIds: string[];
	shouldPinSelectedModelToTop: boolean;
	reasoningEnabledModelIds: string[];
}

export function useAgentProfileModelData(
	options: UseAgentProfileModelDataOptions,
): UseAgentProfileModelDataResult {
	const { workspaceId, providerId, enabled = true } = options;
	const trimmedProviderId = providerId.trim();

	const [providerCatalog, setProviderCatalog] = useState<RuntimeKanbanProviderCatalogItem[]>([]);
	const [providerModels, setProviderModels] = useState<RuntimeKanbanProviderModel[]>([]);
	const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const modelsRequestIdRef = useRef(0);

	useEffect(() => {
		if (!enabled) {
			setProviderCatalog([]);
			return;
		}
		let cancelled = false;
		setIsLoadingCatalog(true);
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
					setIsLoadingCatalog(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, workspaceId]);

	useEffect(() => {
		if (!enabled || trimmedProviderId.length === 0) {
			modelsRequestIdRef.current += 1;
			setProviderModels([]);
			setIsLoadingModels(false);
			return;
		}
		modelsRequestIdRef.current += 1;
		const requestId = modelsRequestIdRef.current;
		setIsLoadingModels(true);
		void fetchKanbanProviderModels(workspaceId, trimmedProviderId)
			.then((models) => {
				if (modelsRequestIdRef.current === requestId) {
					setProviderModels(models);
				}
			})
			.catch(() => {
				if (modelsRequestIdRef.current === requestId) {
					setProviderModels([]);
				}
			})
			.finally(() => {
				if (modelsRequestIdRef.current === requestId) {
					setIsLoadingModels(false);
				}
			});
	}, [enabled, trimmedProviderId, workspaceId]);

	const pickerOptions = useMemo(
		() => buildKanbanAgentModelPickerOptions(trimmedProviderId, providerModels),
		[providerModels, trimmedProviderId],
	);
	const reasoningEnabledModelIds = useMemo(
		() => getKanbanReasoningEnabledModelIds(providerModels),
		[providerModels],
	);

	return {
		providerCatalog,
		providerModels,
		isLoadingCatalog,
		isLoadingModels,
		modelOptions: pickerOptions.options,
		recommendedModelIds: pickerOptions.recommendedModelIds,
		shouldPinSelectedModelToTop: pickerOptions.shouldPinSelectedModelToTop,
		reasoningEnabledModelIds,
	};
}
