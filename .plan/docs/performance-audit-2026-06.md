# Kanban Performance Audit — 2026-06

**Type:** Audit only. No optimizations were implemented; this report measures, locates, and prioritizes. Each hotspot carries: location (file:line) · evidence · impact · optimization direction · estimated gain/risk · parallelizable.

**Method:** Read-only static analysis across four layers (frontend React, runtime CPU/memory, startup/loading, concurrency), plus cheap on-disk measurements (file counts/sizes, git-op timings, grep counts). **The runtime was NOT booted and no live profiler (React Profiler / `--prof` / `perf`) was attached** — booting a second runtime in a worktree risks deleting worktrees (per AGENTS.md). Structural facts (no memo, serial reads, polling cadence, lock scope, spawn mechanism) are directly proven from cited lines. Re-render *counts* and CPU *rankings* are reasoned from traced data-flow paths and labeled as inference where they are not measured. The recommended confirmation step before acting on the CPU-heavy items is a `--prof`/`perf` capture under a controlled N-task load.

**Baseline of this repo:** 146 task shards (~297 KB, ~2 KB avg), 3 vault docs + 4 type defs, board worktree 12 MB. Git gate calls measured ~5–6 ms each.

---

## TL;DR — what's already good, what hurts

**Already well-optimized (verified, no action):**
- The prior PTY-mirror optimization (memory `92f07`) is **fully intact**: micro-batch 16 ms / 64 KB with force-flush on read/resize, scrollback 5 000, onData fanout viewer-gated. Thresholds match documented values exactly. No regression.
- Startup migrations are **correctly gated** by cheap prechecks that short-circuit — they do **not** re-run full scans on an already-migrated repo.
- board-sync does **no network I/O at boot** (deliberate redesign) — the warm-start common case has zero startup fetch risk.
- The session-message journal coalesces correctly — a pi token storm is **not** one-append-per-token.
- **Shell-fallback compliance: COMPLIANT.** Agent detection is in-process PATH scanning; agent launch is direct binary spawn; git is `execFile` without a shell. The only `bash -i`/`zsh -i` is the explicitly-permitted interactive shell-terminal feature.

**The genuine hotspots (ranked in the ROI table at the end):**
1. **Workspace metadata monitor** — a 1 s git poll spawning O(N tasks) `git` subprocesses per open workspace. The dominant idle-CPU cost; the "fan狂转 with multiple tasks" symptom most likely originates here, ahead of the terminal mirror.
2. **Chat transcript rendering** — no virtualization, no per-message memo, markdown re-parsed per token. The heaviest UI interaction.
3. **Monolithic root store** — every WebSocket message re-renders the whole App tree (no selector isolation).
4. **Vault store** — `findById`/`get` re-scan and parse the entire docs tree per single-doc operation (worst scaling pattern found).
5. Serial shard reads, board card memoization, vault Fzf-per-keystroke, mirror per-chunk Buffer copy, unbounded agent-process spawn.

---

# Layer 1 — Frontend UI (web-ui, React)

**Stack:** React 18.3 · `@hello-pangea/dnd` (board DnD) · `@uiw/react-md-editor` + `react-markdown` (vault) · tRPC + raw WebSocket · `xterm`. `react-virtuoso` 4.18 **is installed but used in only 2 places** (vault table, git-history list) — NOT board, NOT chat.

**Cross-cutting structural facts (counts):** `memo(` appears in only **3 component files**; `createContext` appears **once** (unrelated layout context). The entire runtime state (board, sessions, chat, projects, sync status) flows through **one `useReducer` store** consumed at the top of a single 1253-line `App.tsx` with no memo boundaries. The one well-architected counter-example is `stores/workspace-metadata-store.ts`, which uses granular `useSyncExternalStore` per-taskId subscriptions — the model the rest should follow.

### L1-1 — Monolithic root store: every WS message re-renders the whole App tree  ★ foundational
- **Location:** `web-ui/src/runtime/use-runtime-state-stream.ts:315` (`useRuntimeStateStream`), reducer `:155-313`, socket handlers `:382-487`; `web-ui/src/hooks/use-project-navigation.ts:96`; `web-ui/src/App.tsx:87,133`.
- **Evidence:** All 12 WS channels dispatch into one reducer producing one store object, destructured at the top of the single `App` component which has no internal `memo` boundaries. Channels: `task_chat_message`, `task_sessions_updated`, `workspace_state_updated`, `board_sync_status_updated`, `kanban_session_context_updated`, `snapshot`, `projects_updated`, etc.
- **Impact (inferred from traced data flow):** Coarse-grained. A `board_sync_status_updated` (≈5 s commit/push cycle) or `task_sessions_updated` re-renders board + detail + top bar + sidebar for a badge-only change. During streaming, each `task_chat_message` token re-renders the entire App subtree.
- **Mitigating factor (proven):** `board` and `sessions` are local `useState` (`App.tsx:89-90`); `setBoard` is revision-guarded (`use-workspace-sync.ts:115-120`) so the board reference stays stable across chat-token storms. `sessions` is still re-merged on every `task_sessions_updated` and flows to `KanbanBoard`.
- **Direction:** Selector-based subscription — split into multiple contexts or adopt the existing `useSyncExternalStore` pattern from `stores/workspace-metadata-store.ts` so a chat token doesn't touch the board and a sync badge doesn't touch the chat. Amplifies the payoff of L1-2 and L1-3.
- **Gain/Risk:** High gain, **high effort / medium risk** (touches central data flow). **Parallelizable:** schedule deliberately; L1-2/L1-3/L1-5 can land independently first and benefit further once this lands.

