# Kanban Bun 运行时/后端 性能瓶颈清单

调研日期: 2026-06-29 · 分支: 当前 worktree (`aee8b`) · 范围: 后端运行时,**只读调研,未改业务代码**

调研方法: 5 路并行只读 agent,分别覆盖「事件循环阻塞 / WS 广播频率 / 分片读写 / git 操作 / 日志与 journal」五个方向,逐文件核实,交叉验证重叠结论。每条发现按 **现象 → 定位证据(file:line) → 影响范围 → 建议修复 → 预估收益/风险 → 优先级** 给出,作为后续实现任务的输入。

---

## 0. 执行摘要

- **没有遗留 P0**。此前的 P0(`detectGitRepositoryInfo`/`resolveWorkspacePath` 的 `spawnSync git` 在 `loadWorkspaceContext` 热路径上)**已确认修复为异步** (`workspace-state.ts:1089-1194`,`execFileAsync` + 超时 + 降级 `null`,并埋了 `markStall("git:detect")` 面包屑)。
- **唯一仍存在的「同步硬冻结」类问题** 是 P1-A:pi 原生 agent 的 `execute_command` / `search_files` 工具在 **进程内** 用 `execSync`,会把整个运行时阻塞最长 60s/30s。这正是 stall-watchdog 设计要抓的那一类。
- **最高杠杆的异步性能问题** 是一组同根因发现:**在磁盘分片层与 WS 广播层之间没有任何内存缓存**。每次 `workspace_state_updated` / `projects_updated` 广播都从磁盘重读整盘任务分片 + 重跑 ~5 个 git 子进程,且 `projects_updated` 会在每个 150ms 的 session-summary flush 上 **乘性地重读所有项目的整盘**。这是 async churn 的主要来源(不会冻结循环,但在活动会话期间制造大量子进程 + I/O)。
- **git 操作层、journal coalescing、日志门控、终端 per-chunk 路径** 经核实 **已经实现良好**,只有少量 P3 级别的微开销。

### 贯穿性根因(强烈建议作为第一个实现任务)

发现 P1-B、P1-C、以及分片方向的 F2/F4 全部指向同一件事:**缺少一个「按 revision 失效」的内存板缓存(board + workspace git context)**。引入这一层缓存可一次性吃掉这几条:

- 每次广播重读全部 `tasks/<id>.json` 分片 → 命中缓存跳过磁盘重读
- `projects_updated` 重读所有项目整盘只为算 task 计数 → 缓存派生计数
- 每次写盘前又全量重读一遍板来 reconcile rank → 复用缓存
- `loadWorkspaceContext` 每次重跑 ~5 个 git 子进程 → 按 repoPath 缓存,checkout/discard 时失效

**唯一的核心风险是缓存一致性**:外部写入者(board-sync 从 git `reset --hard` 拉取 / 冲突 abort / 多机)必须显式失效缓存。`mutateWorkspaceState`/`saveShardedBoard` 已经持有 workspace 锁,是天然的失效点;board-sync 的 pull/conflict 路径必须额外挂失效钩子。

---

## 1. 优先级汇总表

| ID | 发现 | 类型 | 触发路径 | 频率/规模 | 优先级 |
|----|------|------|----------|-----------|--------|
| **P1-A** | pi `execute_command`/`search_files` 用 `execSync`(进程内,同步冻结) | 事件循环 | 每次 pi agent 跑命令/搜索 | 单次最长 60s/30s 冻结 | **P1** (最严重:硬冻结) |
| **P1-B** | `projects_updated` 在每个 150ms summary flush 上乘性重读**所有项目**整盘 | 广播+分片 | 每次 session 状态变化 | O(项目数 × 每盘分片数) / 150ms | **P1** (最大异步 churn 单点) |
| **P1-C** | `workspace_state_updated` 每次广播全量重读板分片 + ~5 个未缓存 git 子进程 | 广播+分片 | 活动会话期间每分钟多次 | O(N 分片)+~5 git spawn / 次 | **P1** |
| **P2-A** | pi 流式每 token 重发**整条累积消息**(总字节 O(n²)) + 重复 summary | 广播+日志 | 有面板打开时每 token | O(回复长度²) 字节 | **P2** |
| **P2-B** | 文件夹选择器 `spawnSync` 原生对话框(同步,无界冻结) | 事件循环 | `pickProjectDirectory`(加项目) | 罕见但=对话框打开时长 | **P2** |
| **P2-C** | 每次板写入先全量重读板(rank reconcile)+ 对每个 task 都 read+stringify+compare | 分片 | 每次板变更(拖拽/建/删) | O(N 分片) / 写 | **P2** (并入 board cache) |
| P3-A | 每次 `runGit` 为凭证注入额外 2 次 `stat()`(登出态也跑) | git | 每次 git 子进程 | 2 stat / runGit | P3 |
| P3-B | 每次 commit + 每次徽章查询重算 4-spawn ahead/behind(含静态的 `isGitWorktree`/`getDefaultRemote`) | git | debounce 限频(≤1/5s/repo) | 4 git spawn / 周期 | P3 |
| P3-C | `saveShardedBoard` 多余的第 2 次 `readdir` | 分片 | 每次板保存 | O(1) | P3 |
| P3-D | task/board worktree 用两把不同 setup 锁的理论竞态 | git | 冷克隆 board setup 与 task start 并发 | 罕见,有 git index.lock 兜底 | P3 |
| P3-E | 通用分片库(providers/views/db connections)无缓存 | 分片 | 设置类冷路径,集合小 | 小 | P3 / no-op |

