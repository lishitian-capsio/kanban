# 语音指令控制看板 — 设计

> 实现任务设计文档。前置:语音输入(STT)已落地(`web-ui/src/hooks/{use-voice-input,voice-input-state}.ts` + `VoiceInputButton`,挂在共享 `KanbanChatComposer`)。
> 选型依据:`.plan/docs/voice-features-tech-selection.md`(以下简称"调研")。
> 日期:2026-06-28

---

## 0. 一句话

在已有 STT 之上,给 **home 侧边栏聊天** 增加一个 **聊天/命令** 心智切换:命令模式下,把转写文字经一个**极小的本地确定性解析器**(仅 4 个动词:新建/启动/移动/删除)识别为看板动作,**先弹确认卡展示将要执行的具体动作**,确认后把一条**带任务 id 的明确指令**发给现有 home agent 执行(复用 `sendText` → agent 跑 Kanban CLI)。聊天模式与未识别项一律走现有"填草稿、人工发送"。

这忠实于调研的两条核心结论——**复用 agent 通路、不造 NLU**(§4.1)、**转写默认不自动发**(§3.2)——同时落实本任务额外的硬性要求:**会改板的指令执行前必须明确确认并展示动作**、**意图→动作映射与确认流可单测**。调研 §4.3 明确把"少量高频命令的极小本地规则匹配"列为可接受选项,本设计正是其受限实现。

## 1. 关键决策(已定)

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 执行方式 | **走 agent 通路**:本地解析出确切卡片/列 → 确认 → 发**带 id 的明确指令**给 agent | 改动面最小(home 面板已有 `sendText`);看板改板 CLI 仅 home agent 有;直连 tRPC 需把 App 级 `handleCreateTask/handleStartTask` 穿透进聊天面板,代价大且偏离调研 |
| 作用范围 | **仅 home 侧边栏聊天** | 看板管理 agent 在此(placeholder 即 "add, edit, start, or link tasks");任务详情聊天保持纯 STT,其 agent 在任务 worktree 内、未必有改板权限 |
| 入口 UX | composer 麦克风旁 **聊天/命令** 小切换 | 契合"两种心智";只占一处;`onVoiceCommand` 缺省时不渲染(任务聊天零影响) |
| 误识别防护 | 改板指令**一律确认**;未识别/歧义/找不到 → 回退填草稿 + 提示,**绝不自动执行/发送** | 调研 §7 最高优先级风险:STT 误识别 + agent 执行有副作用 CLI |

## 2. 架构与单元边界

```
转写文字 ──(命令模式)──► planVoiceCommand(transcript, board)        [纯函数, 单测]
                              │
              ┌───────────────┼────────────────────────┐
              ▼               ▼                         ▼
        {kind:"chat"}   {kind:"confirm",          {kind:"reject",
         填草稿           resolved, summary}        reason} 提示+填草稿
                              │
                       VoiceCommandConfirmDialog (展示 summary)
                              │ 用户确认
                              ▼
                   buildAgentInstruction(resolved)  [纯函数, 单测]
                              │
                   chatPanelRef.sendText(instruction) → 现有 agent 通路
                              │
                       toast 反馈 + 聊天里 agent 回显(现有 ws)
```

### 2.1 纯逻辑模块 `web-ui/src/voice-command/voice-command.ts`(单测核心)

无 DOM/React 依赖,便于单测。导出:

- `parseVoiceCommand(transcript): ParsedVoiceCommand` — 文本 → 意图(判别联合)。
  - `create`:`{ kind:"create"; title }`(触发词:新建/创建/添加 … 任务;new/create/add task。标题取冒号后或动词后剩余文本)
  - `start`:`{ kind:"start"; target }`(启动/开始/运行 … 任务;start/run)
  - `move`:`{ kind:"move"; target; column }`(把 X 移到/移动到/拖到 Y;move X to Y)
  - `delete`:`{ kind:"delete"; target }`(删除/移除/删掉 X;delete/remove)
  - `chat`:`{ kind:"chat"; text }`(兜底)
