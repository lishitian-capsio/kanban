// The File surface: a first-class, URL-routed (`?file=`) overlay for opening,
// viewing, and editing a single vault markdown document — peer to Vault and
// Database in entry and identity, but a lightweight portaled overlay rather than
// a board-replacing full-page view (file-surface-design §2). Public API:
// NOTE: `FilePopover` (the top-bar toggle + filesystem-explorer popover) is
// intentionally NOT re-exported here — `TopBar` imports it directly, and it in
// turn lazy-imports its `@uiw/react-md-editor` / CodeMirror chunk so that heavy
// code stays out of the entry bundle. This index is imported eagerly (for the
// provider), so re-exporting the popover would pull that chunk into first paint.
export { FileSurfaceProvider } from "./file-surface-provider";
export { fileSurfaceStore } from "./file-surface-store";
export { type OpenFile, useFileSurfaceActive, useFileSurfaceLibrary, useOpenFile } from "./use-open-file";
