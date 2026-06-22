# Board Sync 重设计:自动 commit + 显式 push/pull

> 状态:设计文档(design-only)。本文档**不含实现代码**,只给出现状/根因、重设计架构、决策取舍、风险与分阶段实施拆解。
>
> 背景依赖:`.plan/docs/board-branch-decoupling.md`(方案 C / board-branch 解耦,tag `design/board-branch-decoupling`)。本文是其 P3「board-sync 服务」一节的**重做**。

---

## 1. 为什么重做

当前 board-sync(`src/workspace/board-sync.ts` + `src/workspace/board-worktree.ts`,6/18 P3 提交 `25960c6a`)的行为是:**每次看板写盘 → 5s 防抖 → 在 `kanban/board` worktree 里 `git commit` → 自动 `git push`**(push 被拒时还会 `fetch + merge + re-push` 去 reconcile)。两个严重缺陷:

1. **【最严重】把卡片 move 到 done 时,Bun 进程 CPU 100% 长期不降,整个 Kanban 卡死。**
2. **Windows 启动告警 + push 反复失败**:remote 上还没有 `kanban/board` 分支时,启动 reconcile 与自动 push 反复去 fetch 一个不存在的 ref。

修复方向已由用户拍板(见 §3「锁定决策」):**取消"自行同步"——热路径只保留本地自动 commit(无网络);push 与 pull 全部改为用户手动触发的显式动作。**

---

## 2. 现状架构(代码级)

### 2.1 热路径链路

任何 committed-data 写入(看板/vault/files/providers/threads,服务端写入与 CLI `notifyStateUpdated` 同此)都会走:

```
saveState / hook 等
  → broadcastWorkspaceStateAndSyncBoard       (runtime-server.ts:255-259)
      ├─ broadcastRuntimeWorkspaceStateUpdated  (广播给前端)
      └─ boardSyncService.scheduleSync(target)  (调度 board sync)
```

`broadcastWorkspaceStateAndSyncBoard` 作为 `workspaceApi`(`runtime-server.ts:309`)和 `hooksApi`(`:341`)的广播依赖注入,所以**每一次提交数据变更都会 `scheduleSync`**。

```
scheduleSync(target)                            (board-sync.ts:247-269)
  → 5s 防抖(timersByRepo / latestTargetByRepo,timer.unref())
  → enqueue(repo, () => runCommitAndPush(latest))   (:265)

runCommitAndPush(target)                        (board-sync.ts:212-245)
  → runStartupReconcile(target)   首启 fetch + ff(一次性,startupDoneByRepo 守卫)
  → commitBoardWorktree(...)      本地 git add -A + commit(无网络)
  → pushBoardWorktree(...)        ★ 网络 push
  → 若 push.pulledChanges → broadcastWorkspaceState(...)  (:223-225)
  → 按 push.status 记 conflict / error / 清空        (:226-236)

pushBoardWorktree(repoPath, branch)             (board-worktree.ts:195-241)
  → git push remote branch:branch
  → push 成功 → "pushed" / "up-to-date"
  → 被判 non-fast-forward 拒绝(isNonFastForwardRejection,:150-158)
       → fetchBoardBranchIntoTrackingRef(:130-134)  ★ 网络 fetch
       → git merge --no-edit                          冲突则 merge --abort + 返回 "conflict"
       → git push(re-push)                          ★ 再次网络 push
  → 其它失败 → "error"
```

`enqueue`(`board-sync.ts:108-117`)按 repo **串行**所有 git 工作(防抖 sync、启动 reconcile、手动动作、关机 flush 不并发)。

启动时 `runtime-server.ts:595-601` 会 fire-and-forget 调 `boardSyncService.syncOnStartup(...)`,即对当前活动 workspace 做一次 boot `fetch + fast-forward`。

关机 `dispose()`(`board-sync.ts:445-462`)对每个 workspace 再跑一次 `runCommitAndPush`(最终 commit + push)。

### 2.2 状态与 UI(将原样复用)

