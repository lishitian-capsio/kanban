// The fullscreen presentation of the home agent chat.
//
// When the dockable panel is in its `fullscreen` state, the layout selector
// (`selectHomeChatLayout`) mounts this workspace instead of the compact
// thread-bar surface. It is the home of the planned Home-tab launcher (a grid of
// session cards) and the coexisting session-tab strip — both drawn from the same
// per-workspace thread registry as the compact surface, so the data model is
// untouched (see the "drive the home agent chat layout by panel size" decision).
//
// This is the skeleton: the container exists and is wired through the panel's
// fullscreen shell so entering/exiting fullscreen is fully functional, but the
// Home tab + session tabs are filled in by follow-up tasks. The placeholder
// stays a real, sized container (not a thin wrapper) so those tasks drop content
// straight in.
import { LayoutGrid } from "lucide-react";
import type { ReactElement } from "react";

export function HomeChatWorkspace(): ReactElement {
	return (
		<div className="flex h-full min-h-0 w-full flex-col items-center justify-center rounded-md border border-dashed border-border bg-surface-2 p-8 text-center">
			<LayoutGrid size={28} className="mb-3 text-text-tertiary" aria-hidden="true" />
			<p className="text-sm font-medium text-text-primary">Fullscreen workspace</p>
			<p className="mt-1 max-w-md text-xs text-text-secondary">
				The Home tab launcher and coexisting session tabs land here. Use the dock controls above to return to the
				compact panel.
			</p>
		</div>
	);
}
