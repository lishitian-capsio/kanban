# Kanban web-ui 渲染性能调研 — 瓶颈清单

调研范围：`web-ui/src`（React 18.3 + Vite 6）。方法：按四个轴（React 重渲染热点、大列表/虚拟化、首屏、内存）分别做证据级代码审计，逐条核实 `file:line`。**本文不改业务代码**，仅作为后续实现任务的输入。

调研日期：2026-06-29。代码基线：worktree `d739a`（branch HEAD，main 同步点 `ac5b3589`）。

---

## TL;DR — 一句话定位

- **首屏**：全应用零代码分割（生产代码无 `React.lazy`/`Suspense`），数据库、Vault Markdown 编辑器、diff 渲染器、xterm、23 个 Prism 语法全部静态进入入口 bundle，冷启动要先下载/解析/执行用户还没打开的界面。
- **重渲染**：`runtime-stream-store` 的 granular 设计基本完好（chat/board-sync/ops-metrics 都正确在叶子 fiber 订阅），但有一个结构性回归——高频的 `task_sessions_updated`（~150ms 批次）被并进 **App 级** `workspaceState` slice，导致 agent 工作期间整棵 App 子树每秒重渲染数次。
- **大列表**：chat / git commit / database 已用 `react-virtuoso` 虚拟化（健康）；**看板列**未虚拟化（靠 `content-visibility` 兜底，>几百卡有风险）；**split 模式 diff 查看器**每行 Prism 高亮无缓存且不虚拟化（大 PR review 卡顿）。
- **内存**：监听器/订阅清理干净，但 **每个开过终端的任务保留 10k 行 xterm 滚动缓冲 + 活动 socket + WebGL context 永不释放**；`taskChatMessagesByTaskId` 等按 taskId 键的 Map 在会话内只增不减、单任务无淘汰。

优先级总览：

| # | 现象 | 轴 | 优先级 |
|---|---|---|---|
| 1 | 零代码分割，重依赖全进首屏 bundle | 首屏 | **P0** |
| 2 | `task_sessions_updated` 落入 App 级 `workspaceState` → 全 App 重渲染 | 重渲染 | **P1** |
| 3 | 每任务 xterm 终端保留 10k 滚动+socket+WebGL，切任务不释放 | 内存 | **P1** |
| 4 | `taskChatMessagesByTaskId` 数组无上限、单任务无淘汰 | 内存 | **P1** |
| 5 | split diff 每行 Prism 高亮无缓存 + 不虚拟化 | 大列表 | **P1** |
| 6 | `KanbanBoard`/`BoardColumn`/`CardDetailView` 未 `React.memo`，放大 P1 级联 | 重渲染 | P2 |
| 7 | `HomeSessionCard` 每个 tick 重渲染 | 重渲染 | P2 |
| 8 | 看板列未虚拟化（content-visibility 兜底） | 大列表 | P2 |
| 9 | transcript 传输层只有单条 64KB cap，无总量上限 | 首屏 | P2 |
| 10 | `geometryVersionByTaskId` / metadata 记录按任务永不清理 | 内存 | P2 |

---

## P0 — 首屏：零代码分割，重依赖全部静态进入入口 bundle

**现象**：整个应用作为单个静态模块图加载。首屏（看板/home chat）渲染要等还没显示的界面（数据库、Vault 编辑器、diff 查看器、终端）的 JS 一起下载+解析+执行完。

