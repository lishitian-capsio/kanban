import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFsEntry } from "@/runtime/types";

export interface UseFsTreeResult {
	/** Children per directory (repo-relative path; "" = root). Lazily populated. */
	childrenByDir: Map<string, RuntimeFsEntry[]>;
	/** Directories the user has expanded. */
	expandedDirs: Set<string>;
	/** Directories with an in-flight `listDir`. */
	loadingDirs: Set<string>;
	/** Per-directory load error (path → message). */
	errorByDir: Map<string, string>;
	/** Whether the working tree is a git repository (drives gitignore semantics). */
	isGitRepository: boolean;
	/** Toggle a directory open/closed, lazily loading its children on first open. */
	toggleDir: (path: string) => void;
	/** Ensure a directory is expanded and loaded (used to reveal a deep-linked path). */
	expandDir: (path: string) => void;
	/** Reload a single directory's children in place (incremental refresh after a mutation). */
	reloadDir: (path: string) => void;
	/** Force a full reload of the root and every currently-expanded directory. */
	reload: () => void;
}

/**
 * Owns the lazily-loaded, one-level-at-a-time working-tree state for the
 * filesystem explorer (design §3): a directory's children are fetched only when
 * it is first expanded, never recursively. `showHidden` and an explicit reload
 * both reset the cache and re-fetch the root + expanded directories.
 *
 * A single hook (rather than the design's per-path `useFsDir`) owns the whole map
 * because React forbids calling a variable number of hooks — one hook holding a
 * `Map<dirPath, entries>` is the correct shape for a lazily-growing tree.
 */
export function useFsTree(workspaceId: string | null, showHidden: boolean): UseFsTreeResult {
	const [childrenByDir, setChildrenByDir] = useState<Map<string, RuntimeFsEntry[]>>(new Map());
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
	const [errorByDir, setErrorByDir] = useState<Map<string, string>>(new Map());
	const [isGitRepository, setIsGitRepository] = useState(true);
	const [refreshToken, setRefreshToken] = useState(0);

	// Refs mirror state so the stable callbacks below can read the latest values
	// without being torn down on every change (which would re-run the reset effect).
	const expandedDirsRef = useRef(expandedDirs);
	const childrenByDirRef = useRef(childrenByDir);
	useEffect(() => {
		expandedDirsRef.current = expandedDirs;
	}, [expandedDirs]);
	useEffect(() => {
		childrenByDirRef.current = childrenByDir;
	}, [childrenByDir]);

	const loadDir = useCallback(
		async (path: string) => {
			if (!workspaceId) {
				return;
			}
			setLoadingDirs((prev) => new Set(prev).add(path));
			try {
				const response = await getRuntimeTrpcClient(workspaceId).workspaceFs.listDir.query({
					path: path || undefined,
					showHidden,
				});
				if (response.ok) {
					setChildrenByDir((prev) => new Map(prev).set(path, response.entries));
					setIsGitRepository(response.isGitRepository);
					setErrorByDir((prev) => {
						if (!prev.has(path)) {
							return prev;
						}
						const next = new Map(prev);
						next.delete(path);
						return next;
					});
				} else {
					setErrorByDir((prev) => new Map(prev).set(path, response.error ?? "Failed to load directory."));
				}
			} catch (error) {
				setErrorByDir((prev) =>
					new Map(prev).set(path, error instanceof Error ? error.message : "Failed to load directory."),
				);
			} finally {
				setLoadingDirs((prev) => {
					const next = new Set(prev);
					next.delete(path);
					return next;
				});
			}
		},
		[workspaceId, showHidden],
	);

	// Reset + reload whenever the workspace, hidden-filter, or explicit reload
	// changes. Reads the expanded set via ref so this does not re-run on expand.
	useEffect(() => {
		if (!workspaceId) {
			setChildrenByDir(new Map());
			return;
		}
		const dirsToReload = ["", ...expandedDirsRef.current];
		setChildrenByDir(new Map());
		setErrorByDir(new Map());
		for (const dir of dirsToReload) {
			void loadDir(dir);
		}
	}, [loadDir, workspaceId, refreshToken]);

	const toggleDir = useCallback(
		(path: string) => {
			setExpandedDirs((prev) => {
				const next = new Set(prev);
				if (next.has(path)) {
					next.delete(path);
				} else {
					next.add(path);
					if (!childrenByDirRef.current.has(path)) {
						void loadDir(path);
					}
				}
				return next;
			});
		},
		[loadDir],
	);

	const expandDir = useCallback(
		(path: string) => {
			setExpandedDirs((prev) => {
				if (prev.has(path)) {
					return prev;
				}
				return new Set(prev).add(path);
			});
			if (!childrenByDirRef.current.has(path)) {
				void loadDir(path);
			}
		},
		[loadDir],
	);

	// Incrementally refresh one directory in place (after a create/rename/move/
	// delete). Only re-fetches a directory whose children were already loaded —
	// an unloaded dir has nothing to reconcile and will load lazily on expand.
	const reloadDir = useCallback(
		(path: string) => {
			if (childrenByDirRef.current.has(path)) {
				void loadDir(path);
			}
		},
		[loadDir],
	);

	const reload = useCallback(() => {
		setRefreshToken((token) => token + 1);
	}, []);

	return {
		childrenByDir,
		expandedDirs,
		loadingDirs,
		errorByDir,
		isGitRepository,
		toggleDir,
		expandDir,
		reloadDir,
		reload,
	};
}
