import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	useFullscreenChatNavigation,
	type UseFullscreenChatNavigationResult,
} from "@/hooks/use-fullscreen-chat-navigation";

function HookHarness({
	onSnapshot,
}: {
	onSnapshot: (snapshot: UseFullscreenChatNavigationResult) => void;
}): null {
	const navigation = useFullscreenChatNavigation();
	useEffect(() => {
		onSnapshot(navigation);
	}, [navigation, onSnapshot]);
	return null;
}

describe("useFullscreenChatNavigation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: UseFullscreenChatNavigationResult | null = null;
	let previousActEnvironment: boolean | undefined;

	function require(): UseFullscreenChatNavigationResult {
		if (!latest) {
			throw new Error("Expected hook snapshot to be available.");
		}
		return latest;
	}

	function mount() {
		act(() => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latest = snapshot;
					}}
				/>,
			);
		});
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latest = null;
		window.history.replaceState({}, "", "/project-1");
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		window.history.replaceState({}, "", "/");
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("seeds the active tab from the URL on mount (deep link)", () => {
		window.history.replaceState({}, "", "/project-1?chat=pi");
		mount();
		expect(require().fullscreenChatTab).toBe("pi");
		expect(require().isFullscreen).toBe(true);
	});

	it("is not fullscreen when no chat param is present", () => {
		mount();
		expect(require().fullscreenChatTab).toBeNull();
		expect(require().isFullscreen).toBe(false);
	});

	it("navigateFullscreenTab enters fullscreen and writes the chat param, preserving other params", () => {
		window.history.replaceState({}, "", "/project-1?task=task-9");
		mount();
		act(() => {
			require().navigateFullscreenTab("home");
		});
		expect(require().fullscreenChatTab).toBe("home");
		expect(window.location.search).toBe("?task=task-9&chat=home");
	});

	it("navigateFullscreenTab switches between tabs", () => {
		window.history.replaceState({}, "", "/project-1?chat=home");
		mount();
		act(() => {
			require().navigateFullscreenTab("thread-abc");
		});
		expect(require().fullscreenChatTab).toBe("thread-abc");
		expect(window.location.search).toBe("?chat=thread-abc");
	});

	it("navigateFullscreenTab(null) exits fullscreen and clears the chat param", () => {
		window.history.replaceState({}, "", "/project-1?chat=pi");
		mount();
		act(() => {
			require().navigateFullscreenTab(null);
		});
		expect(require().fullscreenChatTab).toBeNull();
		expect(require().isFullscreen).toBe(false);
		expect(window.location.search).toBe("");
	});

	it("re-reads the active tab on browser back/forward (popstate)", () => {
		window.history.replaceState({}, "", "/project-1?chat=home");
		mount();
		act(() => {
			window.history.replaceState({}, "", "/project-1?chat=thread-xyz");
			window.dispatchEvent(new PopStateEvent("popstate"));
		});
		expect(require().fullscreenChatTab).toBe("thread-xyz");
		act(() => {
			window.history.replaceState({}, "", "/project-1");
			window.dispatchEvent(new PopStateEvent("popstate"));
		});
		expect(require().fullscreenChatTab).toBeNull();
	});

	it("replaceFullscreenTab updates the tab without growing history", () => {
		window.history.replaceState({}, "", "/project-1?chat=thread-gone");
		mount();
		const before = window.history.length;
		act(() => {
			require().replaceFullscreenTab("home");
		});
		expect(require().fullscreenChatTab).toBe("home");
		expect(window.location.search).toBe("?chat=home");
		expect(window.history.length).toBe(before);
	});

	it("navigateFullscreenTab is a no-op when the tab is unchanged", () => {
		window.history.replaceState({}, "", "/project-1?chat=pi");
		mount();
		const before = window.history.length;
		act(() => {
			require().navigateFullscreenTab("pi");
		});
		expect(window.history.length).toBe(before);
		expect(require().fullscreenChatTab).toBe("pi");
	});
});