- 状态契约 `RuntimeBoardSyncStatus`(`src/core/api-contract.ts:618-641`):`state`(11 态:`disabled`/`local-only`/`synced`/`ahead`/`behind`/`diverged`/`syncing`/`conflict`/`error`)、`decoupled`、`branch`、`hasRemote`、`aheadCount`、`behindCount`、`autoSyncPaused`、`lastError`、`worktreePath`。
- tRPC:`getBoardSyncStatus`、`runBoardSyncAction("push"|"pull")`、`setBoardAutoSync`、`updateBoardBranch`(`src/trpc/workspace-api.ts:523-536`)。
- ws 广播:`board_sync_status_updated`(`runtime-state-hub.ts`),前端 `use-board-sync.ts` / `use-runtime-state-stream.ts` 消费,badge 实时更新。
- 组件:`BoardSyncStatusControl`(已含手动 Push/Pull 按钮、ahead/behind 角标、暂停开关、点击进冲突 dialog)、`BoardConflictDialog`(`web-ui/src/components/`)。
- ahead/behind 读取 `getBoardWorktreeAheadBehind`(`board-worktree.ts:292-319`)是 **fetch-free** 的:基于上次已知 remote-tracking ref,从不联网,任何 git 失败降级为 0。

---

## 3. 锁定的设计决策(用户已确认)

- **取消"自行同步"**:去掉每次变更后的自动 push。
- **本地自动 commit 保留**:看板状态变更仍**本地自动提交**到 `kanban/board` 分支(在 board worktree 里),防抖/合并以减少提交数。本地提交便宜、无网络、无远端交互 → 不会有 push 失败 / 重试 / 自反馈这些卡死来源。
- **push 完全手动**(用户 2026-06-22 选择「纯手动,无任何自动 push」):**不做退出兜底 push,不做空闲兜底 push**。唯一的 push 入口是用户点 "Push"。本地 commit 始终累积,push 时整体带走。
- **pull 完全手动**(用户 2026-06-22 选择「改为完全手动 pull」):**移除启动时的 boot fetch + fast-forward(`syncOnStartup`)**。开机只显示上次已知的 ahead/behind(fetch-free 读),用户点 "Pull" 才联网拉取。
- **硬约束(不变)**:看板完整状态(column/rank/依赖/spec)仍随仓库走、clone-即用(见 `.plan/docs/board-branch-decoupling.md` 与记忆 `board-state-must-travel-with-repo`)。改成显式后,跨机器接续需用户先 push 过——用户已接受此取舍。
- **解耦机制保留**:`board-ref` 指针、`kanban/board` 分支、board worktree 全部保留不动。

---

## 4. 根因定位(确切机制)

> 已逐行读过 `board-sync.ts`(全)、`board-worktree.ts`(全)、`runtime-server.ts:200-360 / 588-617`、`board-ref.ts`(全)。

**结构性根因:热路径上挂了无界、易失败、可重试的网络 git I/O,且全程没有任何退避 / 熔断。** move-to-done 把这一缺陷放大成"100% CPU 长期不降":

**放大器 1 — move-to-done 是一次写入风暴。** 移动到 done 不是单次写盘:列变更 + rank 重排 + 依赖更新,叠加 done 时 Kanban-owned 的 merge-into-baseRef、auto-review 状态翻转(见记忆 `git-contract-terminal-agents-implemented`),会接连触发多次 `broadcastWorkspaceStateAndSyncBoard` → 反复重置 5s 防抖,最终 settle 后跑一次 `runCommitAndPush`(含网络 push)。

**放大器 2 — 无退避 / 无熔断。** 一次 push 失败只 `recordResult(error)`(`board-sync.ts:232-236`)就返回,**下一次任意看板写入会重跑整套 push + reconcile**。没有 backoff、没有"失败 N 次后停机"、没有"远端不可达就静默一段时间"。

