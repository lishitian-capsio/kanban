import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeDbFilter, RuntimeDbResultColumn, RuntimeDbRow, RuntimeDbSort } from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { dbErrorMessage } from "./db-utils";

export interface TableDataTarget {
	connId: string;
	schema: string;
	table: string;
}

export interface UseDbTableDataResult {
	columns: RuntimeDbResultColumn[];
	rows: RuntimeDbRow[];
	hasMore: boolean;
	isLoading: boolean;
	isLoadingMore: boolean;
	errorMessage: string | null;
	truncated: { byRows: boolean; byBytes: boolean };
	loadMore: () => void;
	reload: () => void;
	updateRowLocal: (index: number, row: RuntimeDbRow) => void;
	removeRowLocal: (index: number) => void;
}

/**
 * Browse a table's rows with server-side LIMIT bounding + opaque-cursor pagination. Sorting and
 * filtering re-issue from the first page; `loadMore` appends the next page (infinite scroll). A
 * request-id guard discards responses superseded by a newer target/sort/filter change.
 */
export function useDbTableData(
	workspaceId: string | null,
	target: TableDataTarget | null,
	sort: RuntimeDbSort[],
	filters: RuntimeDbFilter[],
): UseDbTableDataResult {
	const [columns, setColumns] = useState<RuntimeDbResultColumn[]>([]);
	const [rows, setRows] = useState<RuntimeDbRow[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [truncated, setTruncated] = useState({ byRows: false, byBytes: false });

	const cursorRef = useRef<string | null>(null);
	const requestRef = useRef(0);
	const inputsRef = useRef({ target, sort, filters });
	inputsRef.current = { target, sort, filters };

	// Re-fetch the first page whenever the target / sort / filters change.
	const fetchKey = target ? JSON.stringify({ target, sort, filters }) : null;

	const fetchPage = useCallback(
		async (mode: "reset" | "more") => {
			const { target: activeTarget, sort: activeSort, filters: activeFilters } = inputsRef.current;
			if (!workspaceId || !activeTarget) {
				return;
			}
			const requestId = requestRef.current + 1;
			requestRef.current = requestId;
			if (mode === "reset") {
				setIsLoading(true);
				setErrorMessage(null);
			} else {
				setIsLoadingMore(true);
			}
			try {
				const response = await getRuntimeTrpcClient(workspaceId).database.browseTable.query({
					connId: activeTarget.connId,
					schema: activeTarget.schema,
					table: activeTarget.table,
					sort: activeSort,
					filters: activeFilters,
					cursor: mode === "more" ? cursorRef.current : null,
				});
				if (requestRef.current !== requestId) {
					return;
				}
				cursorRef.current = response.pagination.nextCursor;
				setHasMore(response.pagination.hasMore);
				setColumns(response.columns);
				setTruncated(response.truncated);
				setRows((prev) => (mode === "reset" ? response.rows : [...prev, ...response.rows]));
			} catch (error) {
				if (requestRef.current !== requestId) {
					return;
				}
				setErrorMessage(dbErrorMessage(error, "Query failed."));
				if (mode === "reset") {
					setRows([]);
					setColumns([]);
					setHasMore(false);
				}
			} finally {
				if (requestRef.current === requestId) {
					setIsLoading(false);
					setIsLoadingMore(false);
				}
			}
		},
		[workspaceId],
	);

	useEffect(() => {
		if (!fetchKey) {
			requestRef.current += 1;
			setRows([]);
			setColumns([]);
			setHasMore(false);
			setErrorMessage(null);
			return;
		}
		cursorRef.current = null;
		void fetchPage("reset");
	}, [fetchKey, fetchPage]);

	const loadMore = useCallback(() => {
		if (hasMore && !isLoading && !isLoadingMore) {
			void fetchPage("more");
		}
	}, [hasMore, isLoading, isLoadingMore, fetchPage]);

	const reload = useCallback(() => {
		cursorRef.current = null;
		void fetchPage("reset");
	}, [fetchPage]);

	const updateRowLocal = useCallback((index: number, row: RuntimeDbRow) => {
		setRows((prev) => prev.map((existing, i) => (i === index ? row : existing)));
	}, []);

	const removeRowLocal = useCallback((index: number) => {
		setRows((prev) => prev.filter((_, i) => i !== index));
	}, []);

	return {
		columns,
		rows,
		hasMore,
		isLoading,
		isLoadingMore,
		errorMessage,
		truncated,
		loadMore,
		reload,
		updateRowLocal,
		removeRowLocal,
	};
}