---

## 2. 详细发现

### P1-A — pi `execute_command` / `search_files` 在进程内用 `execSync`(同步冻结)

**现象**: pi 原生 agent 跑 shell 命令或内容搜索时,整个 Kanban 运行时会冻结(无 ws 广播、其它 tRPC 卡住、其它任务的 chat token 停),持续到该子进程结束 — 最长到工具超时(命令 60s / 搜索 30s)。这正是 watchdog 要抓的「100% CPU 硬挂起」类。

**定位证据** (`src/agent-sdk/kanban/pi-tools-bridge.ts`):
- `createExecuteCommandTool` — line 274: `const output = execSync(params.command, { cwd, encoding: "utf8", maxBuffer: 10MB, timeout })`,默认 `timeout = 60000`(line 273),**同步**,位于 `async execute()` 内。
- `createSearchFilesTool` — line 236: `execSync(\`grep -rn ... | head\`, { timeout: 30000 })`。
- 两者通过 `buildPiToolSet`(line 32-43)→ `pi-agent-runtime.ts:101` → `new Agent({ tools })`(line 124)接入每个 pi 会话。`InMemoryPiAgentRuntime` 是 **进程内**(`pi-agent-runtime.ts:75`),工具 `execute()` 跑在主事件循环上。
- 审批 hook(`createPiToolApprovalHook`,line 56)只决定 **是否** 跑;一旦批准,阻塞是无条件的。

**影响范围**: 每个跑命令/搜索的 pi 会话。一条慢命令(测试套件、构建、对大树 `grep`)阻塞循环最长 60s/30s。定为 P1(非 P0)只因 pi 是多 agent 之一,且命令需用户审批、间歇触发,不在每次广播上。

**建议修复**: 改成 `git-utils.ts:7` / `workspace-state.ts:1061` 已用的异步 `execFile`/`promisify(execFile)`(或 `Bun.spawn` + `await .exited`)。`cwd`/`timeout`/`maxBuffer` 在异步 API 上都有。同时埋 `markStall("pi:exec", …)` 面包屑以便精确归因。错误分支(line 246-253、281-295)读 `error.stdout/stderr/status`,`execFile` 的 reject error 也带这些字段,迁移成本低(注意字段名)。

**预估收益/风险**: 收益高 — 移除活动 agent 路径上最大的无界同步子进程冻结。风险低 — 仅 I/O 形态变化,契约不变。

**优先级**: **P1**(最严重,因为是真正的同步硬冻结)。

---

### P1-B — `projects_updated` 在每个 150ms summary flush 上乘性重读所有项目整盘

**现象**: 单个 task-session summary 变化(agent 状态转换时发生,150ms 批处理)就触发一次 projects 载荷重建,而该重建会从磁盘读 **所有项目的所有 task 分片**。

**定位证据**:
- `flushTaskSessionSummaries` 无条件调用 `void broadcastRuntimeProjectsUpdated(workspaceId)`(`runtime-state-hub.ts:187`)。
- `broadcastRuntimeProjectsUpdated` → `buildProjectsPayload`(`workspace-registry.ts:351`)做 `Promise.all(projects.map(... summarizeProjectTaskCounts ...))`(`:363`)。
- `summarizeProjectTaskCounts`(`:312`)→ `loadWorkspaceBoardById`(`workspace-state.ts:658`)→ `readWorkspaceBoard` → `loadShardedBoard` = **该项目整盘分片全读,无缓存**(`projectTaskCountsByWorkspaceId` 仅是出错时的 fallback `:335`,不是命中缓存)。
- 即:每次 summary flush ⇒ 读 N 个项目 × 各自整盘分片;项目数越多,乘性放大越严重。
- 扇出到 **全部** 连接的客户端(全局 `runtimeStateClients`,`:130`,非 workspace 限定)。