**定位证据**：
- `web-ui/vite.config.ts`：`build.minify: false`（为 xterm 故意不压缩），`manualChunks` 只把 `@xterm` 拆成 `xterm-vendor`，**无路由/功能级拆分**。注释自述不压缩成本约 545KB raw / 58.5KB gzip。
- 全仓 grep `React.lazy|lazy(|Suspense|import(`（`*.tsx/*.ts`）**仅命中测试文件**，生产代码 0 处。
- `App.tsx:10-38` 直接静态 import 全部重界面：`CardDetailView`(L10)、`DatabaseView`(L12)、`AgentTerminalPanel`(L14)、`GitHistoryView`(L15)、`VaultView`(L38)。
- 重依赖及其拖入入口图的静态链：
  - `prismjs` + 23 个语法文件 + `react-markdown` + `remark-gfm` ← `components/detail-panels/kanban-markdown-content.tsx:1-29`（**最严重的 eager offender**：模块求值时无条件 `import "prismjs/components/prism-*"` 23 次）← chat message item ← chat panel ← home sidebar ← `App.tsx:19`。
  - `@xterm/xterm` + 5 个 addon（webgl/fit/unicode11/web-links/clipboard）← `terminal/persistent-terminal-manager.ts:2-7`（虽走独立 chunk，但仍是入口的**静态**依赖，冷启动照样 fetch）。
  - `@uiw/react-md-editor` + CSS ← `components/vault/editor/doc-editor.tsx:1-3` ← VaultView ← `App.tsx:38`。
  - `diff` + Prism ← `components/shared/diff-renderer.tsx` ← `diff-viewer-panel` ← `card-detail-view.tsx:9`。
  - 数据库查看器、`react-rnd`（float dock）同理。

**影响范围**：每次冷启动 / 硬刷新、所有用户。默认首屏是看板/home，却透传拉进 diff 渲染器、全套 Prism 语法、xterm、md-editor、DB grid。

**建议修复**：对 `App.tsx` 里已被布尔 state 门控（`isDatabaseOpen`/`isVaultOpen`/`selectedCard`/`chatDock.open` 等）的界面级组件用 `React.lazy` + `Suspense`——`DatabaseView`、`VaultView`、`GitHistoryView`、`CardDetailView`、`AgentTerminalPanel`/`DockableChatPanel`。这些已有渲染 guard，lazy 边界能干净对齐。另外把 `kanban-markdown-content`（Prism）、`diff-renderer` 也做 lazy，让纯看板首屏不为它们付费；并给 `react-md-editor`/`prismjs`/`database/*` 加 `manualChunks`。

**预估收益/风险**：收益高——首屏 JS 体积/解析时间可观下降（最大单项收益）。风险低——界面已门控，lazy 边界对齐现有渲染条件；需为每个 lazy 界面加 `Suspense` fallback（已有 `Spinner` 可复用），并验证 vite 在 `minify:false` 下的分块产物。

---

## P1 — 重渲染：`task_sessions_updated` 并入 App 级 `workspaceState`，agent 工作期间整棵 App 每 ~150ms 重渲染

**现象**：只要有 agent 在跑，App 组件（1284 行）及其整个可见子树每秒重渲染数次，即便用户可见内容没变。这正是 granular-store 规则要避免的全树重渲染——规则在 chat/metrics/board-sync 上落实了，唯独 session summaries 漏了。

**定位证据**：
- 广播高频（上限 ≈6.7×/s）：`src/server/runtime-state-hub.ts:33` `TASK_SESSION_STREAM_BATCH_MS = 150`；`:190-204` `queueTaskSessionSummaryBroadcast` 每 150ms flush。
- 落入 App 级 slice 而非 per-task slice：`runtime/runtime-stream-store.ts:315-325` reducer 处理 `task_sessions_updated` 时**新建 `workspaceState` 对象**（`{...state.workspaceState, sessions: merge(...)}`）。
- `hooks/use-project-navigation.ts:101` `useRuntimeWorkspaceState()` 在 **App 级**订阅（use-project-navigation 直接在 `App.tsx:129` 调用）→ 新 `workspaceState` 引用唤醒该监听器。
- 进一步：值流入 `useWorkspaceSync`（`App.tsx:215`），`applyWorkspaceState` → `setSessions((cur)=>merge(...))`（`hooks/use-workspace-sync.ts:111-114`）**每次都 alloc 新 `{...currentSessions}`**（L43），App 本地 `sessions` 身份每 tick 也变。

**影响范围**：App 重渲染 → 因 App→board 路径无 memo（见 P2），`KanbanBoard` → 4 个 `BoardColumn` → `CardDetailView`（若打开）全部重渲染；只有 `BoardCard`（唯一 memo 节点，`board-card.tsx:781`）在 props 引用稳定时 bail out。浪费的是看板骨架+列+详情视图，每 150ms 一次，持续整个 agent 生命周期。

