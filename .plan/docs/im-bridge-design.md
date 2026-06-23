# 设计文档:IM 桥接(飞书 / 钉钉 / 企业微信 ↔ Kanban 调度秘书)

> 状态:设计 / 调研稿(不含实现代码,不提交)。日期 2026-06-23。
> 范围:确定架构、绑定模型、会话生命周期、平台能力边界与凭证管理,补齐技术细节与开放问题,给出分阶段拆分。供后续拆成多个实现任务。
> 关联记忆:[[feishu-bridge-roadmap]](goal=从飞书和 Kanban agent 对话管理看板;第一步会话持久化/resume 已完成 bc4da)、[[no-cross-agent-session-sharing]]、[[per-agent-provider-cc-switch]]、[[home-multithread-ui-implemented]]。

---

## 1. Context —— 为什么做这件事

让用户能从**飞书 / 钉钉 / 企业微信**里直接和 Kanban 的 agent 对话来管理看板。

**定位不是"远程命令终端",而是"会主动找你、能一键操作的项目搭档":** 看板把"该用户拍板的事"(待审 / 冲突 / 失败 / 链路卡住)**主动推到 IM**,用户在 IM 里点卡片按钮就能闭环(看 diff / 开 PR / 合并并启动下一个 / 打回 / 查看冲突)。同时用户也能用自然语言和绑定的 agent 对话,让它调看板操作(建任务、链任务、启动任务、报进度)。

**两类信息流的本质差异(贯穿全文的设计原则):**

- **状态通知用模板互动卡片** —— 确定性、即时、零 token、不依赖 agent 在跑。由网关订阅 runtime 事件直接组装卡片推送。
- **对话回复才用 agent 文本** —— 自然语言来回时才拉起 / 喂入 agent 会话。

混淆这两者(例如"每次状态变化都让 agent 写一段话")会带来不必要的 token 成本、延迟和不确定性,是明确要避免的反模式。

---

## 2. 角色模型

### 2.1 两层 agent,职责不混

| | **IM 绑定的 agent(调度秘书)** | **任务 worktree 里的任务 agent** |
|---|---|---|
| 在哪 | 一条 home thread 会话(sidebar 同款) | `<repo>/.kanban/worktrees/<taskId>/<label>` |
| 干什么 | 听懂自然语言 → 调看板操作(建 / 链 / 启动任务、报进度) | 真正写代码、跑测试、提交 |
| 不干什么 | **不写代码** | 不管 IM,不管别的任务 |
| 怎么调看板 | 通过看板的工具面(CLI / MCP / tool-calls)读写 board、requirement、启动任务会话 | —— |

调度秘书是"听懂话 → 转成看板动作"的翻译层 + 编排层;它启动的任务才是干活的。这与现有 home-chat agent 的定位一致(见 [[home-agent-task-default-implemented]]:home-chat agent 创建的任务默认就用该 agent)。

### 2.2 看板是耐久真相源

调度秘书的对话记忆会随空闲淡出 / 压缩(见 §6),但**任务真相**(列、rank、依赖、spec、会话状态)持久化在看板里。记忆淡了不要紧 —— agent 下次被唤醒时现读看板照样接着干。**丢的只是闲聊记忆,不是任务真相。**

---

## 3. 总体架构

### 3.1 三条腿 + 闭环

```
                         ┌──────────────────────────────────────────────┐
                         │            Kanban Runtime (in-process)          │
                         │                                                │
  IM 平台                │   ┌────────────────┐   ┌───────────────────┐   │
 (飞书/钉钉/企微)         │   │  IM Gateway     │   │ Session Managers   │   │
                         │   │  (绑定路由 +     │   │ pi / terminal      │   │
   ① 入站消息  ───────────┼──▶│   生命周期编排) │──▶│ startTaskSession   │   │
   (用户在 IM 说话)        │   │                 │   │ sendInput(writeIn) │   │
                         │   │                 │◀──│ onMessage()        │   │
   ② 出站回复  ◀──────────┼───│  (订阅          │   └───────────────────┘   │
   (agent 文本回到渠道)    │   │   task_chat_…) │                            │
                         │   │                 │   ┌───────────────────┐   │
   ③ 主动推送  ◀──────────┼───│  (订阅 runtime  │◀──│ runtime-state-hub  │   │
   (待审/冲突/失败/链路)   │   │   事件 → 卡片)  │   │ onSummary()        │   │
                         │   │                 │   │ board-sync onStatus│   │
   ④ 闭环回调  ───────────┼──▶│  (卡片按钮 →     │   └───────────────────┘   │
   (点卡片按钮)           │   │   看板动作)     │                            │
                         │   └────────────────┘                            │
                         └──────────────────────────────────────────────┘
```

