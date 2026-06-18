# 设计文档:看板数据与代码分支解耦(方案 C / board-branch)

> 状态:设计/调研稿(不含实现代码)。日期 2026-06-18。
> 范围:确定架构与决策,供后续拆成多个实现任务。

## 1. Context —— 为什么做这件事

当前 Kanban 把看板的完整持久状态(`tasks/<id>.json`、`board.json` 布局清单、vault 文档 `files/docs/**`、文件库 `files/**`)作为**被 git 跟踪、提交进当前 checkout 的代码分支工作区**的文件来存储。判据见 `<repo>/.kanban/.gitignore` 的 **denylist(默认提交,只忽略 runtime/secret)** 策略。

这带来两个问题:

1. **主工作区永远脏 → 切分支被挡。** 运行中的 runtime 持续重写 `tasks/*.json`(`saveWorkspaceState`/`mutateWorkspaceState` 无 commit,只落盘),导致工作树常年 dirty;`git switch` / Git History 双击切分支报 `local changes would be overwritten`。
2. **概念错位。** 看板是 **workspace 级**的东西,却绑死在"当前 checkout 的代码分支"上 —— 切代码分支等于换一套看板,合并代码分支还要合并看板 JSON。

**硬约束(不可违反):**
- 看板完整状态(column/rank/依赖/spec)**必须随仓库走**,clone 后能接着之前的看板记录继续(clone-即用)。
- 因此**不允许**用"挪到机器本地 / gitignore 掉 / 取消跟踪"来回避 —— 那会破坏 clone-即用。

**选定方向:方案 C** —— 看板数据独占一条专用 git 分支(默认 `kanban/board`,orphan,与代码分支平行、永不合并),由 runtime 在一个**专用 worktree** 里读写;代码分支上把 `.kanban` 数据 gitignore 掉,只留一个随代码树走的**指针文件**指明看板在哪条分支。

> **与补丁任务 9d884 的关系:** 9d884 是"切分支前自动提交 `.kanban`"的治标补丁。方案 C 采纳后,代码分支不再跟踪 `.kanban` 数据 → 切分支天然干净,**9d884 作废**(不实现 / 若已存在则回退)。

---

## 2. 现状梳理(关键文件 / 路径 / 读写入口)

> 注:本 worktree(9d8fd)上 **没有** `src/state/kanban-paths.ts`(Phase 1 路径重构未合入此分支);路径函数仍**内联在 `src/state/workspace-state.ts`**。下文以此分支实际代码为准。

### 2.1 单一根 chokepoint
`src/state/workspace-state.ts`:
- `getRuntimeHomePath(repoPath)` **`:237`** → `<repoPath>/.kanban`。**所有 committed 数据的根**。
- `getWorkspacesRootPath(repoPath)` `:245` → `<repoPath>/.kanban/workspaces`
- `getWorkspaceDirectoryPath(repoPath, wsId)` **`:254`** → `<repoPath>/.kanban/workspaces/<id>`。**board/tasks/sessions/meta/threads/committed-providers 全部经此派生**(`:268`–`:330`)。
- `getTaskWorktreesHomePath(repoPath)` `:242` → `<repoPath>/.kanban/worktrees`(任务 worktree,gitignored)。
- vault:`getRuntimeHomePath(repoPath)/files/docs/...`(`:306` 等)。
- `repoPath` 来源:`resolveRepoPathForWorkspaceId(wsId)` `:753`,读机器本地 `~/.kanban/workspaces/index.json`(跨仓库索引)映射 `wsId → repoPath`。

### 2.2 board / vault 读写入口
- `src/state/task-shard-store.ts`:`loadShardedBoard(boardDir, legacyBoardDir?)` / `saveShardedBoard(boardDir, board)`;`boardDir = getWorkspaceDirectoryPath(repoPath, wsId)`。装配/拆解 `board.json`(布局)+ `tasks/<id>.json`(每任务分片,含 rank/dependsOn/owner)。**wire 契约 `runtimeBoardDataSchema` 不变**,分片只在存储层。
- `src/state/sharded-json-store.ts`:`readShardDir`/`writeShardDir`(目录 ↔ `Map<id,value>`)。
- `src/vault/vault-document-store.ts`(`<repo>/.kanban/files/docs/<type>/*.md`)、`src/files/file-library-store.ts`(`files/files.json` + LFS `blobs/`)。
- `loadWorkspaceState`/`saveWorkspaceState`/`mutateWorkspaceState`(`:1265`/`:1273`/`:1325`):workspace-dir 锁下读写,**不 commit**。