**建议修复**：把 task-session summaries 当作和 chat 同构的 **per-task granular slice**——加 `sessionSummaryByTaskId` 监听器映射 + `useTaskSessionSummary(taskId)` 叶子 hook，让 `BoardCard`/`CardDetailView`/`HomeSessionCard` 各自在叶子订阅自己任务的 summary，而不是从 App 透传整个 `taskSessions` record；App 停止从 `workspaceState` 派生本地 `sessions`。低成本部分缓解：把 board（低频）从 `workspaceState` 拆出，使纯 session tick 不动看板读的 slice。

**预估收益/风险**：收益高——消除 agent 工作期最主要的持续 CPU 浪费，且解锁 P2 的 memo。风险中——需新增 per-task slice 与监听器路由（已有 chat 的同款实现可照搬，`runtime-stream-store.ts:543-577`），并改动 App↔board 的数据流；要回归测试 `runtime-stream-store.test.tsx` 的隔离断言。

---

## P1 — 内存：每任务 xterm 终端保留 10k 滚动缓冲 + 活动 socket + WebGL，切任务不释放

**现象**：每个开过终端面板的任务，都在模块级 Map 里保留一个活的 `xterm.Terminal`（最多 1 万行滚动缓冲）。切到别的任务**不** dispose，只把 DOM host “停靠”到屏外。

**定位证据**：
- 滚动 1 万行：`terminal/terminal-options.ts:41` `scrollback: 10_000`。
- 模块级保留 Map：`terminal/persistent-terminal-manager.ts:726` `const terminals = new Map<string, PersistentTerminal>()`；`ensurePersistentTerminal`(728-746) 只插入不自动淘汰。
- taskId 变化时 effect cleanup 只 `unmount`（停靠+断开 ResizeObserver），**不 dispose**：`terminal/use-persistent-terminal-session.ts:138-144`。
- 真正 `.dispose()` + 删 Map 的 `disposePersistentTerminal`(manager 748-756) 只在 hook disabled 或 workspaceId 变 null 时触发（`use-persistent-terminal-session.ts:69,82`）；日常任务间切换都不命中。全量清理只在切 workspace 时（`disposeAllPersistentTerminalsForWorkspace` 758-766）。

**影响范围**：随当前 workspace 会话内“开过终端的任务数”增长。每个保留的 `PersistentTerminal` 持有真实 xterm 缓冲（10k 行）+ WebGL context + 4 addon + **两个仍连接的 WebSocket**（io+control，停靠时仍收/写输出）。不只是内存——是 N 个活 socket + N 个 WebGL context；浏览器 WebGL context 上限 ~16，频繁切任务可能静默丢渲染器。

**建议修复**：LRU 淘汰停靠的终端（保留最近 ~3-5 个，超出 dispose），或 taskId 变化即 dispose 并依赖服务端 restore（manager 已实现 `restore` 快照路径 449-472，可恢复滚动）。最低限度：停靠时降低 `scrollback` 或关闭 socket。

**预估收益/风险**：收益高——封顶真实内存+socket+WebGL 占用。风险中——LRU 需保证 restore 路径在重建后能恢复滚动（已有快照机制），要测“切回已淘汰任务”的体验回归。

---

## P1 — 内存：`taskChatMessagesByTaskId` 数组无上限，且单任务条目从不删除

**现象**：流式 transcript 永久累积。单任务数组无 cap/裁剪；任务被 trash/删除时也不淘汰该任务的数组条目。

**定位证据**：
- `runtime/runtime-stream-store.ts:42` `taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>`。
- 追加路径 `upsertTaskChatMessage`(129-150)：未命中 id 即 `[...currentMessages, nextMessage]`，**无长度检查**（对比 `appendOpsMetricsSample` 84-90 有 60 上限）。
- 仅整体清空（`initialize`116 / `requested_workspace_changed`175 / `snapshot`212 / `projects_updated`238），**无 `delete state.taskChatMessagesByTaskId[taskId]` 单任务路径**；`task_chat_cleared`(255-264) 只把数组置 `[]` 仍留 key，且只由显式 clear 触发，trash 不触发。

