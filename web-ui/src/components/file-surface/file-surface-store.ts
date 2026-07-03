import {
	buildFilesLibraryUrl,
	buildFileUrl,
	buildFsPathUrl,
	parseFileIdFromSearch,
	parseFilesLibraryFromSearch,
	parseFsPathFromSearch,
} from "@/hooks/app-utils";

/**
 * The File surface's open state, held in a module-level external store rather
 * than React state.
 *
 * Why a store (not provider `useState`): the perf thesis (file-surface-design
 * §5.4) is that opening a file must NEVER re-render the board. The board is the
 * provider's `children` (stable element reference), so the provider re-rendering
 * on open is already safe. But the top-bar's "active" ring also needs to reflect
 * open-state WITHOUT threading a boolean down from `App` (which would re-render
 * the whole tree). The project's established answer is a granular external store
 * read via `useSyncExternalStore` in the leaf fiber that shows it (see
 * `perf10-runtime-store-selectors`): the provider subscribes to render the
 * single-doc overlay, `TopBar` subscribes — independently — for the ring, and
 * `App` subscribes to just the `library` slice (below) to place the docked
 * filesystem panel. None re-render on the *other* axes' changes.
 *
 * The store also owns `?file=<id>` URL routing (mirroring the `?task=`/`?chat=`
 * hooks) so the surface is shareable, refresh-survivable, and back/forward
 * navigable — persistence the older Vault/Database toggles lack.
 */
export interface FileSurfaceState {
	/** The vault document id currently open in the editor overlay, or null. */
	fileId: string | null;
	/** Workspace the open file lives in. Resolved at open time. */
	workspaceId: string | null;
	/** Whether the quick-open palette ("pick a file") is showing. Not URL-routed. */
	paletteOpen: boolean;
	/**
	 * Whether the filesystem panel is showing. URL-routed via `?files` so it
	 * survives refresh. Independent of `fileId` — the single-doc overlay can layer
	 * above the panel. In board mode the panel is docked (see `FileDockPanel`).
	 */
	libraryOpen: boolean;
	/**
	 * The filesystem explorer's currently-open repo-relative path (deep link via
	 * `?fsPath`). File → opened in the right pane; directory → revealed/expanded.
	 */
	fsPath: string | null;
}

export interface OpenFileOptions {
	/** Workspace the file lives in. Defaults to the provider's current workspace. */
	workspaceId?: string;
}

/**
 * The slice `App` subscribes to for placing the docked filesystem panel. Kept as
 * a stable reference (recomputed only when its fields change) so that opening a
 * single-doc file / palette — the high-frequency axes — never re-renders `App`
 * or the board.
 */
export interface FileLibrarySlice {
	libraryOpen: boolean;
	fsPath: string | null;
}

function readFileIdFromLocation(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	return parseFileIdFromSearch(window.location.search);
}

function readLibraryFromLocation(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return parseFilesLibraryFromSearch(window.location.search);
}

function readFsPathFromLocation(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	return parseFsPathFromSearch(window.location.search);
}

// Seed synchronously from the URL so a deep link / refresh to `?file=<id>` or
// `?files` opens the corresponding surface on first paint with no flash.
// `workspaceId` is back-filled by the provider (the workspace isn't encoded in
// the URL — it comes from the route).
let state: FileSurfaceState = {
	fileId: readFileIdFromLocation(),
	workspaceId: null,
	paletteOpen: false,
	libraryOpen: readLibraryFromLocation(),
	fsPath: readFsPathFromLocation(),
};

let librarySlice: FileLibrarySlice = { libraryOpen: state.libraryOpen, fsPath: state.fsPath };

function refreshLibrarySlice(): void {
	if (librarySlice.libraryOpen !== state.libraryOpen || librarySlice.fsPath !== state.fsPath) {
		librarySlice = { libraryOpen: state.libraryOpen, fsPath: state.fsPath };
	}
}

// The provider's current workspace, used as the default when a file is opened
// without an explicit workspace and to back-fill a URL-seeded / popstate file.
let defaultWorkspaceId: string | null = null;

const listeners = new Set<() => void>();
let popstateBound = false;

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

function setState(next: FileSurfaceState): void {
	if (
		next.fileId === state.fileId &&
		next.workspaceId === state.workspaceId &&
		next.paletteOpen === state.paletteOpen &&
		next.libraryOpen === state.libraryOpen &&
		next.fsPath === state.fsPath
	) {
		return;
	}
	state = next;
	refreshLibrarySlice();
	emit();
}