**影响范围**: 任何活动会话期间,每 150ms flush 窗口内 O(项目数 P × 每盘分片 N)磁盘读。是最热广播路径上的乘性磁盘扫描。

**建议修复**: (a) 不要在每次 summary flush 都触发 `broadcastRuntimeProjectsUpdated` — projects 载荷只需 task **计数**,其变化远比 summary 少;按真实计数 delta 门控。(b) 按 `meta.revision` 缓存板派生的 task 计数,跳过未变化的项目。

**预估收益/风险**: 单点最大收益 — 从最热广播路径移除「所有项目整盘扫描」。风险低:计数是派生数据,revision-keyed 缓存是精确的。

**优先级**: **P1**(列为头号项)。

---

### P1-C — `workspace_state_updated` 每次广播全量重读板 + ~5 个未缓存 git 子进程

**现象**: 每次 `workspace_state_updated` 广播都从磁盘重建整个 workspace 快照,无缓存。(与 P1-B 同根因,合并自「广播」与「分片」两路 agent 的 F1。)

**定位证据**:
- `broadcastRuntimeWorkspaceStateUpdated`(`runtime-state-hub.ts:359`)→ `buildWorkspaceStateSnapshot`(`workspace-registry.ts:339`)→ `loadWorkspaceState`(`workspace-state.ts:1660`):
  - `loadWorkspaceContext(cwd)` → `resolveWorkspacePath`(1 个 `git rev-parse`)+ `detectGitRepositoryInfo`(`detectGitRoot` + `Promise.all(symbolic-ref HEAD, for-each-ref refs/heads)` + `symbolic-ref origin/HEAD`)= **4–5 个 git spawn,均未缓存**。(`prepareRepoRuntimeHome` 已进程缓存 `:1284`,这部分便宜;**git 探测未缓存** 是问题。)
  - `readWorkspaceBoard` → `loadShardedBoard` → `readStoredTasks`(`task-shard-store.ts:173`):`readdir` + 读 **每个** `tasks/<id>.json`。代码自注:"~0.48s for ~150 shards"(`:176`)。
  - 随后 `broadcastRuntimeWorkspaceStateUpdated` 还调 `workspaceMetadataMonitor.updateWorkspaceState`(`runtime-state-hub.ts:377`)→ `refreshWorkspace` → **每个被跟踪任务** 一个 `probeGitWorkspaceState` git 探测(`workspace-metadata-monitor.ts:325-333`)。
- 触发点很多:pi turn-checkpoint 变化(`runtime-state-hub.ts:588`)、每次 hook 状态转换 `to_review`/`to_running`(`hooks-api.ts:115`)、CLI `notifyStateUpdated`(`task create`/`vault doc create`/文件操作后,`workspace-api.ts:432`)、git checkout/discard、文件 CRUD(`workspace-api.ts:452-463`)。活动会话期间每分钟多次。

**影响范围**: 每次广播、每个活动 workspace:O(N task 分片)磁盘读 + ~5 git spawn + O(M 跟踪任务)git 探测。git 部分现在已异步(task-done-CPU-hang 修复后),不再冻结循环,但负载下是真实的子进程 + I/O churn。

**建议修复**: 给 `loadWorkspaceContext` 的 git 信息加短 TTL 或 revision-keyed 缓存(分支列表很少变,按 repoPath 缓存,checkout 时失效);按 `meta.revision` 缓存组装后的板,使同一 revision 内的重广播跳过分片重读。

**预估收益/风险**: 消除 bursty 广播序列里绝大部分重复 git spawn 与分片重读。风险:若漏挂 checkout 失效则分支列表会陈旧 — 在已有的 checkout/discard handler 上挂失效即可缓解。

**优先级**: **P1**。

---

### P2-A — pi 流式每 token 重发整条累积消息(总字节 O(n²))+ 重复 summary

**现象**: pi 每个 `message_update`(每 token 一次)都把 **当前累积的整条 assistant 消息**(到目前为止的全文)重发给所有连接客户端,且各自一次新的 `JSON.stringify`,同时还发一次 session summary。一条 4KB 回复约 400 token ⇒ ~400 次广播,载荷向 4KB 增长 — 整轮约 O(n²) 字节。