### 2.3 git / worktree 机制(可复用)
- `src/workspace/git-utils.ts`:`runGit(cwd, args, opts)` / `getGitStdout` —— Node `execFile`,支持自定义 env、10MB buffer。**通用 git spawn 助手**。
- `src/workspace/task-worktree.ts`:`getTaskWorktreePath(repoPath, taskId)` `:131`;`ensureTaskWorktreeIfDoesntExist` `:437`;`deleteTaskWorktree` `:565`。worktree 物理位置 `<repo>/.kanban/worktrees/<taskId>/<label>`(与本 cwd 一致),`git worktree add` + 创建锁(`.git/kanban-task-worktree-setup.lock`)。
- `src/workspace/git-sync.ts`:`probeGitWorkspaceState`(branch/upstream/ahead-behind/changes)`:113`、`runGitSyncAction`(fetch/pull/push)`:249`、`runGitCheckoutAction`(智能切支)`:291`、`discardGitChanges` `:345`。
- `src/workspace/turn-checkpoints.ts`:用**专用 git identity**(`kanban-checkpoint`)+ 临时 index + `commit-tree` + 写 ref(`refs/kanban/checkpoints/...`)做无副作用提交。**board commit 可照搬这套 identity/临时-index 手法。**
- `src/workspace/task-worktree-path.ts`:`KANBAN_TASK_WORKTREES_DIR_NAME = "worktrees"`、ID 校验。
- **今天没有文件 watcher**;board 每次请求 `loadShardedBoard` 现读;前端经 `src/server/runtime-state-hub.ts` `broadcastRuntimeWorkspaceStateUpdated` `:312` 发 `workspace_state_updated`。

### 2.4 迁移 / 设置模板
- `src/state/workspace-state.ts` `prepareRepoRuntimeHome(repoPath, wsId)` `:1050`:在 `loadWorkspaceContext` `:1035`(index 锁内)调用,顺序跑一串**幂等**一次性迁移(`migrate*`),模式 = **廉价 precheck → workspace-dir 锁 → 锁内 recheck → 干活**(见 `migrateWorkspaceBoardToShards` `:1205`)。**新迁移加在这里。**
- 工作区设置模板:`src/vault/vault-settings-store.ts`(committed `files/settings.json`,Zod schema `runtimeVaultSettingsSchema`,与 files 同锁)+ tRPC `getVaultSettings`/`updateVaultSettings`(`src/trpc/workspace-api.ts` `:483`)+ 改后 `broadcastRuntimeWorkspaceStateUpdated`。**新设置照此加。**
- `.kanban/.gitignore` 当前内容(denylist):忽略 `worktrees/`、`trashed-task-patches/`、`**/sessions.json`、`**/sessions/`、`**/meta.json`、`*.lock`、secrets;**其余默认提交**(board.json/tasks/files/docs)。

---

## 3. 方案 C 完整架构

### 3.1 三条 git 线,严格独立
| 线 | 分支 | worktree | 装什么 |
|---|---|---|---|
| 代码主树 | 用户的代码分支 | 仓库主目录 | 代码;`.kanban` 被忽略(除指针) |
| 任务代码 | `kanban/task/<id>`(现状) | `<repo>/.kanban/worktrees/<taskId>/<label>` | 从 baseRef 切出的代码改动,done 时并回 baseRef |
| **看板数据(新)** | **`kanban/board`(orphan,默认名,可配)** | **`<repo>/.kanban/worktrees/__board__/<label>/`** | **只有 `.kanban` 看板 JSON / vault / files** |

`kanban/board` 分支**永不接收任务代码**,任务 worktree 永不接触 `kanban/board`。两条 git 线靠"不同分支 + 不同 worktree"天然隔离。