- **① 入站:** IM 消息 → 按 `channelKey ↔ binding` 映射 → 喂进对应 session(首条 = kickoff prompt,后续 = `writeInput` / `sendInput`)。
- **② 出站回复:** 网关订阅 `task_chat_message`(经 `SessionMessageSource.onMessage()`,**不需要走 websocket 客户端**)→ 把 assistant 文本发回该渠道。
- **③ 主动推送:** 网关订阅看板 runtime 事件(`task_sessions_updated` 待审 / 链式启动 / 失败、`board_sync_status_updated` 冲突)→ 组装模板互动卡片 → 调平台 send API 推送。**不依赖 agent 在跑。**
- **④ 闭环:** 卡片按钮回调走入站通道 → 驱动看板动作(看 diff / 开 PR / 合并并启动下一个 / 打回 / 查看冲突),结合现有 auto-review(commit/pr)+ 任务链 + IM 审批,做"人在环但只需点一下"的自动流水线。

### 3.2 桥接站在 agent 无关层(硬约束)

桥接**复用**:home thread + 统一广播 `task_chat_message` + 会话持久化 / resume + agent-start 限流。**不为某个 agent 写死,尤其不做成 pi 专用。** 任意 agent(pi / claude / codex / droid / gemini / opencode)都能背一条绑定。

之所以能做到 agent 无关,是因为 Kanban 已经把会话模型抽到了 agent 无关的接口上:

- `SessionMessageSource`(`src/session/session-message-source.ts`):`onMessage(listener) / listMessages(taskId) / loadTaskSessionMessages(taskId)`。`TerminalSessionManager`(CLI agents)和 `PiTaskSessionService`(pi)都实现它。
- 统一 wire 契约 `RuntimeTaskChatMessage`(`runtimeTaskChatMessageSchema`,`src/core/api-contract.ts`)—— pi 和 CLI 走同一条 `task_chat_message` 广播。
- home session id(`src/core/home-agent-session.ts`):`__home_agent__:<workspaceId>:<agentId>[:<threadId>]`,agentId 编码在 id 里,与具体 agent 解耦。

IM 网关只说"通用 tRPC + session-id + SessionMessage"这套语言,平台差异全部关在 `InboundChatAdapter` 内部(见 §5)。

### 3.3 进程内事件总线,不绕 websocket

关键发现:`runtime-state-hub.ts` 的事件源是 session managers 和 board-sync service 上的**进程内 listener**(`onMessage` / `onSummary` / `onStatusChanged`),websocket 只是其中一个消费者。**IM 网关作为同进程组件,直接订阅这些 listener 即可,无需起 websocket 客户端回连自己。**

| 事件 | 进程内订阅入口 | wire 类型(参考) |
|---|---|---|
| 聊天消息 | `manager.onMessage((taskId, msg) => …)` | `task_chat_message` / `RuntimeStateStreamTaskChatMessage` |
| 会话状态变化 | `manager.onSummary((summary) => …)` | `task_sessions_updated` / `RuntimeTaskSessionSummary[]` |
| 看板同步状态 | board-sync `onStatusChanged` 回调(`CreateBoardSyncServiceDependencies`) | `board_sync_status_updated` / `RuntimeBoardSyncStatus` |

现有 hub 接线参考:`src/server/runtime-state-hub.ts`(terminal `onMessage`/`onSummary` 约 534/528 行;pi 约 571/549 行;board-sync 约 217 行)。IM 网关复用同样的接线,与 hub 平行挂在 `runtime-server.ts`。

---

## 4. 绑定模型

### 4.1 统一模型

一条 IM 绑定 = 五元组:

```ts
interface RuntimeImBinding {
  bindingId: string;            // 稳定唯一 id(workspace 内)
  platform: "feishu" | "dingtalk" | "wecom";
  channelKey: string;           // 外部会话标识(见 §4.3)
  agentId: RuntimeAgentId;      // 固定 agent,不随消息变(见 §6)
  threadId: string;             // 对应一条 home thread(沿用 home-thread 注册表)
  // 凭证 *不* 进绑定记录(见 §9):此处只放凭证引用/账号标识
  credentialRef: string;        // 指向机器密钥库中的一条 app 凭证(如 appId/corpId)
  createdAt: number;
  updatedAt: number;
}
```

> **凭证不入库:** 绑定记录是**提交进仓库的看板数据**(见 §4.2),所以**绝不**放 token / secret。绑定只持有一个 `credentialRef`(指向机器本地密钥库里的某条 app 凭证)。这与 [[claude-provider-env-injection-implemented]] / committed-provider 的"配置入库、密钥留机器本地"边界一致。

### 4.2 存储:per-workspace 注册表,放 threads.json 旁

完全照搬 home-thread 注册表的成熟模式(见 [[home-multithread-ui-implemented]]):

