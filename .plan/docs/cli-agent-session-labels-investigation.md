# CLI Agent Session Labels & Visibility Investigation

Status: read-only investigation (no code changed). Date: 2026-06-22.

## Goal

Let a user tell at a glance **what each CLI agent session is doing** — both the
sessions **running right now** and the ones that **already ran** (history). Today
CLI agent sessions (`claude` / `codex` / `droid` / `kiro` / `gemini` / `opencode`)
have no identifiable label/name, so it is hard to see which session maps to which
task or what it is working on. "Custom name at creation time" is one candidate;
"auto-derive a label from the task prompt" is another — both are evaluated here.

## TL;DR

The key finding is an **asymmetry**: the home (sidebar) chat threads already
solved naming well — `RuntimeHomeChatThread` has a `name` field and a full rename
path (backend + frontend). **Board-task CLI agent sessions did not** — they reuse
the task's `title`, but that title never reaches the running terminal view or any
history listing. The session summary (`sessions.json`) carries **only `taskId`,
no human-readable label at all**, which is the single root cause behind "can't
recognize it" on both the running side and the history side.

---

## 1. Naming / identity mechanism today

### Board-task session
- The session **key is the `taskId` (UUID) itself**; there is no separate "session
  name" concept. `src/terminal/session-manager.ts:431`
  (`summary = createDefaultSummary(taskId)`).
- `RuntimeTaskSessionSummary` (`src/core/api-contract.ts:965-989`) carries
  `taskId / state / agentId / agentSessionId / pid / startedAt / …` —
  **no `title` / `label` / `name`**.
- The human-readable name lives only on the **task card** as `task.title`
  (`src/core/task-title.ts`):
  - User-typed `title`, else `deriveTaskTitleFromPrompt()` takes the prompt's first
    sentence, truncated to 80 chars (`resolveTaskTitle`, `task-title.ts:44-54`).
- `agentSessionId` (claude only) is an auto-generated UUID
  (`src/terminal/agent-session-adapters.ts:555-569`), used for `--session-id` /
  `--resume`. **Not editable, not user-facing.**
- **Conclusion: board sessions have no user-facing naming entry point.** The name
  is a task-level attribute and never enters the session summary.

### Home-thread session (the reference — already done)
- `RuntimeHomeChatThread` (`api-contract.ts:266-273`) has an explicit
  `name: string` field.
- Full rename path: `home-thread-registry.ts:42-55` (pure) →
  `home-thread-store.ts:77-86` → tRPC `renameHomeThread`
  (`runtime-api.ts:647-656`) → FE `use-home-threads.ts:200-225` →
  `home-thread-rename-dialog.tsx`.
- Session id is the 4-segment `__home_agent__:<ws>:<agentId>:<threadId>`
  (`home-agent-session.ts:27-37`); the default thread omits segment 4 for
  backward-compat.

> Naming-path difference: home thread = user **actively names + can rename**;
> board session = relies on `task.title` (derivable/editable), but **that name
> never gets injected into the session summary and there is no "rename session"
> concept**.

---

## 2. Running-session visibility today

| Surface | What it shows | Can you tell which task at a glance? |
|---|---|---|
| **Board Card** (`web-ui/.../board-card.tsx`) | Task Title + Task ID chip + dynamic session activity (`"Thinking..."` / `"Waiting for review"` / tool name — `getCardSessionActivity` 158-225) | ✅ Clearest; distinguished by title |
| **Terminal panel subtitle** (`App.tsx:686-695` + `agent-terminal-panel.tsx`) | Fixed title `"Terminal"` + subtitle = **worktree path (may be null)** + state badge (Running / Ready for review / …) | ⚠️ Unidentifiable when path is null; shows a path, not the task name |
| **Home Thread Bar** (`home-thread-bar.tsx`) | `thread.name` + agent badge | ❌ Shows only thread name + agent; **no running task / no session state** |
| **CLI `task list`** (`src/commands/task.ts:287-319`) | JSON: `state / agentId / pid / startedAt / lastOutputAt / prompt` | ✅ Machine-friendly, complete |

**Core gap:** there is no "cross-session overview: what is each running CLI agent
doing." Board card is per-task; the terminal panel shows a path instead of a task
name; the home thread bar shows a name but no activity.

---

## 3. Historical visibility today

Storage is three layers:

| Layer | Path | Key | Human-readable label? |
|---|---|---|---|
| Session summary | `<repo>/.kanban/workspaces/<id>/sessions.json` | `Record<taskId, Summary>` | ❌ taskId only |
| Message transcript | `<repo>/.kanban/workspaces/<id>/sessions/<taskId>/messages.jsonl` | append-only JSONL | ❌ message content only |
| Claude native transcript | `~/.claude/projects/<cwd>/<uuid>/…` | sessionId (UUID) | ❌ UUID |

**Frontend read-back entry point:** exactly one — open the **task card detail →
chat tab**, via tRPC `getTaskChatMessages(taskId)` (`runtime-api.ts:457-493`, pi
first, fallback to terminal manager), rendered by `KanbanAgentChatPanel`.

