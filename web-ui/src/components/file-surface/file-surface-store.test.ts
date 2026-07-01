import { beforeEach, describe, expect, it, vi } from "vitest";

// The store is a module singleton with URL side effects; reset the module and
// the location between cases so transitions are tested in isolation.
type StoreModule = typeof import("./file-surface-store");

let mod: StoreModule;

beforeEach(async () => {
	vi.resetModules();
	window.history.replaceState(null, "", "/project-1");
	mod = await import("./file-surface-store");
});

describe("fileSurfaceStore", () => {
	it("seeds the open file from ?file= on load", async () => {
		vi.resetModules();
		window.history.replaceState(null, "", "/project-1?file=seeded-id");
		const seeded = await import("./file-surface-store");
		expect(seeded.fileSurfaceStore.getSnapshot().fileId).toBe("seeded-id");
		expect(seeded.fileSurfaceStore.getSnapshot().workspaceId).toBeNull();
	});

	it("openFile sets the file + workspace and writes ?file=", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openFile("doc-9");
		const snapshot = mod.fileSurfaceStore.getSnapshot();
		expect(snapshot.fileId).toBe("doc-9");
		expect(snapshot.workspaceId).toBe("ws-1");
		expect(snapshot.paletteOpen).toBe(false);
		expect(window.location.search).toBe("?file=doc-9");
		expect(mod.isFileSurfaceActive(snapshot)).toBe(true);
	});

	it("openFile honors an explicit workspace override", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openFile("doc-9", { workspaceId: "ws-other" });
		expect(mod.fileSurfaceStore.getSnapshot().workspaceId).toBe("ws-other");
	});

	it("closeFile clears the file and the ?file= param", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openFile("doc-9");
		mod.fileSurfaceStore.closeFile();
		expect(mod.fileSurfaceStore.getSnapshot().fileId).toBeNull();
		expect(window.location.search).toBe("");
	});

	it("setDefaultWorkspace back-fills a URL-seeded file's workspace", async () => {
		vi.resetModules();
		window.history.replaceState(null, "", "/project-1?file=seeded-id");
		const seeded = await import("./file-surface-store");
		expect(seeded.fileSurfaceStore.getSnapshot().workspaceId).toBeNull();
		seeded.fileSurfaceStore.setDefaultWorkspace("ws-7");
		expect(seeded.fileSurfaceStore.getSnapshot().workspaceId).toBe("ws-7");
	});

	it("seeds the library overlay from ?files on load", async () => {
		vi.resetModules();
		window.history.replaceState(null, "", "/project-1?files");
		const seeded = await import("./file-surface-store");
		expect(seeded.fileSurfaceStore.getSnapshot().libraryOpen).toBe(true);
		expect(seeded.isFileSurfaceActive(seeded.fileSurfaceStore.getSnapshot())).toBe(true);
	});

	it("openLibrary sets the flag, workspace, and writes ?files", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openLibrary();
		const snapshot = mod.fileSurfaceStore.getSnapshot();
		expect(snapshot.libraryOpen).toBe(true);
		expect(snapshot.workspaceId).toBe("ws-1");
		expect(mod.isFileSurfaceActive(snapshot)).toBe(true);
		expect(window.location.search).toContain("files");
	});

	it("closeLibrary clears the flag and the ?files param", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openLibrary();
		mod.fileSurfaceStore.closeLibrary();
		expect(mod.fileSurfaceStore.getSnapshot().libraryOpen).toBe(false);
		expect(window.location.search).toBe("");
	});

	it("opening a file leaves the library overlay mounted underneath", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openLibrary();
		mod.fileSurfaceStore.openFile("doc-1");
		const snapshot = mod.fileSurfaceStore.getSnapshot();
		expect(snapshot.libraryOpen).toBe(true);
		expect(snapshot.fileId).toBe("doc-1");
	});

	it("the quick-open palette is reachable while the library is open", () => {
		mod.fileSurfaceStore.openLibrary();
		mod.fileSurfaceStore.openPalette();
		const snapshot = mod.fileSurfaceStore.getSnapshot();
		expect(snapshot.libraryOpen).toBe(true);
		expect(snapshot.paletteOpen).toBe(true);
	});

	it("re-reads ?files on popstate (browser back/forward)", () => {
		mod.fileSurfaceStore.subscribe(() => {});
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openLibrary();
		window.history.replaceState(null, "", "/project-1");
		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(mod.fileSurfaceStore.getSnapshot().libraryOpen).toBe(false);
	});

	it("palette open/close drives active state without a file", () => {
		mod.fileSurfaceStore.openPalette();
		expect(mod.fileSurfaceStore.getSnapshot().paletteOpen).toBe(true);
		expect(mod.isFileSurfaceActive(mod.fileSurfaceStore.getSnapshot())).toBe(true);
		expect(window.location.search).toBe("");
		mod.fileSurfaceStore.closePalette();
		expect(mod.isFileSurfaceActive(mod.fileSurfaceStore.getSnapshot())).toBe(false);
	});

	it("openFile closes an open palette", () => {
		mod.fileSurfaceStore.openPalette();
		mod.fileSurfaceStore.openFile("doc-1");
		expect(mod.fileSurfaceStore.getSnapshot().paletteOpen).toBe(false);
	});

	it("notifies subscribers on change and stops after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = mod.fileSurfaceStore.subscribe(listener);
		mod.fileSurfaceStore.openFile("doc-1");
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		mod.fileSurfaceStore.closeFile();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("re-reads ?file= on popstate (browser back/forward)", () => {
		mod.fileSurfaceStore.subscribe(() => {});
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openFile("doc-1");
		window.history.replaceState(null, "", "/project-1");
		window.dispatchEvent(new PopStateEvent("popstate"));
		expect(mod.fileSurfaceStore.getSnapshot().fileId).toBeNull();
	});

	it("defaults the sub-tab to fs for a legacy valueless ?files link", async () => {
		vi.resetModules();
		window.history.replaceState(null, "", "/project-1?files");
		const seeded = await import("./file-surface-store");
		expect(seeded.fileSurfaceStore.getSnapshot().filesTab).toBe("fs");
	});

	it("seeds the uploads sub-tab from ?files=uploads", async () => {
		vi.resetModules();
		window.history.replaceState(null, "", "/project-1?files=uploads");
		const seeded = await import("./file-surface-store");
		expect(seeded.fileSurfaceStore.getSnapshot().libraryOpen).toBe(true);
		expect(seeded.fileSurfaceStore.getSnapshot().filesTab).toBe("uploads");
	});

	it("setFilesTab switches to uploads and writes ?files=uploads (replace)", () => {
		mod.fileSurfaceStore.openLibrary();
		mod.fileSurfaceStore.setFilesTab("uploads");
		expect(mod.fileSurfaceStore.getSnapshot().filesTab).toBe("uploads");
		expect(window.location.search).toBe("?files=uploads");
	});

	it("openFsPath deep-links a path, forces the fs tab, and writes ?fsPath", () => {
		mod.fileSurfaceStore.setDefaultWorkspace("ws-1");
		mod.fileSurfaceStore.openFsPath("src/index.ts");
		const snapshot = mod.fileSurfaceStore.getSnapshot();
		expect(snapshot.libraryOpen).toBe(true);
		expect(snapshot.filesTab).toBe("fs");
		expect(snapshot.fsPath).toBe("src/index.ts");
		expect(window.location.search).toContain("fsPath=src%2Findex.ts");
	});

	it("seeds ?fsPath on load and clears it when the overlay closes", async () => {
		vi.resetModules();
		window.history.replaceState(null, "", "/project-1?files=fs&fsPath=app.ts");
		const seeded = await import("./file-surface-store");
		expect(seeded.fileSurfaceStore.getSnapshot().fsPath).toBe("app.ts");
		seeded.fileSurfaceStore.closeLibrary();
		expect(window.location.search).toBe("");
	});
});