- **纯函数层** `src/session/im-binding-registry.ts`:`listImBindings / createImBinding / removeImBinding / updateImBinding`,I/O-free、可单测(对照 `home-thread-registry.ts`)。
- **store 编排层** `src/session/im-binding-store.ts`:`ImBindingStore`,注入 `ImBindingPersistence`(`load()` / `mutate(fn)`)+ `onUnbind` 回调(对照 `HomeThreadStore` 的注入式持久化 + `onCloseSession`)。
- **持久化** 在 `src/state/workspace-state.ts`:`loadWorkspaceImBindings` / `mutateWorkspaceImBindings`,锁定 read→mutate→atomic-write,文件落在
  `<boardDataHome>/workspaces/<id>/im-bindings.json`(与 `threads.json` 同目录,走 committed 的 `boardDataHome` 根,复用同一把 workspace-dir 锁)。
- **接线** 在 `src/server/runtime-server.ts`:`getScopedImBindingStore(scope)`,one store per workspace,`onUnbind` 路由清理(对照 `getScopedHomeThreadStore`)。
- **tRPC** 在 `src/trpc/runtime-api.ts`:`listImBindings / bindImChannel / updateImBinding / unbindImChannel`(workspaceScope)。

> 注意 board-branch 解耦(见 [[board-state-must-travel-with-repo]] / `board-branch-decoupling.md`):`im-bindings.json` 是 committed 看板数据,放 `boardDataHome`(解耦激活后 = 板分支 worktree 的 `.kanban`)。**它不含密钥**,所以入库安全,且能随 clone 走(clone + 凭证 = 即用)。

### 4.3 channelKey 的精确定义

`channelKey` 是"这条外部会话是谁"的稳定标识,网关用它把入站事件 / 卡片回调反查到 `binding`。各平台取值:

| 平台 | channelKey 取值 | 来源 |
|---|---|---|
| 飞书 | `chat_id`(单聊 `p2p` 或群 `group` 都是 chat_id) | 入站事件 `event.message.chat_id` |
| 钉钉 | `conversationId`(`openConversationId`,单聊/群一致) | Stream 推送的会话 id |
| 企业微信 | `${external}:${userId}`(自建应用按"应用 + 成员"维度) | 接收消息 XML 的 `FromUserName`(+ AgentId) |

**映射方向有两条,都要存:**

1. `channelKey → bindingId`(入站路由,主键查询):注册表本身按 bindingId 存,网关启动时在内存里建 `Map<platform+channelKey, binding>` 反向索引,绑定增删时维护。
2. `bindingId → { threadId, homeSessionId }`(决定喂哪条会话):`homeSessionId = createHomeAgentSessionId(workspaceId, agentId, threadId)`(`src/core/home-agent-session.ts`)。

### 4.4 平台基数策略 + 重绑语义

统一模型,平台只差一条 `maxBindings` + 重绑语义:

| | **飞书 / 钉钉(Feishu-class,满血)** | **企业微信(受限-class)** |
|---|---|---|
| 能力 | 入站长连接、出站 send API、互动卡片、OA/审批 | 自建应用:出站 send + 模板卡片 + 回调 URL;**无个人微信合规机器人/主动推送** |
| `maxBindings` | ∞ | 1(单槽位) |
| keyed by | `chat_id` / `conversationId`,多条并存 | 单槽位 |
| 加同 key | **更新**已有绑定(改 agent / thread) | —— |
| 加新 key | **新增**一条绑定 | —— |
| "重新绑定" | 不存在冲突(直接新增) | **原子替换占用者**:硬关旧 session(`closeTaskSession` 停进程 / 丢内存 / 清转录)+ 新绑定**全新起一段对话**。**绝不跨 workspace / agent 迁移上下文。** |

企业微信的"原子替换"复用现有 hard-close(§6.4),与 home thread 关闭走同一条清理路径。

---

## 5. InboundChatAdapter 抽象

每平台一个适配器,只暴露收 / 发两个方法;会话 / 线程 / 看板逻辑**零改动**,平台差异全关在适配器内:

```ts
interface InboundChatAdapter {
  readonly platform: "feishu" | "dingtalk" | "wecom";

  /** 启动入站通道:长连接订阅 或 注册 webhook handler。
   *  把规范化后的入站事件交给网关回调。返回 dispose。 */
  startInbound(onEvent: (e: NormalizedInboundEvent) => Promise<void>): Promise<() => void>;

  /** 出站:发文本/卡片到指定渠道。 */
  sendText(channelKey: string, text: string): Promise<void>;
  sendCard(channelKey: string, card: NormalizedCard): Promise<void>;
  updateCard?(cardRef: CardRef, card: NormalizedCard): Promise<void>; // 卡片原地更新(可选)
}

type NormalizedInboundEvent =
  | { kind: "message"; channelKey: string; text: string; images?: ImageRef[]; senderId: string }
  | { kind: "card_action"; channelKey: string; action: CardAction; cardRef: CardRef; senderId: string }
  | { kind: "approval"; channelKey: string; approvalEvent: ApprovalEvent };
```