**缓解事实（为何 P1 非 P0）**：pi 每个 token 复用同一 message id，`upsertTaskChatMessage`(137-149) 原地替换而非按 token 追加 → 数组按**消息数**增长而非 token 数。无界维度是“消息数 + 任务数”，不是 token 数。

**影响范围**：随会话内（a）累计流过的消息总数、（b）流过的不同任务数（key 累积）增长；每条保留完整 `content`。done==trash 同桶，看板会持续 churn 大量任务，key 稳步累积。

**建议修复**：给每任务数组封顶（保留最近 N 条 + in-band 截断标记，对齐后端 journal 的 `maxMessages`）；加淘汰路径——任务离开看板/被 trash 时 `delete taskChatMessagesByTaskId[taskId]`（及指向它的 `latestTaskChatMessage`），由 `workspace_state_updated`/`task_sessions_updated` diff 已知 task id 驱动。同时 `mergeMessages`/`upsertTaskChatMessage` 每次更新 clone 整数组 + `JSON.stringify(meta)` 比较（`runtime-stream-store.ts:143`、`use-kanban-chat-session.ts:45`）随 transcript 长度产生 GC 压力，封顶数组同时缓解此 churn。

**预估收益/风险**：收益中高——封顶长会话内存与流式更新的 GC churn。风险低——封顶是纯展示层裁剪（后端 journal 仍是真相）；淘汰逻辑需确保不误删仍在看板的活动任务。

---

## P1 — 大列表：split 模式 diff 查看器每行 Prism 高亮无缓存，且整文件不虚拟化

**现象**：打开大改动的 review diff 查看器时，**每一** diff 行都渲染成 DOM 行（无虚拟化），且 split 模式下**每次渲染**对每行跑一次 Prism 高亮、**无缓存**。

**定位证据**：
- 不虚拟化：`diff-viewer-panel.tsx:227` `displayItems.map(...renderRow)`，split 模式 `:430 pairs.map(...)` / `:240 item.block.rows.map(...)`；多文件叠加 `:838 groupedByPath.map(...)` / `:890 group.entries.map(...)`。
- split 无缓存高亮：`diff-viewer-panel.tsx:371` `getHighlightedLineHtml(row.text, prismGrammar, prismLanguage)` 在 `renderSide` 内联调用 → `Prism.highlight(...)`（`diff-renderer.tsx:144`）每行每次渲染都跑。**对比** UnifiedDiff 预算了 memo 化的 `highlightedOldByLine`/`highlightedNewByLine`（`diff-viewer-panel.tsx:143-150`）——unified 有缓存，split 没有，这是不一致而非单纯缺优化。
- 行是普通元素非 memo 组件，父级重渲染（如内联评论输入 `:215/:417`、展开/折叠）会重跑全部。

**影响范围**：仅 code review / diff 查看器。几百行改动的文件（或多文件展开）在 split 模式每次渲染跑数百次 `Prism.highlight` + 数百 DOM 节点；1000+ 行或多大文件同时展开时严重（多百 ms 渲染、评论输入卡顿）。

**建议修复（按性价比）**：(1) **缓存 split 高亮**对齐 unified——按 `[rows, grammar, language]` 预算 memo 化 `Map<lineNumber, html>`（复用 `buildHighlightedLineMap`），替掉 L371 内联调用；(2) 把 `renderRow`/`renderSide` 抽成 `React.memo` 组件（按 row+comment 键），让评论编辑不重高亮整文件；(3) 长文件用 `react-virtuoso`（已是依赖）虚拟化 `displayItems`，至少懒渲染折叠文件。

**预估收益/风险**：收益高（review 大 PR 是核心流程）。风险低——(1) 纯计算缓存，行为不变；(2)(3) 需小心 diff 行的 key 与评论态。

---

## P2 — 重渲染：核心看板/详情组件未 `React.memo`，放大 P1 级联