> 交叉验证说明:两路 agent 对此判定不同。「日志」路判 P2(O(n²) 重序列化值得批处理),「广播」路判 P3(per-taskId 隔离 + 载荷小 + 不触发 workspace-state 重算,已较优)。综合裁定 **P2**:前端按 message id 去重 + 按 taskId 隔离扇出确实使其不致命,且 **无客户端连接时 `broadcastTaskChatMessage` 直接 early-return**(`runtime-state-hub.ts:208-210`,后台/headless 会话零开销);但「每 token 重发整条累积文本」在长回复 + 面板打开时确为 O(n²) 字节与主循环 stringify 压力,值得批处理/改增量。

**定位证据**:
- `src/agent-sdk/kanban/pi-event-adapter.ts:264-295` — `handleMessageUpdate` 每 token 跑;调 `emitMessage(...)`(整条消息)**且** `emitSummary(...)` 带 `finalMessage: text`(整条累积文本)。
- `src/server/runtime-state-hub.ts:206-220` — `broadcastTaskChatMessage` 用整条 `message` 建载荷并 loop 所有客户端;`:106-115` 每客户端 `client.send(JSON.stringify(payload))`,**chat 通道无批处理**(对比:session summary 已按 `TASK_SESSION_STREAM_BATCH_MS` 批处理 `:33,200-204`)。

**影响范围**: 每个有 ≥1 ws 观看者的 pi 轮次,频率 = token 速率 × 客户端数。仅面板打开时有真实成本(无连接时 early-return)。

**建议修复**: 像 summary 一样合并/防抖 `task_chat_message` 广播(~50-100ms 或 rAF 对齐),每 taskId 每 tick 只发最新累积文本;前端已按 message id 去重,丢中间帧安全。或改发 token **增量** 而非整条累积文本。并去掉每 token summary patch 里多余的 `finalMessage: text`(`pi-event-adapter.ts:289`,与 chat 通道载荷在第二条通道上重复)。

**预估收益/风险**: 长回复时把流式广播量降 1-2 个数量级,降低面板打开时主循环 stringify 压力。风险低:仅改中间帧节奏,最终消息不变;实时 token 渲染增加一个批间隔的延迟。

**优先级**: **P2**(真实但受观看者门控,非后台空闲成本)。

---

### P2-B — 文件夹选择器 `spawnSync` 原生对话框(同步,无界冻结)

**现象**: 打开系统文件夹选择器会冻结整个运行时,直到用户选定或取消 — 可能数秒或无限期。LAN/远程托管时,一个用户盯着对话框,所有连接客户端都冻结。

**定位证据**:
- `src/server/directory-picker.ts:39` — `defaultRunCommand` → `spawnSync(command, args, …)` 跑 zenity/kdialog/osascript/PowerShell `FolderBrowserDialog`(脚本阻塞到对话框关闭)。
- 来自 tRPC mutation `pickProjectDirectory` — `src/trpc/projects-api.ts:238`: `const selectedPath = deps.pickDirectoryPathFromSystemDialog()`(同步),接线于 `runtime-server.ts:360`。

**影响范围**: 仅 `projects.pickProjectDirectory`(UI 加项目)。罕见且用户发起,但阻塞窗口无界(=对话框打开时长)。注:headless Linux 上这些命令缺失会降级为手动输入路径,故冻结是桌面宿主问题。

**建议修复**: 选择器改异步 spawn(`Bun.spawn`/`execFile` + await exit),`pickDirectoryPathFromSystemDialog` / tRPC dep 返回 `Promise`。对话框本就耗时,异步是正确形态,可让循环在对话框打开期间继续服务其它客户端。

**预估收益/风险**: 收益中 — 移除无界但罕见的冻结。风险中低 — 改 dep 签名(`() => string | null` → `() => Promise<string | null>`),涉及 `runtime-server.ts:84`、`projects-api.ts:57`、`cli.ts:534` 及选择器自身测试。

**优先级**: **P2**。

---

### P2-C — 每次板写入先全量重读板 + 对每个 task 都 read+stringify+compare

**现象**: 写一个被移动/新建的 task,会重读 **所有** 现有 task 分片来重建 `existingRanks` map;且写时对板上 **每个** card 都做 read+stringify+content-compare(即使通常只有 1 个 task 变了)。