**适配器内部各自消化的差异:**

- **入站传输:** 飞书 = 长连接(官方 SDK)或 webhook;钉钉 = Stream 长连接(推荐,零公网 IP)或 webhook;企业微信 = **仅 webhook**(接收消息服务器 URL + 加解密签名)。
- **出站鉴权:** 三家都用 server 端 app token(飞书 `tenant_access_token`、钉钉 app access_token、企微 `access_token = f(corpid, secret)`),适配器负责取 token + 缓存 + 刷新。
- **卡片 / 审批字段格式:** 飞书 interactive card JSON、钉钉互动卡片/AI 卡片、企微模板卡片(按钮交互型)结构各异,在适配器内从 `NormalizedCard` 渲染。

网关只对 `NormalizedInboundEvent` / `NormalizedCard` 编程,完全不知道平台细节。

---

## 6. 会话 / agent 生命周期(关键)

### 6.1 三档对比 —— 选"一段对话"档

| 档位 | 行为 | 问题 |
|---|---|---|
| 每条消息新建 session/agent | 每条都冷启动 | 丢多轮指代 + 每条冷启动,体感最差 ❌ |
| 一条永生 session | 永不回收 | 转录无限膨胀 ❌ |
| **"一段对话"档(选定)** | 连续聊 = 同一条 session(指代接得上);空闲淡出 / 压缩;下次消息 resume 回同一条 | 体感连续 ✅ |

### 6.2 agent 按绑定固定

agent 由 `binding.agentId` 决定,**不随消息变**。换 agent 无收益且破坏连贯。(注:这与 [[agent-switch-must-take-effect]] 不矛盾 —— 那是"用户显式改 task.agentId 时要生效";IM 绑定的 agent 是绑定级配置,改它走 `updateImBinding` + 硬关旧 session。)

### 6.3 消息驱动的状态机

```
   (无 session)
       │  首条消息
       ▼
  ┌─────────┐   后续消息(writeInput/sendInput)   ┌─────────┐
  │ 懒启动   │ ────────────────────────────────▶ │ 运行中   │
  │ start    │                                    │ running  │
  │ TaskSess │ ◀──── resume(重启/断线后首条) ─── │          │
  └─────────┘                                    └────┬────┘
       ▲                                              │ 空闲超过阈值
       │       下次消息 resume 回同一条                │
       └──────────────── (idle) ◀─────────────────────┘
                          空闲回收(可选硬关,见 §6.5)
```

具体复用的入口(全部已存在):

- **懒启动(首条消息才拉起 agent):** `startTaskSession`(`src/trpc/runtime-api.ts`)。传 home session id → 它用 `resolveHomeAgentId(taskId)` 解析 agent(home 路径下 card agentId 不参与),首条 `body.prompt` 作 kickoff。**包在 `limitAgentStart()` 里**(见 §6.6)。
- **喂入运行中 session:** CLI 走 `TerminalSessionManager.writeInput(taskId, Buffer)`(`src/terminal/session-manager.ts`);pi 走 `PiTaskSessionService.sendTaskSessionInput(taskId, text, mode?, images?)`。统一封装是 `runtime-api.ts` 的 `sendTaskSessionInput`(先试 pi 再退 terminal)。
- **重启 / 断线 resume:** 复用 agent session resume(见 [[claude-session-resume-implemented]] / [[codex-session-resume-implemented]])。`agentSessionId` 存在 `RuntimeTaskSessionSummary` 上,持久化进 `sessions.json`;转录持久化进 `~/.kanban/workspaces/<id>/sessions/<taskId>/messages.jsonl`(`FileSessionMessageJournal`)。下次消息到达时,网关对同一 home session id 再调 `startTaskSession` 即触发 resume。
- **空闲回收:** 见 §6.5(**当前不存在,需新建**)。

### 6.4 硬关(hard close)语义

`closeTaskSession`(两个 manager 都有):停进程 + 丢内存 entry + 删转录(`messageJournal.clear(taskId)`)。**不可 resume。** 用于:home thread 显式关闭、企业微信重绑替换、(可选)空闲回收的彻底清理档。

### 6.5 空闲回收(需新建,当前无)

**调研结论:Kanban 目前没有任何 idle-timeout / session-reaper。** 会话只有三态:active(在内存、监听输入)、idle(在内存、无活进程,可被 `startTaskSession` 唤醒)、closed(硬关、永久删除)。没有自动回收。

IM 桥接需新增一个**每-workspace 的后台空闲回收器**:

- 周期扫描各 session 的 `summary.lastOutputAt` / `updatedAt`。
- 超过阈值的会话:
  - **软档(默认推荐):** 停进程但**保留** `agentSessionId` + 转录 → 下次消息 resume 回同一条(指代仍在)。这要求 stop 而非 close。
  - **硬档:** 超过更长阈值后 `closeTaskSession` 彻底清理(转录已持久化,任务真相在看板,丢的只是闲聊记忆)。
