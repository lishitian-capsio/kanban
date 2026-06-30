# Pi Session Management Consolidation — Design

Date: 2026-06-30
Status: Approved design, pre-implementation
Area: `web-ui` (UI/state relocation only — **no backend/session-contract changes**)

## Problem

Managing **Pi sessions** (create / switch / rename / close) is today spread across three
places, and the UI differs by layout mode:

1. **Board mode** (docked/float sidebar) → `HomeSidebarAgentPanel` renders the
   `HomeThreadBar` **dropdown**, which switches/creates/renames/closes *all* home threads
   (Pi and non-Pi, including the legacy synthetic default thread).
2. **Session mode** (fullscreen) → `HomeChatWorkspace` renders a `SessionTabStrip` whose
   **`Pi` anchor tab** opens `PiTabPanel` (a `PiSessionRail` + conversation), and whose
   **per-thread session tabs** + **Home launcher cards** also create/switch/rename/close
   threads.

So a Pi session can be managed from the board dropdown, from a session tab, from a launcher
card, or from the Pi rail. The entry points are duplicated and inconsistent between modes.

All four surfaces already read/write the **same** `useHomeThreads` state, so this is purely
a UI/entry-point relocation — the session data model, the wire contract, and the agent
session lifecycle are untouched.

## Goal

Pi session management is owned by **one** surface — a Pi-area session **rail** — used
identically in board mode and session mode. It is **never a tab**: not the fullscreen `Pi`
anchor tab, and Pi sessions never each become a session tab.

## Scope & non-goals

- **In scope:** Pi sessions only — i.e. created threads with `agentId === "pi"`
  (`derivePiSessions`: non-default, pi-bound).
- **Out of scope / unchanged ("除 Pi 外其它一律不变"):** every non-Pi surface keeps working
  exactly as today:
  - The `HomeThreadBar` dropdown stays in the board-mode sidebar; it simply **filters Pi
    created-threads out** of its list (it continues to manage the legacy **default** thread
    and any **non-Pi** created threads).
  - The fullscreen `Home` launcher tab and non-Pi **session tabs** stay; Pi created-threads
    are **filtered out** of the launcher card grid and the session-tab strip.
  - `HomeAgentConversation`, the runtime store, the thread registry, and all session
    contracts are unchanged.
- **No backend or `api-contract` changes.** No new wire state.

## Design

### The single owner: a permanent, collapsible Pi session rail

A reusable component — **`PiSessionManager`** = `PiSessionRail` (left) + active Pi
conversation (`HomeAgentConversation`, right) — is the one place Pi sessions are managed.
It is a **permanent layout column**, not a tab. The rail is collapsible to a narrow
icon-only strip so it fits a narrow docked sidebar.

The rail's affordances (all already present except rename):
- **New session** ("+") → `createThread({ name: "New session", agentId: "pi" })`, then
  selects it.
- **Switch** → local active-id selection (`resolveActivePiSessionId`).
- **Close** (hard close) → `HomeThreadCloseDialog` → `closeThread`, reselect via
  `nextActivePiSessionAfterClose`.
- **Rename** (NEW on the rail) → `HomeThreadRenameDialog` → `renameThread`. Rename currently
  lives only on the dropdown rows and launcher cards; it must be added to the rail so no
  capability is lost when Pi leaves those surfaces.

