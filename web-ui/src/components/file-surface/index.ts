// The File surface: a first-class, URL-routed (`?file=`) overlay for opening,
// viewing, and editing a single vault markdown document — peer to Vault and
// Database in entry and identity, but a lightweight portaled overlay rather than
// a board-replacing full-page view (file-surface-design §2). Public API:
// NOTE: `FileDockPanel` is intentionally NOT re-exported here — `App` lazy-imports
// it directly so its `@uiw/react-md-editor` / CodeMirror chunk stays out of the
// entry bundle. This index is imported eagerly (for the provider), so re-exporting
// the panel would pull that heavy chunk into first paint.
export { FileSurfaceProvider } from "./file-surface-provider";
export { fileSurfaceStore } from "./file-surface-store";
export { useFileDock } from "./use-file-dock";
export { type OpenFile, useFileSurfaceActive, useFileSurfaceLibrary, useOpenFile } from "./use-open-file";