- 阈值**可配置**(env / workspace 设置),给默认值(开放问题 §11)。

> 实现提示:软停 vs 硬关的区分点 —— `stopTaskSession`(保留 entry + 转录,可 resume)对 `closeTaskSession`(删 entry + 转录,不可 resume)。回收器优先软停。

### 6.6 批量唤醒用现有限流兜底

多条绑定 / 多用户同时来消息 → 批量拉起 agent。复用 `limitAgentStart()`(`src/server/agent-start-limiter.ts`,host-wide p-limit,默认 = CPU 数,env `KANBAN_MAX_CONCURRENT_AGENT_STARTS`,见 [[perf8-agent-start-limiter-implemented]])。网关的懒启动路径**必须**经过它,避免大量 agent 同时冷启动把 runtime 打满(见 [[bun-event-loop-busywait-freeze]] 的教训:大量并发启动会冻 runtime)。

---

## 7. 三条腿详解

### 7.1 ① 入站

1. 适配器 `startInbound` 收到平台事件 → 规范化为 `NormalizedInboundEvent`。
2. 网关用 `platform + channelKey` 反查 `binding`(§4.3 内存索引)。查不到 → 走"未绑定"分支(可选:回提示让用户在 Settings 绑定,或静默丢弃)。
3. 解析 `homeSessionId = createHomeAgentSessionId(workspaceId, binding.agentId, binding.threadId)`。
4. 该 session 无活进程 → `startTaskSession`(首条 = kickoff,经 `limitAgentStart`);已运行 → `sendTaskSessionInput` / `writeInput`。
5. 图片:`SessionMessage` / `RuntimeTaskChatMessage` 已支持 `images`,适配器把 IM 图片下载为 `RuntimeTaskImage` 传入(对照 pi vision 路径)。

### 7.2 ② 出站回复

1. 网关订阅 `manager.onMessage((taskId, msg) => …)`(pi + terminal 都订)。
2. 过滤:`taskId` 是 home session id 且属于某条 binding;`msg.role === "assistant"`(可选含 `status`/`reasoning` 视产品取舍)。
3. 把 assistant 文本 `adapter.sendText(binding.channelKey, msg.content)` 发回。
4. **流式取舍(开放问题 §11):** pi 对同一 assistant id 多次 `message_update`(见 journal 的 coalesce 行为)。IM 出站应**按 turn 边界发整段**(turn 进入 `awaiting_review`),而非每 token 发 —— 否则 IM 会被刷屏。可借 `onSummary` 的状态转换做 turn 边界判定,或在网关侧 debounce 同 id 文本。

### 7.3 ③ 主动推送(降噪是核心)

网关订阅 runtime 事件,**只在需介入时推**:

| 触发 | 事件 / 字段 | 卡片 |
|---|---|---|
| 待审 | `onSummary` → `state` 转入 `awaiting_review` 且 `reviewReason ∈ {hook, attention, error}`(对照 hub 的 `task_ready_for_review` 判定) | "任务 X 待你审" + [看 diff][开 PR][合并并启动下一个][打回] |
| 失败 | `state === "failed"` / `reviewReason === "error"` / `exitCode ≠ 0` | "任务 X 失败" + [看日志][重试][打回] |
| 链路卡住 | 依赖 `RuntimeBoardDependency`(`fromTaskId→toTaskId`)前置完成但后继未起 | "可以启动下一个 Y" + [启动 Y] |
| 看板冲突 | board-sync `onStatusChanged` → `state === "conflict"`,带 `lastError` + `worktreePath` | "看板同步冲突" + [查看冲突][重试拉取] |

**降噪策略:**

- 只推上述需拍板的事件,**不推**常规进度 / 中间态。
- **批量:** 短时间窗内同类事件合并成一张卡(或一张含列表的卡)。
- **静默时段:** 尊重用户配置的勿扰时段(开放问题 §11),静默期内缓存非紧急通知,期满补发或丢弃。

### 7.4 ④ 闭环卡片动作

1. 用户点卡片按钮 → 平台回调 → 适配器规范化为 `{ kind: "card_action", action, cardRef, … }`。
2. 网关把 `action` 映射到看板动作(纯函数 `resolveCardAction(action) → KanbanCommand`):
   - **看 diff** → 返回 diff 摘要卡片(读 turn checkpoint / git)。
   - **开 PR / 合并并启动下一个** → 复用 auto-review(`autoReviewMode: "commit" | "pr"`,task spec)+ 任务链(`dependsOn`)路径。
   - **打回** → 把卡片移回 in_progress / backlog,可选携带打回理由喂回任务 agent。
   - **查看冲突** → 回 `worktreePath` + 冲突说明,或触发 board-sync 重试拉取。
