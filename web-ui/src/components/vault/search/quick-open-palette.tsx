import { CornerDownLeft, FileText } from "lucide-react";
import type React from "react";
import { useCallback } from "react";

import type { VaultDoc } from "../data/vault-doc-model";
import { getVaultTypeView } from "../data/vault-type-registry";
import { SearchOverlay } from "./search-overlay";
import { SearchResultRow } from "./search-result-row";
import { useSearchKeyboard } from "./use-search-keyboard";
import { useVaultQuickOpen } from "./use-vault-quick-open";

function docIcon(type: string): React.ReactNode {
	const Icon = getVaultTypeView(type)?.icon ?? FileText;
	return <Icon size={15} />;
}

function typeLabel(type: string): string {
	return getVaultTypeView(type)?.label ?? type;
}

/**
 * Quick-open palette (Cmd/Ctrl+K): jump to any vault document by fuzzy-matching its
 * title or aliases. Matching is client-side and instant; Enter opens the highlighted
 * document.
 */
export function QuickOpenPalette({
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
	const { query, setQuery, results, isLoading, selectedIndex, setSelectedIndex } = useVaultQuickOpen(workspaceId, open);

	const openDoc = useCallback(
		(doc: VaultDoc | undefined) => {
			if (!doc) {
				return;
			}
			onOpenDoc(doc.type, doc.id);
			onClose();
		},
		[onOpenDoc, onClose],
	);

	const handleKeyDown = useSearchKeyboard({
		count: results.length,
		selectedIndex,
		setSelectedIndex,
		onOpen: () => openDoc(results[selectedIndex]),
		onClose,
	});

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
			placeholder="Go to document…"
			icon={<CornerDownLeft size={16} />}
			scrollKey={selectedIndex}
			footer={<span>↑↓ to navigate · ↵ to open · esc to close</span>}
		>
			{results.length === 0 ? (
				<div className="px-2.5 py-6 text-center text-[13px] text-text-tertiary">
					{isLoading ? "Loading documents…" : "No documents found."}
				</div>
			) : (
				results.map((doc, index) => (
					<SearchResultRow
						key={doc.id}
						icon={docIcon(doc.type)}
						title={doc.name || "Untitled"}
						badge={typeLabel(doc.type)}
						selected={index === selectedIndex}
						onSelect={() => openDoc(doc)}
						onHover={() => setSelectedIndex(index)}
					/>
				))
			)}
		</SearchOverlay>
	);
}