**Gaps:**
1. **No standalone "session history browser"** — history is reachable only through
   the matching task card.
2. Even to list history, the summary holds only `taskId`, so **no human-readable
   label can be shown** (would require joining the board task shard for the title).
3. `getTaskChatMessages` return body carries **no `taskTitle` / context**, so the
   UI has nothing to annotate with.

---

## 4. Gap summary

1. **The label doesn't travel with the session.** `RuntimeTaskSessionSummary`
   lacks a human-readable field → any surface that only has a summary (terminal
   panel, a future history list) can't recognize it and degrades to worktree path
   or taskId.
2. **No running overview.** No aggregated "all running CLI sessions + what each is
   doing" surface.
3. **History lacks both an entry point and a label.** Reachable only per-card, and
   unlabeled when listed.
4. Home threads already have a full `name` + rename; board sessions don't — **the
   existing implementation pattern can be borrowed directly.**

---

## 5. Candidate options

| Option | Approach | Pros | Cons | Effort |
|---|---|---|---|---|
| **A. Auto-derive label** | Reuse `task.title` (already has `deriveTaskTitleFromPrompt`); join it into the session summary / `getTaskChatMessages` response at read time; show title instead of path/taskId everywhere | Zero new user input; instant win for board sessions; can be pure read-time join (no data-model change) | Name can't diverge from the task; home thread keeps its own `name` (unaffected) | Small |
| **B. Custom session name** | Add an editable `label`/`name` to the session summary + a rename endpoint (mirror the home-thread stack) | Consistent with home threads; full user control | Needs a new write path + persistence + UI; semantic overlap between a session `label` and `task.title` | Medium |
| **C. Both (recommended)** | Auto-derive by default (= A), allow override/rename (= B's rename UI). Exactly mirrors the home thread "default name → renamable" model | Best UX; consistent mental model with home threads; "recognizable out of the box" *and* "correctable" | Largest effort | Medium-large |

**Recommendation:** ship in two steps — **A first** (low cost, immediately kills
"can't recognize it"), then layer B's rename on top to reach **C** as desired.
Rationale: A is almost a pure read-time join that lets the running terminal panel
and a future history list show the task name; C's rename can lift the existing
home-thread code wholesale.

---

## 6. Change checklist (not executed in this investigation)

**Contract layer**
- `src/core/api-contract.ts` — add optional `title`/`label` to
  `runtimeTaskSessionSummarySchema` (or to the `getTaskChatMessages` response).
  Option A can add only the response field without touching summary persistence.

**Read-time join (Option A core)**
- `src/trpc/runtime-api.ts:457-493` (`getTaskChatMessages`) — fetch `task.title`
  from the board task shard and return it alongside.
- If the broadcast summary should carry the title, join the task shard on that path
  too.

**Running views**
- `web-ui/.../App.tsx:686-695` + `agent-terminal-panel.tsx` — terminal subtitle
  shows the **task title** (worktree path demoted to secondary / tooltip).
- (Optional) a "running sessions overview" component, or add an activity / current-
  task indicator to the home thread bar (`home-thread-bar.tsx`).

**History view**
- New "session history list" tRPC endpoint (list sessions + joined title) + a
  frontend list component (no standalone entry exists today). **This is the largest
  history gap and the bulk of the work.**

**Custom naming (Option B/C)**
- Reuse the home-thread pattern as the template: `home-thread-registry.ts` /
  `home-thread-store.ts` / `renameHomeThread` tRPC / `home-thread-rename-dialog.tsx`
  — add a `label` + rename for board sessions.

---

## Appendix: key references

- Session summary schema: `src/core/api-contract.ts:965-989`
- Board session key = taskId: `src/terminal/session-manager.ts:431`
- Task title derivation: `src/core/task-title.ts:24-54`
- Claude agentSessionId (UUID, resume): `src/terminal/agent-session-adapters.ts:528-569`
- Home session id (4-segment): `src/core/home-agent-session.ts:19-37`
- Home thread schema + rename: `src/core/api-contract.ts:266-298`,
  `src/session/home-thread-registry.ts:42-55`, `src/session/home-thread-store.ts:77-86`,
  `src/trpc/runtime-api.ts:647-656`
- Board card activity: `web-ui/src/components/board-card.tsx:158-225`
- Terminal subtitle: `web-ui/src/App.tsx:686-695`,
  `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`
- Home thread bar: `web-ui/src/components/home-agent/home-thread-bar.tsx`
- CLI task list: `src/commands/task.ts:287-319`
- History read path: `src/trpc/runtime-api.ts:457-493`,
  `web-ui/src/hooks/use-kanban-chat-session.ts`,
  `web-ui/src/components/detail-panels/kanban-agent-chat-panel.tsx`
- Transcript journal: `src/session/session-message-journal.ts`
- Storage paths: `src/state/workspace-state.ts:365-376`