3. 动作完成 → `adapter.updateCard`(若平台支持原地更新)反馈结果,形成闭环。

> **状态通知用模板卡片(确定性、零 token);对话回复才用 agent 文本。** 闭环动作本身是确定性看板命令,不经 agent。

### 7.5 与审批结合

飞书 / 钉钉的 OA 审批可作为"北极星动作"的人在环关卡:例如"合并并启动下一个"先发起一条审批,审批通过事件(飞书 approval-v4 task event / 钉钉 OA 审批回调)再触发实际合并。企业微信亦有审批 API 但与自建应用消息体系分离,能力降级(§8)。审批事件经适配器规范化为 `{ kind: "approval", … }` 入站。

---

## 8. 平台能力边界对照

| 能力 | 飞书(Feishu) | 钉钉(DingTalk) | 企业微信(WeCom 自建) |
|---|---|---|---|
| **入站接入** | 长连接(官方 SDK)/ webhook 二选一 | **Stream 长连接**(推荐,零公网 IP / 零证书)/ webhook | **仅 webhook**(接收消息服务器 URL) |
| **入站鉴权 / 校验** | 事件订阅 verification token / 签名;长连接走 SDK 握手 | Stream 走 SDK;webhook 签名校验 | URL 回调:`Token` + `EncodingAESKey` 加解密 + 签名 |
| **出站发消息** | `POST im/v1/messages`,`tenant_access_token` | app access_token 推送 | 发送应用消息,`access_token = f(corpid, secret)` |
| **互动卡片** | interactive card(JSON,≤30KB),按钮 → card action callback(长连接 / webhook) | 互动卡片 / AI 卡片,卡片回调经 Stream | 模板卡片(按钮交互型 / 投票 / 多选),支持回调更新 |
| **卡片原地更新** | ✅ 更新已发卡片 | ✅ | ✅(更新模板卡片) |
| **OA / 审批** | ✅ approval-v4(审批实例 + task 状态事件) | ✅ OA 审批回调 | ⚠️ 有审批 API,但与自建应用消息体系分离,接入更重 |
| **主动推送** | ✅ 满血 | ✅ 满血 | ⚠️ 仅自建应用对成员推送;**个人微信无合规机器人 / 主动推送** |
| `maxBindings` | ∞ | ∞ | 1 |
| **北极星动作落地度** | 全部可落(看 diff / 开 PR / 合并并启动 / 打回 / 查看冲突 / 审批闭环) | 全部可落 | 卡片按钮 + 推送可落;审批闭环降级(可先做"通知 + 一键动作",审批走 Kanban 内部或后置) |

**降级结论:** 企业微信走自建应用,做"通知卡片 + 一键动作"完全可行;审批闭环作为可选增强,初期可不接企微审批,用 Kanban 内部确认替代。个人微信明确不在范围(无合规主动推送)。

---

## 9. 凭证与鉴权管理

**原则(与 [[shared-provider-launch-resolver-implemented]] / committed-provider 边界一致):配置入库,密钥留机器本地。**

- **绑定记录(入库)**:只含 `credentialRef`(指向某条 app 凭证)+ 非密钥账号标识(如 appId / corpId / agentId)。**绝不**含 token / secret。
- **app 凭证(机器本地,不入库)**:`app secret`(飞书 app_secret / 钉钉 app_secret / 企微 corpsecret)、`EncodingAESKey`、verification token 等,存机器本地密钥库(对照现有 `agent_providers.json` 在 machine-home 的做法),走 `.gitignore` 边界,**永不 committed**。
- **出站 token 生命周期**:`tenant_access_token` / app access_token 有有效期,适配器内部缓存 + 到期刷新,不落盘长期 token(或只缓存内存)。
- **入站校验**:webhook 路径验签 / 解密在适配器内完成(企微的 `Token`+`EncodingAESKey`、飞书 verification token、钉钉签名);长连接走官方 SDK 握手。
- **代理**:若 runtime 走代理(见 [[live-proxy-fetch-monkeypatch-works]]),适配器出站 fetch 自动经 `globalThis.fetch` monkey-patch;长连接 SDK 如不走 fetch 需单独确认代理路径(开放问题 §11)。

---

## 10. Settings 绑定 UI

在现有 Settings 里加一个 **IM Bindings** 区(或并入 Agent / Integrations 页):

- **绑定列表**:每条显示 platform 图标、channelKey(可读名,如群名 / 用户名)、agentId、threadId、状态(已连 / 断线)。
- **添加绑定**:选 platform → 选 agent → 选 / 新建 thread → 选 app 凭证(`credentialRef`)→ 输入 / 确认 channelKey(或由"在 IM 里 @机器人发一句话"自动捕获首个 channelKey,体验更好,开放问题 §11)。
- **改 agent**:`updateImBinding` + 硬关旧 session(换 agent 破坏连贯,需重起)。
- **重新绑定 / 解绑**:
  - 飞书 / 钉钉:加新 channelKey = 新增;同 channelKey = 更新。无冲突。
  - 企业微信:已占用时,"添加"变成**重绑确认对话框**("将替换当前绑定并清空其对话,确定?")→ 原子替换(§4.4)。