### L1-2 — Chat transcript: no virtualization + no per-message memo + markdown re-parse per token
- **Location:** plain `.map()` list `web-ui/src/components/detail-panels/kanban-agent-chat-panel.tsx:430`; per-message component not memoized `…/kanban-chat-message-item.tsx:178`; markdown re-parsed each render `…/kanban-markdown-content.tsx:212`; per-token client setState `web-ui/src/hooks/use-kanban-chat-session.ts:124-129`; reducer recreates the by-task map per token `use-runtime-state-stream.ts:222-231`; auto-scroll `useLayoutEffect` keyed on `messages` `kanban-agent-chat-panel.tsx:245-258`.
- **Impact (inferred, chain proven end-to-end):** Heaviest interaction in the app. Per streaming token: recreate messages array → re-render all N message components (no memo, no windowing) → re-parse markdown + Prism-highlight → fire a layout-affecting scroll effect. Scales O(N messages) per token on long transcripts.
- **Existing mitigation (proven):** `upsertTaskChatMessage` (`use-runtime-state-stream.ts:131-139`) bails when content/role/createdAt/meta are unchanged — kills duplicate broadcasts, does not help genuine token growth.
- **Direction:** (1) Virtualize with the already-installed `react-virtuoso` (`followOutput` streaming mode); (2) `React.memo` the message item keyed on `id`+`content`; (3) memoize parsed markdown per content so only the active message re-parses; (4) optional client-side token coalescing.
- **Gain/Risk:** High gain, **medium effort / low-medium risk**. **Parallelizable:** yes (largely independent of L1-1).

### L1-3 — Board: `BoardCard` not memoized + unstable per-card `onClick`
- **Location:** `web-ui/src/components/board-card.tsx:227` (no `memo`, 921-line component); `web-ui/src/components/board-column.tsx:154-203` builds cards in a loop with a fresh arrow `onClick={() => …}` at `:192-198` (unstable prop that defeats any future memo); drag state writes at board root `web-ui/src/components/kanban-board.tsx:340-363`; per-card `useLayoutEffect` text measurement `board-card.tsx:312-324`; unmemoized `renderStatusMarker` `:422-434`.
- **Impact (inferred):** Drag start/end writes board-root state → with no memo boundary all columns/cards re-render at drag boundaries (note: `@hello-pangea/dnd` does **not** stream per-pixel updates here, so there is no per-pixel storm — a relief). Each card's `useLayoutEffect` DOM measurement re-runs per board render; session churn re-renders affected cards' activity machines. The unstable `onClick` guarantees a future `memo` would be a no-op until the callback is stabilized.
- **Direction:** `React.memo(BoardCard)`; lift `onClick` to a stable `useCallback(id)`; memoize the status marker; gate the measurement effect once stable.
- **Gain/Risk:** Medium gain, **low effort / low risk**. **Parallelizable:** yes.

### L1-4 — Board has no virtualization (large-board scaling)
- **Location:** `web-ui/src/components/board-column.tsx:154-203` renders every card into the DOM; no windowing.
- **Impact (inferred):** Linear DOM growth — a 100+ task column mounts 100+ heavy `BoardCard` instances (each with measurements + several hooks). Combined with L1-3, a single board render reconciles every card. This is the "what happens with 100+ tasks" answer: everything is in the DOM at once.
- **Caveat:** Virtualizing a `@hello-pangea/dnd` `Droppable` is a known hard combination (the lib needs measurable draggables).
- **Direction:** Windowed rendering within columns (dnd lib has documented virtual-list patterns) or, cheaper interim, `content-visibility: auto` off-screen culling.
- **Gain/Risk:** Medium-high gain at scale, **high effort / medium-high risk**. **Parallelizable:** yes but should follow L1-3.

