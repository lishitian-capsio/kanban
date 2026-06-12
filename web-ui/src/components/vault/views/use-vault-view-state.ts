import { useCallback, useEffect, useMemo, useState } from "react";

import type {
	RuntimeVaultFilterGroup,
	RuntimeVaultSort,
	RuntimeVaultView,
	RuntimeVaultViewLayout,
} from "@/runtime/types";
import { useRawLocalStorageValue } from "@/utils/react-use";

import { useVaultViews } from "../data/use-vault-views";
import { EMPTY_GROUP } from "../filter/filter-tree";

/** The working configuration the toolbar edits; saved into a {@link RuntimeVaultView}. */
export interface ViewDraft {
	filters: RuntimeVaultFilterGroup;
	sort: RuntimeVaultSort | null;
	layout: RuntimeVaultViewLayout;
	listPropertiesDisplay: string[];
}

function viewToDraft(view: RuntimeVaultView | null): ViewDraft {
	if (!view) {
		return { filters: EMPTY_GROUP, sort: null, layout: "table", listPropertiesDisplay: [] };
	}
	return {
		filters: view.filters,
		sort: view.sort,
		layout: view.layout,
		listPropertiesDisplay: view.listPropertiesDisplay,
	};
}

export interface VaultViewStateResult {
	views: RuntimeVaultView[];
	selectedViewId: string | null;
	selectedView: RuntimeVaultView | null;
	selectView: (id: string | null) => void;
	draft: ViewDraft;
	setFilters: (filters: RuntimeVaultFilterGroup) => void;
	setSort: (sort: RuntimeVaultSort | null) => void;
	setLayout: (layout: RuntimeVaultViewLayout) => void;
	setListPropertiesDisplay: (keys: string[]) => void;
	isDirty: boolean;
	isMutating: boolean;
	saveCurrent: () => Promise<void>;
	saveAsNew: (name: string) => Promise<void>;
	deleteCurrent: () => Promise<void>;
}

const identity = (value: string): string => value;

/**
 * Orchestrates a document type's saved views and the live working draft the
 * toolbar edits. The selected view id is persisted per (workspace, type) in
 * localStorage so a surface reopens where the user left it; the draft is seeded
 * from the selected view and re-seeded whenever that view changes (e.g. after a
 * save), so `isDirty` reflects unsaved edits.
 */
export function useVaultViewState(workspaceId: string | null, type: string): VaultViewStateResult {
	const { views, isMutating, createView, updateView, deleteView } = useVaultViews(workspaceId, type);

	const storageKey = `vault:view:${workspaceId ?? "none"}:${type}`;
	const [storedViewId, setStoredViewId] = useRawLocalStorageValue<string>(storageKey, "", identity);
	const selectedViewId = storedViewId === "" ? null : storedViewId;

	const selectedView = useMemo(
		() => views.find((view) => view.id === selectedViewId) ?? null,
		[views, selectedViewId],
	);

	const [draft, setDraft] = useState<ViewDraft>(() => viewToDraft(selectedView));

	// Re-seed the draft when the selected view changes identity or is re-saved.
	const seedKey = selectedView ? `${selectedView.id}:${selectedView.updatedAt}` : "none";
	// seedKey is the stable identity of selectedView; re-seed only when it changes (not on every draft edit).
	useEffect(() => {
		setDraft(viewToDraft(selectedView));
	}, [seedKey]);

	const selectView = useCallback(
		(id: string | null) => {
			setStoredViewId(id ?? "");
		},
		[setStoredViewId],
	);

	const setFilters = useCallback((filters: RuntimeVaultFilterGroup) => setDraft((d) => ({ ...d, filters })), []);
	const setSort = useCallback((sort: RuntimeVaultSort | null) => setDraft((d) => ({ ...d, sort })), []);
	const setLayout = useCallback((layout: RuntimeVaultViewLayout) => setDraft((d) => ({ ...d, layout })), []);
	const setListPropertiesDisplay = useCallback(
		(listPropertiesDisplay: string[]) => setDraft((d) => ({ ...d, listPropertiesDisplay })),
		[],
	);

	const isDirty = useMemo(
		() => JSON.stringify(draft) !== JSON.stringify(viewToDraft(selectedView)),
		[draft, selectedView],
	);

	const saveCurrent = useCallback(async () => {
		if (!selectedViewId) {
			return;
		}
		await updateView(selectedViewId, draft);
	}, [selectedViewId, draft, updateView]);

	const saveAsNew = useCallback(
		async (name: string) => {
			const created = await createView({ type, name, ...draft, order: views.length });
			if (created) {
				selectView(created.id);
			}
		},
		[type, draft, views.length, createView, selectView],
	);

	const deleteCurrent = useCallback(async () => {
		if (!selectedViewId) {
			return;
		}
		const removed = await deleteView(selectedViewId);
		if (removed) {
			selectView(null);
		}
	}, [selectedViewId, deleteView, selectView]);

	return {
		views,
		selectedViewId,
		selectedView,
		selectView,
		draft,
		setFilters,
		setSort,
		setLayout,
		setListPropertiesDisplay,
		isDirty,
		isMutating,
		saveCurrent,
		saveAsNew,
		deleteCurrent,
	};
}
