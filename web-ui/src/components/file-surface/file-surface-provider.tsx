import type React from "react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { fileSurfaceStore } from "./file-surface-store";
import { useFileRecents } from "./use-file-recents";
import { FileSurfaceContext, type OpenFile } from "./use-open-file";

// Code-split the overlay (and, through it, the heavy `@uiw/react-md-editor`) and
// the palette so neither is in first paint — they load on first open
// (file-surface-design §8). Importing the module is cheap; the editor chunk
// arrives only when a file is actually opened.
const FileOverlay = lazy(() => import("./file-overlay").then((m) => ({ default: m.FileOverlay })));
const FileQuickOpen = lazy(() => import("./file-quick-open").then((m) => ({ default: m.FileQuickOpen })));
const FileLibraryOverlay = lazy(() =>
	import("./file-library-overlay").then((m) => ({ default: m.FileLibraryOverlay })),
);

const subscribe = fileSurfaceStore.subscribe;
const getSnapshot = fileSurfaceStore.getSnapshot;

/**
 * Mounts the File surface (editor overlay + quick-open palette) as portaled
 * siblings of the app content and exposes the stable `openFile` opener via
 * context.
 *
 * Perf invariant (file-surface-design §2, §5.4): the board NEVER re-renders when
 * a file opens. The board is this provider's `children` (a stable element
 * reference passed straight through), so even though the provider re-renders on
 * open (it reads the open state via `useSyncExternalStore`), React keeps the
 * same `children` element and bails out of re-rendering the board subtree. The
 * context value is only the opener, so consumers that read it never re-render on
 * open/close either. The overlay is a Radix portal layered above a board that is
 * never unmounted or resized — none of the Vault/Database board-swap cost.
 */
export function FileSurfaceProvider({
	workspaceId,
	children,
}: {
	/** Default workspace for files opened without an explicit `workspaceId`. */
	workspaceId: string | null;
	children: ReactNode;
}): React.ReactElement {
	const snapshot = useSyncExternalStore(subscribe, getSnapshot);

	// Register the active workspace so files opened by id (and URL-seeded files)
	// resolve to the right workspace.
	useEffect(() => {
		fileSurfaceStore.setDefaultWorkspace(workspaceId);
	}, [workspaceId]);

	const { recents, addRecent } = useFileRecents(snapshot.workspaceId ?? workspaceId);

	// Defer mounting the overlay (and its editor chunk) until the first open, then
	// keep it mounted so closing animates and the chunk isn't re-fetched. The
	// editor body itself is gated by `fileId` inside the overlay, so its memory is
	// still released on close.
	const [overlayMounted, setOverlayMounted] = useState(false);
	useEffect(() => {
		if (snapshot.fileId !== null) {
			setOverlayMounted(true);
		}
	}, [snapshot.fileId]);

	// `openFile` is the sole context value and is referentially stable forever —
	// it delegates to the store, which resolves the default workspace itself.
	const openFile = useCallback<OpenFile>((fileId, options) => {
		fileSurfaceStore.openFile(fileId, options);
	}, []);

	const handleCloseOverlay = useCallback(() => {
		fileSurfaceStore.closeFile();
	}, []);

	const handleClosePalette = useCallback(() => {
		fileSurfaceStore.closePalette();
	}, []);

	const handleCloseLibrary = useCallback(() => {
		fileSurfaceStore.closeLibrary();
	}, []);

	const handleOpenPalette = useCallback(() => {
		fileSurfaceStore.openPalette();
	}, []);

	const handleSelectFilesTab = useCallback((tab: Parameters<typeof fileSurfaceStore.setFilesTab>[0]) => {
		fileSurfaceStore.setFilesTab(tab);
	}, []);

	const handleOpenFsPath = useCallback((path: string) => {
		fileSurfaceStore.openFsPath(path);
	}, []);

	return (
		<FileSurfaceContext.Provider value={openFile}>
			{children}
			{overlayMounted ? (
				<Suspense fallback={null}>
					<FileOverlay
						open={snapshot.fileId !== null}
						fileId={snapshot.fileId}
						workspaceId={snapshot.workspaceId}
						onClose={handleCloseOverlay}
						onFileOpened={addRecent}
					/>
				</Suspense>
			) : null}
			{snapshot.paletteOpen ? (
				<Suspense fallback={null}>
					<FileQuickOpen
						open
						workspaceId={snapshot.workspaceId ?? workspaceId}
						recents={recents}
						openFile={openFile}
						onClose={handleClosePalette}
					/>
				</Suspense>
			) : null}
			{snapshot.libraryOpen ? (
				<Suspense fallback={null}>
					<FileLibraryOverlay
						open
						workspaceId={snapshot.workspaceId ?? workspaceId}
						filesTab={snapshot.filesTab}
						fsPath={snapshot.fsPath}
						onClose={handleCloseLibrary}
						onOpenPalette={handleOpenPalette}
						onSelectTab={handleSelectFilesTab}
						onOpenFsPath={handleOpenFsPath}
					/>
				</Suspense>
			) : null}
		</FileSurfaceContext.Provider>
	);
}