**定位证据**:
- `src/state/task-shard-store.ts:292-296` `saveShardedBoard` 开头 `for (const task of await readStoredTasks(boardDir))` — 全 `readdir` + 并行解析每个分片,只为填 `existingRanks`。`mutateWorkspaceState`(`workspace-state.ts:1727`)在 mutate 前 **也** 读了整盘,故单 task 移动 = `mutateWorkspaceState` 一次全读 + `saveShardedBoard` 内又一次全读 + 写。
- `assembleBoard`(`:254`)在组装时丢弃 `rank`,然后保存时又重读回来 — 一次浪费的往返。
- `src/fs/locked-file-system.ts:124-131` `writeTextFileAtomic`:写前 `readFileIfExists` + 字符串比较,相等则跳过写。这是保持「未动的 task 不产生 git churn」的 **有意且承重** 的机制;但 `saveShardedBoard` 的写扇出(`:341`)对每个 card 都调它,故每次保存做 O(N)次 read+stringify+compare。

**影响范围**: 每次板变更(拖拽/移动、建、删)。规模 O(N 分片)读 / 单 task 写。

**建议修复**: 用贯穿性 board cache 提供 `existingRanks`,免磁盘 I/O;或把 `mutateWorkspaceState` 已读的 `StoredTask[]`/ranks 下传给 `saveShardedBoard`,免在 save 内重读。基于缓存做内存 diff(比较序列化 prev vs next),只对真正变化的 id 调 `writeJsonFileAtomic`,跳过未动 task 的 read+stringify(磁盘 content-compare 仍作最终安全网保留)。

**预估收益/风险**: 收益:500-task 板上单 task 移动从 ~499 次 read+stringify+compare 降到 ~1。风险低中,前提是门控在缓存上;需在 mutate→save 缝隙传 rank 数据而不让 `rank` 泄进 wire 契约。

**优先级**: **P2**(并入贯穿性 board cache 一起做)。

---

### P3 级微开销(真实但小)

- **P3-A — 凭证注入每次 `runGit` 额外 2 次 `stat()`(登出态也跑)**: `runGit` 无条件调 `collectGitCredentialInjection()`(`git-utils.ts:116`),遍历已注册的 `"github"`/`"gitee"` 注入器(`cli.ts:420-421`)。mtime 缓存短路了 **文件读**,但 **没短路 `stat()` 本身**(`github-auth-service.ts:119-128`,gitee 同)。登出态下 `stat()`(ENOENT)仍每次触发。一次 debounce 提交 ≈ 7 次 `runGit` ⇒ ~14 次额外 stat。建议:给 `stat()` 加 250-500ms TTL,或登录前惰性注册注入器。**P3**(mtime 缓存已挡住昂贵的读+解析+zod)。

- **P3-B — 每次 commit + 每次徽章查询重算 4-spawn ahead/behind**: `runCommitOnly` 总在末尾调 `emitStatus`(`board-sync.ts:253`)→ `getBoardWorktreeAheadBehind`(`board-worktree.ts:369-396`)= `isGitWorktree` + `getDefaultRemote` + `remoteBranchExists` + `rev-list` = **4 git spawn**;`commitBoardWorktree` 本身 3 spawn。一次 debounce 写 ≈ 7 git spawn。`getBoardWorktreeAheadBehind` 也在每次 `getBoardSyncStatus` tRPC 查询(徽章挂载/刷新,`workspace-api.ts:593`)重跑。频率受 5s debounce 限,绝对成本低。建议:对效果上静态的 `isGitWorktree`/`getDefaultRemote` 加短 TTL;或 `commitBoardWorktree` 返回 `false`(无提交)时跳过 `emitStatus` 重算。**P3**。

- **P3-C — `saveShardedBoard` 多余第 2 次 `readdir`**: `:345` 的 `listTaskFileIds`(算删除集)与 `:294` 的 `readStoredTasks`(已 `readdir`)重复。复用前者枚举的 id 列表即可。**P3**(琐碎)。

- **P3-D — task/board worktree 双锁理论竞态**: task worktree setup 锁(`task-worktree.ts:99-105`,按 git-common-dir)与 board worktree setup 锁(`board-worktree.ts:135-141`)是同一 common-dir 上的 **两把不同 lockfile**,故冷克隆 board setup 与 task start 并发时,两个 Kanban 发起的 `git worktree add` 不被 Kanban 锁互斥(靠 git 自身 `index.lock` 兜底)。board setup 是一次性冷启动事件,碰撞概率低。若实测出现 git lock 错误,再把两者统一到一把锁。**P3**。

