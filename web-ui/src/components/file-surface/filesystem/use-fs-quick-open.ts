import { Fzf } from "fzf";
import { useEffect, useMemo, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

const QUICK_OPEN_LIMIT = 50;

const EMPTY_PATHS: string[] = [];

export interface UseFsQuickOpenResult {
	query: string;
	setQuery: (query: string) => void;
	/** Fuzzy-matched (or, with an empty query, leading) repo-relative file paths. */
	results: string[];
	isLoading: boolean;
	/** True when the working tree had more files than the server cap. */
	truncated: boolean;
	selectedIndex: number;
	setSelectedIndex: (index: number) => void;
}

/**
 * Client-side Quick Open (⌘P) over the working tree's file paths. The full path
 * index is fetched once each time the palette opens (`workspaceFs.listPaths`, a
 * single capped `git ls-files`), then fzf matches instantly and synchronously as
 * the user types — the same fetch-once-then-match-locally shape as
 * {@link useVaultQuickOpen}. With an empty query the leading paths are shown so
 * the palette is useful before typing.
 */
export function useFsQuickOpen(workspaceId: string | null, active: boolean): UseFsQuickOpenResult {
	const [query, setQuery] = useState("");
	const [paths, setPaths] = useState<string[]>(EMPTY_PATHS);
	const [isLoading, setIsLoading] = useState(false);
	const [truncated, setTruncated] = useState(false);
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
				const response = await getRuntimeTrpcClient(workspaceId).workspaceFs.listPaths.query({});
				if (cancelled) {
					return;
				}
				setPaths(response.ok ? response.paths : EMPTY_PATHS);
				setTruncated(response.ok ? response.truncated : false);
			} catch {
				if (!cancelled) {
					setPaths(EMPTY_PATHS);
					setTruncated(false);
				}
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

	// Match on the full path so a fragment of a directory OR the filename hits.
	const finder = useMemo(() => new Fzf(paths, { selector: (path) => path }), [paths]);

	const results = useMemo(() => {
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			return paths.slice(0, QUICK_OPEN_LIMIT);
		}
		return finder
			.find(trimmed)
			.slice(0, QUICK_OPEN_LIMIT)
			.map((entry) => entry.item);
	}, [paths, finder, query]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	return { query, setQuery, results, isLoading, truncated, selectedIndex, setSelectedIndex };
}