- **app 凭证管理**:单独的凭证录入处(secret 等机器本地),绑定只引用。

UI 数据全走 §4.2 的 tRPC(`listImBindings` 等),与 home-thread / provider 的 Settings 形态一致。

---

## 11. 开放问题(需实现期确认 / 调研)

1. **入站接入选型(每平台)**:飞书 / 钉钉优先长连接(免公网 IP),但长连接在 headless / 多 workspace 下的连接数与稳定性需压测;企微只能 webhook,需要 runtime 暴露一个可被企微回调的入站 HTTP 端点(本地 / 内网穿透 / 反代),与现有 `--host` 绑定及 NO_PROXY 处理(见 [[host-proxy-cli-workaround]])如何协同?
2. **长连接 SDK 是否走 `globalThis.fetch`**:若用各家官方 Node SDK 起长连接,代理 monkey-patch 可能覆盖不到(非 fetch 传输),需单独验证(对照 [[live-proxy-fetch-monkeypatch-works]] 的覆盖边界)。
3. **channelKey 自动捕获 vs 手填**:"在 IM 里 @机器人说一句 → 自动建 / 补全 channelKey"体验最佳,但要先有一条入站通道在跑且未绑定的处理路径;需定义"未绑定 channelKey 的入站事件"行为。
4. **出站流式取舍**:per-token 发会刷屏,按 turn 边界发整段更合理;turn 边界判定用 `onSummary` 转 `awaiting_review` 还是网关侧 debounce?长 turn 是否需要"思考中…"占位卡?
5. **空闲回收阈值**:软停阈值(建议默认 15–30 min 无消息)、硬关阈值(建议默认 24h+);是否按 platform / binding 可配?
6. **resume 冷启动开销**:resume 一条 idle 会话(重新拉起进程 + 喂历史)的延迟,对 IM 即时性的影响;是否需要"正在唤醒…"提示卡。
7. **转录压缩策略**:journal 已有 coalesce + 截断标记(见 [[perf14-journal-compaction-triggers]]);IM 长期对话是否需要更激进的摘要 / 压缩,还是靠"看板是真相源 + 闲聊记忆可丢"即可?
8. **企业微信审批闭环**:是否接企微 OA 审批,还是降级为 Kanban 内部确认?
9. **多用户 / 群语义**:一条群绑定里多个用户都能下指令时,如何归因 senderId、是否需要权限校验(谁能点"合并")?
10. **凭证库形态**:复用现有 machine-home secret 存储,还是为 IM app 凭证单开一个 store?

---

## 12. 分阶段实现拆分建议

按"先抽象、再满血平台、再闭环、再扩平台"的顺序,每阶段可独立交付 / 测试:

> **阶段 0(可选,前置):** 抽出 IM 绑定注册表(§4.2 的纯函数 + store + 持久化 + tRPC)+ Settings 列表骨架。纯数据层,无平台依赖,可先单测。

**阶段 1 —— 入站网关抽象 + 会话生命周期**
- `InboundChatAdapter` 接口 + `NormalizedInboundEvent` / `NormalizedCard`(§5)。
- IM Gateway:绑定路由(channelKey→binding 内存索引)、懒启动 / 喂入 / resume 编排(§6),经 `limitAgentStart`。
- 订阅 `onMessage` 出站回复(§7.2),按 turn 边界发文本。
- **空闲回收器**(§6.5,新建)。
- 验收:用一个 mock adapter(内存收发)端到端跑通"入站消息 → 起 agent → assistant 文本出站 → 空闲软停 → 再消息 resume"。

**阶段 2 —— 飞书适配器 + 卡片交互**
- 飞书入站(长连接 / webhook)+ 出站 `im/v1/messages` + `tenant_access_token` 管理。
- interactive card 渲染(`NormalizedCard` → 飞书 JSON)+ card action callback 入站。
- 主动推送(§7.3):订阅 `onSummary` / board-sync,组装待审 / 失败 / 冲突卡片,含降噪 + 静默时段。
- 闭环动作(§7.4):看 diff / 打回 / 查看冲突先落地。
- Settings 绑定 UI(飞书,新增语义)。
- 验收:飞书里收到待审卡片 → 点按钮 → 看板动作生效 → 卡片更新。

**阶段 3 —— 审批闭环**
- 飞书 approval-v4:北极星动作(合并并启动下一个 / 开 PR)走审批,审批通过事件触发实际动作。
- 结合 auto-review(commit/pr)+ 任务链(`dependsOn`)做"人在环但只需点一下"的流水线。
- 验收:点"合并并启动下一个" → 发起审批 → 通过 → 自动合并 + 启动后继任务。