Active-session selection stays **local transient state** (as in today's `PiTabPanel`); the
session list itself stays persisted via the registry. No change to `useHomeThreads`'s public
surface is required — it already exposes `createThread`/`renameThread`/`closeThread`/
`clearNextStep` and the thread list.

### Session mode (fullscreen) — `HomeChatWorkspace`

```
┌─────────┬──────────────────────────────────────┐
│ Pi rail │  [Home] [non-Pi sess…] [File]  ← tabs  │
│ +New    │ ─────────────────────────────────────│
│ Pi#a1   │                                       │
│ Pi#b2 • │   right pane:                          │
│ Pi#c3   │     · active Pi conversation, or       │
│ «collapse│     · Home launcher / non-Pi tab body  │
└─────────┴──────────────────────────────────────┘
```

- **Remove** the `Pi` anchor tab from `SessionTabStrip`.
- The **Pi rail becomes a permanent left column** of the fullscreen workspace, outside and
  to the left of the tab strip. Selecting a Pi session in the rail shows that session's
  conversation in the right pane and clears the active Home/session tab selection.
- The tab strip retains **`Home`** (launcher) + **non-Pi session tabs** + **`File`**,
  unchanged in behavior. Pi created-threads are filtered out of both the launcher card grid
  (`fullscreenThreads`) and the open-session-tab set.
- Right-pane precedence: an active Pi-rail selection wins; otherwise the active tab
  (`Home` launcher / non-Pi session conversation) renders as today.

### Board mode (docked / float sidebar) — `HomeSidebarAgentPanel`

```
┌─ Sidebar ────────────────────────┐
│ [non-Pi dropdown ▾]  (unchanged)  │  ← HomeThreadBar, Pi filtered out
│ ┌──┬────────────────────────────┐ │
│ │Pi│  active Pi conversation     │ │  ← Pi rail collapsed to icon strip;
│ │ +│                            │ │     » expands to full rail
│ │a1│                            │ │
│ │b2│                            │ │
│ └──┴────────────────────────────┘ │
└───────────────────────────────────┘
```

- Render the **same `PiSessionManager`** (rail + conversation), with the rail
  **collapsed by default** to a narrow icon strip (narrow sidebar); `»` expands it.
- **Keep** `HomeThreadBar` for the default/non-Pi threads, filtering Pi created-threads out
  of its list. (Most faithful to "除 Pi 外不变"; if the workspace has no non-Pi/default
  threads it simply shows the default entry.)

### Shared / reuse

- `PiSessionRail` already implements list + select + create + close; **add rename**.
- `PiSessionManager` is the rail+conversation composition extracted from today's
  `PiTabPanel` so board and fullscreen mount the identical component and state. `PiTabPanel`
  is effectively replaced by `PiSessionManager`.
- A **collapsed** rail variant (icon strip + expand toggle) is added for the narrow docked
  case; fullscreen mounts it expanded.
- Pure helpers `derivePiSessions` / `resolveActivePiSessionId` /
  `nextActivePiSessionAfterClose` (in `pi-sessions.ts`) are reused as-is.

## Components touched

| File | Change |
|---|---|
| `components/home-agent/pi-session-rail.tsx` | Add rename affordance + `HomeThreadRenameDialog`; add collapsed/icon-strip variant + expand toggle. |
| `components/home-agent/pi-tab-panel.tsx` | Rename/repurpose into `PiSessionManager` (rail + conversation), reusable in both modes; accept a `collapsedByDefault`/layout prop. |
| `components/home-agent/home-sidebar-agent-panel.tsx` | Mount `PiSessionManager` for Pi; keep `HomeThreadBar` but pass it a Pi-filtered thread list. |
| `components/home-agent/home-chat-workspace.tsx` | Drop the `Pi` tab branch; mount `PiSessionManager`'s rail as a permanent left column; right pane shows Pi conversation when a Pi session is selected, else Home/non-Pi tab body. |
| `components/home-agent/session-tab-strip.tsx` | Remove the `Pi` anchor tab + its `onActivatePi`/`piTabActive` props. (Pi threads are already excluded because `fullscreenThreads` will exclude them.) |
| `components/home-agent/home-thread-bar.tsx` | No structural change; receives a Pi-filtered `threads` list (filter done by the caller). |
| `components/home-agent/pi-sessions.ts` | Reused; possibly export a small `isPiSession`/filter helper so callers filter Pi out consistently. |
| `hooks/use-fullscreen-chat-navigation.ts` / URL routing | Remove the reserved `"pi"` tab value; Pi selection is rail-local, not a URL tab. |

No changes to: `home-agent-conversation.tsx`, `use-home-threads.ts` public surface,
`use-home-agent-session.ts`, runtime store, `api-contract`, any `src/` backend.

## Data flow

`useHomeThreads` → threads list. Callers split it:
- Pi sessions (`derivePiSessions`) → `PiSessionManager` rail (both modes).
- Non-Pi + default → `HomeThreadBar` (board) and `Home` launcher + session tabs
  (fullscreen).

Mutations route through the existing `createThread`/`renameThread`/`closeThread`. Active Pi
selection is local component state via `resolveActivePiSessionId`. Status dots reuse
`deriveHomeSessionCardStatus` from the streamed per-session summaries. Per the granular-store
rule, chat-token subscriptions stay inside the single mounted `HomeAgentConversation` leaf —
unchanged.

## Edge cases

- **No Pi sessions yet:** rail shows the existing empty state / "New session" CTA; right
  pane shows the Pi empty state (board) or the active non-Pi tab/launcher (fullscreen).
- **Closing the active Pi session:** `nextActivePiSessionAfterClose` clears selection; right
  pane falls back to empty state / Home tab.
- **Default thread + non-Pi threads:** never appear in the Pi rail; remain in the dropdown /
  launcher / non-Pi tabs exactly as today.
- **Deep link to old `?chat=pi`:** routing no longer recognizes `"pi"`; it falls back to the
  `Home` launcher (same fallback the workspace already uses for unknown tabs).
- **Collapsed rail in board mode:** expand state is local UI state (not persisted) unless we
  later choose to persist it; default collapsed in the narrow sidebar, expanded in
  fullscreen.

## Testing

- Reuse/extend pure unit tests for `pi-sessions.ts` (filtering, active resolution,
  next-after-close).
- Component-level: rail rename flow; collapsed↔expanded toggle; that Pi threads are absent
  from `HomeThreadBar` and the fullscreen launcher/session tabs.
- Manual self-test (acceptance): in **both** board and session modes, create / switch /
  rename / close a Pi session from the rail; confirm identical behavior and shared state
  (a session created in one mode appears in the other); confirm non-Pi/default threads are
  unchanged in the dropdown and fullscreen launcher; `web:typecheck` passes.

## Open question carried to review

- Board mode keeps the `HomeThreadBar` (Pi-filtered) per "除 Pi 外不变". If in practice there
  are never non-Pi/default threads worth a dropdown, we could instead drop it from the
  sidebar and surface non-Pi only in the fullscreen launcher. Defaulting to **keep** (least
  change); flag during spec review if you'd rather drop it.