### L1-5 — Vault editor: full Fzf re-scan of all docs per keystroke during `[[` autocomplete
- **Location:** controlled editor, no debounce `web-ui/src/components/vault/editor/doc-editor.tsx:87-115`; per-keystroke search `web-ui/src/components/vault/links/use-wikilink-editor-completion.ts:62-76`; **new `Fzf` instantiated over all candidates every call** `web-ui/src/components/vault/links/wikilink-candidates.ts`.
- **Impact (inferred):** While typing inside a `[[` token, each keystroke rebuilds an Fzf index and scans all docs — O(total docs) per keystroke. Fine for small vaults; degrades as the vault grows (and the roadmap is to grow it into a knowledge base). Outside `[[`, the editor is a normal controlled `<MDEditor>` — acceptable.
- **No-issue notes (proven):** vault table view **is** virtualized (`vault/views/vault-table-view.tsx:58-72`); the md-editor "ghosting" CSS workaround has **no perf cost**.
- **Direction:** Memoize the `Fzf` instance per `candidates` identity (build the index once, not per keystroke); debounce the query (~150–200 ms); lazy-load candidates only when `[[` is active.
- **Gain/Risk:** Medium gain at scale, **low-medium effort / low risk**. **Parallelizable:** fully independent.

### L1-6 — WebSocket → setState granularity (channel summary)
- **Location:** `web-ui/src/runtime/use-runtime-state-stream.ts:382-487` → reducer `:155-313`.

| Channel | Freq | Re-render granularity |
|---|---|---|
| `task_chat_message` | per token (high) | whole App; chat list O(N) — L1-1, L1-2 |
| `task_sessions_updated` | per agent state change | board + cards — L1-1, L1-3 |
| `workspace_state_updated` | occasional | whole App; board guarded by revision (mitigated) |
| `board_sync_status_updated` | ~5 s commit/push | whole App for a badge-only change |
| `kanban_session_context_updated` | occasional | whole App (bumps a version int) |
| `snapshot` / `projects_updated` | rare | whole App (acceptable) |

This table is the runtime expression of L1-1: the high-frequency channels and the periodic sync badge all dispatch into one un-isolated store.

---

# Layer 2 — Runtime CPU / Memory

**Prior optimization (`92f07`) status — all three intact:**

| Mitigation | Status | Evidence |
|---|---|---|
| Micro-batch 16 ms / 64 KB, force-flush on read/resize | ✅ | `src/terminal/terminal-state-mirror.ts:21-22`; force-flush `:133`,`:154`,`:87` |
| Scrollback 10k→5k | ✅ | `terminal-state-mirror.ts:12` (`TERMINAL_SCROLLBACK = 5_000`) |
| onData fanout viewer-gated | ✅ (stronger) | `src/terminal/session-manager.ts:601` skips fanout when `listeners.size === 0` |

### L2-4 — Workspace metadata monitor: 1 s git poll, O(N tasks) `git` subprocesses per workspace  ★ biggest idle-CPU cost
- **Location:** `src/server/workspace-metadata-monitor.ts:337-346` (1 s `setInterval`), `refreshWorkspace:283-322`; git probes in `src/workspace/git-sync.ts:113-200`; `runGit`=`execFile` in `src/workspace/git-utils.ts:45`.
- **Evidence (static):** `WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000` (`:10`). Each tick does `loadHomeGitMetadata` then `Promise.all` over **every tracked task**, each calling `probeGitWorkspaceState`, which spawns: `git rev-parse --show-toplevel` (**uncached, every probe**) + `git status --porcelain=v2 --branch --untracked-files=all` + `git rev-parse --verify HEAD`, plus a `stat()` per changed/untracked path. ⇒ **≈3 git process forks + N stat() per tracked task, every second**, per connected workspace. 10 active tasks ≈ 30 git forks/sec continuously while a board is open.
- **Mitigation present (good):** a `stateToken` short-circuit (`workspace-metadata-monitor.ts:222-228`) avoids the extra `git diff --numstat` when nothing changed — but the 3 probe spawns run **unconditionally** every tick to compute the token.
- **Impact (inference, but high-confidence):** Highest steady-state idle CPU. A `git` fork/exec is categorically more expensive than anything in the terminal mirror; this scales O(N tasks) and runs continuously. Likely the true source of the "fan狂转 with multiple tasks open" symptom — ahead of the PTY mirror.
- **Direction:** (1) **Cache `resolveRepoRoot`** per worktree path — it's constant, currently re-spawns `git rev-parse --show-toplevel` every probe (removes 1 of 3 spawns/task/tick, trivial). (2) Back off the interval when idle (3–5 s) or event-drive off PTY `lastOutputAt` / board-sync writes. (3) Batch a single `git status` over the shared parent repo instead of per-worktree spawns.
- **Gain/Risk:** High gain. #1 = **low effort / low risk**; #2 = medium effort (touches UI freshness expectations). **Parallelizable:** yes (self-contained module).

