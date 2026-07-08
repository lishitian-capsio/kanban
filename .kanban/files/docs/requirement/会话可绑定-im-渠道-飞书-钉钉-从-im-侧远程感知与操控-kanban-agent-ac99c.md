---
_id: ac99c
type: requirement
_created: 1783323546359
_updated: 1783477495511
priority: medium
status: parked
title: 会话可绑定 IM 渠道（飞书 / 钉钉），从 IM 侧远程感知与操控 Kanban agent
---
## 谁受影响

用 Kanban 编排 coding agent 的用户，尤其是 **runtime 跑在服务器 / 远程 / LAN、人不在那台机器前**的场景（local-first + 远程访问是 Kanban 的常态）。

## 今天的痛点

要感知或推进一个 agent 会话，用户必须**打开 Kanban 界面盯着**。人在外面、只带手机时：

- 任务完成、agent 有产出、需要 review，**没有主动触达**——只能事后回看板才发现。
- 想给某个会话补一句指令 / 确认，也**必须回 Kanban UI**，无法从随身的 IM 里完成。

而团队日常沟通本就在飞书 / 钉钉里，Kanban 与这些 IM 之间是断开的。

## 客户需要什么

让 Kanban 的会话（home thread）能与飞书 / 钉钉的 IM 会话打通，从 IM 侧远程感知与操控 agent。**平台范围：飞书（Lark）+ 钉钉（DingTalk）两家；明确不做微信**（个人微信无官方 API、违反 ToS；企业微信本轮排除）。IM 做成**可插拔渠道抽象**（按平台 keyed 的 adapter）。

### 产品落点（关键：不做独立 tab，融进 Home）

- **Settings：只配 bot 凭证**（app_id/secret / webhook / 签名密钥）。一次性、秘密、极少动，和 GitHub/Gitee 认证卡片同一路。
- **Home：有一块"IM 会话 id 列表"**——存着有哪些飞书 / 钉钉会话可绑。列表来源**两种都要**：
  1. **手动添加**（把群 / 单聊 id 加进来）；
  2. **@ 过 bot 的会话自动进列表**（在群里 @ 一下 bot，它就出现在列表里可选）。
- **绑定 = 选**：在 **home tab（新建会话）** 或**某个会话 tab** 上，从列表里选一个 IM 会话 id 绑到该 thread。
- **一对一**：一个 IM 会话 id 同一时间只能绑一个 thread；选到新 thread 时自动从旧 thread 解绑（避免一条 IM 消息进两个会话）。
- **切换 = 换个会话 tab 再选**：想把某个 IM 会话切到别的 thread，就去那个 thread 的 tab 选中这个 IM id——等于把它"挪"过去。IM 里也可用命令切（见下）。
- **没有独立 IM tab、也不在 Kanban 侧另做聊天框**：真正的对话仍在 IM 里进行；Kanban 只做"配对 / 绑定 / 指向哪个会话"的管理。

### agent 怎么定（被前面的模型自然解决）

因为绑定是把 IM 会话挂到一个**已存在的 thread** 上，而 thread 创建时就锁定了 agent（pi 或某个 cli）——**直接用那个 thread 的 agent 即可，不需要在绑定/配对时再单独选 agent**。thread 的 agent 创建后不可改。

### 两个方向

- **方向 A — Kanban → IM 出站通知（阶段 1，后端已基本实现于 `src/im/`）**：绑定后，会话关键进展（任务完成 / 进入 review / agent 结束一轮）主动推到绑定的 IM 会话。单向，不依赖常驻或唤醒。
- **方向 B — IM ↔ Kanban 双向（阶段 2，核心）**：IM 里发消息 → 进绑定的 thread 驱动 agent；agent 回复回推 IM。等于把会话搬进 IM 遥控。

### 未绑定会话的引导（onboarding，选定方案 A：交互卡片）

一个**未绑定**的 IM 会话第一次来消息时，**不丢弃、也不靠默认 agent 瞎猜**，而是引导用户当场选：