**阶段 4 —— 钉钉适配器**
- 钉钉 Stream 长连接入站 + app access_token 出站 + 互动 / AI 卡片 + OA 审批回调。
- 复用阶段 1/2/3 的网关 / 卡片 / 审批逻辑,只填适配器。
- Settings 绑定 UI 复用(钉钉,新增语义,`maxBindings=∞`)。

**阶段 5 —— 企业微信适配器**
- 自建应用:webhook 入站(`Token`+`EncodingAESKey` 加解密)+ `access_token` 出站 + 模板卡片(按钮交互型)。
- 单槽位 `maxBindings=1` + 重绑确认(§4.4 / §10),原子替换走 hard-close。
- 审批闭环降级(§8):初期"通知 + 一键动作",不接企微 OA 审批。
- Settings 绑定 UI:已占用变重绑确认对话框。

---

## 13. 复用现有机制清单(不重造)

| 复用 | 来源 | 用途 |
|---|---|---|
| home thread 注册表模式 | `home-thread-registry.ts` / `home-thread-store.ts` / `workspace-state.ts` | IM 绑定注册表照搬(§4.2) |
| home session id | `src/core/home-agent-session.ts` | 绑定 → 会话寻址 |
| 会话启动 / 喂入 / 关闭 | `startTaskSession` / `sendTaskSessionInput` / `writeInput` / `closeTaskSession` | 生命周期(§6) |
| agent session resume | `claude --session-id` / codex capture-after-launch + `agentSessionId` on summary | 重启 / 断线续聊 |
| 会话持久化 | `FileSessionMessageJournal`(messages.jsonl) | 转录跨重启 |
| `SessionMessageSource.onMessage` | `src/session/session-message-source.ts` | 出站回复订阅 |
| runtime 事件 | `runtime-state-hub` 的 `onSummary` / board-sync `onStatusChanged` | 主动推送(进程内订阅,不走 ws) |
| agent-start 限流 | `limitAgentStart`(`agent-start-limiter.ts`) | 批量唤醒兜底 |
| auto-review + 任务链 | `autoReviewMode` / `RuntimeBoardDependency.dependsOn` | 闭环"合并并启动下一个" |
| logging facade | `createLogger`(`src/logging/`) | 网关 / 适配器日志(禁 `console.*`) |
| 代理 fetch monkey-patch | `src/config/proxy-fetch.ts` | 出站 API 自动走代理 |

**明确不重造:** 不在 IM 层另起一套会话模型 / 转录存储 / agent 抽象;不为 pi 写死;不引入第二条事件总线。

---

## 14. 约束与非目标

**约束(遵循 AGENTS.md):**
- 不用 `any`;优先 SDK 提供的类型 / schema。
- 统一 logging facade `createLogger`,**禁止 `console.*`**;结构化字段(workspaceId / bindingId / channelKey / error)进 fields,不字符串拼接。
- 优先复用现有机制(§13),不重造会话模型。
- 无内联 import;小文件单一职责;DRY。

**非目标:**
- 不做个人微信机器人(无合规主动推送)。
- 调度秘书**不写代码**(写代码是任务 worktree 的任务 agent)。
- 不跨 agent / 跨 workspace 迁移会话上下文(见 [[no-cross-agent-session-sharing]])。
- 本任务**只产出设计文档,不实现、不提交。**

---

## 附:关键文件索引

| 主题 | 文件 |
|---|---|
| home session id | `src/core/home-agent-session.ts` |
| home thread 纯函数 / store | `src/session/home-thread-registry.ts` / `home-thread-store.ts` |
| per-workspace 持久化 + 两根分裂 | `src/state/workspace-state.ts`(`BoardDataLocation` / `resolveBoardDataLocation`) |
| 会话启动 / 喂入 / 限流 | `src/trpc/runtime-api.ts`(`startTaskSession` / `sendTaskSessionInput` / `limitAgentStart`) |
| 会话管理(CLI / pi) | `src/terminal/session-manager.ts` / `src/agent-sdk/kanban/pi-task-session-service.ts` |
| 会话消息源契约 | `src/session/session-message-source.ts` |
| 转录持久化 | `src/session/session-message-journal.ts` |
| 事件广播 / hub | `src/server/runtime-state-hub.ts` |
| wire 契约 | `src/core/api-contract.ts`(`runtimeTaskChatMessageSchema` / `RuntimeTaskSessionSummary` / `RuntimeBoardSyncStatus` / `RuntimeBoardDependency`) |
| board-sync | `src/workspace/board-sync.ts` |
| agent-start 限流 | `src/server/agent-start-limiter.ts` |
| runtime-server 接线 | `src/server/runtime-server.ts`(`getScopedHomeThreadStore`) |
| board-branch 解耦背景 | `.plan/docs/board-branch-decoupling.md` |
