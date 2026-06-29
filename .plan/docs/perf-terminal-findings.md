# Kanban Terminal-Agent Session Chain — Performance Bottleneck Findings

**Date:** 2026-06-29
**Scope:** The CLI/terminal agent (claude/codex/…) session pipeline only — PTY ingest → headless xterm mirror → transcript capture → message journal → token-usage parsing → multi-session broadcast pressure. Read-only investigation; **no business code changed**.
**Relationship to prior work:** This is a focused follow-up to `.plan/docs/performance-audit-2026-06.md` (the whole-system audit). Where that audit recommended terminal-mirror fixes (its tasks **#7, #9, #14, #8**), this report **verifies they are now implemented** (no regression) and concentrates net-new findings on the **token-usage read path** and the **per-chunk decode**, which the June audit did not cover.

Method: 5 parallel source-reading passes (PTY hot path, headless mirror, transcript+journal, token-usage reads, multi-session concurrency), each independently cross-checked against the actual code by the author. Findings are marked **CONFIRMED** (read from source) or **SPECULATIVE** (reasoned, not measured). No live profile/flamegraph was captured — magnitudes are structural estimates.

---

## TL;DR

The hot paths the June audit hardened are **intact and, for #7/#9, improved beyond the audit's snapshot**. The genuinely new, actionable bottleneck is **token-usage parsing**, which the audit never examined:

| # | Finding | Path | Confidence | Severity |
|---|---------|------|-----------|----------|
| **T1** | Codex `findLatestCodexRollout` walks the **entire global `~/.codex/sessions` tree** (recursive readdir + `stat` every file + first-line read of candidates) on every turn boundary, **and up to 30× at launch**. Unbounded growth with the user's lifetime Codex usage × concurrent sessions. | token | CONFIRMED structure | **High** |
| **T2** | Both Claude & Codex usage readers `readFile` the **entire** session/rollout JSONL and re-parse every line on **every turn boundary**, no mtime/size cache. Cost ≈ O(turns × final-size) ≈ quadratic in transcript bytes over a session. | token | CONFIRMED | **Med-High** |
| **T3** | `workspace_state_updated` broadcast → `detectGitRepositoryInfo` spawns **~4 git subprocesses, uncached**, per broadcast (gated to turn-boundary transitions). N agents finishing turns together → ~4N concurrent gits + N index-lock acquisitions on one repo. | multi-session | CONFIRMED structure | **Med** |
| **T4** | `workspaceTrustBuffer` is seeded/reset to `""` (never `null`) for Claude/Codex, leaving the `needsDecodedOutput` gate **permanently open** → per-chunk `toString("utf8")` + string concat (+ periodic 16 KB slice) for the **whole session**. | PTY | CONFIRMED | **Med-Low** |
| **T5** | `updateSummary` spreads the whole summary object **per output chunk** (line 591). Per-chunk allocation; does **not** broadcast. | PTY | CONFIRMED | **Low** |
| **T6** | Two `FileSessionMessageJournal` instances (pi + terminal) point at the **same** `messages.jsonl`; reads for CLI tasks always route through pi first → split compaction bookkeeping. | journal | CONFIRMED smell | **Low** |
| **T7** | `getSnapshot`/`SerializeAddon.serialize()` serializes the full ≤5k-line buffer on **viewer (re)connect** (not per-chunk, not per-broadcast). | mirror | CONFIRMED | **Low** |
| **T8** | `buildProjectsPayload` reads **all** projects' board shard-dirs on each per-workspace summary flush. (NOTE: the June-agent's "~6.7 Hz" framing is **refuted** — see Refuted below; this runs at emit/turn frequency, not per-chunk.) | multi-session | CONFIRMED | **Low** |

---

## Regression check — June-audit terminal items are intact / now implemented ✅

The user explicitly asked to confirm no regression on the prior Bun event-loop busy-wait fix (`92f07`, per-chunk GC churn → micro-batch + scrollback 10k→5k). **Confirmed intact, plus three June recommendations have since shipped:**