### 3.2 board worktree(已选:仓库内 worktrees/ 下)
- 物理位置:`<repo>/.kanban/worktrees/__board__/<label>/`,与任务 worktree 同根、**已被代码分支 gitignore**(`worktrees/` 规则)。`__board__` 作保留 sentinel(经 `normalizeTaskIdForWorktreePath` 等价校验或单独常量,避免与真实 taskId 撞)。
- 该 worktree 内部布局**镜像现状**:`<boardWorktree>/.kanban/workspaces/<id>/board.json|tasks/...`、`<boardWorktree>/.kanban/files/docs/**`。于是**路径派生逻辑全部复用**,只把传入的"committed-data 根"从 `<repo>/.kanban` 换成 `<boardWorktree>/.kanban`。
- 出现 `.kanban/worktrees/__board__/.kanban/...` 的嵌套是预期的、可接受的(外层 `.kanban` 是代码树的、被忽略;内层 `.kanban` 是 board 分支的工作树内容)。
- 共享主仓库 `.git`(worktree 机制)→ fetch/push/branch 都对同一 remote 生效。

### 3.3 路径根的"二分"(核心改动点)
今天一个 `repoPath` 派生全部。方案 C 把根**显式二分**:

- **committed 看板数据根** → `boardDataHome(wsId) = <boardWorktree>/.kanban`:`getWorkspacesRootPath` / `getWorkspaceDirectoryPath`(board.json/tasks)、vault `files/docs`、`files/`(库+LFS)、committed-providers、threads。
- **机器本地 runtime 根** → 仍 `<repo>/.kanban`:`getTaskWorktreesHomePath`(任务 worktree —— **必须留主仓库,否则递归**)、`trashed-task-patches/`、`.gitignore` 本身、以及(见 §3.4)sessions/meta/锁。

落地手法(不写码,仅定方向):引入一个 **`BoardDataLocation` 解析**,在 `loadWorkspaceContext` 阶段算出 `{ runtimeHome: <repo>/.kanban, boardDataHome: <boardWorktree>/.kanban }`,把现有 `getWorkspaceDirectoryPath(repoPath, …)` 的调用点改成接收 `boardDataHome`(committed)或 `runtimeHome`(runtime)。`getWorkspaceDirectoryPath` 仍是 chokepoint,只是它的根入参来源被替换。

### 3.4 sessions/meta/locks 放哪(决策)
现状这些在 `getWorkspaceDirectoryPath` 下(committed 目录里,但被 denylist 忽略)。方案 C **保留它们在 `<repo>/.kanban/workspaces/<id>/`(runtime 根)**,不搬进 board worktree。理由:① 它们本就机器本地/gitignored;② board worktree 应只含 board 分支会提交的内容,放 runtime-only 文件进去会让 board 分支工作树多出一堆 ignored 文件、易误提交;③ workspace-dir 锁仍锚在 runtime 根,迁移期与现状一致。
→ 即:**`workspaces/<id>/{board.json,tasks/,docs|files...}` 走 board worktree;`workspaces/<id>/{sessions*,meta.json,*.lock}` 留主仓库 `.kanban`。** 两处同名 `workspaces/<id>` 目录并存(一处 committed-数据、一处 runtime),由二分根区分。

### 3.5 指针文件(发现入口,关键)
- 代码分支里保留**唯一不被忽略的** `.kanban/board-ref`(JSON:`{ "version": 1, "branch": "kanban/board" }`)。它随代码树提交 → clone 后据此知道去哪条分支加载 → clone-即用成立。
- **指针不能存在 board 分支自身**(鸡生蛋):board 分支不含 `board-ref`。
- 代码分支 root `.gitignore` 用"忽略目录内容 + 重新纳入单文件"模式:
  ```
  /.kanban/*
  !/.kanban/board-ref
  ```
  (忽略的是 `.kanban/*` 内容而非 `.kanban/` 目录本身,故可 `!` 重新纳入 `board-ref`;若忽略目录本身则无法再纳入子文件。)
- 现有 `<repo>/.kanban/.gitignore`(denylist)**继续作为 board 分支的 ignore 规则**(board 分支仍要提交 board.json/tasks/files 但忽略 worktrees/sessions/meta/locks)。它本身在 board 分支被提交。

