import type { BoardCard } from "@/types";
import { getTaskOwnerLabel } from "@/utils/task-owner";

/**
 * Per-column view state: a purely *presentational* filter/search/sort applied on
 * top of the real board data. None of this touches persisted rank or the column
 * enum — it only changes which cards a single column shows and in what order.
 * Every column owns its own {@link ColumnViewState}; they never share state.
 */

export type ColumnSortKey = "rank" | "createdAt" | "updatedAt" | "title";
export type ColumnSortDirection = "asc" | "desc";

export interface ColumnViewState {
	/** Free-text query matched (case-insensitively) against title and prompt. */
	search: string;
	/**
	 * Agent filter: `null` shows all, {@link COLUMN_VIEW_UNASSIGNED} shows cards
	 * with no explicit agent override, otherwise an exact `agentId` match.
	 */
	agentId: string | null;
	/**
	 * Owner filter: `null` shows all, {@link COLUMN_VIEW_UNASSIGNED} shows cards
	 * with no owner, otherwise an exact owner-key match (see {@link getCardOwnerKey}).
	 */
	ownerKey: string | null;
	/** `"rank"` preserves the persisted manual order (the board's source of truth). */
	sortKey: ColumnSortKey;
	sortDirection: ColumnSortDirection;
}

/** Sentinel filter value selecting cards that have no agent / no owner. */
export const COLUMN_VIEW_UNASSIGNED = "__unassigned__";

export const DEFAULT_COLUMN_VIEW: ColumnViewState = {
	search: "",
	agentId: null,
	ownerKey: null,
	sortKey: "rank",
	sortDirection: "asc",
};

export function createDefaultColumnView(): ColumnViewState {
	return { ...DEFAULT_COLUMN_VIEW };
}

/**
 * Whether the view diverges from the default presentation. When active, the
 * displayed order no longer maps 1:1 to persisted rank, so the caller must
 * disable drag for that column to keep the UI order and disk rank in sync.
 */
export function isColumnViewActive(view: ColumnViewState): boolean {
	return view.search.trim() !== "" || view.agentId !== null || view.ownerKey !== null || view.sortKey !== "rank";
}

/** Stable identity for a card's owner: email when present, else name, else null. */
export function getCardOwnerKey(card: BoardCard): string | null {
	const owner = card.owner;
	if (!owner) {
		return null;
	}
	const email = owner.email?.trim() ?? "";
	const name = owner.name?.trim() ?? "";
	return email || name || null;
}

function cardMatchesSearch(card: BoardCard, search: string): boolean {
	const query = search.trim().toLowerCase();
	if (!query) {
		return true;
	}
	return card.title.toLowerCase().includes(query) || card.prompt.toLowerCase().includes(query);
}

function cardMatchesAgent(card: BoardCard, agentId: string | null): boolean {
	if (agentId === null) {
		return true;
	}
	if (agentId === COLUMN_VIEW_UNASSIGNED) {
		return !card.agentId;
	}
	return card.agentId === agentId;
}

function cardMatchesOwner(card: BoardCard, ownerKey: string | null): boolean {
	if (ownerKey === null) {
		return true;
	}
	if (ownerKey === COLUMN_VIEW_UNASSIGNED) {
		return getCardOwnerKey(card) === null;
	}
	return getCardOwnerKey(card) === ownerKey;
}

export function filterColumnCards(cards: BoardCard[], view: ColumnViewState): BoardCard[] {
	return cards.filter(
		(card) =>
			cardMatchesSearch(card, view.search) &&
			cardMatchesAgent(card, view.agentId) &&
			cardMatchesOwner(card, view.ownerKey),
	);
}

function compareCardsByKey(a: BoardCard, b: BoardCard, sortKey: Exclude<ColumnSortKey, "rank">): number {
	switch (sortKey) {
		case "createdAt":
			return a.createdAt - b.createdAt;
		case "updatedAt":
			return a.updatedAt - b.updatedAt;
		case "title":
			return a.title.localeCompare(b.title);
	}
}

export function sortColumnCards(cards: BoardCard[], view: ColumnViewState): BoardCard[] {
	if (view.sortKey === "rank") {
		// Preserve the persisted manual order verbatim.
		return cards;
	}
	const sortKey = view.sortKey;
	const direction = view.sortDirection;
	// Decorate with the original index so equal keys keep a stable order
	// regardless of sort direction.
	return cards
		.map((card, index) => ({ card, index }))
		.sort((a, b) => {
			const comparison = compareCardsByKey(a.card, b.card, sortKey);
			if (comparison !== 0) {
				return direction === "desc" ? -comparison : comparison;
			}
			return a.index - b.index;
		})
		.map((entry) => entry.card);
}

/** Filter then sort. The result is display-only and never written back to the board. */
export function applyColumnView(cards: BoardCard[], view: ColumnViewState): BoardCard[] {
	return sortColumnCards(filterColumnCards(cards, view), view);
}

export interface ColumnFilterOption {
	value: string;
	label: string;
	count: number;
}

/**
 * Distinct agent options present in a column, with per-option card counts. An
 * `__unassigned__` option is appended when some cards carry no agent override.
 * `resolveLabel` is injected so this stays free of the agent-catalog import.
 */
export function deriveColumnAgentOptions(
	cards: BoardCard[],
	resolveLabel: (agentId: string) => string,
): ColumnFilterOption[] {
	const counts = new Map<string, number>();
	let unassigned = 0;
	for (const card of cards) {
		if (card.agentId) {
			counts.set(card.agentId, (counts.get(card.agentId) ?? 0) + 1);
		} else {
			unassigned += 1;
		}
	}
	const options: ColumnFilterOption[] = [...counts.entries()]
		.map(([value, count]) => ({ value, label: resolveLabel(value), count }))
		.sort((a, b) => a.label.localeCompare(b.label));
	if (unassigned > 0) {
		options.push({ value: COLUMN_VIEW_UNASSIGNED, label: "Default agent", count: unassigned });
	}
	return options;
}

/**
 * Distinct owners present in a column, keyed by {@link getCardOwnerKey}, with
 * per-option counts. A "No owner" option is appended when some cards are
 * unowned.
 */
export function deriveColumnOwnerOptions(cards: BoardCard[]): ColumnFilterOption[] {
	const byKey = new Map<string, { label: string; count: number }>();
	let unassigned = 0;
	for (const card of cards) {
		const key = getCardOwnerKey(card);
		if (!key) {
			unassigned += 1;
			continue;
		}
		const existing = byKey.get(key);
		if (existing) {
			existing.count += 1;
		} else {
			byKey.set(key, { label: getTaskOwnerLabel(card.owner) || key, count: 1 });
		}
	}
	const options: ColumnFilterOption[] = [...byKey.entries()]
		.map(([value, { label, count }]) => ({ value, label, count }))
		.sort((a, b) => a.label.localeCompare(b.label));
	if (unassigned > 0) {
		options.push({ value: COLUMN_VIEW_UNASSIGNED, label: "No owner", count: unassigned });
	}
	return options;
}

export type ColumnEmptyState = "none" | "empty" | "no-matches";

/**
 * Distinguish a genuinely empty column from one filtered to nothing so the UI
 * can show the right copy (and an offer to clear filters).
 */
export function resolveColumnEmptyState(
	totalCount: number,
	displayedCount: number,
	isActive: boolean,
): ColumnEmptyState {
	if (displayedCount > 0) {
		return "none";
	}
	if (totalCount === 0) {
		return "empty";
	}
	return isActive ? "no-matches" : "empty";
}