### L2-1 — Per-chunk `Buffer.from(chunk)` copy still on the mirror hot path
- **Location:** `src/terminal/terminal-state-mirror.ts:63-130`, specifically `:69` `this.pendingChunks.push(Buffer.from(chunk))`.
- **Evidence (static):** Batching solved the xterm-write / Promise-per-chunk cost, but `applyOutput` still allocates a `Buffer` copy **per PTY chunk**. The copy is justified (`:67-68`): the filtered chunk may be a subarray view onto the reused PTY read buffer. So under a token flood there is still one heap allocation per chunk feeding GC churn — the cost class `92f07` chased, relocated from xterm-write to the copy. The per-batch `new Promise` + `enqueueOperation` (`:122-129`) now runs only ~once per 16 ms batch, so it is no longer dominant.
- **Impact (inference):** Moderate. Allocation volume scales with chunk *count* (many tiny escape-sequence chunks), not byte volume; O(N tasks) when N agents stream. GC pressure during streaming.
- **Direction:** Move buffer ownership to the protocol-filter handoff so the mirror can store the view and copy once at flush (where `Buffer.concat` already produces one owned buffer at `:119`), instead of copying per chunk. Must change the filter→mirror ownership contract — do not remove the copy without that (the aliasing bug at `:67` is real).
- **Gain/Risk:** Moderate gain, **medium effort / medium risk** (buffer-ownership correctness). **Parallelizable:** yes (mirror + protocol-filter contract).

### L2-2 — `getCommittedLines()` rescans the entire 5k scrollback every turn boundary
- **Location:** `src/terminal/terminal-state-mirror.ts:153-180` (full scan `0..baseY`, `translateToString` per line), driven by `src/terminal/terminal-transcript-capture.ts:76-86` which then **slices off only the new tail** and discards the rest. Frequency: per `awaiting_review` turn transition (`session-manager.ts:1227`), serialized on `captureChain`.
- **Impact (static):** Low-moderate. Bounded by 5k lines × turn frequency (seconds-to-minutes apart) — not a hot loop, but it materializes up to ~5000 strings to keep a small delta; transient `string[]` memory spike per capture.
- **Direction:** Push the `committedLineCount` cursor into the mirror so it iterates only `[committedLineCount-1, baseY)` and returns just the delta (the `-1` preserves the wrapped-line rejoin at `:173`).
- **Gain/Risk:** Low-moderate gain, **low effort / low risk** (delta already computed downstream). **Parallelizable:** yes.

### L2-3 — Session-message journal: coalescing healthy; minor on-disk bloat
- **Location:** `src/session/session-message-journal.ts:107-150`.
- **Evidence (static, positive):** Same-id token re-emits only **replace the in-memory tail** — append happens only on id-change (`:112`), the 250 ms debounce (`:30,:123-129`), or explicit `flush()` (`:266`). A 500-token message ⇒ ~1 append per 250 ms, **not 500 appends**. A second `id+content` dedup guard at `:142-149` skips redundant idle ticks. Writes are buffered `appendFile` (no `fsync`), timers `unref`'d. **Subsystem is well-optimized.**
- **Residual:** Each debounce tick `JSON.stringify`s and appends the *full current content* of the growing message ⇒ a 50 KB message over 10 s writes ~40 progressively-growing lines (~1 MB redundant append) before compaction. Compaction (`readAndCompact:213-239`) runs **only on read**, so a long streaming session never read back grows until the UI next opens it (capped at `DEFAULT_MAX_MESSAGES = 10_000`).
- **Direction (optional polish):** Trigger opportunistic compaction also at `flush()`/`dispose()` or past an append-count threshold; optionally persist progress less often (raise debounce / persist final content on id-change), trading crash-recovery granularity.
- **Gain/Risk:** Low gain, **low effort / low risk**. **Parallelizable:** yes.

### L2-5 — Per-task live-timer inventory (what scales with N tasks)
- **Static inventory (grep over `src/`, excluding vendored `agent-sdk`):**

| Site | Scope | Freq | O(N)? |
|---|---|---|---|
| `terminal-state-mirror.ts:97` flushTimer | per active mirror | 16 ms, pending-gated, `unref` | yes, self-extinguishing |
| `session-message-journal.ts:123` flushTimer | per task w/ pending tail | 250 ms, `unref`, cleared on append | yes, cheap |
| `ws-server.ts:329` outputFlushTimer | per viewer | 4 ms, pending-gated | yes per viewer |
| `ws-server.ts:274` resumeCheckTimer | per backpressured viewer | 16 ms, while paused | conditional |
| **`workspace-metadata-monitor.ts:341`** | **per connected workspace** | **1000 ms, always on** | **yes — L2-4** |
| `runtime-server.ts:114` keepalive | singleton | 1000 ms, empty body | no |
| `codex-hook-events.ts:1005` | CLI hook **subprocess**, not runtime | — | N/A |