- **P3-E — 通用分片库无缓存**: `committed-provider-store`/`saved-view-store`/db `connection-store` 每次访问 `readShardDir` 全读、写时重序列化整 map。但这些集合小(个位/低双位数)、不在 per-turn 广播路径,`writeShardDir` 的 content-compare 使未变分片 no-op。**P3 / no-op**,仅记录完整性。

---

## 3. 已核实「实现良好,无需改动」(避免重复调研)

事件循环 / 同步子进程:
- **此前 P0 已修复**:`detectGitRepositoryInfo`/`resolveWorkspacePath`/`runGitCapture`(`workspace-state.ts:1089-1194`)全异步,带 10s 超时 + maxBuffer + 降级 `null`,埋了 `markStall("git:detect")`。
- 所有热路径 state store 用异步 fs(`sharded-json-store.ts`、`task-shard-store.ts`、`session-message-journal.ts`、`vault-document-store.ts`、`get-workspace-changes.ts`);`runGit` 异步。
- `existsSync` 仅单次 stat,可忽略(`board-ref.ts:47`、`board-worktree.ts:98`);`agent-provider-config.ts` 的 `readFileSync` 有内存缓存(`loadState` 一次读盘)。
- 冷/CLI/启动路径的同步 fs/spawn(`cli.ts` bootstrap、`update.ts` 自更新、`service/*` 守护进程安装、`db/driver/*` 一次性 SSL CA、`commands/hooks.ts`)正确地保持同步,不在运行时循环上。
- 厂商 vendored omp 代码(`src/agent-sdk/shared/*` 等)保留自有约定,**勿动**,非 Kanban 热路径。

分片读写:
- 所有扇出走 `mapFilesConcurrent`(`concurrent-files.ts`,共享 `p-limit(48)` 包 `Promise.all`)— **并行、fd 受限,非串行 await**(EMFILE 历史已修)。
- rank reconcile 便宜:`reconcileColumnRanks`(`task-rank.ts:15-65`)O(列内任务数)两趟线性;`generateNKeysBetween` 只对被移动的段调用,单 task 移动只重排 1 个分片。
- 撕裂分片跳过不致命(`task-shard-store.ts:180-205`);`writeShardDir` 删除集只用一次 `readdir`(无 per-file stat)。
- **requirements 不在热路径**:requirement 子系统已退役(B6),分片仅在一次性 vault 迁移时读(`workspace-state.ts:684-734`)。原始调研对「per-requirement 读」的担忧在本分支不适用;`requirement-store.ts` 在本分支不存在。

git 操作:
- board-sync 架构健全:写→5s debounce 本地 commit→不联网(`runCommitOnly` 永不 push/fetch,`board-sync.ts:224-254`);push/pull 仅用户发起(`runManualPush`/`runManualPull`)。
- 每 repo 串行队列(`enqueue` `:131-140`)把 commit/push/pull/rename/reconcile/shutdown-flush 串成单链,带 `.catch` 防毒化。
- 网络 git 带 30s 超时 + SIGKILL(`BOARD_NETWORK_GIT_TIMEOUT_MS`)。
- debounce 合并正确(`scheduleSync` 每写 `clearTimeout`,`timer.unref()`,测试 `board-sync.test.ts:127` 覆盖)。
- 后台 reconcile **正确退避自停**:延迟 `[15s,30s,60s,120s,300s]` 按 repo 尝试数索引并钳在末位;仅 `still-unreachable` 重排,其它状态清计数不重排;非 adopt-pending 直接 bail;正常路径不 log spam;`timer.unref()`。**不是 30s 错误风暴循环**。
- worktree setup 把昂贵的 per-worktree 镜像/patch 放在锁 **外**,只对短的 `worktree add` 临界区按 repo 串行;repo 级 ignore-path 计算有 1s TTL 缓存,防启动 burst 重算。
- `scheduleSync` 在每次 committed-data 广播触发,但其自身便宜(无 git spawn),5s debounce 是限频器;push 不在 commit 路径上,杜绝了此前「广播→saveState→scheduleSync 把 CPU 打满」的反馈环。

广播扇出:
- 除 `projects_updated` 与 `runtime_metrics_updated`(有意全局)外,所有通道按 `runtimeStateClientsByWorkspaceId` 限 workspace 扇出,看别的 workspace 的客户端不被唤醒。
- `task_sessions_updated` 150ms 合并;PTY data chunk **不广播**(`updateSummary` 每 chunk 但 `emitSummary` 仅状态转换;无观看者时跳过输出扇出);hook `activity` 事件 early-return 不广播(只有 `to_review`/转换广播)。
- workspace-metadata 轮询自适应退避 1s→5s,`refreshPromise` 并发守护,per-task git 工作 `stateToken` 缓存(未变时只跑便宜探测,跳过昂贵的 `getGitSyncSummary`)。

