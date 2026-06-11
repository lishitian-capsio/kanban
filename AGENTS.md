This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like reasoning settings, use the pi adaptation layer (`src/agent-sdk/kanban/`) or the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- The agent-agnostic session message model lives in `src/session/`, NOT in the pi adaptation layer. `SessionMessage` (`session-message.ts`) is a type alias of the websocket contract type `RuntimeTaskChatMessage` (`runtimeTaskChatMessageSchema` in `api-contract.ts`) — the wire schema is the source of truth, so the in-memory transcript and the `task_chat_message` broadcast payload can't drift. Streaming reconciliation (assistant/reasoning/tool fold-in + per-turn cursors) is in `session-message-buffer.ts` and operates on a generic `SessionMessageBuffer`; `SessionMessageSource` (`session-message-source.ts`) is the read/subscribe contract the runtime hub consumes. pi's `KanbanTaskSessionEntry` (`src/agent-sdk/kanban/session-state.ts`) just `extends SessionMessageBuffer` and adds the pi `summary`; `PiTaskSessionService extends SessionMessageSource`. This split is the shared base for future CLI/terminal transcripts, persistence, and resume — do NOT re-add the message model under `src/agent-sdk/kanban/`. The role enum already covers both pi's rich structure and a CLI agent's lightweight per-turn `assistant` text, so don't widen the model per-agent.
- CLI/terminal agents (claude/codex/...) now produce a real `SessionMessage` transcript too, captured in memory by `TerminalSessionManager` (which `implements SessionMessageSource`). The non-obvious part: there is no structured event stream from a PTY, so assistant text is reconstructed from the xterm headless mirror's **committed scrollback** — `TerminalStateMirror.getCommittedLines()` returns only the logical lines that have scrolled *above* `buffer.active.baseY` (the live input box/spinner in the viewport is deliberately excluded), and returns `[]` for the alternate-screen buffer. The **turn boundary** is the session-state-machine transition into `awaiting_review` (Claude's `Stop` hook → `transitionToReview` → `applySessionEvent`); each boundary folds the new committed-line delta into one `assistant` message. User messages come from the kickoff prompt (`startTaskSession`) and follow-up keystrokes in `writeInput` (committed on Enter, ANSI/backspace-stripped). All of this lives in `src/terminal/terminal-transcript-capture.ts` (pure, unit-tested) — fidelity is intentionally "good enough" (no per-tool-call parsing; the prompt echo Claude prints back may leak into the next assistant message). The hub broadcasts these over the same `task_chat_message` channel as pi via `manager.onMessage`, and `getTaskChatMessages` falls back to the terminal manager when pi has no session.
- Session transcripts are now **persisted to disk** so they survive a Kanban restart (the old "memory-only" note is obsolete). The store is `src/session/session-message-journal.ts` (`FileSessionMessageJournal`), writing append-only JSONL at `~/.kanban/workspaces/<id>/sessions/<taskId>/messages.jsonl` (one JSON `SessionMessage` per line; sibling to the `sessions.json` *summary* file). Both agents share it: it's injected into `InMemoryPiTaskSessionService` (via `CreatePiTaskSessionServiceOptions.messageJournal`, wired in `runtime-server.ts`) and `TerminalSessionManager` (constructor `messageJournal`, wired in `workspace-registry.ts`); the in-memory/test default is `NoopSessionMessageJournal`, so pi's behavior is unchanged when no journal is configured. Non-obvious bits: (1) pi re-emits the **same assistant message id** on every `message_update` token, so the journal *coalesces* a per-task `tail` and only appends on id-change / a 250ms debounce / `flush()` — naive append-per-emit would write hundreds of lines per message; (2) reads de-dupe by id (last write wins), tolerate a torn trailing line from a crash, opportunistically compact, and cap at `maxMessages` with an in-band `status` truncation marker; (3) restart history reaches the UI through the **existing** `getTaskChatMessages` path — `loadTaskSessionMessages` does `mergeSessionMessages(persisted, liveInMemory)`, so no frontend change was needed (the chat panel already fetches on open via `use-kanban-chat-session.ts`). The journal flushes on `dispose()` and `markInterruptedAndStopAll()`. The pi service can't be imported under vitest (agent-sdk touches `Bun.env` at import → existing tests mock it), so pi persistence is covered by a Bun round-trip, not a vitest test; the journal core and the terminal path are vitest-tested. Agent **session resume** (re-attaching pi/CLI to a prior conversation) is still a later task — this is view/read-back persistence only.
- The **home (sidebar) chat is multi-thread-capable at the foundation layer**. The synthetic home session id (`src/core/home-agent-session.ts`) gained an optional fourth segment: `__home_agent__:<workspaceId>:<agentId>:<threadId>`. **Backward-compat is load-bearing**: `createHomeAgentSessionId(ws, agent, threadId?)` emits the *legacy three-segment* id when `threadId` is omitted or equals `DEFAULT_HOME_THREAD_ID` (`"default"`), so the default thread's on-disk taskId is unchanged and existing transcripts/`sessions.json`/resume reconnect with no migration. `parseHomeAgentSessionId` parses positionally (workspaceId, agentId, optional threadId) — this is why `append-system-prompt.ts`'s agentId lookup uses the parser, NOT `parts.at(-1)` (which would grab the threadId on a 4-segment id). The thread **registry** is persisted per-workspace at `<repoPath>/.kanban/workspaces/<id>/threads.json` (a `{ threads: RuntimeHomeChatThread[] }` doc, sibling to `sessions.json`): pure list/create/rename/close ops live in `src/session/home-thread-registry.ts` (I/O-free, vitest-tested); `src/state/workspace-state.ts` owns persistence (`loadWorkspaceHomeThreads` / `mutateWorkspaceHomeThreads` — locked read→mutate→atomic-write, resolving `repoPath` via `resolveRepoPathForWorkspaceId` like the other per-workspace loaders post-T1); `src/session/home-thread-store.ts` (`HomeThreadStore`) is the orchestration seam with **injected** persistence + an `onCloseSession` callback (so it's unit-testable without touching `~/.kanban`). Closing a thread is a **hard close**: `TerminalSessionManager.closeTaskSession` / `InMemoryPiTaskSessionService.closeTaskSession` stop the process, drop the in-memory entry, and delete the transcript via `journal.clear(taskId)`. Wiring is in `runtime-server.ts` (`getScopedHomeThreadStore`, one store per workspace, `onCloseSession` routes cleanup to the agent that actually backs the session via `parseHomeAgentSessionId`); it's exposed through the `createRuntimeApi` deps but **not yet consumed** — tRPC endpoints + the multi-thread sidebar UI are deliberately later tasks, this layer is id-scheme + registry + close-lifecycle only.
- Kanban's native agent is `pi` (oh-my-pi, source-embedded in `src/agent-sdk/`). The old embedded Cline SDK runtime (`src/cline-sdk/` + `@clinebot/*`) and the external `cline` CLI agent option have both been removed; `runtime-api.ts` / `runtime-server.ts` and the catalog (`src/core/agent-catalog.ts`) only know `pi` plus the external CLI agents (claude/codex/droid/kiro/gemini/opencode). The pi adaptation layer (`src/agent-sdk/kanban/`) maps omp `AgentEvent` to Kanban's `RuntimeTaskSessionSummary` contract.
- The token `cline` survives in two unrelated places — never blanket-rename it: (1) the **native agent id was historically `cline`, now `pi`** (web-ui shares `RuntimeAgentId`/`RuntimeKanbanOauthProvider` from `src/core/api-contract.ts` via the `@runtime-contract` tsconfig alias, so narrowing the agent enum ripples into `web:typecheck`); (2) the **live Cline-hosted model provider/account** (`runtimeKanbanOauthProviderSchema` `"cline"`, `providerId`/`oauthProvider`, `api.cline.bot`/`app.cline.bot`/`data.cline.bot`) that the `pi` agent uses for managed models, credits, OAuth, and Featurebase — keep all of those.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. The old `test/runtime/cline-sdk/` test suite was the prior culprit (now deleted) because it booted the real Cline SDK host.
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- Commander nested subcommands: if a child subcommand re-declares an option already declared on its parent (e.g. `--project-path` on both a `foo` command and its `foo apply` child), commander silently routes the passed value to the *parent* command, so the child action's plain `options` arg has it `undefined`. Read it via `this.optsWithGlobals()` inside the child action (use a regular `function`, not an arrow, so `this` is the Command). This first bit during the (now-removed) requirement review/reconcile `apply` subcommands and looked like a workspace-resolution bug — watch for it whenever you add a nested `<command> <subcommand>` that shares a parent option.
- In-process outbound proxy is split from subprocess proxy. **Subprocesses** (agent sessions) get the proxy via env vars computed at spawn time (`config/proxy-env.ts` `buildProxyEnvVars`). **The runtime process's own fetch ignores those env vars** — Bun's global fetch does not read `HTTP_PROXY`, and Node/undici's global fetch doesn't either. So in-process live proxying goes through `config/proxy-fetch.ts`: a single `globalThis.fetch` monkey-patch installed once in `startServer()` (before provider SDKs load) that reads a mutable holder per request and injects the proxy engine-natively — **Bun ⇒ `{ proxy }` option, Node ⇒ `{ dispatcher: new ProxyAgent(url) }`** (undici). The holder is updated next to every `applyProxyToProcessEnv` call (`trpc/runtime-api.ts` saveConfig + `server/workspace-registry.ts` startup), so settings changes take effect on the next request with no restart. The patch covers everything that ultimately calls `globalThis.fetch` — provider SDKs (OpenAI/Anthropic/Google/Bedrock-custom-fetch), and the ~26 bare `fetch()` OAuth/token/model-discovery sites (a *global* patch covers bare calls even though they have no fetch-injection seam). It does NOT cover non-fetch transports (Cursor's HTTP/2 — a stub in embedded mode; AWS SDK — not used). The wrapper passes through untouched when the proxy is disabled, when the caller already set `dispatcher`/`proxy` (e.g. `getRuntimeFetch`'s CA-pinned dispatcher), and for loopback/`NO_PROXY` hosts (`shouldBypassProxy`). This is the working successor to the abandoned `feat/live-proxy-switching` branch — the key difference is **no always-on local proxy hop**.
