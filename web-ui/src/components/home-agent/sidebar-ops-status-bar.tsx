// Bottom status-bar seam for the unified Kanban-agent sidebar.
//
// SEAM FOR PART ②: this is the reserved mount point for the VSCode-style ops
// status bar (process RSS / CPU% / event-loop stall state, extensible later to
// health + board-sync). Part ② replaces the `null` below with the real bar and
// its metrics channel.
//
// It is mounted at the bottom of the sidebar's flexible container
// (`dockable-chat-panel.tsx` → `DockHeaderWithChildren`), so it travels with the
// sidebar when docked left/right or floated and is hidden when the sidebar
// collapses to its edge strip — exactly like the rest of the cockpit.
//
// Per the runtime-store leaf-subscription rule (web-ui perf model), part ② MUST
// subscribe its high-frequency metrics slice HERE, inside this leaf component,
// so streaming metric updates re-render only this bar and not the whole app.
//
// Today it renders nothing (the slot is present but empty); keeping it as a
// real, mounted component means part ② is a content change, not a wiring change.
export function SidebarOpsStatusBar(): React.ReactElement | null {
	return null;
}