**现象**：因 App 频繁重渲染（P1），所有未 memo 的子组件随之重渲染，到叶子卡片前没有 memo 边界拦截。

**定位证据**（grep 确认均未 memo，仅 `BoardCard` 是）：`kanban-board.tsx:32` `KanbanBoard`、`board-column.tsx:16` `BoardColumn`（收整个 `taskSessions` record，L49/L210）、`card-detail-view.tsx:327` `CardDetailView`（`App.tsx:1108` 传 `taskSessions={sessions}`，故除自身正确的叶子 chat 订阅外，还随每次 board session tick 重渲染）、`top-bar.tsx:301` `TopBar`；唯一 memo：`board-card.tsx:781`。

**回调稳定性注意**：App 的看板 handler 来自 `useBoardInteractions`，多个依赖 `board`（`use-board-interactions.ts:657-668` handleDragEnd、`:680` handleStartTask、`:745` handleCardSelect），`board` rehydrate 时身份变。`BoardColumn` 已用稳定的 `handleCardActivate`（`board-column.tsx:82-91`）护住 `BoardCard`，但因上层未 memo，目前这些不稳定回调没造成额外渲染。要上 memo 必须先稳定它们（在 handler 内用 ref 读 `board`，如 `kanban-board.tsx` 已对 `latestDataRef` 做的）。

**影响范围**：把 P1 成本沿整个看板骨架 + 打开的详情视图放大。

**建议修复**：先修 P1（summaries 不再 churn App），再给 `KanbanBoard`/`BoardColumn`/`CardDetailView` 加 `React.memo` 并稳定 `board` 依赖的回调；停止把整个 `taskSessions` record 传进这些组件，改用叶子订阅 per-task summary。

**预估收益/风险**：收益中（依赖 P1 先落地，否则 memo 因 props 不稳定而无效）。风险中——回调稳定化要避免闭包读到旧 `board`。

---

## P2 — 重渲染：`HomeSessionCard` 每个 session tick 重渲染（即便计数没变）

**现象**：全屏 Home launcher 可见且 agent 在跑时，每个 session tile 每 ~150ms 重渲染，不管其展示的任务计数是否变化。

**定位证据**：`components/home-agent/thread-task-counts.ts:72-76` `useHomeThreadTaskCounts` 订阅 App 级高 churn slice（`useRuntimeWorkspaceState()` → `board`）；`home-session-card.tsx:71` 每卡调用；`HomeSessionCard`（`home-session-card.tsx:55`）未 memo，在 launcher grid 按 thread 映射（`home-chat-workspace.tsx:231-232`）。

**缓解事实（为何 P2）**：reducer 在 `task_sessions_updated` 时保留 `workspaceState.board` 引用（`runtime-stream-store.ts:319-325` 只换 `sessions`），故内层 `useMemo([board, threadId])` 返回缓存计数，计数身份不变。浪费的是未 memo 的 `HomeSessionCard`（及 `useHomeSessionCard`）每 tick 重渲染，非重算。

**影响范围**：Home tab 打开且 agent 活动时 N 个 launcher tile 每 150ms 重渲染，受 thread 数约束，但完全可避免。

**建议修复**：让 `useHomeThreadTaskCounts` 读 board-only slice（见 P1 拆分），或给 `HomeSessionCard` 加忽略“引用变但值稳”props 的比较器 memo。最干净是 P1 提出的 per-task-summary slice。

**预估收益/风险**：收益低中（受 thread 数限）。风险低——随 P1 一并解决。

---

## P2 — 大列表：看板列未虚拟化（靠 content-visibility 兜底）

**现象**：每列对每张卡渲染一个 `<BoardCard>`，无 windowing。长 trash/done 尾巴或大 backlog 要为每卡付 React 协调 + DOM 节点。

**定位证据**：`board-column.tsx:186-235` IIFE 遍历 `displayedCards` push `<BoardCard>`；`kanban-board.tsx:408` 映射所有列。兜底：`styles/globals.css:416-419` `.kb-board-card-body { content-visibility: auto; contain-intrinsic-size: auto 92px }` 跳过屏外卡的 paint/layout——但**不**跳过 React 渲染/协调/DOM 创建，每个 `BoardCardComponent` 仍跑 hooks、`useMeasure` ResizeObserver（`board-card.tsx:130`）、文本宽度测量（canvas `descriptionDisplay` useMemo `:238-266`）。`BoardCard` 是 memo，稳态便宜；O(N) 成本在首挂载 + per-card ResizeObserver 注册。