- bot 在该 IM 会话回一张**交互卡片**，列出**可用的 agent**（装了/配了的，过滤掉不可用的）：`[pi] [claude] [codex] …`。
- 用户点某个按钮 → **建一个该 agent 的会话 + 绑定这个 IM 会话** → 把用户最初那条原消息**补投**进去（不用重发）。
- 之后该会话再来消息，已绑定，直接正常投递，不再询问。
- 于是"选哪个 agent"变成**首次来消息时的一次 onboarding**（人在环里），取代了"auto-新建靠默认 agent 兜底"。

## 分阶段

- **阶段 1（出站 + 绑定基础）**：`src/im/` 的 provider 抽象、飞书 / 钉钉出站 adapter、thread 的 imChannel 字段、进度推送订阅器**已实现**；**待补：IM 凭证的 Settings 配置入口**（后端 `im-credential-store.ts` 的读写函数已在、但无 tRPC / UI 调用者）。
- **阶段 2（双向 + Home 绑定运营面）**：架构路线已由同类开源实现（OpenClaw / Nous Research 的 hermes-agent，MIT）验证：**轻量常驻 gateway + 长连接入站 + agent 按需唤醒 + 入站路由到绑定 thread**。

## 成功的样子

- Settings 里能配 / 清飞书、钉钉的 bot 凭证（不回显秘密）。
- Home 里有 IM 会话 id 列表（手动加 + @ 自动进）；新建会话或在会话 tab 上能从列表选一个 IM id 绑定，一对一。
- 方向 A：绑定的会话进度自动推到该 IM 会话。
- 方向 B：在绑定的 IM 会话里发消息即驱动对应 thread 的 agent 并收到回复；pi 会话优先跑通，cli 随后。
- 换个会话 tab 选中同一个 IM id 即完成"把 bot 切到该会话"。

## 范围说明与交付注记（非需求本身）

- **凭证存储**：机器本地 `~/.kanban/settings/im-credentials.json`（0600，`KANBAN_IM_CREDENTIALS_FILE` 可覆盖），永不提交、永不打日志。**绑定关系**（thread 的 `imChannel`）与 **IM 会话 id 列表**：随 thread registry / workspace 数据持久化（committed 侧）。
- **onboarding 卡片依赖卡片回调事件**：交互卡片按钮点击走飞书 `card.action.trigger`（钉钉对应的 ActionCard 回调），需在长连接入站里**多接一类事件**（现在只接了 `im.message.receive_v1`）；出站发卡片 provider 已支持。需要一个"该会话正在等选择 agent + 暂存原消息"的 pending 状态；用户选定后 create-thread + bind + 补投原消息。可先用文字选项（回复数字）跑通闭环，卡片作为增强——但目标形态是卡片（方案 A）。
- **未绑定当前行为**：现实现是 `ImInboundRouter` 找不到绑定即 `return` **丢弃**（onboarding 未做前的现状）；本需求把它改成"回推卡片引导选择"。
- **长连接（关键）**：入站走飞书 WebSocket / 钉钉 Stream 长连接，**无需公网可达的回调 URL**——契合 Kanban 的 headless / LAN 形态（一度被视为障碍，实测可绕过）。
- **轻量常驻 gateway**：只有 gateway 长驻收发 IM，**不是整个 agent 常驻**；订阅 `im.message.receive_v1`（飞书）/ 钉钉 Stream。
- **agent 按需唤醒**：绑定 thread 的 agent 若空闲/未在跑，来消息时先唤醒 / 接续再处理。pi 在进程内跑、有规整的结构化消息模型，**入站（塞入 pi 输入口）与出站（结构化消息，且与 cli 共用 task_chat_message 通道）都比 cli 干净——建议先用 pi 跑通**；cli 入站需写 PTY、出站靠终端回滚重建，糊一些，随后支持。
- **IM 内切换命令**（可选增强）：`/sessions` 列表 / `/switch <n>` / `/new`，复用 Kanban 已有 slash-command 基础设施；切到已存在 thread 用该 thread 自己的 agent。
- **幂等去重**：IM 平台 at-least-once 投递，出站 / 入站都要按 event_id 防重复。
- **身份**：群机器人以 bot 身份收发即可；读用户个人资源才需 per-user 授权（扫码 / 授权链接，属另一议题）。
- **human-in-the-loop**：review / 高风险动作宜用 IM 交互卡片按钮做确认（飞书、钉钉均支持）。