function writeUrl(fileId: string | null, mode: "push" | "replace"): void {
	if (typeof window === "undefined") {
		return;
	}
	const currentUrl = new URL(window.location.href);
	if (parseFileIdFromSearch(currentUrl.search) === fileId) {
		// Already at the target — never add a duplicate history entry.
		return;
	}
	const nextUrl = buildFileUrl({
		pathname: currentUrl.pathname,
		search: currentUrl.search,
		hash: currentUrl.hash,
		fileId,
	});
	if (mode === "push") {
		window.history.pushState(window.history.state, "", nextUrl);
	} else {
		window.history.replaceState(window.history.state, "", nextUrl);
	}
}

function writeLibraryUrl(open: boolean, mode: "push" | "replace"): void {
	if (typeof window === "undefined") {
		return;
	}
	const currentUrl = new URL(window.location.href);
	if (parseFilesLibraryFromSearch(currentUrl.search) === open) {
		// Already at the target — never add a duplicate history entry.
		return;
	}
	const nextUrl = buildFilesLibraryUrl({
		pathname: currentUrl.pathname,
		search: currentUrl.search,
		hash: currentUrl.hash,
		open,
	});
	if (mode === "push") {
		window.history.pushState(window.history.state, "", nextUrl);
	} else {
		window.history.replaceState(window.history.state, "", nextUrl);
	}
}

function writeFsPathUrl(fsPath: string | null, mode: "push" | "replace"): void {
	if (typeof window === "undefined") {
		return;
	}
	const currentUrl = new URL(window.location.href);
	if (parseFsPathFromSearch(currentUrl.search) === fsPath) {
		return;
	}
	const nextUrl = buildFsPathUrl({
		pathname: currentUrl.pathname,
		search: currentUrl.search,
		hash: currentUrl.hash,
		fsPath,
	});
	if (mode === "push") {
		window.history.pushState(window.history.state, "", nextUrl);
	} else {
		window.history.replaceState(window.history.state, "", nextUrl);
	}
}

function handlePopState(): void {
	const fileId = readFileIdFromLocation();
	const libraryOpen = readLibraryFromLocation();
	setState({
		fileId,
		workspaceId: fileId || libraryOpen ? (state.workspaceId ?? defaultWorkspaceId) : null,
		paletteOpen: false,
		libraryOpen,
		fsPath: readFsPathFromLocation(),
	});
}

export const fileSurfaceStore = {
	getSnapshot(): FileSurfaceState {
		return state;
	},

	/** Stable-reference `library` slice for the docked panel (see `FileLibrarySlice`). */
	getLibrarySlice(): FileLibrarySlice {
		return librarySlice;
	},

	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		if (!popstateBound && typeof window !== "undefined") {
			window.addEventListener("popstate", handlePopState);
			popstateBound = true;
		}
		return () => {
			listeners.delete(listener);
		};
	},

	/**
	 * Register the active workspace (the open project). Back-fills the workspace
	 * for a file that was seeded from the URL before the provider mounted.
	 */
	setDefaultWorkspace(workspaceId: string | null): void {
		defaultWorkspaceId = workspaceId;
		if ((state.fileId || state.libraryOpen) && !state.workspaceId && workspaceId) {
			setState({ ...state, workspaceId });
		}
	},

	openFile(fileId: string, options?: OpenFileOptions): void {
		writeUrl(fileId, "push");
		setState({
			...state,
			fileId,
			workspaceId: options?.workspaceId ?? state.workspaceId ?? defaultWorkspaceId,
			paletteOpen: false,
		});
	},

	closeFile(): void {
		writeUrl(null, "push");
		setState({ ...state, fileId: null, paletteOpen: false });
	},

	openPalette(): void {
		setState({ ...state, paletteOpen: true });
	},

	closePalette(): void {
		if (!state.paletteOpen) {
			return;
		}
		setState({ ...state, paletteOpen: false });
	},

	/** Open the docked filesystem panel. */
	openLibrary(): void {
		writeLibraryUrl(true, "push");
		setState({
			...state,
			workspaceId: state.workspaceId ?? defaultWorkspaceId,
			libraryOpen: true,
			paletteOpen: false,
		});
	},

	closeLibrary(): void {
		if (!state.libraryOpen) {
			return;
		}
		writeLibraryUrl(false, "push");
		setState({ ...state, libraryOpen: false });
	},

	/**
	 * Open (deep-link) a repo-relative path in the filesystem explorer. Pushes a
	 * history entry so back/forward navigates opened files. `null` clears the
	 * selection (e.g. the open file was deleted).
	 */
	openFsPath(path: string | null): void {
		writeFsPathUrl(path, "push");
		setState({ ...state, libraryOpen: true, fsPath: path });
	},
};

/**
 * True when any File surface UI is showing (single-doc editor overlay, the
 * filesystem panel, or the quick-open palette). Drives the top-bar ring.
 */
export function isFileSurfaceActive(snapshot: FileSurfaceState): boolean {
	return snapshot.fileId !== null || snapshot.paletteOpen || snapshot.libraryOpen;
}