> **content-visibility / suppressCulling 机制核查：完好。** 卡换列会 re-parent 进不同 `<Droppable>`→React 挂新元素，其 `content-visibility:auto` 无记忆 intrinsic size→首帧跳 paint=闪烁；修复用 `findColumnChangedCardIds`（`state/board-card-moves.ts:30`）+ `recentlyMovedCardIds`（`kanban-board.tsx:392-393`）→ `board-column.tsx:209 suppressCulling` → `board-card.tsx:433 style={{contentVisibility:"visible"}}` 强制首帧 paint。确认仍生效。另一处 content-visibility（`.kb-db-cell` globals.css:428）在 `TableVirtuoso` 内，行 DOM 回收、排序/筛选是整表数据换不是原地 re-parent，无同类闪烁，**无需保护**。

**影响范围**：所有看板列。~100-200 卡/列平滑（content-visibility 扛住）；300-500+ 时首挂载/切项目成本 + ResizeObserver churn 上升，滚动仍 OK（paint 被 cull）。`@hello-pangea/dnd` 要求每个 `<Draggable>` 在 DOM，drop-in 虚拟化会破坏拖拽。

**建议修复**：典型负载可维持现状。若列常超 ~500 卡，现实做法**不是** drop-in virtuoso（破坏 rbd），而是封顶终态列（trash/done）尾巴（渲染最近 N + “show more”），因为这些是无界列。

**预估收益/风险**：收益条件性（仅大看板）。风险中——虚拟化与 rbd 冲突，封顶尾巴是更稳的折中。

---

## P2 — 首屏：transcript 传输层只有单条 64KB cap，无总量上限

**现象（核查结论）**：64KB cap 工作正常且在首屏传输路径上（对失控单条消息有效），但“多条 <64KB 消息组成的长 transcript”在初次 fetch 时总量不受限。

**定位证据**：`src/session/session-message-display-cap.ts:21` `MAX_DISPLAY_CONTENT_CHARS = 64*1024`；`capChatMessagesForTransport`(50-66) **按条**裁剪保留 head + 截断标记。仅在 fetch 边界应用：`src/trpc/runtime-api.ts:493-519` `getTaskChatMessages`（pi 路径 L519 + terminal fallback L508）——正是首屏路径（chat panel 挂载经 `use-kanban-chat-session.ts:121-151` 拉历史）。**仅按条**，传输投影无总量字节/条数 cap；on-disk journal 的 `DEFAULT_MAX_MESSAGES = 10_000`（`session-message-journal.ts:37`）是持久化条数 cap 非首屏 payload 上限（理论 ~640MB）。**实时**广播路径（`runtime-state-hub.ts:206-220`）不 cap（单 token 不大，OK）。

**影响范围**：仅病态场景（数千条历史的任务）。典型 transcript 无碍。长 transcript 的首屏渲染成本已被 Virtuoso 虚拟化缓解（见 P2 大列表），剩余主要是 JSON 数组的序列化+解析。

**建议修复**：若长历史首屏成为问题，给传输投影加总量上限（初次 fetch 只回最近 N 条 / 最近 M 字节 + “load earlier”），而非只靠按条 cap。

**预估收益/风险**：收益低（病态场景）。风险低——纯传输投影改动。

---

## P2 — 内存：`geometryVersionByTaskId` 与 workspace-metadata 记录按任务永不清理

**现象**：两处与 P1（chat Map）同形的“按 taskId 键、单任务不删”小泄漏。

