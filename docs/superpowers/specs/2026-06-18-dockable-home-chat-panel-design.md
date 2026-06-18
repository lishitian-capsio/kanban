# Dockable / floatable home chat panel

## Goal
Turn the home/sidebar chat panel into a panel whose dock location is switchable
and that can detach into a floating window. Dock state is modeled as
`dock = 'left' | 'right' | 'float'`.

## Current state
The chat is the **"Kanban Agent" tab inside the left `ProjectNavigationPanel`**
(`agentSectionContent`), shown only when `activeSection === 'agent'` and a
project is selected. The chat element is produced by `useHomeSidebarAgentPanel`
(`HomeThreadBar` + chat/terminal body). The root layout is a flex row:
`[ProjectNavigationPanel][main column (TopBar + board/vault/git + card detail)]`.

## Decisions (locked with user)
- **Independent column.** Pull the chat out of the Agent tab into its own
  column. `ProjectNavigationPanel` stays leftmost and becomes projects-only
  (Projects/Agent tab toggle removed). Chat is a first-class, always-on column
  when a project is selected.
- **Default dock = `right`.**
- **Float uses `react-rnd`** (drag + resize + min-size + bounds in one dep).

## Interaction
Three **independent** buttons at the top of the chat panel (a dock header above
`HomeThreadBar`), each a definite target state (no cycle button):
- `PanelLeft` → `dock='left'`
- `PanelRight` → `dock='right'`
- `PictureInPicture2` → `dock='float'`
The button for the current state is highlighted (active). In float, an extra
`X` close button returns to the last docked side. The dock header doubles as the
float drag handle (title region only; buttons excluded from drag).

## Layout (App.tsx root flex), via CSS `order` so left↔right does NOT remount
- `left`:  `[ProjNav][Chat][Board flex-1]` (chat `order-1`, main `order-2`)
- `right`: `[ProjNav][Board flex-1][Chat]` (chat `order-3`, main `order-2`)
- `float`: `[ProjNav][Board flex-1]` + fixed overlay (chat in `<Rnd>`)
Chat renders in one JSX slot; toggling left/right only changes the order class
(same subtree → no remount). Toggling to/from float swaps the wrapper
(div ↔ Rnd) → one remount, acceptable.

## Components / files
1. `web-ui/src/components/home-agent/chat-dock-state.ts` — pure: `ChatDockPosition`,
   `ChatDockSide`, `ChatFloatRect`, defaults/min/max, `normalizeChatDockPosition`,
   `normalizeChatDockSide`, `clampChatDockWidth`, `normalizeChatFloatRect`,
   `chatDockReducer(state, action)` where
   `state={position,lastDockedSide}` and actions `dock(side)|float|close`.
   - dock → `{position:side, lastDockedSide:side}`
   - float → `{position:'float', lastDockedSide:unchanged}`
   - close → `{position:lastDockedSide, lastDockedSide:unchanged}`
   Unit-tested (`chat-dock-state.test.ts`).
2. `web-ui/src/utils/react-use.ts` — add `useJsonLocalStorageValue<T>` wrapper
   (JSON serialize) following the existing wrappers.
3. `web-ui/src/storage/local-storage-store.ts` — add keys
   `ChatDockPosition`, `ChatDockLastSide`, `ChatDockWidth`, `ChatDockFloatRect`
   and include them in `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS`.
4. `web-ui/src/hooks/use-chat-dock.ts` — owns persisted `position`,
   `lastDockedSide`, docked `width`, `floatRect`; exposes `dockLeft/dockRight/
   floatPanel/closeFloat`, `setWidth`, `setFloatRect`. Trivial wrapper over the
   reducer semantics.
5. `web-ui/src/hooks/use-horizontal-resize.ts` — small drag-to-resize hook
   (mouse events + body cursor), parameterized by edge (`left`|`right`) so the
   docked column resizes from its inner edge; persists via `setWidth`.
6. `web-ui/src/components/home-agent/chat-dock-header.tsx` — the 3 dock buttons
   (+ close when floating); title/grip region carries the drag-handle class.
7. `web-ui/src/components/home-agent/dockable-chat-panel.tsx` — the shell.
   Docked: flex column (`surface-1`, inner border, persisted width, resize
   handle). Float: fixed full-screen `pointer-events-none` overlay (`z-40`,
   below dialogs at `z-50`) containing `<Rnd>` (`bounds="parent"`,
   `dragHandleClassName`, min size, controlled position/size persisted on stop).
   Renders `ChatDockHeader` then `children`.
8. `web-ui/src/components/home-agent/terminal-agent-hints.tsx` — `TerminalAgentHints`
   moved out of `project-navigation-panel.tsx`, rendered in the chat shell when
   the active agent is a CLI agent (non-`pi`).

## App.tsx / ProjectNavigationPanel changes
- App: add `order-2` to the main column; render
  `{!selectedCard && homeSidebarAgentPanel ? <DockableChatPanel ...>{homeSidebarAgentPanel}</DockableChatPanel> : null}`
  as a root-flex sibling; delete `homeSidebarSection` state.
- ProjectNavigationPanel: remove `activeSection`/`onActiveSectionChange`/
  `canShowAgentSection`/`agentSectionContent`/`selectedAgentId` props and the tab
  toggle + agent-section branch; always render projects + ShortcutsCard.

## Visibility
Chat shows only on the home/board view (`!selectedCard` and a project selected),
all three dock modes — same gating as today. Float hides when a card detail
opens. Mobile keeps working (docked column responsive); float is desktop-oriented.

## Constraints honored
- Reuse the existing chat element (no JSX duplication).
- Dark-theme tokens, Radix primitives, lucide icons, Tailwind classes (no `dark:`).
- All dock state + float geometry persisted to localStorage.
- `z-40` float keeps Radix dialogs/dropdowns (`z-50`, portaled) on top.

## Verification
`chat-dock-state` vitest unit tests; `npm run web:typecheck`; biome lint clean.