- `TaskReference = { kind:"topBacklog" } | { kind:"title"; query }` — 目标任务引用("顶部/第一个待办";或标题片段)。
- `ColumnReference` — 口语列名 → `RuntimeBoardColumnId`(同义词表:待办/backlog→backlog;进行中/doing→in_progress;评审/审查/review→review;完成/done/删除→trash。done==trash 终态桶,见仓库记忆)。
- `resolveVoiceCommand(parsed, board): ResolvedVoiceCommand | VoiceCommandRejection` — 把引用对照 board 快照解析成确切卡片(id+显示名)与列;歧义/找不到/空板/未知列 → rejection。
- `planVoiceCommand(transcript, board): VoiceCommandOutcome` — 顶层入口,合 parse+resolve:返回 `{kind:"chat"|"confirm"|"reject", …}`。
- `describeResolvedCommand(resolved): { title; detail }` — 确认卡中文文案。
- `buildAgentInstruction(resolved): string` — 发给 agent 的带 id 明确指令(如 `把任务「修复登录 bug」(id: abc123)移动到「完成」列`)。

board 快照用模块自有最小接口 `VoiceCommandBoard`(`columns:[{id,title,cards:[{id,title?,prompt}]}]`),调用处从 `RuntimeBoardData` 适配,解耦且单测零依赖。

### 2.2 控制器 hook `useVoiceCommandController`

输入:`{ board, onExecute(instruction), onFillDraft(text) }`。
返回:`{ handleTranscript(transcript), pending, confirm(), cancel() }`。
职责:调 `planVoiceCommand` → chat/reject 走 `onFillDraft`(reject 另发提示 toast)→ confirm 置 `pending` 打开对话框;`confirm()` 调 `onExecute(buildAgentInstruction)` 并 toast,清 pending;`cancel()` 清 pending(可选回填草稿供编辑)。

### 2.3 UI `VoiceCommandConfirmDialog`

复用 `@/components/ui/dialog` 的 `AlertDialog`(破坏性确认范式)。展示 `describeResolvedCommand` 的标题+明细 + 确认/取消。遵循设计 token、深色主题、lucide 图标。

### 2.4 接线

- `KanbanChatComposer`:新增可选 `onVoiceCommand?(transcript)`;有它时渲染 **聊天/命令** 切换(放在麦克风左侧),命令模式下 `VoiceInputButton.onTranscript` 路由到 `onVoiceCommand` 而非 `appendTranscriptToDraft`。
- `KanbanAgentChatPanel`:透传新增 `onVoiceCommand` 给 composer。
- `HomeAgentConversation`:读 `useRuntimeWorkspaceState().board`,装配 `useVoiceCommandController`(`onExecute=chatPanelRef.sendText`,`onFillDraft=chatPanelRef.appendToDraft`),把 `handleTranscript` 作为 `onVoiceCommand` 传给面板,并渲染确认对话框。

## 3. 反馈

- 执行后 `toast`(sonner)即时回执("已发送指令:移动任务…")。
- agent 的实际执行结果经现有 `task_chat_message` ws 在聊天里回显,无需新通道(调研 §4.2)。

## 4. 测试

`web-ui/src/voice-command/voice-command.test.ts`:
- parse:四动词的中/英多种说法、标题抽取、列同义词、兜底 chat。
- resolve:topBacklog、标题精确/子串/歧义/找不到、空板、未知列。
- plan:chat/confirm/reject 三类 outcome。
- describe / buildAgentInstruction:文案与带 id 指令正确。
- 控制器确认流的纯部分(若抽出 reducer)。

## 5. 明确不做(YAGNI)

- 不做独立 NLU / 通用意图引擎(调研 §4.1)。
- 不做直连 tRPC 执行(见 §1)。
- 不做任务详情聊天的命令模式、不做 TTS、不做唤醒词/常驻监听、不做"自动发送"开关。
- 不新增后端 endpoint(纯前端,复用既有 STT 与 send 通路)。