| Item | June status | Now | Evidence |
|------|-------------|-----|----------|
| Micro-batch 16 ms / 64 KB + force-flush on read/resize | fix present | ✅ intact | `terminal-state-mirror.ts:21-22, 68-141`; force-flush `:96,:144,:167` |
| Scrollback 10k → 5k | fix present | ✅ intact | `terminal-state-mirror.ts:12` (`TERMINAL_SCROLLBACK = 5_000`) |
| **#7** `getCommittedLines` delta cursor (stop full 5k rescan) | recommended | ✅ **done** | cursor `committedRowCount` `terminal-state-mirror.ts:53,183-199`; commit `5e57b992` |
| **#9** Mirror copy-once at flush (drop per-chunk `Buffer.from`) | recommended | ✅ **done** | zero-copy retain `:78`, single `Buffer.concat` at flush `:130`; commit `45d7e2f7` |
| **#14** Journal opportunistic compaction at flush/dispose | recommended | ✅ **done** | stale-threshold mid-stream `session-message-journal.ts:196`, flush compaction `:347-372` |
| **#8** Bound concurrent agent-process spawn | recommended | ✅ **done** | `agent-start-limiter.ts` `pLimit(cpuCount)`, env `KANBAN_MAX_CONCURRENT_AGENT_STARTS` |
| No sync subprocess on load hot path (`spawnSync`→async) | fixed | ✅ intact | `workspace-state.ts:1089-1097` `execFileAsync` + `timeout`; comment `:1081` |
| No interactive shell on agent-startup hot path | compliant | ✅ intact | `pty-session.ts:180-192` direct `Bun.spawn([binary,...args])`; PATH via `command-discovery.ts:46-78` `accessSync` (no `which`/`zsh -i`) |

**Verdict:** No regression. The PTY/mirror/journal hot paths are well-defended; per-chunk fan-out is viewer-gated (`session-manager.ts:629`) and does zero cross-session work. The remaining wins are *outside* the lean session-manager spawn/output path.

---

## New findings (detail)

### T1 — Codex rollout locator walks the entire global `~/.codex/sessions` tree per turn boundary ★ primary

- **现象:** For Codex under **official login** (no custom provider), each turn boundary's token read does a recursive directory walk of the user's *global* Codex sessions directory — every session, every project, every day, accumulated for the lifetime of their Codex usage — plus a `stat` of every file and a first-line read of candidates. The same walk runs up to **30×** during session launch.
- **定位证据:**
  - `readCodexSessionUsage` → `findLatestCodexRollout` → `collectRolloutFiles` does `readdir(sessionsDir, { recursive: true, withFileTypes: true })` over the **whole tree** (`codex-session-capture.ts:100-124`), then `findLatestCodexRollout` loops every file with `await stat(file)` (`:157`) and `readRolloutSessionMeta` first-line reads for cwd-matching (`:164`).
  - The usage path passes `sinceMs: Number.NEGATIVE_INFINITY` (`codex-session-usage.ts:112`), so the mtime floor **does not prune** — only the running `bestMtimeMs` skips work *after* the `stat`, and files are visited in directory-walk order (not mtime-sorted).
  - Under official login `sessionUsageDir` resolves to global `~/.codex/sessions` (`agent-session-adapters.ts:841,864` → `resolveCodexSessionsDir(null)`). With a custom provider it is an isolated per-task dir and tiny — so the cost is **bimodal and bad specifically for the default setup**.
  - Launch amplifier: `captureCodexSessionId` polls `findLatestCodexSessionId` up to `DEFAULT_CAPTURE_ATTEMPTS = 30` times at 500 ms (`codex-session-capture.ts:41-42, 201-216`) — i.e. up to 30 full-tree walks per launch.
