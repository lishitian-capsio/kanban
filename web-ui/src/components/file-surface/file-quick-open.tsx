import { Clock, FileText, Search } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeVaultSearchResult } from "@/runtime/types";
import { useDebouncedEffect } from "@/utils/react-use";
import type { FileRecent } from "./use-file-recents";
import type { OpenFile } from "./use-open-file";

const SEARCH_LIMIT = 20;

interface QuickOpenRow {
	id: string;
	title: string;
	/** Secondary line: a search snippet, or the recent file's path-ish hint. */
	hint: string;
	isRecent: boolean;
}

interface FileQuickOpenProps {
	open: boolean;
	workspaceId: string | null;
	recents: FileRecent[];
	openFile: OpenFile;
	onClose: () => void;
}

/**
 * The startable entry for the File surface (file-surface-design §6): a
 * lightweight searchable picker. With an empty query it shows the recents
 * shortlist (zero network); typing runs `searchDocuments` (server-ranked,
 * capped) — never `listDocuments`, so even the picker never loads the whole
 * library. Selecting a row hands the `id` to `openFile`, closing the palette and
 * opening the editor overlay.
 *
 * Mounted only while open (the provider gates it), so its search state is
 * created on open and discarded on close.
 */
export function FileQuickOpen({
	open,
	workspaceId,
	recents,
	openFile,
	onClose,
}: FileQuickOpenProps): React.ReactElement {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [results, setResults] = useState<RuntimeVaultSearchResult[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);

	// Debounce keystrokes into `debouncedQuery`; the fetch keys off that, so the
	// search runs at most once per pause, not per keystroke.
	useDebouncedEffect(() => setDebouncedQuery(query.trim()), 180, [query]);

	const trimmedQuery = debouncedQuery;
	useEffect(() => {
		if (!workspaceId || trimmedQuery.length === 0) {
			setResults([]);
			setIsSearching(false);
			return;
		}
		let cancelled = false;
		setIsSearching(true);
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspace.searchDocuments.query({
					query: trimmedQuery,
					limit: SEARCH_LIMIT,
				});
				if (!cancelled) {
					setResults(response.results);
				}
			} catch {
				if (!cancelled) {
					setResults([]);
				}
			} finally {
				if (!cancelled) {
					setIsSearching(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId, trimmedQuery]);

	const rows = useMemo<QuickOpenRow[]>(() => {
		if (trimmedQuery.length === 0) {
			return recents.map((recent) => ({
				id: recent.id,
				title: recent.title || "Untitled",
				hint: "Recent",
				isRecent: true,
			}));
		}
		return results.map((result) => ({
			id: result.id,
			title: result.title || "Untitled",
			hint: result.snippet || result.relativePath,
			isRecent: false,
		}));
	}, [trimmedQuery, recents, results]);

	// Keep the active row in range as the list changes.
	const clampedActiveIndex = rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1);

	const select = useCallback(
		(id: string) => {
			openFile(id);
			onClose();
		},
		[openFile, onClose],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveIndex((index) => (rows.length === 0 ? 0 : (index + 1) % rows.length));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex((index) => (rows.length === 0 ? 0 : (index - 1 + rows.length) % rows.length));
			} else if (event.key === "Enter") {
				event.preventDefault();
				const row = rows[clampedActiveIndex];
				if (row) {
					select(row.id);
				}
			}
		},
		[rows, clampedActiveIndex, select],
	);

	const isEmptyQuery = trimmedQuery.length === 0;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			contentClassName="max-w-xl w-[90vw] p-0 overflow-hidden"
		>
			<div className="flex items-center gap-2 border-b border-[#5A6572] bg-surface-2 px-3 py-2.5">
				<Search size={16} className="shrink-0 text-text-tertiary" />
				{/* A command palette focuses its input on open. */}
				<input
					autoFocus
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(0);
					}}
					onKeyDown={handleKeyDown}
					placeholder="Search files by title or content…"
					aria-label="Search files"
					className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
				/>
				{isSearching ? <Spinner size={14} /> : null}
			</div>

			<div className="max-h-[50vh] overflow-y-auto overscroll-contain bg-surface-1 p-1">
				{rows.length === 0 ? (
					<div className="px-3 py-6 text-center text-[13px] text-text-tertiary">
						{isEmptyQuery
							? "No recent files yet — start typing to search."
							: isSearching
								? "Searching…"
								: "No files match your search."}
					</div>
				) : (
					rows.map((row, index) => (
						<button
							key={row.id}
							type="button"
							onClick={() => select(row.id)}
							onMouseEnter={() => setActiveIndex(index)}
							className={cn(
								"flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left",
								index === clampedActiveIndex ? "bg-surface-3" : "hover:bg-surface-2",
							)}
						>
							<span className="mt-0.5 shrink-0 text-text-tertiary">
								{row.isRecent ? <Clock size={15} /> : <FileText size={15} />}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] font-medium text-text-primary">{row.title}</span>
								{row.hint ? (
									<span className="block truncate text-xs text-text-tertiary">{row.hint}</span>
								) : null}
							</span>
						</button>
					))
				)}
			</div>
		</Dialog>
	);
}