- **Key facts:** there is **no per-task busy loop**; PTY/journal/ws timers are all `unref`'d, output-gated, self-clearing (no idle CPU). The only always-on, O(N), heavy loop is the metadata monitor (L2-4). One `TerminalStateMirror` per active session ⇒ memory O(N × 5k-line buffer), bounded.

### L2-6 — Broadcast amplification: controlled (no action)
- **Location:** raw output `session-manager.ts:601-604` → `ws-server.ts:365-375` → batch `:316-331`; chat `runtime-state-hub.ts:190-204`.
- **Evidence (static, positive):** Raw terminal output is **batched per viewer at 4 ms** (`OUTPUT_BATCH_INTERVAL_MS`) with full VS Code-style flow-control/backpressure (high/low watermarks, pause/resume the shared PTY) and is **skipped entirely when no viewer is attached** (`:601`). Not one frame per chunk. Chat messages broadcast only at turn boundaries / on user input — low frequency. Confirms the memory's two-consumer model (mirror `applyOutput` at `:526` + viewer `onOutput` at `:603` from the same chunk).
- **Action:** None. Fixing L2-1 benefits both consumers.

---

# Layer 3 — Startup / Loading

### L3-1 — Migrations are correctly gated; they do NOT re-run every boot (no action)
- **Location:** `src/state/workspace-state.ts:1150-1165` (`prepareRepoRuntimeHome`), gates at `:865,:885,:906,:945-955,:1305,:1434,:1192-1197`.
- **Evidence (static):** Every migration short-circuits on a cheap precheck before taking the workspace-dir lock — `migrateWorkspaceDataFromLegacyHome` (`pathExists` `:865`), `migrateSeedVaultTypes` (`:885`), `migrateRequirementsToVaultDocs` (`:906`), `dropRetiredRequirementData` (`Promise.all(pathExists)` `:954`), `migrateToCommittedProviders` (`pathExists` **before** the provider-config read `:1305`), `migrateWorkspaceBoardToShards` (`boardNeedsSharding` = one manifest read `:1434`), `migrateDecoupleBoardToBranch` (`git ls-files` `:1192`). The lock is acquired only **inside** a migration after its gate passes. **Verdict: good — the critical "does it scan every boot?" question is a clean no.**

### L3-5 — Vault store re-scans & parses the ENTIRE docs tree on every `get`/`findById`  ★ worst scaling pattern
- **Location:** `src/vault/vault-document-store.ts:182-201` (`scan`, fully serial nested `for` loops with `await readDocument` each), and `findById:176-179` **calls `scan()` over the whole vault** to locate one doc; `get:85-88`, `create:92`, `update:133`, `remove:167` all funnel through it.
- **Impact (static):** O(total docs) parse **per single-doc operation**. Low today (3 docs) but this is the only genuinely bad-scaling pattern found; the roadmap grows the vault into a Notion/Obsidian-style base, at which point every `get`/`update`/link-resolve/backlink/search becomes a full-tree gray-matter parse.
- **Direction:** (a) Parallelize `scan` with `Promise.all`; (b) more importantly, give `findById` a direct-path lookup — filenames are `<slug>-<id>.md` under `docs/<type>/`, so a targeted `readdir` or an id→path index avoids parsing every doc; (c) an in-process scan cache invalidated on write.
- **Gain/Risk:** High gain at scale, **moderate effort / moderate risk** (cache invalidation, slug/id edge cases). **Parallelizable:** scan-parallelization yes; index is a structural change.

### L3-3 — Board read is serial: N task-shard reads in a `for` loop + double Zod parse
- **Location:** `src/state/task-shard-store.ts:166-182` (`readStoredTasks` — `for … await readJson`), final full re-validation `:226`; called by `loadShardedBoard:242`.
- **Evidence (static + measured):** one `readdir` + **N serial `readFile`** + N per-shard `safeParse` + a **second** full-board `runtimeBoardDataSchema.parse` (`:226`) re-validating everything already validated. Measured: a serial shell read loop over the 146 shards took **0.48 s** (process-spawn-dominated; in-process `readFile` is far faster but still pays N serial round-trips + double validation). Read on every workspace snapshot (`loadWorkspaceState:1493`), `loadWorkspaceBoardById`, and broadcast.
- **Impact (inference):** Moderate, **scales linearly with task count**. Fine at 146; the double validation + serial reads dominate at 1000+ tasks.
- **Direction:** `await Promise.all(ids.map(readJson))` (ordering restored by the `rank` sort at `:211`); make the second full-board parse dev-only or trust per-shard validation.
- **Gain/Risk:** Moderate gain, **low effort / low risk**. **Parallelizable:** yes.