日志 / journal:
- journal coalescing 生效:per-task `tail`,仅 id 变 / 250ms debounce / flush 时追加;**异步 `appendFile`**(非 sync,非全文件重写);id+content 不变跳过写;per-task `.then` 链串行写,链替换不留已解析节点(无无界 promise 链内存增长);`timer.unref()`。读路径 `parseTranscript` O(file) 但读不频繁(面板打开,非 per token),且 `loadMergedMessages` 用 `SessionMessageMergeCache` 按 `journal.getGeneration` 缓存,未变 transcript 不重读;compaction 由 `DEFAULT_COMPACTION_STALE_THRESHOLD=16` 门控,`maxMessages=10_000` 截断带 in-band 标记。
- 日志门控正确:`emit`(`logging/logger.ts:136-144`)**第一行** 就 `isLevelEnabled` 门控,在字段 merge 与 `sink` 之前 — below-threshold 的 `log.debug` 零序列化成本。文件 sink 惰性 + 默认关(`KANBAN_LOG_FILE`);无 per-log sync flush(winston `DailyRotateFile` 内部缓冲)。经 grep 核实 **无热循环调用点传大对象**(命中均为 one-shot launch 级日志)。
- 终端 per-chunk 路径干净:`onData`(`session-manager.ts:542-634`)**无 log 调用**;`applyOutput` 微批修复 **在位**(retain-by-reference,64KB 阈值或 16ms 定时器 flush,单次 `Buffer.concat`);scrollback 限 5000 且 `getCommittedLines` 按游标只扫新滚出行(O(delta));`recordInput` 限 `MAX_PENDING_INPUT_CHARS=8192`。

---

## 4. 建议实施顺序

1. **P1-A**(`pi-tools-bridge.ts` 的 `execute_command`/`search_files` 改异步)— 独立、低风险、移除唯一遗留的同步硬冻结。可单独成任务先做。
2. **贯穿性 board/context 缓存**(吃掉 P1-B、P1-C、P2-C)— 最高杠杆,但需仔细处理与 board-sync git 写入者的缓存一致性(pull/`reset --hard`/conflict abort 必须显式失效)。建议:(a) 先做 `projects_updated` 的计数门控 + revision 缓存(P1-B,收益最大、风险最低);(b) 再做 `workspace_state_updated` 的 board + git-context 缓存(P1-C);(c) 顺带让 save 路径复用缓存(P2-C)。
3. **P2-A**(批处理/增量化 `task_chat_message` 广播 + 去重复 summary `finalMessage`)— 镜像已有的 summary 批处理机制。
4. **P2-B**(文件夹选择器异步化)— 改 dep 签名为 `Promise`,涉及面小但跨几处接线。
5. **P3 项** — 仅在 git-spawn / stat 计数实测成为瓶颈时再做;均为有界、异步、非冻结风险。

---

*调研产出 by 5 路并行只读 agent,2026-06-29。所有 file:line 引用基于当前 worktree(`aee8b`)快照,实施前请复核行号。*

---

## 5. 实施记录 (2026-06-29, worktree `8c1f0`)

按优先级落地,所有改动 wire contract 不变、前端零改动、补单元测试。`tsc` 基线有 ~123 个既存 vendored-omp 报错(`src/agent-sdk/ai/*`),本次改动净增 0;`test/runtime` 有 ~21 个既存环境依赖失败(proxy/network-bridge/agent-registry/runtime-config/endpoint),与本次无关(stash 对比确认)。

