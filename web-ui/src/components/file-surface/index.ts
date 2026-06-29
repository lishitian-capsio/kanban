// The File surface: a first-class, URL-routed (`?file=`) overlay for opening,
// viewing, and editing a single vault markdown document — peer to Vault and
// Database in entry and identity, but a lightweight portaled overlay rather than
// a board-replacing full-page view (file-surface-design §2). Public API:
export { FileSurfaceProvider } from "./file-surface-provider";
export { fileSurfaceStore } from "./file-surface-store";
export { type OpenFile, useFileSurfaceActive, useOpenFile } from "./use-open-file";