**定位证据**：
- `terminal/terminal-geometry-registry.ts:25-31` `clearTerminalGeometry` 删 geometry 条目但 `nextGeometryVersion(taskId)` 递增 `geometryVersionByTaskId`、从不删除 → 每个见过的 task id 留一个小整数条目（字节极小，但会话内无界）。
- `stores/workspace-metadata-store.ts:16-27` `taskWorkspaceInfoByTaskId`/`taskWorkspaceSnapshotByTaskId`/`taskWorkspaceStateVersionByTaskId` 三个增长型 record。**listener** map 正确裁剪（L88 set 空即 delete），但三个数据 record **无单任务删除**，按任务数无界（条目为小结构对象）。

**影响范围**：随会话内见过的不同任务数增长，单条字节小，超长会话累积。

**建议修复**：`clearTerminalGeometry` 同时 `delete geometryVersionByTaskId[taskId]`（caller 经 `prepareWaitForTerminalGeometry` 默认 0 重新播种）；三个 metadata record 在任务离开看板时随 P1 一并裁剪。

**预估收益/风险**：收益低（字节小）。风险低——与 P1 淘汰逻辑共用驱动。

---

## 已核查为健康（无需改动，记录以免重复排查）

- **granular-store 规则在 chat/board-sync/ops-metrics 上正确落实**：`useTaskChatMessages`/`useLatestTaskChatMessageForTask` 仅在叶子订阅（`card-detail-view.tsx:477-478`、`home-agent-conversation.tsx:128`、`use-home-session-card.ts:33`）；`useRuntimeBoardSyncStatus` 仅 `home-board-sync-control.tsx:15`（在 TopBar 内但独立 fiber）；`useRuntimeOpsMetrics(History)` 仅 `sidebar-ops-status-bar.tsx:38-39`（叶子）。**未发现**任何高频 slice 在 App 级订阅（唯一问题是 `workspaceState` 实际并非低频——见 P1）。
- **token chip 不在前端解析 session 文件**：`session-meta-badges.tsx:36-39` 直接读 `summary.usage.totalTokens` 等预算字段；JSONL 解析在后端（`src/terminal/claude-session-usage.ts`、`codex-session-usage.ts`）折进 summary。仅 `formatTokenCount` O(1) 格式化，`board-card` memo。
- **首屏渐进、URL 种子、虚拟化**：store 模块加载即从 URL 播种 `currentProjectId`（`runtime-stream-store.ts:370-378`）避免 loading 闪；App 区分 `isInitialRuntimeLoad`/`isAwaitingWorkspaceSnapshot`，仅对 `shouldShowProjectLoadingState` 显示 Spinner（`App.tsx:134-136,978-981`），非全屏白屏；chat（`kanban-agent-chat-panel.tsx`）、git commit（`git-commit-list-panel.tsx`，Virtuoso + `endReached` 增量）、database（`database/data-grid.tsx` TableVirtuoso）均虚拟化。
- **监听器/订阅清理干净**：per-field/per-task 订阅集合空即 delete（`runtime-stream-store.ts:384-394,543-577`、`workspace-metadata-store.ts:77-91`）；WebSocket 在 cleanup/dispose 关闭并清重连定时器（`use-runtime-state-stream.ts:48-57,245-251`、`persistent-terminal-manager.ts:710-723`，含 stale-socket guard）；所有 `addEventListener` 有配对 `removeEventListener`（`use-dependency-linking.ts`、`dependency-overlay.tsx` 含 ResizeObserver/MutationObserver/rAF、`directory-autocomplete.tsx`、`notification-badge-sync.ts`；`use-theme.ts:316` 的 storage 监听是 app 生命周期单例，非泄漏）；所有 `setInterval`/`setTimeout` 有 clear；observer 有 disconnect。
- **拖拽不按 pointer-move 重渲染**：`@hello-pangea/dnd` 内部处理拖动位移；board state 仅在 `handleDragStart`/`handleDragEnd` 生命周期变（`kanban-board.tsx:365`、`use-board-interactions.ts:589`）。唯一代价：drag start/end 翻 `activeDragTaskId` 透传各列（`isCardDropDisabled` `board-column.tsx:104-109`）使所有列重渲染一次/手势，非 per-move，可接受。
- **ops-metrics 历史封顶 60**（`runtime-stream-store.ts:82-90`），切 workspace/snapshot 重置。