### L3-2 — Per-load migration chain is 8 sequential awaits, several spawning git
- **Location:** `src/state/workspace-state.ts:1154-1164`.
- **Evidence (static + measured):** 8 migrations run strictly sequentially; on an already-migrated repo that's ~2 git spawns (`isGitWorktree`, `isBoardRefTrackedOnCodeBranch`, measured ~10–15 ms total) + ~13 `pathExists`/`stat`, all serialized. `loadWorkspaceContext` is called on many paths (registry init `:192`, every `loadWorkspaceState`, tRPC `projects-api.ts:129`, task-worktree ops).
- **Impact (inference):** Low-moderate. Gate prechecks are mutually independent and could run concurrently; only `migrateDecoupleBoardToBranch` must stay last.
- **Direction:** Evaluate the independent gate prechecks with `Promise.all`; or cache "this repo is fully migrated" in-process per `repoPath` so the chain is skipped on repeat calls within one process.
- **Gain/Risk:** Low-moderate gain, **low effort / low-moderate risk** (preserve last-runs-last invariant). **Parallelizable:** gates yes, migrations no.

### L3-4 — Generic sharded store reads/writes are serial (latent)
- **Location:** `src/state/sharded-json-store.ts:52-74` (`readShardDir`, serial), `:83-92` (`writeShardDir`, serial writes + a **second `listShardIds` readdir** to compute deletions).
- **Impact:** Low today — now backs only committed-providers + legacy migration reads (requirements retired/B6), so N is tiny. Latent tech-debt if reused for larger collections.
- **Direction:** `Promise.all` the reads and writes; reuse the pre-write `listShardIds` result for the deletion pass instead of re-reading.
- **Gain/Risk:** Low gain, **low effort / low risk**. **Parallelizable:** yes.

### L3-6 — board-sync does NO network I/O at startup (no action; one minor caveat)
- **Location:** `src/server/runtime-server.ts:592-595` (explicit "No boot reconcile" design comment); `src/workspace/board-worktree.ts:307-341` (`getBoardWorktreeAheadBehind` documented fetch-free, runs `git rev-list --left-right --count` against the local tracking ref).
- **Evidence (static, positive):** Warm-start common case has **zero** startup network I/O; the only fetch entry points are user-triggered Pull (`board-sync.ts:284`) and push-reconcile, both behind `BOARD_NETWORK_GIT_TIMEOUT_MS` (30 s, `board-worktree.ts:27`).
- **Minor caveat:** A **cold clone's** first boot runs a synchronous `git fetch` in `createBoardWorktree` (`board-worktree.ts:557`) on the `ensureBoardWorktree` critical path, and that fetch is **not** wrapped in `BOARD_NETWORK_GIT_TIMEOUT_MS` — a slow/unreachable remote can hang first-boot. Warm starts skip it (`isGitWorktree` early-return).
- **Direction (low priority):** Apply a network timeout to the cold-clone fetch at `board-worktree.ts:557`.
- **Gain/Risk:** Low gain (first-boot only), **low effort / low risk**.

### L3-7 — startServer critical path is fine (no action)
- **Location:** `src/cli.ts:382-551`; `src/server/workspace-registry.ts:190-282`.
- **Evidence (static, positive):** Server-stack modules load via `Promise.all` of 8 dynamic imports (`cli.ts:431-440`, deliberately lazy). `createWorkspaceRegistry` then runs a short serial await chain with genuine data dependencies (workspace path must resolve before the second config load) — correctly serial. The proxy fetch interceptor installs synchronously before any provider SDK loads. The one expensive critical-path item is the initial `loadWorkspaceContext(cwd)` — wins there are the downstream L3-2/L3-3.

---

# Layer 4 — Concurrent Tasks / Agents

### L4-3 — Shell-fallback compliance: COMPLIANT (conclusive, highest-value check)
- **Evidence (static, conclusive):**
  - **Agent detection** = in-process PATH scan: `src/terminal/command-discovery.ts:46` (`isBinaryAvailableOnPath` → `accessSync(join(entry, binary), X_OK)` per PATH entry, `:55-77`), used by `src/terminal/agent-registry.ts:56,:89`. No `which`/`command -v`/`zsh -i`. The file carries an explicit comment (`:22-45`) citing the conda/nvm freeze risk — it directly implements the AGENTS.md warning.
  - **Agent launch** = direct binary spawn: `src/terminal/pty-session.ts:193` → `Bun.spawn([binary, ...args], …)` (`:207`) or `pty.spawn(binary, args, …)` (`:239`). No `shell: true`, no `-i`. The only shell-ish branch is the Windows `cmd` launch for `.cmd`/`.bat` shims (`:227-229`) — a Windows execution requirement.
  - **Git** = `execFile("git", …)` with **no** `shell: true` (`src/workspace/git-utils.ts:45`).
  - The only `bash -i`/`sh -i` lives in `SHELL_FALLBACK_STRATEGIES` (`session-manager.ts:63-68`), reached only via `startShellSession`→`spawnShellProcess` (the explicit interactive shell-terminal feature). The task-agent path (`startTaskSession:430`) never touches it.
