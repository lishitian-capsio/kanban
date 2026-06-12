import { FileText, Search } from "lucide-react";
import type React from "react";
import { useCallback, useMemo } from "react";

import type { RuntimeVaultSearchResult } from "@/runtime/types";

import { getVaultTypeView } from "../data/vault-type-registry";
import { SearchOverlay } from "./search-overlay";
import { SearchResultRow } from "./search-result-row";
import { useSearchKeyboard } from "./use-search-keyboard";
import { useVaultSearch } from "./use-vault-search";

interface ResultGroup {
	type: string;
	label: string;
	items: RuntimeVaultSearchResult[];
}

/**
 * Group ranked results by document type, preserving the global ranking: groups
 * appear in order of their best (first-seen) result and items keep their ranked
 * order. The flattened `ordered` list mirrors the visual order so a single
 * `selectedIndex` drives keyboard navigation across groups coherently.
 */
function groupResultsByType(results: RuntimeVaultSearchResult[]): { groups: ResultGroup[]; ordered: RuntimeVaultSearchResult[] } {
	const groups: ResultGroup[] = [];
	const byType = new Map<string, ResultGroup>();
	for (const result of results) {
		let group = byType.get(result.type);
		if (!group) {
			group = { type: result.type, label: getVaultTypeView(result.type)?.pluralLabel ?? result.type, items: [] };
			byType.set(result.type, group);
			groups.push(group);
		}
		group.items.push(result);
	}
	return { groups, ordered: groups.flatMap((group) => group.items) };
}

function resultIcon(type: string): React.ReactNode {
	const Icon = getVaultTypeView(type)?.icon ?? FileText;
	return <Icon size={15} />;
}

/**
 * The vault full-text search panel: type-as-you-search over title, frontmatter, and
 * body (ranked server-side), results grouped by type, full keyboard navigation, and
 * Enter to open the highlighted document.
 */
export function VaultSearchPanel({
	workspaceId,
	open,
	onClose,
	onOpenDoc,
}: {
	workspaceId: string | null;
	open: boolean;
	onClose: () => void;
	onOpenDoc: (type: string, id: string) => void;
}): React.ReactElement {
	const { query, setQuery, results, isSearching, errorMessage, selectedIndex, setSelectedIndex } = useVaultSearch(
		workspaceId,
		open,
	);

	const { groups, ordered } = useMemo(() => groupResultsByType(results), [results]);

	const openResult = useCallback(
		(result: RuntimeVaultSearchResult | undefined) => {
			if (!result) {
				return;
			}
			onOpenDoc(result.type, result.id);
			onClose();
		},
		[onOpenDoc, onClose],
	);

	const handleKeyDown = useSearchKeyboard({
		count: ordered.length,
		selectedIndex,
		setSelectedIndex,
		onOpen: () => openResult(ordered[selectedIndex]),
		onClose,
	});

	const hasQuery = query.trim().length > 0;

	return (
		<SearchOverlay
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			query={query}
			onQueryChange={setQuery}
			onKeyDown={handleKeyDown}
			placeholder="Search documents…"
			icon={<Search size={16} />}
			scrollKey={selectedIndex}
			footer={
				<div className="flex items-center justify-between">
					<span>↑↓ to navigate · ↵ to open · esc to close</span>
					{isSearching ? <span>Searching…</span> : ordered.length > 0 ? <span>{ordered.length} results</span> : null}
				</div>
			}
		>
			{errorMessage ? (
				<div className="px-2.5 py-6 text-center text-[13px] text-status-red">{errorMessage}</div>
			) : !hasQuery ? (
				<div className="px-2.5 py-6 text-center text-[13px] text-text-tertiary">
					Search across titles, properties, and document text.
				</div>
			) : ordered.length === 0 ? (
				<div className="px-2.5 py-6 text-center text-[13px] text-text-tertiary">
					{isSearching ? "Searching…" : "No matches."}
				</div>
			) : (
				groups.map((group) => (
					<div key={group.type} className="mb-1.5 last:mb-0">
						<div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
							{group.label}
						</div>
						{group.items.map((result) => {
							const flatIndex = ordered.indexOf(result);
							return (
								<SearchResultRow
									key={result.id}
									icon={resultIcon(result.type)}
									title={result.title || "Untitled"}
									subtitle={result.field === "title" ? undefined : result.snippet}
									selected={flatIndex === selectedIndex}
									onSelect={() => openResult(result)}
									onHover={() => setSelectedIndex(flatIndex)}
								/>
							);
						})}
					</div>
				))
			)}
		</SearchOverlay>
	);
}
