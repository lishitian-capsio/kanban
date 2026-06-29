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
});