- **Verdict:** **Compliant.** No action.

### L4-1 — Worktree creation runs ~5–8 serial git ops under a per-repo lock
- **Location:** `src/workspace/task-worktree.ts:437` (`ensureTaskWorktreeIfDoesntExist`), lock `:461` (`withTaskWorktreeSetupLock`, keyed on git common dir = **one lock per repo**, `:99-104`); reached from `src/trpc/runtime-api.ts:247`→`:609`. Fast path (no lock) when the worktree already exists `:450-459`.
- **Evidence (static):** Under the lock, serial git ops: `rev-parse HEAD` (`:462`), `rev-parse --verify <baseRef>` (`:484`), optional remove (`:507`), `worktree prune` (`:514`), `worktree add --detach` (`:517`, +retry `:532`), `prepareNewTaskWorktree` (`:534`) → submodule init (`config --get-regexp`) + `syncIgnoredPathsIntoWorktree` (`ls-files --others --ignored`, `rev-parse --git-path info/exclude`, per-path `lstat`/`mkdir`/mirror). ⇒ ~5–8 `git` forks + filesystem mirroring, serialized. Lock is `proper-lockfile`, `retries:200`, 25–50 ms poll, `stale:10_000ms` — a spin-wait, not a fair queue.
- **Impact (static):** N tasks needing **fresh** worktrees → creation serializes per repo (≈N× single-creation git-op cost). Existing worktrees skip the lock and proceed fully in parallel.
- **Direction:** Narrow the lock to only the genuinely repo-global steps (`worktree prune` + `worktree add`); move `syncIgnoredPathsIntoWorktree`/submodule init outside the lock (they target the isolated new dir); cache `listIgnoredPaths`/exclude-file per repo across concurrent creations.
- **Gain/Risk:** Medium gain, **medium effort / medium risk** (git-correctness-sensitive). **Parallelizable:** partially (filesystem mirroring yes; `git worktree add` no).

### L4-4 — Many-tasks-at-once: per-repo worktree lock bounded, but agent-process spawn is UNBOUNDED
- **Location:** tRPC entry `src/trpc/app-router.ts:657-661` (plain `await`, no batching); orchestration `src/trpc/runtime-api.ts:237`. Grep for `p-limit`/`Semaphore`/`mutex`/`queue` on the start path found **only** the per-repo worktree lock and the journal's per-task `captureChain` (not a cross-task limiter).
- **Evidence (static):** Two regimes for starting 5 tasks: 5 fresh worktrees → creation serialized on the one repo lock (L4-1); 5 existing worktrees → all 5 PTY spawns + adapter file writes run **fully in parallel, no throttle**. Nothing caps concurrent **agent processes** — N simultaneous starts ⇒ N real CLI processes (claude/codex/…) at once. The only cap (`MAX_AUTO_RESTARTS_PER_WINDOW=3`, `session-manager.ts:51`) is crash-restart only.
- **Impact (inference):** Unbounded process spawn is the most plausible CPU-thrash risk on a large simultaneous start.
- **Direction:** Optional `p-limit` on agent-process spawn count per workspace/host (configurable, default ≈ CPU count). Do **not** add a lock around the lean session-manager critical path (L4-2).
- **Gain/Risk:** Medium gain (thrash prevention), **low-medium effort / low risk** (additive). **Parallelizable:** yes (orthogonal to the worktree lock).

### L4-2 — Session-manager critical path is lean (no action)
- **Location:** `src/terminal/session-manager.ts:430` (`startTaskSession`, 1313 lines), PTY spawn `:507`.
- **Evidence (static, positive):** Only **2 awaits** before spawn for CLI agents — `buildAgentProviderEnv` (`:469`, sync no-op for opencode) and `prepareAgentLaunch` (`:477`). The blocking work is a handful of small local file reads/writes (claude/codex/opencode settings + the conditional `projectCodexHome`, which writes nothing for official login) and, only if the task has images, a temp write. **No lock** on this path, so these run per-task in parallel across concurrent starts.
- **Minor correctness note (not perf):** claude/opencode read-merge-write a **shared** `~/.claude/settings.json`; concurrent starts are last-writer-wins despite atomic writes. Out of audit scope but worth a ticket.

---

# ROI-ranked optimization task list

ROI = (impact × likelihood it bites) ÷ (effort × risk). "Independent" = can be a standalone board task with no ordering dependency.

