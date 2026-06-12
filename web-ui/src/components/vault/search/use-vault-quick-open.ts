import { Fzf } from "fzf";
import { useEffect, useMemo, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

import { toVaultDoc, type VaultDoc } from "../data/vault-doc-model";
import { quickOpenSearchText } from "./quick-open-text";

const QUICK_OPEN_LIMIT = 25;

const EMPTY_DOCS: VaultDoc[] = [];

export interface UseVaultQuickOpenResult {
	query: string;
	setQuery: (query: string) => void;
	results: VaultDoc[];
	isLoading: boolean;
	selectedIndex: number;
	setSelectedIndex: (index: number) => void;
}

/**
 * Client-side quick-open over every vault document, fuzzy-matching on title +
 * frontmatter `aliases` (via {@link quickOpenSearchText}) with `fzf`. The full doc
 * list is fetched once each time the palette opens; matching is then instant and
 * synchronous as the user types. With an empty query the most-recently-updated docs
 * are shown so the palette is useful before typing.
 */
export function useVaultQuickOpen(workspaceId: string | null, active: boolean): UseVaultQuickOpenResult {
	const [query, setQuery] = useState("");
	const [docs, setDocs] = useState<VaultDoc[]>(EMPTY_DOCS);
	const [isLoading, setIsLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);

	useEffect(() => {
		if (!active) {
			setQuery("");
			setSelectedIndex(0);
			return;
		}
		if (!workspaceId) {
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.listDocuments.query({});
				if (cancelled) {
					return;
				}
				const mapped = response.documents.map(toVaultDoc);
				mapped.sort((a, b) => b.updatedAt - a.updatedAt);
				setDocs(mapped);
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [active, workspaceId]);

	const finder = useMemo(() => new Fzf(docs, { selector: quickOpenSearchText }), [docs]);

	const results = useMemo(() => {
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			return docs.slice(0, QUICK_OPEN_LIMIT);
		}
		return finder
			.find(trimmed)
			.slice(0, QUICK_OPEN_LIMIT)
			.map((entry) => entry.item);
	}, [docs, finder, query]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	return { query, setQuery, results, isLoading, selectedIndex, setSelectedIndex };
}