---

## 建议执行顺序

1. **P0 代码分割** — 独立、收益最大、风险最低，可先做。
2. **P1 per-task session-summary slice**（#2）—— 解决 agent 工作期最大持续浪费，并解锁 P2 #6/#7 的 memo。复用现有 chat 的 per-task 通道实现。
3. **P1 终端 LRU 释放**（#3）与 **P1 chat Map 封顶+淘汰**（#4）—— 内存/socket/WebGL 封顶，可与 #2 的“任务离开看板”淘汰驱动共用。
4. **P1 split diff 高亮缓存**（#5）—— 独立、review 核心流程收益高。
5. **P2** #6/#7（随 #2）、#8（仅大看板）、#9（仅长历史）、#10（随 #3/#4）。

各条均为后续实现任务的输入，落地前应按对应 `file:line` 复核当前代码（本基线为 worktree `d739a`）。

---

## 实现状态（第一轮 commit `2d2f9724` + 第二轮）

第一轮（`2d2f9724`）落地：P0 代码分割（lazy 各重界面 + lazy markdown）、P1 #2 per-task session slice、P1 #3 终端 LRU、P1 #4 chat 数组**封顶**（1000）、P1 #5 split diff **高亮缓存**。

第二轮补齐第一轮遗漏的子项（仅 P0/P1，逐条复核确认未做）：

- **P0 — AgentTerminalPanel lazy 边界被静态导入击穿（已修）**：`home-agent-conversation`（首屏 home 侧栏）静态 `import` `AgentTerminalPanel`，把 `persistent-terminal-manager → @xterm` 拉进入口 chunk，使 `dist/index.html` 在首屏 `modulepreload` 了 `xterm-vendor`（620KB raw / **142KB gzip**）。新增共享 `agent-terminal-panel-lazy.tsx`（`LazyAgentTerminalPanel`），App/card-detail-view/home-agent-conversation 三处全部走它 → xterm 仅在终端真正挂载时动态加载。**收益**：入口 gzip 542.6 → 535.6KB，且首屏不再 fetch 142KB gzip 的 xterm；build 不再报 dynamic-vs-static 警告。
- **P1 #4 — chat 淘汰路径（已补）**：封顶已有，缺淘汰。新增 `pruneChatForRemovedTasks`，在 `workspace_state_updated` 用**前一块板 vs 新板的 card-id diff** 删除已离板任务的 chat（及指向它的 `latestTaskChatMessage`）。用 diff 而非「不在板上即删」是关键：合成的 `__home_agent__:…` home-chat id 从不是 board card，故永不被误删。测试：`runtime-stream-store.test.tsx`（淘汰 + latest 清空 + home-id 存活 + 无变更不 churn）。
- **P1 #5 — split diff 文件级 memo（已补高性价比部分）**：高亮缓存第一轮已做（消除了 CPU 热点 `Prism.highlight`）。本轮补：把 `UnifiedDiff`/`SplitDiff` 包成 `React.memo`，把回调用 ref 稳定身份，并给每个文件传**按 path 切片且未变路径引用稳定**的 comment 子集（`stabilizeCommentsByPath`）。效果：在评论框打字（每次按键产生新 `comments` Map）只重渲染**被编辑的那个文件**，不再重渲染所有展开文件的全部行。测试：`diff-viewer-panel.test.tsx`（`stabilizeCommentsByPath` 引用稳定性）。
  - **未做（刻意推迟）：diff 整文件虚拟化**。findings 本身将其列为 #5 最低性价比、最高风险子项；且折叠文件**已**不渲染其行（`diff-viewer-panel.tsx` `{isExpanded ? … : null}`，等价于「懒渲染折叠文件」），CPU 热点已被高亮缓存消除，键盘提交快捷键（Cmd+Enter）读取实时 `comments` Map 与 react-virtuoso + 内联评论 + 多文件分组 + 滚动同步耦合，drop-in 虚拟化风险显著大于收益。若未来出现单文件数千行 + 全展开的实测卡顿再做。

P2 各项（#6–#10）不在本轮范围（仅 P0/P1）。
