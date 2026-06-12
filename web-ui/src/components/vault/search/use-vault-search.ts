import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeVaultSearchResult } from "@/runtime/types";
import { useDebouncedEffect } from "@/utils/react-use";

const DEBOUNCE_MS = 200;

const EMPTY_RESULTS: RuntimeVaultSearchResult[] = [];

export interface UseVaultSearchResult {
	query: string;
	setQuery: (query: string) => void;
	results: RuntimeVaultSearchResult[];
	isSearching: boolean;
	errorMessage: string | null;
	selectedIndex: number;
	setSelectedIndex: (index: number) => void;
}

/**
 * Debounced full-text vault search backed by the `workspace.searchDocuments` tRPC
 * query. Stale responses are dropped via a generation counter, and the query +
 * results reset whenever the panel closes (`active=false`). Ranking/scoring lives
 * server-side (`src/vault/vault-search.ts`); this hook only orchestrates fetching.
 */
export function useVaultSearch(workspaceId: string | null, active: boolean): UseVaultSearchResult {
	const [query, setQuery] = useState("");
	const [debounced, setDebounced] = useState("");
	const [results, setResults] = useState<RuntimeVaultSearchResult[]>(EMPTY_RESULTS);
	const [isSearching, setIsSearching] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const generationRef = useRef(0);

	useEffect(() => {
		if (!active) {
			generationRef.current += 1;
			setQuery("");
			setDebounced("");
			setResults(EMPTY_RESULTS);
			setIsSearching(false);
			setErrorMessage(null);
			setSelectedIndex(0);
		}
	}, [active]);

	useDebouncedEffect(
		() => {
			setDebounced(query.trim());
		},
		DEBOUNCE_MS,
		[query],
	);

	useEffect(() => {
		if (!active || !workspaceId) {
			return;
		}
		if (debounced.length === 0) {
			generationRef.current += 1;
			setResults(EMPTY_RESULTS);
			setIsSearching(false);
			setErrorMessage(null);
			setSelectedIndex(0);
			return;
		}

		generationRef.current += 1;
		const generation = generationRef.current;
		setIsSearching(true);
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.searchDocuments.query({
					query: debounced,
				});
				if (generation !== generationRef.current) {
					return;
				}
				setResults(response.results);
				setSelectedIndex(0);
				setErrorMessage(null);
			} catch (error) {
				if (generation !== generationRef.current) {
					return;
				}
				setResults(EMPTY_RESULTS);
				setErrorMessage(error instanceof Error ? error.message : "Search failed.");
			} finally {
				if (generation === generationRef.current) {
					setIsSearching(false);
				}
			}
		})();
	}, [active, workspaceId, debounced]);

	const setQueryStable = useCallback((next: string) => {
		setQuery(next);
	}, []);

	return {
		query,
		setQuery: setQueryStable,
		results,
		isSearching,
		errorMessage,
		selectedIndex,
		setSelectedIndex,
	};
}