### 3.6 启动序列
`loadWorkspaceContext` → `prepareRepoRuntimeHome` 内新增 `ensureBoardWorktree(repoPath, wsId)`:
1. 读代码树 `.kanban/board-ref`;无 → 进入**迁移/初始化**(§7)。
2. `git fetch <remote> <branch>`(存在 remote 时)。
3. 确保 board worktree 存在且 checkout 在目标分支:不存在则 `git worktree add <path> <branch>`(本地无该分支但 remote 有 → `--track`);已存在则校验分支正确。
4. **ff-only** 把 board worktree 推进到 `origin/<branch>`(落后时);本地领先则留待推送。
5. 之后所有 board 读写指向 board worktree(§3.3)。
全程在 workspace-dir 锁 + board-worktree 创建锁(仿 `task-worktree.ts` 的 `.git/...lock`)下,幂等。

### 3.7 写入 → commit → push
- runtime 写 board(`saveShardedBoard` 等)落到 **board worktree**。
- 写完触发 board commit:用 `kanban/board` 专用 git identity(仿 `turn-checkpoints.ts`),`git -C <boardWorktree> add -A && commit -m "board: <摘要>"`。可走临时-index 法避免污染 board worktree 的 index 状态,但 board worktree 是 runtime 独占的,直接 `add -A` 更简单 —— **推荐直接 add/commit**(board worktree 没有人手动操作)。
- **去抖自动 push**(§5)。

---

## 4. 七个必敲设计点 —— 决策与取舍

**(1) board worktree 落地** — 见 §3.2/§3.3。位置 `<repo>/.kanban/worktrees/__board__/<label>/`(已选);已被 gitignore;与任务 worktree 同生命周期范式(`task-worktree.ts` 的 ensure/创建锁/路径校验可复用);读写路径经"二分根"从 `<repo>/.kanban` 重定向到 `<boardWorktree>/.kanban`。任务 worktree 体系**不动**。

**(2) 分支名指针(随仓库走)** — 见 §3.5。`.kanban/board-ref`(代码分支唯一不忽略的文件)是发现入口;不存 board 分支自身;`/.kanban/* + !/.kanban/board-ref` 实现。

**(3) 分支名可配置** — Settings 新增 workspace 级设置 `boardBranch`(默认 `kanban/board`),照 `VaultSettingsStore` + tRPC 模板加(§2.4)。**真值同时落两处**:committed 设置(便于 UI 编辑)+ `.kanban/board-ref`(发现入口)。约定:`board-ref` 是权威发现源;设置里的值改动会触发改名迁移(4)并同步写 `board-ref`。

**(4) 改名迁移(不可弃旧重开)** — 在 board worktree 内:① `git branch <new> <old>`(基于旧 tip 建新,历史/数据带过去);② 把 board worktree 切到 `<new>`(`git -C <bw> switch <new>`);③ 更新并提交代码树 `.kanban/board-ref` 与设置;④ 同步远端:`git push origin <new>` 然后 `git push origin --delete <old>`(旧分支可保留一个 grace 期或打 tag `kanban/board-archive/<ts>` 再删,作回滚锚)。失败回滚:任一步失败则停在旧分支、`board-ref` 不动、UI 报错。**绝不**"建空新分支" → 杜绝看板变空。

**(5) push/pull 同步策略(已选:启动拉 + 变更自动推去抖)**
- 启动:`fetch` + ff board worktree(§3.6)。
- 变更:写分片 → commit(board identity)→ **去抖 ~5s** 合并多次写为一次 push。
- push 被拒(remote 领先):`fetch` → 在 board 分支上 merge/rebase。分片化(每任务一文件、`board.json` 仅布局)使不同任务的并发改动**天然无冲突**;同一任务/同一布局冲突 → 不自动毁数据,**surface 到 UI** 让用户裁决(可为 `board.json` 配 union merge driver 减少布局冲突)。
- **同步状态 UI 可见**(消除"飘"):`[✓已同步] / [↻同步中] / [↓落后 N] / [⚠冲突]`,数据源 `probeGitWorkspaceState`(ahead/behind)。
- 自动 vs 手动:默认自动(去抖),提供手动"立即推送/拉取"与"暂停自动同步"开关。
- 多机/交接:靠该分支 push/pull;分片冲突少 + UI 冲突提示兜底。

