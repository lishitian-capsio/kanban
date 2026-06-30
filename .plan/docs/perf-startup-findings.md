# Kanban 启动 / 项目打开 / 首次连接 — 性能瓶颈清单

**类型:** 只读调研，未改任何业务代码。本文聚焦**启动链路**(项目打开 → workspace 加载 → websocket 首帧 → 会话恢复 → board worktree),是 `performance-audit-2026-06.md`(聚焦稳态 idle-CPU / React 重渲染)的姊妹篇。

**方法:** 5 路并行只读 agent 静态分析 + 一次性磁盘度量(分片数/体积/git-op 计时)。**未启动 runtime,未挂 profiler**(在 worktree 里起第二个 runtime 有删 worktree 的风险,见 AGENTS.md)。"PROVEN" = 直接从源码行证明的结构事实;"推断" = 沿数据流推理的代价/时延(已逐条标注)。

**重要前情:** 本次调研**推翻 / 更新了之前审计与本任务 brief 里的多条前提**(它们已被修复),见下方「§0 前提更正」。真正的剩余瓶颈比 brief 预想的更窄、更集中。

---

## §0 前提更正(brief / 旧审计中已被修复的点)

逐条对源码核实,以下"已知问题"在当前 tree **已经修复,不要重复修**:

| 旧前提(brief / performance-audit-2026-06.md) | 当前实际 | 证据 |
|---|---|---|
| board 分片是 `for` 循环串行 `readFile` | **已并行** `mapFilesConcurrent`(全局 48 fd) | `task-shard-store.ts:173-193`;`fs/concurrent-files.ts:30` |
| board 读完有第二次全量 `runtimeBoardDataSchema.parse` | **已删除**,`assembleBoard` 不再 re-parse,仅保留 title 变换 | `task-shard-store.ts:254-260` |
| 无 "已迁移 workspace" 的进程内缓存 | **存在** `fullyPreparedRepoRuntimeHomes` Set,短路整条迁移链 | `workspace-state.ts:1284,1306-1327` |
| requirement 分片启动时仍被读 | 已退役迁移到 vault;只在一次性 `migrateRequirementsToVaultDocs` gate 内读,且被 prepared-cache 跳过;本仓 0 个 requirement 分片 | `workspace-state.ts:990,999`;磁盘度量 |
| vault `get`/`findById` 每次全树 gray-matter parse | **已修复**:list/search/links 走 `VaultReadCache`(stat 签名门控);`findById`/`get` 走文件名后缀直查,只读一个文件 | `vault-read-cache.ts`;`vault-document-store.ts:267-286` |
| 冷克隆 board fetch 未加超时,可无限 hang(旧审计 L3-6 / ROI #16) | **已修复**:已被 `BOARD_NETWORK_GIT_TIMEOUT_MS=30_000` + SIGKILL 包裹 | `board-worktree.ts:740-742,28`;`git-utils.ts:137` |

> 结论:旧审计 L3-2/L3-3/L3-5/L3-6 与 brief 里关于分片串行、双 parse、vault 全树扫的担忧**均已解决**。剩余真问题集中在:**(a) 两处 `spawnSync` 阻塞事件循环;(b) 广播/首连接时 board 与 git 信息的冗余重算;(c) Codex rollout 的无界目录扫描**。

---

## §1 仓库磁盘度量(本仓基线,用于量化标度)

> 取自权威 board worktree `.kanban/worktrees/__board__/kanban/.kanban/workspaces/kanban/`(注:各 sibling worktree 各有自带 `.kanban`,度量需认准 `__board__`)。

- **task 分片 300 个**,共 1.3 MB,均值 ~3.2 KB;`board.json` 布局清单仅 282 B(已重构为无卡片清单)。board 自旧审计(146)起约 **2× 增长**。
- **`sessions.json` 会话摘要文件 475 KB,约 180 条目**(含 task / `__home_agent__` / `__detail_terminal__` 各类),**无裁剪、随项目生命周期无界增长** — 在 workspace 加载热路径上被读。
- **session transcript 日志 292 个**(`.kanban/workspaces/kanban/sessions/<taskId>/messages.jsonl`,机器本地 runtime 根,不在 board 分支)。**最大 24 MB**,另有数个 280–380 KB。
- 串行 `cat` 300 个分片:0.84 s(进程 spawn 主导;进程内 `readFile` 远快,但 N 次 round-trip 仍在)。
- board worktree 上 `git rev-parse` / `git status`:warm <10 ms/次。requirement 分片 0;vault docs 6(`files/docs`)/ 59(含子目录)。

---

## §2 项目打开 / 添加 workspace

### F-OPEN-1 ★ `pickProjectDirectory` 用 `spawnSync` 拉起**模态**原生选择框 — 阻塞整个事件循环直到用户关窗  【P0(桌面)/ P1(headless)】

- **现象:** 点击 UI "浏览文件夹" → 用 `spawnSync` 启动原生模态选择框(osascript / zenity / PowerShell)。`spawnSync` 会阻塞整个 Bun 事件循环**直到子进程退出 = 直到用户关掉对话框**。对话框开着的几秒~几分钟内,整个 runtime 冻结:无 ws 广播、无其他 tRPC、无 agent I/O,直接进 stall-watchdog 区间。这是打开流程里最严重的阻塞点。
- **定位证据:** `src/server/directory-picker.ts:38-43` `defaultRunCommand` → `spawnSync(command, args, …)`;模态命令在 `:92-99`(darwin `osascript … choose folder`)、`:109-133`(linux `zenity`/`kdialog`)、`:135-159`(win32 `FolderBrowserDialog`)。tRPC 入口 `src/trpc/projects-api.ts:236-258` → `runtime-server.ts:360`。已 firsthand 核实(`grep`)。
- **影响范围:** 任何用"浏览"按钮(而非手输路径)的用户。headless Linux 上 zenity/kdialog 缺失会快速 `ENOENT`→`unavailable`,影响小;桌面 macOS/Windows/Linux runtime 上则按对话框存活时长全程冻结。
- **建议修复:** 改 async `spawn` + await 子进程 `close`。`RunCommand` 间接层已存在且可注入测试,只需把 `defaultRunCommand` 换成返回 Promise 的 spawn 包装、并把 `pickDirectoryPathFromSystemDialog` 与其唯一 tRPC 调用方(已 `async`)改 await。爆炸半径仅此文件 + 一个调用方。
- **预估收益/风险:** 消除一次"数秒~数分钟整 runtime 冻结"。风险低(对话框语义不变,只是等待变非阻塞)。"对话框真实时长"为推断,但"spawnSync 按子进程全生命周期阻塞循环"是 PROVEN。
- **优先级:** **P0**(桌面冻结严重性);headless 上因 binary 缺失快速退出,可降为 P1。

### F-OPEN-2 ★ `hasGitRepository` 在 `addProject` 热路径上用 `spawnSync git` — 最后一处同步 git 地雷  【P1】

- **现象:** 添加已有项目时跑同步 `git rev-parse --is-inside-work-tree`,阻塞整个事件循环。若此刻 git 被占用(并发 `git worktree add` / board-sync 持仓锁 — 正是之前 88s 冻结的场景),`addProject` 会冻结整个 runtime 而非仅该请求。**无超时**,wedged git 即硬冻结。
- **定位证据:** `src/cli.ts:262-270` `function hasGitRepository(path): boolean` → `spawnSync("git", ["rev-parse","--is-inside-work-tree"], …)`;经 `cli.ts:485,531` 注入 server,`runtime-server.ts:347` 转发;热路径消费 `src/trpc/projects-api.ts:102`。同 anti-pattern 即 AGENTS.md「No synchronous subprocess on any async hot path」与 `task-done-cpu-hang-bug` 记忆所指 — 它幸存是因为上次只把 `detectGitRepositoryInfo` 改 async,漏了这个 `cli.ts` helper。
- **影响范围:** 每次对已有目录 `addProject`(常见路径),以及 registry 启动一次(见 F-OPEN-3)。常态 ~10–15 ms,但无界。
- **建议修复:** 换用已存在的 async 探测 `detectGitRoot(path)`(`workspace-state.ts:1107`,async + timeout),或用 `runGit`/`execFileAsync` 写 async `hasGitRepository`。dep 签名 `(path)=>boolean` 需改 `Promise<boolean>`,两个调用方(`projects-api.ts:102`、`workspace-registry.ts:192`)加 await。
- **预估收益/风险:** 移除打开/添加路径上最后的同步 git → git 被占用时不再冻结循环。风险低(机械 async 化),需动 `projects-api`/`workspace-registry` 的 dep 测试。
- **优先级:** **P1**。

### F-OPEN-3 registry 启动时同一处 `hasGitRepository` 同步 git  【P3】

- **现象/证据:** `createWorkspaceRegistry` 启动期调一次同 `spawnSync` git 判断 launch cwd 是否仓库:`src/server/workspace-registry.ts:192`。
- **影响:** 仅启动一次(非反复热路径),此刻循环尚无并发工作,影响极小。
- **建议修复:** 随 F-OPEN-2 的 async 化顺手 await。**优先级 P3**(搭车修)。

### F-OPEN-4 远端 git 门控正确(确认项,无需动作)

- **证据:** `prepareRepoRuntimeHome` 先跑 `ensureBoardWorktree`(`workspace-state.ts:1312`);无 board-ref → 立即 no-op(`board-worktree.ts:808-811`)→ 解耦前仓库零 git;有 board-ref 时 `setupBoardWorktree` 经 `isGitWorktree` early-return(`board-worktree.ts:848-850`,一次本地 `rev-parse`,无网络);唯一远端 `fetch`(`board-worktree.ts:740-742`)仅冷克隆 + 本地 board 分支缺失 + `allowRemoteAdopt:true` 才到达,且 30s SIGKILL 超时;种子解耦迁移显式 `allowRemoteAdopt:false`(`workspace-state.ts:1373`)→ 新增项目零远端 git;不可达远端降级为 provisional 空 board + `board-adopt-pending`(`board-worktree.ts:768-777`)。**local-first 原则成立。** 唯一残留是 F-BWT-1 的 30s 阻塞。
- **优先级:** 无(确认)。

### F-OPEN-5 迁移链已被廉价 gate + 进程内缓存覆盖(确认项)

- **证据:** `prepareRepoRuntimeHome`(`workspace-state.ts:1305-1327`)8 个串行 await,每个有 `pathExists`/目录 gate 短路;整链经 `fullyPreparedRepoRuntimeHomes` 缓存(`:1306`)在解耦完成后跳过。残留:进程内首次打开一个已解耦仓库(缓存冷)仍跑完链,结尾 `migrateDecoupleBoardToBranch` 的 gate `isBoardRefTrackedOnCodeBranch`(`git ls-files`)+ `ensureBoardWorktree` 的 `isGitWorktree` ≈ 2 次本地 git spawn + ~6 `pathExists`,均 async/有界(~10–15 ms 量级)。**优先级 P3 / 信息项。**
- **回归确认:** EMFILE 修复成立 — 所有分片/vault fan-out 走全局 `pLimit(48)`(`fs/concurrent-files.ts:70`);非 git add 先种 `.gitignore` 再用超时包 `git add -A`(`initialize-repo.ts:104-143`)。`detectGitRepositoryInfo`/`resolveWorkspacePath` 仍 async(`workspace-state.ts:1089-1194`,`GIT_DETECT_TIMEOUT_MS=10_000` + 三读 `Promise.all`)。**两条历史地雷未回归。**

---

## §3 workspace 加载(广播 / 重启连接的反复代价)

### F-WS-1 ★ 每次广播都全量重读 + 重组 board(无 revision 级快照缓存)  【P1】

- **现象:** 每个 `workspace_state_updated` 广播都从全部 task 分片完整重读重组 board,**即便触发广播的事件与 board 无关**(如某 session/chat 事件)。
- **定位证据:** `runtime-state-hub.ts:368` `broadcastRuntimeWorkspaceStateUpdated` → `buildWorkspaceStateSnapshot`(`workspace-registry.ts:343`)→ `loadWorkspaceState`(`workspace-state.ts:1660-1665`,无缓存无条件读)→ `readWorkspaceBoard`(`:643-656`)→ `loadShardedBoard` = N 个并行 `readFile` + N 个 `storedTaskSchema.safeParse` + `updateTaskDependencies`。仅 `workspace-api.ts` 就有 **23 处广播调用点**,加 `board-sync.ts`(3)、`hooks-api.ts`、`runtime-state-hub.ts:589`。`markStall("board:read")`(`:647`)正因此处是"读路径上最深的同步工作"。
- **影响范围:** O(N tasks) Zod parse + O(N) `readFile`/广播。本仓 300 分片下数十 ms(并行),线性增长;千级 task 时每个 chat-token / session 驱动的广播都全量重算。
- **建议修复:** 在 `buildWorkspaceStateSnapshot` 按 `meta.revision`(已在 `:1664` 读)memoize 组装好的 board:先读 meta(1 个小文件),revision 未变则复用上次缓存的 `RuntimeBoardData`,sessions/live-summaries 照常叠加。board 写会 bump `revision`(`:1689,:1743`),key 即权威。board-sync pull(进程外编辑)处加一次 cache-bust 兜底。
- **预估收益/风险:** 在多数(非 board-写)广播上省掉 N 个 readFile + N 个 parse;收益随 task 数与广播频率放大。风险低(revision 是既有乐观并发 token)。
- **优先级:** **P1**。

### F-WS-2 ★ 每次广播都跑 git 探测(~5 次 spawn),从不缓存  【P1】

- **现象:** `loadWorkspaceState` → `loadWorkspaceContext` → `detectGitRepositoryInfo` 每次广播 spawn **4 个 git** 子进程(`resolveWorkspacePath` 再 +1),只为刷 snapshot 里 `git.{currentBranch,defaultBranch,branches}`。这些信息极少变(切分支才变),却每次状态推送都重探。
- **定位证据:** `workspace-state.ts:1239/1260` `git: await detectGitRepositoryInfo(repoPath)`;`detectGitRepositoryInfo`(`:1151-1172`)= `detectGitRoot`(rev-parse) + `Promise.all([symbolic-ref, for-each-ref])` + `detectGitDefaultBranch`(symbolic-ref origin/HEAD)= 4 spawn;`resolveWorkspacePath`(`:1183`)再 +1 `rev-parse --show-toplevel`。`fullyPreparedRepoRuntimeHomes` 缓存只短路**迁移**,**不**含 git 探测/`resolveWorkspacePath`(`:1268-1274` 注释明示留作每次跑)。
- **影响范围:** ~5 次 git `execFile` spawn/广播。本仓 ~34 ms 冷 / 几 ms 暖,但 AGENTS.md 记录过 git 被占用时的 88s 硬冻结(正是这些被改 async 的原因)。async 后不再冻结循环,但仍给每个广播加 spawn 时延并与并发 `git worktree add`/board-sync 抢资源。
- **建议修复:** 给 `RuntimeGitRepositoryInfo` 加按 repoPath 的短 TTL(2–5 s)或 revision 稳定的进程内缓存,并在已知切分支路径(`git-sync.ts runGitCheckoutAction`)失效;或把 git 探测从 board-state 广播中拆出走独立低频 channel。
- **预估收益/风险:** 去掉每广播 ~5 次 spawn。风险中低(进程外 `git switch` 后到 TTL 过期前分支列表可能 stale;在已知 checkout 路径失效可缓解)。
- **优先级:** **P1**。

### F-WS-3 `sessions.json` 摘要 475 KB / 无界增长,在加载热路径上被读  【P2】

- **现象:** `loadWorkspaceState` 每次广播读并 `JSON.parse` 整个 `sessions.json`。本仓已 **475 KB / ~180 条**,且**无裁剪**:task、`__home_agent__:*`、`__detail_terminal__:*` 各类会话摘要随项目生命周期只增不减。
- **定位证据:** `workspace-state.ts:1660-1665` `readWorkspaceSessions` 在 `loadWorkspaceState` 内无条件读;`sessions.json` 为按 session id 键的单对象(磁盘度量:475166 B,~180 key)。
- **影响范围:** 每广播一次 475 KB JSON parse(随历史增长)。当前可接受,但随月增长会成为每广播的固定税,且与 F-WS-1 同在热路径。
- **建议修复:** (1) 随 F-WS-1 的 revision 缓存一并 memoize sessions 读;(2) 对终态/已关闭的 `__detail_terminal__` / 旧 `__home_agent__` 线程摘要做归档/裁剪策略,控制文件无界增长。
- **预估收益/风险:** 去掉每广播一次大 JSON parse;裁剪需谨慎(摘要被卡片/计数消费,误删=数据丢失),建议先做缓存(低风险)、裁剪另立任务。
- **优先级:** **P2**。

### F-WS-4 `readWorkspaceIndex` 每次 id-keyed 调用都重读 + 重校验 index.json  【P2】

- **现象:** 每个 `*ById` helper(`loadWorkspaceBoardById`/`loadWorkspaceHomeThreads`/`loadWorkspaceCommittedProviders`/`mutate*`/`loadWorkspaceContextById` …)都 `resolveRepoPathForWorkspaceId` → `readWorkspaceIndex` → 从头读 + Zod `superRefine` 校验 `index.json`,而该文件仅增删项目时变。
- **定位证据:** `workspace-state.ts:935-938`(无缓存)、`:825-828`(`readJsonFile`+`parseWorkspaceIndex`,schema `superRefine` `:196-233`);在 projects fan-out(`workspace-registry.ts:320`)与 `runtime-server.ts:202` 等处反复触发,O(projects)。
- **建议修复:** 进程内缓存解析后的 index,在 `writeWorkspaceIndex`/`removeWorkspaceIndexEntry`(均在本文件 `:830,:1634`)失效。单写者、罕改,易缓存。
- **预估收益/风险:** 去掉 projects fan-out 与各 per-ws loader 上的冗余读+校验。风险极低。
- **优先级:** **P2**。

---

## §4 websocket 首次连接

### F-CONN-1 ★ 首连接时 active workspace 的 board 被**读两次**(并发,无 memo)  【P1】

- **现象:** 首连接 / 重连时,active workspace 的分片 board 被两个独立 builder 并发各读一遍。
- **定位证据:** `runtime-state-hub.ts:474-477` `Promise.all([buildProjectsPayload, buildWorkspaceStateSnapshot])`;路径 A `buildWorkspaceStateSnapshot`→`loadWorkspaceState`→`readWorkspaceBoard`;路径 B `buildProjectsPayload`→`summarizeProjectTaskCounts`(`workspace-registry.ts:312,320`)→`loadWorkspaceBoardById`→同一 `readWorkspaceBoard`。`readStoredTasks` 读全部分片(`task-shard-store.ts:173-193`)。
- **影响范围:** 每首连接/重连。随 active board task 数线性;300 分片下约一次多余的全量 fan-out。
- **建议修复:** 两 builder 间共享一次 active board 读(把已读 board 传入该 workspace 的 `summarizeProjectTaskCounts`),或加 ~1s 短 TTL per-workspaceId board 读缓存。
- **预估收益/风险:** 每连接省一次全量 board fan-out。风险低(两处本就要同一逻辑快照)。
- **优先级:** **P1**。

### F-CONN-2 ★ projects payload 为算列计数读了**每个项目的完整 board**  【P1(多项目下 P0)】

- **现象:** 组装 snapshot 的 `projects` 数组时,读并组装**每个**注册项目的**完整**分片 board,只为得到每项目 4 个整数(列计数)。
- **定位证据:** `workspace-registry.ts:362-369` 对所有项目 fan-out `summarizeProjectTaskCounts` → `loadWorkspaceBoardById` → `readWorkspaceBoard` 读全部分片(`task-shard-store.ts:180`),再 `countTasksByColumn`(`:108,321`)归约成计数。所有 fan-out 共享**同一个全局 48 fd** 限流器(`fs/concurrent-files.ts:30`)。
- **影响范围:** 首连接 + 每次 `projects_updated`/重连。代价 = Σ(所有项目 tasks) 次分片读,与 active board 读(F-CONN-1)、metadata 抢同一 48 fd 预算 → 多项目×多 task 时 active snapshot 读会被其他项目的计数读挤到后面,直接拖慢 time-to-interactive。
- **建议修复:**(按价值排序)(1) 把列计数持久化进 `board.json` 布局清单(或一个小 `counts.json`),task 写时更新 → 计数变 O(1) 清单读而非 O(T) fan-out;(2) 短期:只为 active 项目算计数,其他项目计数随后续消息流式补;(3) 用已存在的 `projectTaskCountsByWorkspaceId` 缓存(`workspace-registry.ts:324,332`,目前仅作错误兜底)上连接发缓存值、后台刷新。
- **预估收益/风险:** 多项目安装收益最大 — 从连接关键路径移除 (M−1)×T 次分片读。方案 1 中风险(清单计数须随每次 task move/create/delete 同步,漂移=徽章错);方案 3 低风险(stale-but-fast)。
- **优先级:** **P1**(多大项目用户 P0)。

### F-CONN-3 board 卡片在 snapshot 内携带完整 prompt + 内联 base64 图片  【P2】

- **现象:** snapshot 里每张 board 卡带完整 `prompt` 字符串,以及(若有)**内联 base64 图片 `data`** — snapshot 唯一的无界体积来源。
- **定位证据:** `runtimeBoardCardObjectSchema`(`api-contract.ts:241-262`)`prompt: z.string()` + `images?`;`runtimeTaskImageSchema`(`:162-167`)`data: z.string()`(base64 字节);board 随 `workspaceState.board` 进 snapshot(`api-contract.ts:1587`,`runtime-state-hub.ts:500`)。
- **影响范围:** snapshot 体积随全 board prompt 总量、尤其任意附图增长;几张截图任务即可把 snapshot 从 KB 撑到 MB,推高 `socket.onmessage` 上的 JSON parse + 单次 dispatch 成本(`use-runtime-state-stream.ts:98,101`)。
- **建议修复:** 别在 board 线协议里塞图片字节 — `images[].data` 改为引用(id/URL)按需懒取(仿 `use-runtime-artifact-content.ts` 懒取);可选在 board 卡截断 `prompt`、详情打开时取全文。**先核实图片在 board 卡上是否常见**(推断:多数卡无图,属潜在非常热)。
- **预估收益/风险:** 图多的 board 可数量级缩小 snapshot。风险中(动 `runtimeBoardDataSchema` 这一刻意稳定的线协议,需配套懒取端点 + UI)。图常见才优先,否则 defer。
- **优先级:** **P2**。

### F-CONN-4/5/6 已优化(确认项)

- **chat transcript 不在 snapshot 里**(懒取):snapshot 字段仅 `currentProjectId/projects/workspaceState/workspaceMetadata/kanbanSessionContextVersion`(`runtime-state-hub.ts:496-503`),session summary 无 message 数组(`api-contract.ts:1548-1580`);chat 经 `use-kanban-chat-session.ts:121-151` 在面板挂载时才 `getTaskChatMessages`(`runtime-api.ts:493-504`);store 在 snapshot 上显式清空 chat map(`runtime-stream-store.ts:211-212`)。**P3 / 保持现状。**
- **首帧非阻塞 + 单次大 dispatch**:`main.tsx:13-53` 只做 Sentry + theme 即 render;`currentProjectId` 模块加载时从 URL seed(`runtime-stream-store.ts:375-378`)避免切换闪;loading gate 非阻塞(`App.tsx:134-136`);snapshot 为**一次** `JSON.parse` + 一次 reducer dispatch,之后 `dispatchRuntimeStreamAction` 按字段 diff 只唤醒变化的 slice。**P3**(只有 F-CONN-3 体积变大时这次同步 parse 才显)。
- **tRPC 挂载 round-trip 极少且并行非门控**:交互由 **ws snapshot** 门控而非 tRPC;`useRuntimeProjectConfig`(`App.tsx:137-145`)并行 query,仅门控 agent-setup 而非 board 渲染。**P3**(确认 `currentProjectId===settingsWorkspaceId` 时 query 去重即可)。
- **跨切关注:** F-CONN-1 + F-CONN-2 同抢单一 48 fd 限流器,合修可叠加增益(去掉冗余/不必要 board 读 → 释放预算 → 必要的 active board snapshot 读更快完成)。

---

## §5 会话恢复(重启后)

### F-SESS-1 ★ Codex rollout 扫描:对共享、永不裁剪的目录树做**无界递归 readdir + 逐文件 stat**,每次 launch + 每个 turn boundary 都跑  【P1】

- **现象:** 每次 Codex session-id 捕获、每次 Codex token 用量读取,都对 `<CODEX_HOME>/sessions/` 做完整递归扫描,stat 每个 `rollout-*.jsonl`、读每个 cwd 候选的首行。该树只增不裁;**官方登录 Codex 下是机器级共享的 `~/.codex/sessions`**(累积用户跑过的所有 Codex 会话)。
- **定位证据:** `codex-session-capture.ts:100-124` `collectRolloutFiles` `readdir(sessionsDir, { recursive: true })` 无日期窗过滤;`:149-171` `findLatestCodexRollout` 逐文件**串行** `stat` 取 mtime,再对过 floor 的文件读首行 `session_meta`;无裁剪;经 `captureAndApplyAgentSessionId`(`session-manager.ts:755-757`)在**每次 launch**、经 `captureSessionUsage`→`readCodexSessionUsage`(`session-manager.ts:768,1397`;`codex-session-usage.ts:109`)在**每个 turn boundary + 每次 relaunch** 调用。
- **影响范围:** 自定义 provider Codex:`CODEX_HOME` 按 task 隔离 → 树小,廉价(推断,据 projector 设计)。**官方登录 Codex:共享树随历史 O(全部历史 rollout)** 增长 — 重度用户数千历史会话时,**每个 turn boundary** 都付数百 ms~秒级扫描(反复,不止恢复时)。官方登录是 CLI agent 文档默认,故是常见路径。
- **建议修复:**(1) 按日期收窄:从 `sinceMs`(及"今天/昨天",兼容午夜跨天与时钟偏移,代码已有 `MTIME_FLOOR_TOLERANCE_MS`)推出候选 `YYYY/MM/DD` 子目录,弃 `recursive:true`;(2) `stat` 并行化 `Promise.all`,按文件名时间戳(`rollout-<ts>-<uuid>`)newest-first 短路,匹配到首个 cwd 即停;(3) 首次捕获后**按 task 缓存解析出的 rollout 路径**,token 读直接 `readFile` 该路径、跳过扫描(文件消失才重扫)。三者都汇于同一 `findLatestCodexRollout`(`codex-session-capture.ts:149`),**单点修复同时解决 resume 与反复的 turn-boundary 刷新** — 本焦点区单点杠杆最高。
- **预估收益/风险:** 官方登录重度用户从 O(全史) 降到 O(1–2 天),每个 Codex turn-boundary 刷新与每次 relaunch 省数百 ms~秒。风险中(日期窗须容忍跨天/时钟偏移 — 含相邻日目录)。
- **优先级:** **P1**(自定义 provider 用户 P2;官方登录是默认故 P1)。

### F-SESS-2 Codex resume 捕获轮询最坏 15s(30×500ms),每次重扫  【P2】

- **现象/证据:** `codex-session-capture.ts:41-42` `DEFAULT_CAPTURE_ATTEMPTS=30`、`INTERVAL=500ms`;`captureCodexSessionId`(`:201-219`)循环每次跑 F-SESS-1 的全扫再睡 500ms。**fire-and-forget**(`session-manager.ts:755-757` `void`),**不阻塞** session-start 响应/UI;但慢/大共享树上 30 次各付全扫代价;新 task 永不匹配时浪费 15s 后台 CPU/IO。用户可见仅是 resume id 持久化(下次重启正确 `--resume`)晚到 ≤15s 的 freshness 滞后。
- **建议修复:** 先修 F-SESS-1(让每次尝试变廉价);并对前几次用更短间隔(~100ms)再退避;若 Bun `fs.watch` 可靠则改 watch 取代轮询。
- **预估收益/风险:** 更快更省的捕获,限制无谓后台工作。`fs.watch` Bun 下可靠性不一,轮询作兜底。**优先级 P2**(后台非阻塞,严重性随 F-SESS-1)。

### F-SESS-3/4/5 已优化(确认项)

- **transcript 读回是懒的(面板打开),非启动期全读** — 重启只 `hydrateFromRecord` 读 `sessions.json` 摘要、`active:null`,**不开任何 `messages.jsonl`**(`workspace-registry.ts:253-266`;`session-manager.ts:392-409`);journal 仅经 `getTaskChatMessages`(`runtime-api.ts:493-520`)在面板打开时读;`SessionMessageMergeCache`(`session-message-merge-cache.ts:45-73`)使静默会话重开零 I/O。**启动代价 O(active workspaces) 摘要读,非 O(tasks) transcript 读。** ⚠️ 但本仓最大 transcript 24 MB、数个 280–380 KB:**冷大 transcript 首次面板打开** = 整文件 `readFile` + 逐行 `JSON.parse` + `runtimeTaskChatMessageSchema.safeParse`,会有一次性时延尖峰(可选:按 mtime+size 缓存解析结果缓解)。**P3。**
- **重启不自动重连 N 会话** — shutdown 只标 `interrupted`(`shutdown-coordinator.ts:33-47`),`hydrateFromRecord` 不 spawn PTY;`startTaskSession` 仅显式 API(用户点 restart)触发,无启动循环。**无 boot fan-out。P3。**
- **Claude resume 廉价同步** — `prepare` 同步推 `--resume <id>`,无捕获轮询(`agent-session-adapters.ts:590-606`);token 读走确定路径 `~/.claude/projects/<cwd-slug>/<id>.jsonl` 单 `readFile`(`claude-session-usage.ts:48-51,150`),无目录扫描。残留:超长 Claude 会话每 turn 重读重 parse 整文件(可选增量读偏移)。**P3。** token 读全是 fire-and-forget,不在卡片渲染路径(`session-manager.ts:768,1397`,渲染只消费已持久化的 `summary.usage`)。

---

## §6 board worktree(启动 git 开销与串行化)

### F-BWT-1 冷克隆 fetch 在阻塞式打开路径上(最坏 30s)  【P2】

- **现象:** 虽已 30s 超时(见 §0),冷克隆 fetch 仍**同步 await 在项目打开关键路径**,慢/不可达远端会让打开卡到 30s 才降级。
- **定位证据(全 await,无后台分发):** `loadWorkspaceContext`(`workspace-state.ts:1222`)→ `await prepareRepoRuntimeHome`(`:1234/1255`)→ 首个 await `await ensureBoardWorktree`(`:1312`)→ `await setupBoardWorktree`(`allowRemoteAdopt` 默认 `true`,`:845`)→ 冷路径 `await runGit(["fetch",...], {timeoutMs:30_000})`(`:740`)。provisional 兜底**确实防永久 hang 且覆盖两类错误**(网络失败/超时 SIGKILL 走 `:768` 写 `board-adopt-pending`;`isMissingRemoteRefError` 走 `:778` 纯 orphan-init)——但打开仍**阻塞满 30s** 才到兜底。
- **影响范围:** 冷克隆首启 + 不可达远端 → 打开阻塞 ≤30s(UI 等)。warm 启动经 `isGitWorktree` early-return 完全跳过。
- **建议修复:**(a) 打开路径用更短 fetch 预算(5–8s)、用户触发的 push/pull 保留 30s(非破坏性 provisional + 后台 adopt 已存在,快速放弃严格更优);(b) 把冷克隆 fetch 改后台 best-effort(立即用 provisional 打开,让 `adoptRemoteBoardIfPending` 首次 fetch)——改动更大,彻底去阻塞。
- **预估收益/风险:** 最坏冷克隆打开从 30s→~5s(a)或 ~0(b)。(a) 风险低(过激超时会把"慢但可达"的远端提前 provisional,后台 reconcile 仍正确);(b) 中。
- **优先级:** **P2**(仅冷克隆+慢远端;warm 不受影响)。

### F-BWT-2/3/4 已优化(确认项)

- **per-path git spawn 数:** warm=1(`isGitWorktree`)、冷-本地≈4–5、冷-克隆≈7–8(一次远端 fetch)。均有界(`board-worktree.ts:146,700-711,713-787`)。
- **`allowRemoteAdopt:false` 真·零远端 git** — `remote` 强制 `null`,`getDefaultRemote` 都不调,整个 `if(remote)` fetch 块跳过(`board-worktree.ts:733-734`;`workspace-state.ts:1373`)。新增项目零远端阻塞。
- **board 设置按仓串行(git-common-dir 锁),跨项目并行;reclaim 仅冷路径** — `setupBoardWorktree:852` `withLock(getBoardWorktreeSetupLock(repoPath))`,键为 `git rev-parse --git-common-dir` → 同仓所有 worktree 共锁串行,**不同仓并行**;锁内双查 `isGitWorktree` 使第二等待者 no-op;`reclaimStaleBoardWorktree`(`:700-711`)仅冷路径 1–2 spawn,warm 不达。
- **`getStatus`/`getBoardWorktreeAheadBehind` fetch-free;reconcile 退避非 spam** — 仅本地读(`rev-list --left-right --count` 对本地 tracking ref,`board-worktree.ts:369-396`);reconcile 退避 15s→30s→60s→120s→300s 后保持(`board-sync.ts:40,302-332`),仅 `still-unreachable` 重排、终态删计数器、静默、`unref`、串行队列。**非 30s 错误 spam。**

---

## §7 综合优先级清单(作为实现任务输入)

> ROI = 影响 × 命中概率 ÷(工作量 × 风险)。"独立"= 可独立成任务,无顺序依赖。

| # | 任务 | 区 | 位置 | 工作量 | 风险 | 收益 | 独立 | 优先级 |
|---|------|---|------|--------|------|------|------|--------|
| 1 | `pickProjectDirectory` 改 async `spawn` + await close(去模态对话框冻结循环) | §2 | `directory-picker.ts:38-43` | 低 | 低 | **高**(整 runtime 冻结) | ✅ | **P0** |
| 2 | `hasGitRepository` 改 async(去 addProject 同步 git 地雷),F-OPEN-3 搭车 | §2 | `cli.ts:262`→`projects-api.ts:102`,`workspace-registry.ts:192` | 低 | 低 | 高(git 占用时冻结) | ✅ | **P1** |
| 3 | projects payload 计数改清单/缓存(停止为计数读全 board) | §4 | `workspace-registry.ts:362`,`board.json` | 中(方案1)/低(方案3) | 中(1)/低(3) | **高**(多项目下最大) | ✅ | **P1**(多项目 P0) |
| 4 | snapshot 两 builder 共享一次 active board 读 | §4 | `runtime-state-hub.ts:474`;`workspace-registry.ts:312` | 低 | 低 | 高(每连接省一次全量 fan-out) | ✅ | **P1** |
| 5 | `buildWorkspaceStateSnapshot` 按 `meta.revision` memoize board(每广播免全量重读) | §3 | `workspace-registry.ts:343`;`workspace-state.ts:1664` | 低-中 | 低 | 高(随 task 数 × 广播频率) | ✅ | **P1** |
| 6 | `RuntimeGitRepositoryInfo` 加短 TTL/revision 缓存 + 切分支失效(每广播省 ~5 spawn) | §3 | `workspace-state.ts:1151,1239` | 低-中 | 中-低 | 高 | ✅ | **P1** |
| 7 | `findLatestCodexRollout` 日期收窄 + 并行 stat + newest-first 短路 + per-task 路径缓存 | §5 | `codex-session-capture.ts:149,100` | 中 | 中 | 高(官方登录重度用户) | ✅ | **P1** |
| 8 | `readWorkspaceIndex` 进程内缓存 + 写时失效 | §3 | `workspace-state.ts:825,935` | 低 | 极低 | 中(projects fan-out) | ✅ | **P2** |
| 9 | `sessions.json` 读随 #5 一并 memoize;终态会话摘要裁剪策略 | §3 | `workspace-state.ts:1660` | 低(缓存)/中(裁剪) | 低/中 | 中(随历史增长) | ✅ | **P2** |
| 10 | board 卡片图片字节移出线协议改懒取(图常见才做) | §4 | `api-contract.ts:162,241`;`runtime-state-hub.ts:500` | 中 | 中 | 中-高(图多 board) | ⚠️先核实图频率 | **P2** |
| 11 | 冷克隆 fetch 用更短打开路径预算(或后台化) | §6 | `board-worktree.ts:740`;`workspace-state.ts:1312` | 低(a)/中(b) | 低(a)/中(b) | 中(冷克隆+慢远端) | ✅ | **P2** |
| 12 | Codex 捕获轮询提前退避 / fs.watch | §5 | `codex-session-capture.ts:41,201` | 低-中 | 中(Bun watch) | 中(后台) | 随#7 | **P2** |
| 13 | 冷大 transcript 首开按 mtime+size 缓存解析 | §5 | `session-message-journal.ts:202`;merge-cache | 低 | 低 | 低-中(24MB 尖峰) | ✅ | **P3** |
| 14 | 长 Claude 会话 token 增量读(偏移) | §5 | `claude-session-usage.ts:69` | 低-中 | 低 | 低 | ✅ | **P3** |

**建议波次:**
- **Wave A(P0/P1,低风险,可并行):** #1、#2、#4、#5、#6、#8 — 多为机械 async 化 / 加缓存,无顺序依赖,立竿见影去冻结 + 去每广播冗余重算。
- **Wave B(P1,中):** #3(计数清单化)、#7(Codex 扫描收窄)、#9(sessions 缓存)。
- **Wave C(P2):** #10、#11、#12。
- **Backlog(P3):** #13、#14。

**置信与下一步:** 结构事实(spawnSync 阻塞、每广播重读、Codex 无界扫、两 builder 双读)均 PROVEN;具体 ms 时延为沿数据流推断(已标注)。在投入 #5/#6/#7 前,建议在受控负载(多项目 + 5–10 并发 task + 大 transcript)下抓一次 `--prof`/`perf` 火焰图与 Bun 事件循环 stall 采样,确认排名 —— 本调研刻意只读、未启动 runtime。

**与 `performance-audit-2026-06.md` 的关系:** 该文聚焦稳态 idle-CPU(metadata 1s git 轮询 L2-4 仍是最大稳态 CPU 项)与 React 重渲染;本文聚焦**启动/打开/连接**一次性 + 广播驱动代价。两文的 board-read 优化(#4/#5)与该文 L3-3 同源但更新了"已并行/已去双 parse"的事实;该文 L3-6 的冷克隆 fetch 担忧已被本文 §0/§6 证实**已修复**(可从其 ROI 退役 #16)。

---

## §8 实施记录 (2026-06-30) — 第二轮后端缓存类 P1 收尾

**Audit-first 结论(动手前核实当前 tree):** brief 设想的"贯穿性根因——按 revision 失效的内存板缓存(board snapshot + workspace git context)"**已在 Wave A (`ef528f54`) 全部落地**,且比当时 `perf-runtime-findings.md §5` 标注的"延迟"更进一步:

- **#5 (F-WS-1) + #4 (F-CONN-1) 已实现,跳过** — `workspace-state.ts` 的 `loadWorkspaceBoardMemoized` 按 `meta.revision` 缓存**已解析的 board promise**(非仅 in-flight 去重):同 revision 的重复广播命中缓存零分片读;首连接两个并发 builder 共享同一 in-flight promise(去双读)。in-process 写 bump revision 自动失效;board-sync pull 经 `runtime-server.ts` 包裹 `invalidateWorkspaceBoardCache` 显式失效。测试 `test/state/workspace-board-cache.test.ts`(5 例:同 revision 1 读 / 跨 builder 共享 / 并发去重 / save 后重读 / 失效后重读)。
- **#6 (F-WS-2) 已实现,跳过** — `detectGitRepositoryInfo` 3s 单飞 TTL 缓存(`workspace-state.ts:1338`),`invalidateGitRepositoryInfoCache()` 在 checkout 成功后失效(`workspace-api.ts:285`)。每广播 ~5 git spawn → 命中 0。
- **#1/#2/#8 已实现,跳过** — directory-picker 异步、`hasGitRepository`→async `isGitRepository`、`readWorkspaceIndex` stat-signature 缓存,均在 Wave A。
- **运行时 P1-B 已实现,跳过** — `refreshProjectTaskCountsIfChanged` + `projectTaskCountsEqual` 门控 projects 广播(`394705d3`)。

**✅ 本轮唯一缺口 — #3 (F-CONN-2) 冷首连接整盘 fan-out。** board 缓存让**稳态**重复 projects_updated 变 O(1)(同 revision 命中),但**冷进程首连接**仍为算列计数对**每个**项目读整盘,且连接路径 `Promise.all([buildProjectsPayload, snapshot])` **在发 snapshot 前 await 全部 M 个盘**,直接拖慢 time-to-interactive(多项目 P0)。

- **方案选择:** 否决 doc 原"优先方案"(计数持久化进 `board.json`/`counts.json`)——它会让每次 task move/create/delete 重写一个**已提交**文件,重新引入分片本要消除的 git 合并冲突,违反"不破坏分片合并友好性"约束。改用**延迟计算 (deferred-compute)**:零持久化、零漂移(计数恒由权威盘读得出,仅延后)、wire contract 不变、前端零改动。
- **实现:** `workspace-registry.ts` 新增 `buildProjectsPayloadFast(preferredCurrentProjectId)` —— 仅读**当前**项目盘(snapshot 本就要读它),其余项目用 `projectTaskCountsByWorkspaceId` 的最近一次缓存计数(进程冷启时为空)。纯函数 `resolveFastProjectTaskCounts(ids, currentId, currentCounts, cached)` 做"当前→新鲜 / 其余→缓存或空"的逐项选择(导出+单测)。连接路径(`runtime-state-hub.ts`)两分支均改用 fast 版;发完 snapshot 后**在关键路径外** `void broadcastRuntimeProjectsUpdated(currentId)` 跑一次完整重算,经既有 `projects_updated` 通道把非当前项目的计数纠正为权威值。单项目安装不触发后台重算(`projects.length > 1` 门控),零额外开销。
- **可测量收益:** `test/server/projects-payload-fast.test.ts` 用 `getWorkspaceBoardReadCountForTests` 证明——**fast 路径整盘读 = 1**(仅当前项目),完整 `buildProjectsPayload` = 2(两项目;一般 = M)。即从连接关键路径移除 (M−1) 次整盘 fan-out,M 个项目时 time-to-interactive 不再被其余 (M−1) 个盘的 read+Zod 阻塞,也不再与 active board 读抢同一 48 fd 预算。纯逻辑 `resolveFastProjectTaskCounts` 6 例覆盖(当前用新鲜值 / 非当前用缓存 / 非当前无缓存→空 / 无当前项目 / 当前读不可用→缓存或空 / 逐项一对一)。
- **未做(超范围,记录):** F-WS-3/F-WS-4(sessions.json/index 缓存,#9/已部分)、F-SESS-1/2(Codex rollout 扫描收窄,#7/#12)、F-CONN-3/F-BWT-1(snapshot 图片字节懒取、冷克隆 fetch 预算,#10/#11)、运行时 P2-C(save 路径复用 ranks)——均非本任务"已确认且未实现的后端缓存类 P1",留作独立任务。

`tsc` 净增 0 错误(基线 ~122 个 vendored-omp,本轮 0 命中我方文件);biome clean;`test/server` + `test/state/workspace-board-cache` 全绿(`runtime-state-stream.integration` 在 `npx vitest`/Node 下因 server 子进程 `bun:` ESM 失败,系既有环境限制,与本轮无关——已 stash 对比基线证实同样失败)。
