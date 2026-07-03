import { createContext, useContext, useSyncExternalStore } from "react";

import {
	type FileLibrarySlice,
	fileSurfaceStore,
	isFileSurfaceActive,
	type OpenFileOptions,
} from "./file-surface-store";

const EMPTY_LIBRARY_SLICE: FileLibrarySlice = { libraryOpen: false, fsPath: null };

/** Opens a single vault file `id` in the File surface overlay. Stable reference. */
export type OpenFile = (fileId: string, options?: OpenFileOptions) => void;

/**
 * Context value is the stable `openFile` opener bound to the provider's current
 * workspace — nothing else. Consumers that only open files never re-render when
 * the overlay opens/closes (open state lives in `fileSurfaceStore`, read via
 * `useSyncExternalStore` only where it's actually shown).
 */
export const FileSurfaceContext = createContext<OpenFile | null>(null);

/**
 * The seam every trigger uses: `const openFile = useOpenFile(); openFile(id)`.
 * Throws when no `FileSurfaceProvider` is mounted so a miswired trigger fails
 * loudly rather than silently doing nothing.
 */
export function useOpenFile(): OpenFile {
	const open = useContext(FileSurfaceContext);
	if (!open) {
		throw new Error("useOpenFile must be used within a <FileSurfaceProvider>.");
	}
	return open;
}

/**
 * Whether any File surface UI is currently showing (editor overlay or quick-open
 * palette). For the top-bar "active" ring: reading it here subscribes ONLY the
 * calling fiber (e.g. the `TopBar`), so an open/close never re-renders `App` or
 * the board (file-surface-design §5.4).
 */
export function useFileSurfaceActive(): boolean {
	return useSyncExternalStore(
		fileSurfaceStore.subscribe,
		() => isFileSurfaceActive(fileSurfaceStore.getSnapshot()),
		() => false,
	);
}

/**
 * The `library` slice (`libraryOpen` + `fsPath`) for placing the docked
 * filesystem panel. `App` subscribes here rather than to the whole snapshot so
 * the high-frequency single-doc / palette axes never re-render the board — the
 * store hands back a stable slice reference until these two fields change.
 */
export function useFileSurfaceLibrary(): FileLibrarySlice {
	return useSyncExternalStore(
		fileSurfaceStore.subscribe,
		fileSurfaceStore.getLibrarySlice,
		() => EMPTY_LIBRARY_SLICE,
	);
}
