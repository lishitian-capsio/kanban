import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { useCallback, useMemo, useState } from "react";

import type { RuntimeAgentId } from "@/runtime/types";
import {
	applyColumnView,
	type ColumnFilterOption,
	type ColumnSortDirection,
	type ColumnSortKey,
	type ColumnViewState,
	createDefaultColumnView,
	deriveColumnAgentOptions,
	deriveColumnOwnerOptions,
	isColumnViewActive,
} from "@/state/board-column-view";
import type { BoardCard } from "@/types";

/** Default agent-label resolver backed by the runtime agent catalog. */
function resolveAgentLabelFromCatalog(agentId: string): string {
	return getRuntimeAgentCatalogEntry(agentId as RuntimeAgentId)?.label ?? agentId;
}

export interface ColumnViewControls {
	view: ColumnViewState;
	isActive: boolean;
	/** Cards after this column's filter + sort, ready to render. */
	displayedCards: BoardCard[];
	agentOptions: ColumnFilterOption[];
	ownerOptions: ColumnFilterOption[];
	setSearch: (search: string) => void;
	setAgentId: (agentId: string | null) => void;
	setOwnerKey: (ownerKey: string | null) => void;
	setSort: (sortKey: ColumnSortKey, sortDirection: ColumnSortDirection) => void;
	reset: () => void;
}

/**
 * Owns one column's independent, client-only view state (search / agent / owner /
 * sort) and derives the displayed cards + filter option lists from it. Each
 * column mounts its own instance, so the columns never affect one another. The
 * heavy lifting lives in the pure {@link applyColumnView} helpers; this hook is
 * just React state + memoization around them.
 */
export function useColumnView(
	cards: BoardCard[],
	options: { resolveAgentLabel?: (agentId: string) => string } = {},
): ColumnViewControls {
	const resolveAgentLabel = options.resolveAgentLabel ?? resolveAgentLabelFromCatalog;
	const [view, setView] = useState<ColumnViewState>(createDefaultColumnView);

	const setSearch = useCallback((search: string) => {
		setView((current) => ({ ...current, search }));
	}, []);
	const setAgentId = useCallback((agentId: string | null) => {
		setView((current) => ({ ...current, agentId }));
	}, []);
	const setOwnerKey = useCallback((ownerKey: string | null) => {
		setView((current) => ({ ...current, ownerKey }));
	}, []);
	const setSort = useCallback((sortKey: ColumnSortKey, sortDirection: ColumnSortDirection) => {
		setView((current) => ({ ...current, sortKey, sortDirection }));
	}, []);
	const reset = useCallback(() => {
		setView(createDefaultColumnView());
	}, []);

	const isActive = useMemo(() => isColumnViewActive(view), [view]);
	const displayedCards = useMemo(() => applyColumnView(cards, view), [cards, view]);
	const agentOptions = useMemo(() => deriveColumnAgentOptions(cards, resolveAgentLabel), [cards, resolveAgentLabel]);
	const ownerOptions = useMemo(() => deriveColumnOwnerOptions(cards), [cards]);

	return {
		view,
		isActive,
		displayedCards,
		agentOptions,
		ownerOptions,
		setSearch,
		setAgentId,
		setOwnerKey,
		setSort,
		reset,
	};
}