**放大器 3 — `remote has no board branch` 持续失败。** remote 上没有 `kanban/board` 分支时(`board-worktree.ts:542` 的告警来源):push 一旦被远端以 `[rejected]` / `updates were rejected` 等措辞拒绝,`isNonFastForwardRejection`(`:150-158`)命中 → 进入 reconcile 分支 → `fetchBoardBranchIntoTrackingRef`(`:130-134`)去 fetch 一个**不存在的远端分支** → 失败 → 返回 `"error"`。每个周期重演。`syncOnStartup` 的 boot fetch 同理,每次开机都对不存在的 ref fetch 失败(Windows 启动告警的直接来源)。

**放大器 4 — 串行队列被网络操作堵死。** `enqueue`(`:108-117`)把同一 repo 的所有 git 工作串行化。一旦 `git push` / `git fetch` 卡在网络超时或凭据交互循环,整条队列被这一个挂起操作堵死;后续 sync 全部排队等待。叠加持续被重置的防抖、不断重启的 git 子进程 spawn/teardown,表现为"CPU 100% 长期不降 + UI 卡死"。

**放大器 5 — 可能的反馈回环(整合分支)。** `runCommitAndPush` 在 `push.pulledChanges` 为真时调 `broadcastWorkspaceState`(`:223-225`)→ 重读 board 并广播 → 前端 board 列 ↔ doc `frontmatter.status` 的 reconciliation(见记忆 `vault-frontend-implemented`:拖卡会把 `frontmatter.status` 写盘)可能再次写回 → `saveState` → `broadcastWorkspaceStateAndSyncBoard` → 再次 `scheduleSync`,把整个周期重新拉满。该分支仅在 push 走 reconcile/整合时出现。

### 4.1 回答两个关键问题

**Q1:去掉自动 push,是否就消除卡死?——是,完全消除。**
重设计后热路径只剩本地 commit。这意味着:无网络、无 push 失败面、无"fetch 不存在的 ref"、无 reconcile、无可被堵死的网络队列、无 `pulledChanges → 广播` 的整合反馈分支(该分支只在 push 整合时产生)。**放大器 1–5 全部消失**——放大器 1 仍会产生多次 commit 调度,但 commit 是有界纯本地操作,防抖把它们合并成最多每 5s 一次,不再有任何可重试/可堵塞的网络成本。

**Q2:commit 本身是否参与回环?——否,可放心保留在热路径。**
`commitBoardWorktree`(`board-worktree.ts:627-638`)只做 `git add -A` + 本地 `git commit`,**从不**调用 `broadcastWorkspaceState` 或 `scheduleSync`。整条 sync 链里唯一的"再入广播"是 push 的 `pulledChanges → broadcastWorkspaceState`(`board-sync.ts:223-225`);push 移出热路径后,该再入自然消失。因此**本地自动 commit 在结构上可证明无回环**——这正是用户"commit 若也参与循环也要断掉"所要的确认结论:它没有参与,无需额外断环措施,只需确保 commit-only 路径里不引入任何广播/调度。

---

## 5. 重设计架构:自动 commit + 显式 push/pull

**核心原则:任何自动 / 防抖 / 关机路径只做本地 commit;所有网络 git I/O(push、fetch、merge、reconcile)只发生在用户显式点击的 `pushNow` / `pullNow` 里。**

```
┌─ 热路径(自动,无网络) ───────────────────────────────┐
│ 数据变更 → scheduleSync → 5s 防抖 → enqueue(runCommitOnly)│
│              runCommitOnly = 守卫 + commitBoardWorktree + emitStatus │
│ 关机 dispose() → enqueue(runCommitOnly)(最终本地提交)    │
└───────────────────────────────────────────────────────┘
┌─ 显式路径(手动,唯一联网处) ──────────────────────────┐
│ 用户点 Push → pushNow → commit + pushBoardWorktree(含 reconcile)│
│ 用户点 Pull → pullNow → commit + pullBoardWorktree(fetch+merge) │
└───────────────────────────────────────────────────────┘
启动:不再 syncOnStartup;badge 用 fetch-free 的 ahead/behind 显示上次已知值。
```

### 5.1 自动 commit 引擎(`board-sync.ts`)

