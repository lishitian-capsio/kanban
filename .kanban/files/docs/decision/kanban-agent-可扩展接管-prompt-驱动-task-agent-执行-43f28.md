---
_id: 43f28
type: decision
_created: 1781762270495
_updated: 1781764753989
status: accepted
title: 'Kanban agent 可扩展接管(prompt 驱动),task agent 执行'
---
## 角色骨架:kanban agent 接管,task agent 执行

整个 auto = 两个 agent 角色的分工,事件向上、prompt 向下:

- **kanban agent = 接管者**(侧栏 home 线程的 agent):跟用户对话、写 prompt 派活、收任务事件、把流程往前推、回报用户。是「脑子」/编排者。
- **task agent = 执行者**:在各自 worktree 里干活,产生状态机跃迁 / 事件。是「手」。

```
用户 ──对话──▶ kanban agent(接管者)
                 │ 写 prompt 派活 ▼
             task agent(执行者, worktree 干活)
                 │ 状态机跃迁(进程内事件)▲
             kanban agent 被注入 prompt → `接管下一步` → 回报用户
```

## 决定

### 1. 默认 = prompt;接管 = 可自定义扩展

- **默认基线 = 裸 prompt**:kanban agent 只是 prompt 驱动——事件渲染成 prompt 注入,agent 照 prompt 行动,**无任何写死的接管逻辑**。
- **接管 = 自定义扩展**:想要特定接管行为(自动往前推、特定编排、某条脉络的特殊策略),作为**扩展用 prompt 来写**(像 skill / vault 类型那样:自描述、数据驱动、按需加载),不在代码里写死。不挂扩展 = 退回裸 prompt。
- **不做内建固定分层**(此前设想的 L0/L1/L2 不是代码层);「分层」只是扩展可以实现出来的形态之一。

### 2. 不做收敛/判定(砍掉)

接管 agent **不当 review 闸、不对照需求判过/打回**。到 review/完成时它**回报用户**,裁决权留用户。auto-review(commit/PR)+ link 保留为接管者可调用/可委派的快捷动作。

### 3. 机制:runtime 进程内 hook + prompt 注入(无 websocket)

接管 agent 的 session 与任务状态机同在一个 runtime 进程,**不需要 websocket**(那是 runtime 跟自己网络通信)。在状态机跃迁点做**进程内 hook**:查发起线程的接管开关/扩展,开 → 渲染 prompt → 直接调 session manager 注入发起 home session 并触发。web-ui 已有自己的 websocket(实时显示)不受影响;外部(飞书等)暂不考虑。

```
runtime 跃迁点(in-process hook)→ 查接管开关/扩展 → 渲染 prompt
  → 直接调 session manager 注入发起 home session 并触发(无 websocket、无订阅桥)
```

### 4. 多种 agent 接管

接管 agent 可为 claude/codex/pi/gemini 等。

- **哪个 agent 接管**:已解决——每条 home 线程各选自己的 agent(home-multithread)。
- **统一投递接缝(异构难点)**:抽一个「向本 home session 投递 prompt 并触发执行」的方法,pi(enqueue user message + run)与 CLI/terminal(`writeInput` + 回车)各自实现于 SessionMessageSource / 两套 manager;hook 用 parseHomeAgentSessionId 解析背后 agent → 调对应实现。
- **liveness/resume**:注入前 session 须活;CLI agent 可能已退出,复用 claude session resume(--session-id/--resume)或在该线程 cwd 重新拉起。
- **行为层 agent-中立**:注入的是纯文本 prompt + 现成 CLI 动词,与 agent 类型无关;异构只在投递接缝 + resume 吸收。

## 控制面:每条 home 线程的「接管」开关

是否接管 = **每条 home 线程级**(非 workspace、非每任务):一条会话线程 = 一条需求脉络。默认 OFF。事件发生时动态读(切 ON 纳入在跑任务,切 OFF 立即停)。可进一步选择挂哪个接管扩展。

## 后果(待实现,见任务 29940)

1. 任务↔发起线程绑定(创建时总是绑,出口按开关动态 gate)。
2. 每线程接管开关(默认 OFF)+ 可选接管扩展加载点。
3. runtime 状态机跃迁点的进程内 hook → 渲染 prompt → 注入发起 session(无 websocket)。
4. 统一投递接缝(pi / terminal 各实现)+ CLI resume/拉起。
5. 接管行为不写代码,纯 prompt 扩展驱动;auto-review/link 收编为可委派快捷动作。
6. 短期可用侧栏 /loop `轮询近似。`
