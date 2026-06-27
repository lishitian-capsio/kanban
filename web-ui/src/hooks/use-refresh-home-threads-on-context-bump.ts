// Re-fetch the home thread registry whenever the kanban session-context version bumps.
//
// A thread self-titles (via `home-thread set-title`) and proposes next steps server-side,
// each of which bumps the session-context version — the existing broadcast, no new wire
// message. Both home surfaces (the compact sidebar panel and the fullscreen workspace) need
// to pick those changes up, so this shared hook lives in each. The version is subscribed in
// the calling leaf component's fiber (per the granular-store rule), keeping the refetch out
// of App's render path. The initial render is skipped so the registry's own first load is
// not duplicated.
import { useEffect, useRef } from "react";

import { useRuntimeKanbanSessionContextVersion } from "@/runtime/runtime-stream-store";

export function useRefreshHomeThreadsOnSessionContextBump(refresh: () => Promise<void> | void): void {
	const kanbanSessionContextVersion = useRuntimeKanbanSessionContextVersion();
	const previousVersionRef = useRef(kanbanSessionContextVersion);
	useEffect(() => {
		if (previousVersionRef.current === kanbanSessionContextVersion) {
			return;
		}
		previousVersionRef.current = kanbanSessionContextVersion;
		void refresh();
	}, [kanbanSessionContextVersion, refresh]);
}