- **✅ P1-A** — `pi-tools-bridge.ts`:`execute_command`/`search_files` 从 `execSync` 改为 `promisify(exec)`(保留 shell 语义:搜索的 `grep | head` 管道、任意用户命令)。错误字段 `status`→`code`(exec 约定)。**收益**:移除活动 agent 路径上唯一遗留的同步硬冻结(单次最长 60s/30s 主循环阻塞 → 0)。测试 `test/agent-sdk/pi-tools-bridge.test.ts`:非阻塞竞速(执行期间 50ms 定时器先于命令 resolve)+ stdout/stderr/exit-code/搜索正确性。
- **✅ P1-B** — `flushTaskSessionSummaries` 不再每次 150ms flush 都重建所有项目载荷;改为 `registry.refreshProjectTaskCountsIfChanged(ws)`(只读**本** workspace 一次盘)→ 仅当本 workspace 的粗粒度计数(backlog/in_progress/review/trash)真正变化时才 `broadcastRuntimeProjectsUpdated`。**收益**:活动会话期间最热广播路径从 O(项目数 P × 每盘分片) 磁盘读降为「计数未变 ⇒ 1 次本盘读、0 扇出」(绝大多数 token/内部状态 flush 不移动 task 列)。纯函数 `projectTaskCountsEqual` 导出+测试。出错兜底回退无条件广播,UI 不会卡在陈旧态。
- **✅ P1-C(git 部分)** — `detectGitRepositoryInfo` 加 5s TTL 缓存(按 `resolve(repoPath)`)+ `invalidateGitRepositoryInfoCache`;`checkoutGitBranch` 成功后失效。**收益**:每次 `workspace_state_updated` 广播从 ~5 个未缓存 git 子进程(rev-parse×2 + symbolic-ref + for-each-ref + origin/HEAD)降为缓存命中 0 spawn;分支信息陈旧上限 5s(纯展示,checkout 立即失效)。测试在 `workspace-state-git-detection.test.ts`(缓存命中不反映新分支 + 失效后反映)。
- **✅ P2-A** — 抽出 `src/server/task-chat-message-batcher.ts`:按 `(ws, task, messageId)` 合并、保序、50ms 防抖(注入式定时器以便测试),接入 hub `broadcastTaskChatMessage`(保留无观看者 early-return 的零开销;dispose/close 清理)。**收益**:长回复流式广播从 O(tokens) 次「整条累积消息重序列化」降为 ~1 次/50ms 窗口(降 1-2 个数量级),distinct 消息全保序不丢。另:pi-event-adapter 每 token summary 的 `finalMessage: text`→`null`(与 chat 通道重复;前端仅在 review-ready 读 finalMessage,取 message_end 的最终值)。测试 `test/server/task-chat-message-batcher.test.ts`。
- **✅ P2-B** — `directory-picker.ts` `spawnSync`→`promisify(execFile)`,`pickDirectoryPathFromSystemDialog` 返回 `Promise<string|null>`;dep 签名在 `runtime-server.ts`/`projects-api.ts` 更新(+`await`),`cli.ts` 直接传异步函数。归一化 `DirectoryPickerCommandOutput`(解耦 spawnSync 形状)。**收益**:对话框打开期间不再冻结整个运行时(无界 → 异步,其它客户端继续服务)。测试改异步 + 非阻塞竞速。
- **⚠️ 延迟(按风险)— P1-C 的 board-读 部分 + P2-C(贯穿性 board-assembly 缓存)**:这是唯一触及**数据正确性**的一项(缓存陈旧 ⇒ UI 显示错误的卡片/列),不在长会话末尾仓促引入。**已落地的改动已吃掉最大的广播 churn(P1-B 的 ×P 扇出 + P1-C 的 git spawn)**;剩余的「每广播一次本盘分片读」是有界并行异步 I/O,非冻结。
  - **后续安全设计**:按 `workspaceId` 缓存组装后的板,key 用 `meta.revision`;进程内写经 `mutateWorkspaceState`/`saveShardedBoard` 自增 revision ⇒ 自动失效。**外部写盘者必须显式 `invalidateBoardCache(ws)`**:仅两处 —— `board-sync.ts runManualPull`(merge 拉取)与 `board-worktree.ts adoptRemoteBoardIfPending`(`reset --hard`)。关键陷阱:`meta.json` 在 runtime-home(**非** board worktree,方案 C),拉取不会自增 revision,故显式失效是**强制**的;`merge --abort` 保留本地无需失效。注意导入环(board-sync → … → `git-utils` 是 leaf,缓存放 `task-shard-store`/`workspace-state` 并由 board-sync 反向调用需防环)。P2-C 顺带:用缓存的 `existingRanks` 免 `saveShardedBoard` 内重读。
  - **不要动 P3-C**:`saveShardedBoard` 的第 2 次 `readdir`(`listTaskFileIds`)并非纯冗余 —— 它捕获 `readStoredTasks` 跳过的撕裂分片以便删除,"去重"会漏删坏文件。
- **P3-A/B/D/E**:未做(仅在 git-spawn/stat 计数实测成瓶颈时再做;均有界、异步、非冻结)。