- **新增内部 `runCommitOnly(target)`**:`isBoardDecouplingActive` 守卫 → `commitBoardWorktree` → `emitStatus`。**不调用** `runStartupReconcile`、`pushBoardWorktree`、`broadcastWorkspaceState`。
- `scheduleSync` 的防抖回调从 `enqueue(runCommitAndPush)` 改为 `enqueue(runCommitOnly)`(现 `:265`)。防抖 / 合并策略保留不变(5s 窗口、`latestTargetByRepo`、`timersByRepo`、`timer.unref()`、按 repo 串行 `enqueue`)。
- **断环保证(代码级不变量)**:`runCommitOnly` 全程不得出现任何 `scheduleSync` / `broadcastWorkspaceState` 调用 → commit 不可能再触发一轮 sync。建议在该函数加注释钉死这一不变量。
- **离线 / 无 remote 完全不受影响**:commit 是纯本地操作,`getDefaultRemote` 都不会被触及;有网 / 无网行为完全一致。
- **`dispose()`** 改为最终一次**本地 commit**(去掉 push),保证关机前最后的 interrupted-session save 落入 commit;无任何网络交互。
- **暂停语义**(`autoSyncPausedByRepo`)保留并收窄:暂停 = 连本地 commit 也跳过,只刷新 badge(现 `:259-264` 的"刷新 badge 不提交"逻辑可直接复用,只是语义从"暂停 push"变为"暂停 commit")。
- **删除**:`runCommitAndPush`、`syncOnStartup`、`runStartupReconcile`、`startupDoneByRepo`(连同 `fetchAndFastForwardBoardWorktree` 的唯一调用点)。`fetchAndFastForwardBoardWorktree` 本身可保留(未来若加回 boot reconcile 复用)或一并清理——倾向保留以备后用,标注 currently unused。

### 5.2 显式 push(`pushNow` / `runManualPush`,基本沿用现 `board-sync.ts:281-318`)

- 唯一 push 入口。流程不变:`commitBoardWorktree`(先把待提交写入 commit)→ `pushBoardWorktree`(含 non-ff → fetch + merge + re-push reconcile)→ 冲突 / 错误经 `recordResult` surface 到 status。
- **上限 + 无重试 + 不自旋**:push 仅由用户手动触发,本就不会自旋;仍要保证(a)单次 push 内的 git 子调用有超时(在 `runGit` 层或本调用点设置,避免无限期挂起堵队列);(b)失败只 `recordResult(error)` 返回,**绝不自动重试**;(c)`inFlightByRepo` 防并发重入,前端在 `runningAction` 期间禁用按钮(已有)。

### 5.3 显式 pull(`pullNow` / `runManualPull`,沿用现 `board-sync.ts:320-358`)

- 唯一 fetch 入口。流程不变:commit 本地待提交 → `pullBoardWorktree`(fetch + merge;真冲突 `merge --abort` + surface,本地数据完好)。同样需单次超时、无自动重试。

### 5.4 移除启动自动 reconcile

- `runtime-server.ts:595-601` 删除 `void boardSyncService.syncOnStartup(...)`。
- 效果:**消除 Windows 启动告警**(不再 boot fetch 一个不存在的远端 board 分支)。
- 开机 badge 用 fetch-free 的 `getBoardWorktreeAheadBehind` 显示**上次已知** ahead/behind;`behindCount` 仅在用户点 Pull 后刷新。

### 5.5 UI / 交互(复用现有,接近零改)

新模型无需任何新 wire 契约——§2.2 的状态 / tRPC / 广播 / 组件全部够用:

- `BoardSyncStatusControl` 的 Push/Pull 按钮、ahead/behind 角标、暂停开关、冲突 dialog 全部保留。
- **文案 / 语义微调**:
  - badge / tooltip 文案从"自动同步中"改为反映"本地已提交 N 个,待 Push"(`aheadCount` 角标即提醒)。
  - 暂停开关文案收窄为"暂停自动提交"。
  - tooltip 注明"behind 数需点 Pull 刷新"。