- **影响范围:** O(total historical rollout files) per Codex turn boundary, **per concurrent Codex session** (each task re-walks the same shared global tree — duplicated work). Grows unbounded with months of Codex usage, independent of the current task. All async (`node:fs/promises`), so it will **not** trip the stall watchdog, but it is heavy syscall I/O that degrades over time and multiplies under concurrency. This is the only path that worsens with both history *and* session count.
- **建议修复:** (a) **Resolved-path cache** per `(taskId, agentSessionId)` — once located, the rollout file path is stable for the session; subsequent refreshes skip the scan entirely and go straight to the (tail) read. Invalidate on relaunch (the capture-on-every-launch logic already re-resolves). (b) **Date-prune the walk** — descend only the newest `YYYY/MM/DD` dirs and early-exit on first cwd match (the active rollout is newest). (c) Sort candidates by mtime descending and stop at the first cwd match.
- **预估收益/风险:** **Largest win** — turns an unbounded O(all-history) scan (×30 at launch, ×N concurrent at steady state) into O(1)-after-first-resolution. Risk: low — cache-invalidation correctness on resume only; the launch capture already re-resolves so a per-launch-cleared cache is safe.

### T2 — Token-usage readers re-parse the entire JSONL every turn boundary, no cache

- **现象:** On every completed agent turn, the full session transcript is read from byte 0 and every line JSON-parsed, even though only the tail changed. The file grows monotonically with conversation length.
- **定位证据:**
  - Trigger is correctly bounded to **launch + turn boundary** (`session-manager.ts:768` and `:1392-1397`, fire-and-forget `void captureSessionUsage`). It is **NOT** on the broadcast/summary read path — `listSummaries()`/`getSummary()` return the cached `entry.summary.usage` (`session-manager.ts:411-418`). Good.
  - Claude: `readFile(filePath, "utf8")` of the **whole** transcript then `content.split("\n")` + `JSON.parse` per line into two `Map`s (`claude-session-usage.ts:150,69-135`). Claude writes one JSONL line per content block per turn, so this file is large and multi-line-per-message.
  - Codex: `readFile(located.file, "utf8")` + split + parse per line (`codex-session-usage.ts:119,45-89`).
  - **No mtime/size cache, no offset/tail read** in any of the three modules. Two reads can even race (launch self-heal `:768` vs near-simultaneous turn boundary `:1397`).
- **影响范围:** Per session, cost ≈ O(turns × final-transcript-size) ≈ quadratic in bytes over a long session; late-session turns are the most expensive. Multiply by concurrent active sessions. Async, so not a freeze — an avoidable CPU+I/O cost that scales with conversation length.
- **建议修复:** Cache by `(path, mtimeMs, size)` and skip re-parse when unchanged (lowest-risk, removes redundant re-parses including the launch/turn race). Better: incremental tail read — keep a byte offset + running dedup state (Claude's `Map`, Codex's last `total_token_usage`) and parse only appended bytes. Codex needs only the *last* `total_token_usage`, so a bounded tail read suffices.
- **预估收益/风险:** Big win on long sessions (turn cost O(file)→O(delta)). Risk: incremental parse must handle a torn trailing line and Claude's per-message cross-line dedup; the mtime+size cache variant is near-zero-risk and captures most of the benefit.

### T3 — `workspace_state_updated` snapshot spawns ~4 uncached git subprocesses per broadcast

- **现象:** Each terminal-agent turn boundary triggers a full workspace-state snapshot whose `loadWorkspaceContext` re-detects git repo info (current branch, branch list, default branch) by spawning git, with no memoization. N agents finishing turns at once → ~4N concurrent git processes on one repo.
- **定位证据:**
  - `broadcastRuntimeWorkspaceStateUpdated` → `buildWorkspaceStateSnapshot` → `loadWorkspaceState` → `loadWorkspaceContext`, which calls `detectGitRepositoryInfo(repoPath)` **uncached** (`workspace-state.ts:1239` and `:1260`).
  - `detectGitRepositoryInfo` (`:1151-1172`) runs `detectGitRoot` + `Promise.all([detectGitCurrentBranch, detectGitBranches])` + `detectGitDefaultBranch` ≈ **4 git subprocesses**. `prepareRepoRuntimeHome` is process-cached (comment `:1262+`) but the **git detection is not**.
  - **Gating (the saving grace):** the snapshot is fired only on real hook **state transitions** (`hooks-api.ts:115`; `activity` hooks early-return at `:73-75` and never reach it), pi checkpoint changes (`runtime-state-hub.ts:589`), and explicit tRPC board mutations — **not** per output chunk and **not** per summary. So frequency = turn boundaries, not stream rate.