| # | Task | Layer | Location | Effort | Risk | Gain | Independent | Notes |
|---|------|-------|----------|--------|------|------|-------------|-------|
| **1** | **Cache `resolveRepoRoot` + back off the 1 s metadata git-poll** | L2-4 | `workspace-metadata-monitor.ts:337`, `git-sync.ts:202` | Low (cache) / Med (cadence) | Low | **High** (top idle-CPU win, the fan symptom) | ✅ | Split into 1a cache (trivial) + 1b cadence |
| **2** | **Virtualize chat transcript + memo message item + memoize markdown parse** | L1-2 | `kanban-agent-chat-panel.tsx:430`, `kanban-chat-message-item.tsx:178`, `kanban-markdown-content.tsx:212` | Med | Low-Med | **High** (heaviest UI interaction) | ✅ | `react-virtuoso` already installed |
| **3** | **Parallelize board shard reads (`Promise.all`) + drop double Zod parse** | L3-3 | `task-shard-store.ts:166`,`:226` | Low | Low | Med (linear in tasks) | ✅ | Quick, scales the board read |
| **4** | **`React.memo(BoardCard)` + stabilize per-card `onClick`** | L1-3 | `board-card.tsx:227`, `board-column.tsx:192` | Low | Low | Med | ✅ | Must stabilize onClick or memo is a no-op |
| **5** | **Vault: memoize Fzf index + debounce `[[` autocomplete** | L1-5 | `wikilink-candidates.ts`, `use-wikilink-editor-completion.ts:62`, `doc-editor.tsx:87` | Low-Med | Low | Med at scale | ✅ | Fully isolated |
| **6** | **Vault store: direct-path `findById` + parallel `scan` (+ scan cache)** | L3-5 | `vault-document-store.ts:176`,`:182` | Med | Med | High at scale | ✅ | Worst scaling pattern; do before vault grows |
| **7** | **`getCommittedLines` delta cursor (stop full 5k rescan)** | L2-2 | `terminal-state-mirror.ts:153` | Low | Low | Low-Med | ✅ | Cheap, clean |
| **8** | **Bound agent-process spawn with `p-limit` per workspace** | L4-4 | `runtime-api.ts:237`, `app-router.ts:657` | Low-Med | Low | Med (thrash prevention) | ✅ | Additive limiter |
| **9** | **Mirror: move buffer ownership to filter, copy once at flush** | L2-1 | `terminal-state-mirror.ts:69`, protocol filter | Med | Med | Med (GC under streaming) | ✅ | Needs ownership-contract change |
| **10** | **Root store: selector-based subscription (split contexts / `useSyncExternalStore`)** | L1-1 / L1-6 | `use-runtime-state-stream.ts:315`, `App.tsx:87` | High | Med | High (amplifies #2,#4) | ⚠️ foundational | Model = `stores/workspace-metadata-store.ts` |
| **11** | **Narrow worktree-creation lock scope + cache ignored-paths** | L4-1 | `task-worktree.ts:461`,`:534` | Med | Med | Med (N-fresh-worktree starts) | partial | Git-correctness-sensitive |
| **12** | **Board column virtualization under `@hello-pangea/dnd`** | L1-4 | `board-column.tsx:154` | High | Med-High | Med-High at scale | ⚠️ after #4 | Hard DnD+virtualization combo |
| **13** | **Parallelize per-load migration gate prechecks / in-process "migrated" cache** | L3-2 | `workspace-state.ts:1154` | Low | Low-Med | Low-Med | ✅ | Keep decouple-migration last |
| **14** | **Journal opportunistic compaction at flush/dispose** | L2-3 | `session-message-journal.ts:213` | Low | Low | Low | ✅ | Polish only |
| **15** | **Parallelize generic sharded-store reads/writes** | L3-4 | `sharded-json-store.ts:52` | Low | Low | Low (small N today) | ✅ | Latent tech-debt |
| **16** | **Cap cold-clone board-sync fetch with a network timeout** | L3-6 | `board-worktree.ts:557` | Low | Low | Low (first boot only) | ✅ | Edge-case robustness |

**Suggested wave plan:**
- **Wave A (quick, independent, parallel):** #1a (resolveRepoRoot cache), #3, #4, #5, #7 — all low-effort/low-risk, no ordering dependencies, immediate CPU + UI wins.
- **Wave B (medium):** #1b (poll cadence), #2 (chat virtualization), #6 (vault lookup), #8 (spawn limiter), #9 (mirror ownership).
- **Wave C (foundational/larger):** #10 (store selectors) — do before/with the remaining UI memo work to compound gains; then #11, #12.
- **Backlog:** #13–#16 polish.

**Confidence & next step:** The structural findings are proven from source. The two CPU-heaviest items (#1 metadata poll, #9 mirror copy) and all re-render claims (#2, #4, #10) are reasoned from traced paths, not from a live profile. Before committing engineering effort to #1/#9/#10, capture a `--prof` (Node)/`perf` flamegraph and a React Profiler trace under a controlled 5–10 concurrent-task load to confirm the ranking — the audit was deliberately read-only and did not boot the runtime.