**(6) 切分支后内存/磁盘一致性**
- 主代码工作树切分支**不再影响看板**(`.kanban` 数据已从代码分支解耦/忽略)→ 这正是方案 C 的目的,问题消解。
- board worktree 自身被外部推进(pull 带来新 commit)后:在执行 pull/ff 的**同一流程结束处**重新 `loadShardedBoard` + `broadcastRuntimeWorkspaceStateUpdated` 刷新内存与前端(复用现有广播,无需新 watcher)。本地写为权威,无需轮询文件。
- (可选增强,非 v1)对 board worktree 加 `chokidar` watcher 捕获带外编辑;v1 不做。

**(7) 迁移路径** — 见 §7。

---

## 5. 触及模块清单

| 模块 | 改动性质 |
|---|---|
| `src/state/workspace-state.ts` | 二分根:`getRuntimeHomePath`/`getWorkspaceDirectoryPath` 调用点区分 runtime vs boardData 根;`loadWorkspaceContext` 算 `BoardDataLocation`;`prepareRepoRuntimeHome` 加 `ensureBoardWorktree` + 迁移 |
| `src/state/task-shard-store.ts` | `loadShardedBoard`/`saveShardedBoard` 接收 boardData 根(签名不变,传不同 dir) |
| `src/vault/vault-document-store.ts`、`src/files/file-library-store.ts` | 构造入参根从 `<repo>/.kanban` → boardData 根 |
| **新增** `src/workspace/board-worktree.ts`(仿 `task-worktree.ts`) | ensure/创建/改名 board worktree;commit/push/pull/probe(复用 `git-utils`/`git-sync`/`turn-checkpoints` identity) |
| **新增** `src/state/board-ref.ts` | 读写 `.kanban/board-ref` 指针 |
| `src/workspace/git-sync.ts` / `git-utils.ts` | 复用;可能加 board 专用 sync action |
| `src/server/runtime-state-hub.ts` / `workspace-registry.ts` | pull/改名后触发 board 重载 + 广播;同步状态广播 |
| `src/trpc/workspace-api.ts` + `src/core/api-contract.ts` | 新设置 `boardBranch` 的 get/update;同步状态/手动 push-pull 端点;contract schema |
| `src/vault/vault-settings-store.ts`(或新建 board-settings) | 承载 `boardBranch` 设置 |
| `<repo>/.kanban/.gitignore` + 代码分支 root `.gitignore` | board 分支沿用 denylist;代码分支加 `/.kanban/* + !/.kanban/board-ref` |
| web-ui:Settings(分支名)+ 看板顶栏同步状态徽标 | 新 UI |
| 任务 9d884(切分支前自动提交 .kanban) | **作废/回退** |

---

## 6. 风险与体感

- **git worktree + orphan 分支创建**:`git worktree add --orphan`(git ≥ 2.42)或 plumbing(空 `mktree` → `commit-tree` → `git branch`)。需探测 git 版本,优先 plumbing 保兼容。
- **嵌套 `.kanban`**:排查心智成本(已接受);文档明示外层忽略、内层是 board 分支工作树。
- **board worktree 被误删/损坏**:`ensureBoardWorktree` 幂等重建;数据在 board 分支(本地 + remote)不丢。
- **指针与设置漂移**:约定 `board-ref` 为权威;改名走迁移流程同步两处。
- **并发多机同一任务冲突**:分片已大幅降冲突;残余冲突 surface 到 UI,绝不自动毁数据。
- **首次写在脏代码树**:迁移期 `git rm --cached` + gitignore 落定前后要幂等,避免半迁移态(§7 锁 + recheck)。
- **体感**:切代码分支瞬间干净(主目标达成);同步状态徽标消除"飘";自动 push 去抖避免提交风暴。

---

## 7. 迁移路径(现有仓库 + 全新仓库,幂等可回滚)

**判定(幂等门):** `.kanban/board-ref` 存在且 board 分支存在 → 跳过。否则在 workspace-dir 锁内执行,锁内 recheck。

