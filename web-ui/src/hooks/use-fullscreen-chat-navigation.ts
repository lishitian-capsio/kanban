// URL-routed state for the home-chat fullscreen workspace.
//
// Whether the fullscreen workspace is open — and which tab is active inside it —
// lives entirely in the URL (`?chat=<tab>`), not in component/localStorage state.
// The value is the active tab: the reserved "home" (launcher) anchor, or a non-pi
// session thread id. Its mere presence means fullscreen. (Pi sessions are not tabs —
// they live in the Pi rail, tracked by `homeThreads.activePiSessionId`, not the URL.)
//
// Keeping this in the URL makes the fullscreen view refreshable, deep-linkable, and
// navigable with the browser back/forward buttons — and it root-causes the
// "open a task from fullscreen, go back, lose fullscreen" bug: returning restores the
// prior URL (fullscreen + tab) instead of relying on easily-lost in-memory state.
//
// Mirrors the project / detail-task URL hooks (hand-rolled History API, no router):
// the state seeds synchronously from the URL on first render (no first-paint flash)
// and a popstate listener re-reads it on back/forward. `navigate*` pushes a history
// entry (user navigation: enter / switch tab / exit), `replace*` rewrites in place
// (corrections such as a deep link to a now-closed thread).
import { useCallback, useState } from "react";

import { buildFullscreenChatUrl, parseFullscreenChatTabFromSearch } from "@/hooks/app-utils";
import { useWindowEvent } from "@/utils/react-use";

export interface UseFullscreenChatNavigationResult {
	/** The active fullscreen tab ("home" | a non-pi session thread id), or null when not fullscreen. */
	fullscreenChatTab: string | null;
	/** Convenience flag: the fullscreen workspace is open. */
	isFullscreen: boolean;
	/** Navigate to a tab (or exit with null), pushing a history entry so back/forward works. */
	navigateFullscreenTab: (tab: string | null) => void;
	/** Set the tab in place (no new history entry) — for corrections, not user navigation. */
	replaceFullscreenTab: (tab: string | null) => void;
}

function readTabFromLocation(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	return parseFullscreenChatTabFromSearch(window.location.search);
}

export function useFullscreenChatNavigation(): UseFullscreenChatNavigationResult {
	const [fullscreenChatTab, setFullscreenChatTab] = useState<string | null>(readTabFromLocation);

	const writeTab = useCallback((tab: string | null, mode: "push" | "replace") => {
		if (typeof window === "undefined") {
			return;
		}
		const currentUrl = new URL(window.location.href);
		const currentTabInUrl = parseFullscreenChatTabFromSearch(currentUrl.search);
		setFullscreenChatTab(tab);
		if (currentTabInUrl === tab) {
			// Already at the target tab — keep state authoritative but never add a
			// duplicate history entry (e.g. re-clicking the active tab).
			return;
		}
		const nextUrl = buildFullscreenChatUrl({
			pathname: currentUrl.pathname,
			search: currentUrl.search,
			hash: currentUrl.hash,
			chatTab: tab,
		});
		if (mode === "push") {
			window.history.pushState(window.history.state, "", nextUrl);
		} else {
			window.history.replaceState(window.history.state, "", nextUrl);
		}
	}, []);

	const navigateFullscreenTab = useCallback((tab: string | null) => writeTab(tab, "push"), [writeTab]);
	const replaceFullscreenTab = useCallback((tab: string | null) => writeTab(tab, "replace"), [writeTab]);

	const handlePopState = useCallback(() => {
		setFullscreenChatTab(readTabFromLocation());
	}, []);
	useWindowEvent("popstate", handlePopState);

	return {
		fullscreenChatTab,
		isFullscreen: fullscreenChatTab !== null,
		navigateFullscreenTab,
		replaceFullscreenTab,
	};
}