- **影响范围:** O(sessions) git-spawn amplification when many sessions hit turn boundaries together. Async (won't hard-freeze — that was the prior `spawnSync` fix), but ~4N concurrent gits + N `getWorkspaceIndexLockRequest` acquisitions (`workspace-state.ts:1244`) will saturate/lag the repo. **Same root cause** as the June audit's L2-4 (the 1 s metadata-monitor git poll, June task #1) — git repo info isn't memoized — but a **distinct trigger** (snapshot-on-transition vs interval poll). SPECULATIVE on exact magnitude; CONFIRMED on structure.
- **建议修复:** (1) Memoize `detectGitRepositoryInfo` per `repoPath` with a short TTL (branch list changes rarely; collapses ~4N → ~4 spawns and also fixes June L2-4). (2) Debounce/coalesce `broadcastRuntimeWorkspaceStateUpdated` per-workspace (like the existing 150 ms summary debounce) so N near-simultaneous turn boundaries produce one snapshot.
- **预估收益/风险:** High under concurrent turn boundaries. Risk: a short-TTL git cache may show a stale branch list briefly after a branch op — low; the board-sync/checkpoint paths already tolerate eventual consistency. (Shared win with L2-4.)

### T4 — `workspaceTrustBuffer = ""` keeps the per-chunk decode gate open for the whole session

- **现象:** For Claude/Codex sessions, every filtered PTY chunk is decoded to a UTF-8 string and appended to a rolling buffer for the **entire session**, not just startup, because the trust buffer is `""` (truthy for the `!== null` gate), never reset to `null`.
- **定位证据:**
  - Seeded to `""` (not `null`) for Claude/Codex/Codex-launch-signature (`session-manager.ts:699-704`), and reset to `""` again after auto-confirm (`:583-585`) and on review transition (`:1383`) — **never `null`** (grep confirms no `= null` post-init).
  - Gate: `needsDecodedOutput = entry.active.workspaceTrustBuffer !== null || …` (`:556-560`) → permanently true → `const data = … filteredChunk.toString("utf8")` per chunk (`:560`), then `workspaceTrustBuffer += data` + length-check + `.slice(-16384)` when over `MAX_WORKSPACE_TRUST_BUFFER_CHARS` (`:562-568`).
- **影响范围:** Every Claude/Codex session (the two most-used CLI agents), full duration, on the hottest path: one string alloc + one concat (+ periodic 16 KB slice) per chunk. Same *class* of GC pressure the `92f07` micro-batch fix removed on the xterm side, relocated to session-manager and smaller in scale. Idle cost ~0; matters under heavy token streaming × N sessions.
- **建议修复:** Set `workspaceTrustBuffer = null` (not `""`) once the trust prompt is auto-confirmed / on the review transition, so the gate closes and the decode/concat stops. Alternatively decode lazily only inside the consuming branches.
- **预估收益/风险:** Moderate benefit under streaming. **Risk: moderate** — the buffer is also read by the Codex deferred-startup-input path (`:601-603`) and the transition detector relies on non-empty `data` (`:598`); nulling too early could break trust auto-confirm or Codex plan-mode startup. Must sequence the null-out after the relevant startup milestones and verify against Codex/Claude startup tests.

### T5 — `updateSummary` spreads the whole summary object per output chunk

- **现象:** `updateSummary(entry, { lastOutputAt: now() })` runs on every chunk and shallow-copies the entire summary object.
- **定位证据:** `session-manager.ts:591` (and restart path `:957`) → `updateSummary` does `entry.summary = { ...entry.summary, ...patch, updatedAt: now() }` (`:204-211`). It does **not** call `emitSummary`, so no broadcast — but it allocates a fresh ~15-field object per chunk.
- **影响范围:** Per-chunk allocation for every active session; combined with T4, the Claude/Codex data callback allocates a UTF-8 string + a concatenated string + a spread summary object per chunk. GC pressure under flood, no correctness impact.
- **建议修复:** Mutate `lastOutputAt`/`updatedAt` in place, or coalesce the `lastOutputAt` bump to the mirror's flush cadence (16 ms) instead of per chunk.
- **预估收益/风险:** Low benefit, low risk. Trivial if T4 is being touched anyway (same callback).

### T6 — Two journal instances over one `messages.jsonl`

- **现象:** pi's `PiTaskSessionService` and the `TerminalSessionManager` each construct a separate `FileSessionMessageJournal` pointed at the **same** per-workspace sessions dir, so a CLI task's file is written by the terminal journal but read through the pi journal.
- **定位证据:** Both wired to `getWorkspaceSessionMessagesDirPath` (`runtime-server.ts:170-172`, `workspace-registry.ts:255-257`). `getTaskChatMessages` always calls `piService.loadTaskSessionMessages` first (`runtime-api.ts:498`); because pi returns non-empty, the terminal-fallback branch (`:502-510`) is skipped. The two instances have independent `lastAppended`/`staleAppends`/`generation`/compaction state over one file.
- **影响范围:** Not a hot-path cost — reads are memoized per generation via `SessionMessageMergeCache` (`session-manager.ts:356-360`), so it's **one** read per open in steady state, and `mergeSessionMessages` is O(n) (Map/Set, `session-message-journal.ts:399-417`). The issue is **correctness-adjacent**: split compaction bookkeeping over a shared file.
- **建议修复:** Route CLI-task reads through the terminal manager (the summary already disambiguates the owning agent), or share a single per-workspace journal instance between pi and terminal services.
- **预估收益/风险:** Low; mostly robustness, not speed. Low risk (read-routing branch only).

### T7 — Reconnect snapshot serializes the full ≤5k-line buffer

- **现象:** `SerializeAddon.serialize()` with no range walks the entire scrollback (up to 5000 rows × cols) into one ANSI string.
- **定位证据:** `terminal-state-mirror.ts:150` (`serialize()` no-arg → addon's full-buffer default). Only consumer is `getRestoreSnapshot` (`session-manager.ts:437-443`) → `ws-server.ts:498-499`, fired **once per control-socket connection** (viewer attach/reconnect), never per-chunk or per-broadcast.
- **影响范围:** Reconnect-only synchronous CPU walk + large string alloc on the operation queue. Small blast radius.
- **建议修复:** Optional — cap restore depth with `serialize({ scrollback: N })` (a reconnecting viewport needs the last few hundred rows, not 5000). Does not affect transcript fidelity (that's the separate `getCommittedLines` path).
- **预估收益/风险:** Low; only worth doing if reconnect latency is ever observed. Risk: scrollback above N won't repaint on reconnect.

---

## Refuted / non-issues (checked, no action)

- **"~6.7 Hz `lastOutputAt`-driven projects broadcast" — REFUTED.** The per-chunk `updateSummary(lastOutputAt)` at `session-manager.ts:591` does **not** call `emitSummary` (all emit sites are discrete events: transitions, launch, usage capture, exit — verified by grep of `emitSummary` call sites). So `task_sessions_updated` and the downstream `broadcastRuntimeProjectsUpdated` fire at **emit/turn frequency** (debounced 150 ms per workspace, `runtime-state-hub.ts:33,190-204`), not per output chunk. The residual T8 (board read × all projects per flush, `workspace-registry.ts:351-377`) is therefore Low severity: refresh only the flushed workspace's counts / gate on count-affecting changes.
- **`getCommittedLines` full-scrollback rescan — RESOLVED** (June #7, now cursor-based; see Regression check).
- **Mirror per-chunk `Buffer.from` copy — RESOLVED** (June #9, now zero-copy; see Regression check).
- **`mergeSessionMessages` quadratic — FALSE.** O(persisted + live), Map/Set lookups (`session-message-journal.ts:399-417`).
- **Journal per-token writes — FALSE.** 250 ms debounce + id-change append + content dedup (`session-message-journal.ts:147-200`); terminal agents emit one assistant message per turn anyway.
- **Per-task busy loops / stacking intervals — NONE.** Per-session timers (mirror 16 ms flush, journal 250 ms) are `unref`'d and self-clearing; the only always-on O(workspace) loop is the metadata monitor (June L2-4), one per workspace, not per session.
- **fsync per write — NONE.** `appendFile` / atomic rewrite, no `fsync` (`session-message-journal.ts:189,314`).

---

## Cross-reference — still-open June-audit items that bear on the terminal chain

These are not re-derived here; see `performance-audit-2026-06.md`. They compound with the findings above:

- **L2-4 / June #1 — metadata monitor 1 s git poll, O(N tasks) git forks per workspace** (the "fan spins up with multiple tasks" idle-CPU symptom). **Shares T3's root cause** (git repo info uncached); fixing `detectGitRepositoryInfo` memoization + `resolveRepoRoot` cache benefits both. *Highest steady-state idle-CPU item overall.*
- **L4-1 / June #11 — worktree creation runs 5–8 serial git ops under a per-repo lock** (only when starting tasks needing *fresh* worktrees).

---

## Priority-ranked implementation task list

ROI = (impact × likelihood) ÷ (effort × risk). All are independent unless noted.

| Pri | Task | Finding | Location | Effort | Risk | Gain |
|-----|------|---------|----------|--------|------|------|
| **P0** | Cache the resolved Codex rollout path per session + date-prune the walk + early-exit on first cwd match | T1 | `codex-session-capture.ts:100,149-172`; `codex-session-usage.ts:103-124` | Med | Low | **High** (kills the only unbounded-with-history × concurrency path; also speeds the 30× launch capture) |
| **P1** | `(path,mtime,size)` cache (min.) or incremental tail-read for token usage | T2 | `claude-session-usage.ts:142-155`; `codex-session-usage.ts:103-124` | Low (cache) / Med (tail) | Low | High on long sessions |
| **P1** | Memoize `detectGitRepositoryInfo` per repoPath (short TTL) + debounce `broadcastRuntimeWorkspaceStateUpdated` | T3 | `workspace-state.ts:1151,1239,1260`; `runtime-state-hub.ts:359-385` | Low–Med | Low | High under concurrent turns; **also fixes June L2-4** |
| **P2** | Close the decode gate: set `workspaceTrustBuffer = null` after trust auto-confirm / review transition | T4 | `session-manager.ts:583-587,699-704,1383` | Low | **Med** (verify Codex/Claude startup detection) | Med under streaming |
| **P2** | `broadcastRuntimeProjectsUpdated`: refresh only the flushed workspace / gate on count-affecting changes | T8 | `runtime-state-hub.ts:187`; `workspace-registry.ts:351-377` | Low | Low | Low–Med on multi-project hosts |
| **P3** | In-place `lastOutputAt` update (no per-chunk object spread) | T5 | `session-manager.ts:204-211,591` | Low | Low | Low (fold into P2/T4 work) |
| **P3** | Route CLI-task transcript reads through the owning journal (or share one instance) | T6 | `runtime-api.ts:493-516`; `runtime-server.ts:170` | Low | Low | Low (robustness) |
| **P3** | Cap reconnect serialize depth `serialize({ scrollback: N })` | T7 | `terminal-state-mirror.ts:150` | Low | Low | Low (reconnect-only) |

**Suggested wave plan**
- **Wave A (high-leverage, low-risk):** P0 (T1 rollout-path cache), P1 (T2 mtime cache), P1 (T3 git-info memoize) — these three remove the unbounded/quadratic/amplified I/O and share a theme (stop re-doing expensive reads that didn't change).
- **Wave B (careful):** P2 (T4) — real per-chunk GC win but startup-sequencing sensitive; do with tests. P2 (T8) cheap correctness/efficiency.
- **Backlog:** P3 polish (T5/T6/T7).

**Confidence & next step:** All structural claims are read from source (`file:line` cited). Absolute magnitudes (transcript sizes, rollout-file counts, turn rates) are **not measured**. Before investing in P0–P1, capture a quick profile under a controlled multi-session Codex-official-login load (e.g. 5 concurrent tasks, several turns each, a populated `~/.codex/sessions`) — that scenario is where T1+T2+T3 compound, and it will confirm the ranking. The lean PTY/mirror/journal hot paths need no further work; the cost has moved into the **read/broadcast layer's coupling to growing on-disk transcripts and uncached git**.