- **可选增强**:在 `RuntimeBoardSyncStatus` 加可选 `lastPushedAt`,tooltip 展示"上次 Push 时间"。非本期必需,作为后续可选项。

---

## 6. 迁移(平滑替换现自动-push board-sync)

**无数据迁移、无 wire 契约变更、无 `board-ref` / 分支 / worktree 变更**——纯行为收窄。改动集中在两个文件:

1. **`src/workspace/board-sync.ts`**:`runCommitAndPush` → 拆出 `runCommitOnly`(防抖与 dispose 用);保留 `runManualPush` / `runManualPull` 的手动路径;删 `syncOnStartup` / `runStartupReconcile` / `startupDoneByRepo`。
2. **`src/server/runtime-server.ts`**:删 boot `syncOnStartup` 调用(`:595-601`)。`broadcastWorkspaceStateAndSyncBoard`(`:255-259`)**语义不变**——仍 `scheduleSync`,只是 `scheduleSync` 现在只 commit。
3. **前端**:文案 / badge 语义微调 +(可选)`lastPushedAt`。
4. **单测**:更新 `test/.../board-sync` 断言——防抖路径不再产生任何 push / 网络调用;`pushNow` / `pullNow` 手动路径测试基本不变。

向后兼容:已激活解耦的仓库无需任何迁移;`board-ref` 缺失的仓库 `isBoardDecouplingActive` 仍返回 false,全程 no-op,行为与现在一致。

---

## 7. 风险与取舍

| 风险 | 评估 / 缓解 |
| --- | --- |
| 跨机器接续依赖用户记得 Push | 用户已接受。badge 的 ahead 角标作为"N 个本地提交未推送"提醒。 |
| 本地提交无限累积 | 多而无害(sharding 让历史干净)。未来可加"自上次 Push 已 N 提交"的更醒目提示。 |
| `git add -A` 在超大 worktree 上的 CPU | 每个防抖窗口仅一次,有界,远低于原网络重试成本。file library 很大时可后续用 pathspec 优化,非本期阻塞。 |
| 关机不再 push | 崩溃 / 断电时未推送的本地提交留在本地,下次开机仍在 `kanban/board` 分支、可手动 Push,**数据不丢**。 |
| behind 数滞后(开机不 fetch) | 设计接受。文案明确"需 Pull 刷新";用户对远端动向的获取改为显式。 |

---

## 8. 分阶段实施拆解(供后续实现任务,本期不写码)

- **S1 — 自动 commit 引擎**:`board-sync.ts` 拆出 `runCommitOnly`;防抖回调与 `dispose` 改走 commit-only;删 `syncOnStartup` / `runStartupReconcile` / 网络 reconcile 路径。钉死"commit-only 路径无广播 / 无调度"不变量。
- **S2 — 去掉启动联网**:`runtime-server.ts` 删 boot `syncOnStartup` 调用。
- **S3 — 手动路径加固**:`pushNow` / `pullNow` 内 git 子调用加单次超时 + "绝不自动重试"注释;确认 `inFlightByRepo` 并发守卫。
- **S4 — 前端文案**:badge / tooltip / 暂停开关语义微调;(可选)`lastPushedAt`。
- **S5 — 测试与验证**:更新 board-sync 单测(防抖 = 无网络;手动 = 网络);端到端验证 move-to-done **不再触发任何 push、CPU 不再飙升**;验证无 remote / 无 board 分支 / 断网下自动 commit 正常、无启动告警。

---

## 9. 验证(本设计落地后如何核对)

- move-to-done 在以下场景均不触发任何 `git push` / `git fetch`,CPU 不飙升:有 remote、无 remote、remote 无 `kanban/board` 分支、断网。
- 启动不再出现 "remote has no board branch" 告警(不再 boot fetch)。
- 自动 commit 在离线 / 无 remote 下与有网行为完全一致(纯本地)。
- 仅用户点 Push/Pull 时才联网;失败 surface 到 badge / 冲突 dialog,无自动重试、无自旋。
- 解耦未激活的仓库行为不变(全程 no-op)。