**现有仓库(代码分支已提交了 `.kanban` 看板数据):**
1. 采集:现 `<repo>/.kanban` 工作树即当前看板数据(committed 部分)。
2. 建 board worktree + orphan `kanban/board`;把当前 `.kanban` 的 committed-数据(board.json/tasks/files/docs,按现 denylist 过滤)复制进 board worktree 的 `.kanban/`;`commit`(初始)。
3. 写代码树 `.kanban/board-ref`(branch=配置值)。
4. 代码分支:root `.gitignore` 追加 `/.kanban/*` + `!/.kanban/board-ref`;`git rm -r --cached .kanban`(保留 `board-ref` 跟踪);`commit`("decouple kanban board to branch")。
5. 有 remote 则 `push origin kanban/board`。
- **回滚思路**:① 代码分支历史仍含旧 `.kanban` 数据(`rm --cached` 不删历史)→ revert 那个 commit 即恢复跟踪;② 删 `board-ref` + 删 board 分支即回到现状;③ 改名迁移留 `kanban/board-archive/<ts>` tag 作锚。
- **半迁移崩溃容忍**:锁 + 锁内 recheck + 每步幂等(worktree ensure、branch 存在性、`rm --cached` 对已 untracked 安全)。

**全新仓库(无既有 `.kanban` 数据):** 首启即建空 orphan `kanban/board` + board worktree + 写 `board-ref` + 代码分支 gitignore;无数据可采集,直接初始化。

**clone 后(他人接手):** `.kanban/board-ref` 随代码到位;`kanban/board` 在 remote → 启动 `fetch` + `worktree add --track` → clone-即用。若 remote 无该分支(对端没 push)→ 按"全新仓库"初始化空看板,并提示。

---

## 8. 分阶段实施拆解(后续可拆成实现任务)

> 状态(2026-06-18):P0–P5 全部落地。逐阶段提交见 git log `feat(board-state): … (P0…P4)` + P5 收尾 commit。

- **P0 路径二分(地基)** ✅:引入 `BoardDataLocation`,把 committed 根从 `<repo>/.kanban` 抽象出来,默认仍指向 `<repo>/.kanban`(行为不变)。纯重构 + 测试。
- **P1 board worktree 生命周期** ✅:新建 `board-worktree.ts`(ensure/create/orphan 创建/probe),`board-ref.ts`;`ensureBoardWorktree` 接入 `prepareRepoRuntimeHome`;让 boardData 根指向 board worktree。
- **P2 迁移** ✅:`migrateDecoupleBoardToBranch`(§7)接入迁移链;代码分支 gitignore 翻转;`rm --cached`。覆盖现有/全新/clone 三态。
- **P3 commit + 同步** ✅:写后 commit(board identity)、去抖 push、启动 fetch+ff、pull 后重载+广播。
- **P4 设置 + UI** ✅:`boardBranch` 设置 + 改名迁移;同步状态广播 + 顶栏徽标 + 手动 push/pull 与暂停开关。
- **P5 收尾** ✅:
  - **9d884 作废确认**:代码中**不存在**"切分支前自动提交 `.kanban`"补丁 —— `runGitCheckoutAction`(`git-sync.ts`)是裸 `git switch`,checkout 路径无 kanban 预提交钩子。方案 C 使代码分支不再跟踪 `.kanban` 数据,切分支天然干净,补丁无需求亦不可重新引入(已在 AGENTS.md 记录)。
  - **文档**:AGENTS.md 新增条目记录二分根(runtimeHome vs boardDataHome)、三条 git 线、`board-ref` 指针机制、9d884 作废。
  - **冲突 surface UI 打磨**:`conflict`/`error` 徽标可点击 → `BoardConflictDialog`(说明 + 「本地数据完好」+ board worktree 路径 + 立即重试 push/pull);`RuntimeBoardSyncStatus` 增 `worktreePath` 供该对话框定位人工解决位置。
  - **端到端复核**:见 §9。

---

## 9. 验证(文档落盘后,无代码改动)
- 本任务交付物 = 设计文档本身;验证 = 文档在 `.plan/docs/board-branch-decoupling.md` 落盘,7 个设计点均有明确决策、模块清单/迁移/分阶段齐备。
- 后续实现阶段各自带验证(P0 现有测试零回归;P2 三态迁移集成测试;P3 多机 push/pull + 冲突 surface 手测;切代码分支不再脏的端到端验证)。
