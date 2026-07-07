---
_id: ac99c
type: requirement
_created: 1783323546359
_updated: 1783387376697
priority: medium
status: proposed
title: 会话可绑定 IM 渠道（飞书 / 钉钉），从 IM 侧远程感知与操控 Kanban agent
---
## 谁受影响

用 Kanban 编排 coding agent 的用户，尤其是 **runtime 跑在服务器 / 远程 / LAN、人不在那台机器前**的场景（local-first + 远程访问是 Kanban 的常态）。

## 今天的痛点

要感知或推进一个 agent 会话，用户必须**打开 Kanban 界面盯着**。人在外面、只带手机时：

- 任务完成、agent 有产出、需要 review，**没有任何主动触达**——只能事后回看板才发现。
- 想给某个会话补一句指令 / 确认，也**必须回到 Kanban UI**，无法从随身的 IM 里完成。

而团队日常沟通本就在飞书 / 钉钉里，Kanban 与这些 IM 之间是断开的。

## 客户需要什么

IM 与 Kanban 打通分**两个方向**，机制不同、创建流程也不同：

### 方向 A — Kanban 会话 → IM 出站通知（阶段 1，后端已基本实现）
- 一个在 Kanban 里创建的 chat thread（`New chat thread`，正常输入 prompt），可**绑定一个 IM 渠道**，把关键进展（任务完成、进入 review、agent 结束一轮）主动推过去。单向 Kanban → IM，不依赖常驻监听或 headless 唤醒。
- 这一侧**需要 Kanban 侧选渠道**（Kanban 里已有 thread，选择推到哪个飞书 / 钉钉会话）。

### 方向 B — IM 原生会话（阶段 2，核心）：绑定在 IM 侧，Kanban 不创建
- **一次性 pairing**：用户扫码 / 私聊 bot 完成配对（非 OAuth，见阶段 2）。配对是**一次性的**，不是每个会话都配。
- 配对后，用户**直接在 IM 里给 bot 发消息**——这条入站消息本身就**自动物化 / 驱动一个 Kanban thread**。
- 因此 **Kanban 侧不需要"新建 IM 会话"的创建入口**，也不需要在创建时选平台 / 填 chatId：**IM 会话本身就是入口**，thread 由入站消息隐式创建。（这**修正了早期"在新建会话弹窗里选填 IM 信息"的设想**——那套只适用于方向 A 的出站绑定。）
- 这些 IM 会话在 Kanban 里以**镜像**形式出现（可读、可选管理），但不在 Kanban 里创建。等于把 agent 会话整个搬进 IM 遥控（hermes 模型）。

### 平台范围
- **支持飞书（Lark）与钉钉（DingTalk）两家**；两家均具备长连接事件能力，入站对两家统一可行。
- **明确不做微信**：个人微信无官方开放 API，第三方接入违反 ToS；企业微信本轮也排除在范围外。
- IM 应做成**可插拔的渠道抽象**（provider / adapter 按平台 keyed），新增平台是加一个 adapter，而非改造主流程。

## 分阶段（由上面两种类型的依赖自然划分）

- **阶段 1 — chat thread 出站通知绑定**：类型 A 的绑定能力。单向、零常驻依赖，一次渠道抽象同时覆盖飞书 + 钉钉。风险最低，先交付。
- **阶段 2 — IM 原生会话（双向遥控）**：方向 B。绑定在 IM 侧（一次性 pairing），入站消息**自动物化 thread**，**Kanban 侧无创建入口**。架构路线已由同类开源实现（OpenClaw / Nous Research 的 hermes-agent，MIT）验证：**轻量常驻 gateway + 长连接入站 + pairing-code 配对 + agent 按需唤醒 + 入站自动物化 thread**（见交付注记）。

## 成功的样子

- new session 入口只有「New chat thread」（Kanban 原生）；**没有"New IM thread"创建卡**——IM 会话由 IM 侧发起，不在 Kanban 创建。
- 方向 A（阶段 1）：Kanban 里的 chat thread 可绑定飞书 / 钉钉渠道，进度自动推送到该 IM 会话；一次抽象覆盖两家。
- 方向 B（阶段 2）：一次性配对后，直接在 IM 里发消息即自动物化 thread、驱动对应 agent 并收到回复——**无需在 Kanban 侧创建或填写任何 IM 信息**。
- 配对 / 绑定关系持久化；解除配对后该 IM 会话不再驱动 Kanban。

## 范围说明与交付注记（非需求本身）

- 绑定 / 渠道信息挂在会话（home thread）上，形如 `imChannel: { platform: 'lark'|'dingtalk', chatId, ... }`，随 thread registry 持久化。方向 A 由 Kanban 侧选渠道写入；方向 B 的 thread 由**入站消息自动创建**并盖上来源 chatId，用一个标记区分“IM 驱动、无 Kanban composer”。**配对关系（哪个 IM 用户 / 会话已授权驱动 Kanban）单独持久化，与具体 thread 解耦**（配对一次，之后每段对话各自物化 thread）。
- 出站两平台形态一致（群机器人 webhook / 发消息 API），是抽象的最小公共面；应优先落地。
- 入站（阶段 2 / 类型 B）架构路线（参考 OpenClaw / hermes-agent 已验证）：
  - **轻量常驻 gateway**：只有 gateway 长驻收发 IM，**不是整个 agent 常驻**。飞书 WebSocket / 钉钉 Stream 长连接接收事件，**无需公网可达的回调 URL**——直接契合 Kanban 的 headless / LAN 形态（这一度被视为障碍，实测可绕过）。
  - **agent 按需唤醒**：会话背后的 agent 执行环境空闲时休眠、gateway 收到消息时按需拉起（hermes 用 serverless 后端做到近乎零成本待机）。这替代了原先"整个 agent 常驻"的重方案。
  - **pairing-code 配对**（替代 Kanban 侧下拉选群）：用户在 IM 里私聊 / @ bot → bot 回一个一次性配对码 → 用户在 Kanban（或 CLI）批准 → **授权该 IM 用户 / 会话可驱动 Kanban（一次性）**。**非 OAuth**，走长连接，无回调。
  - **入站自动物化 thread**：配对后，该会话的入站消息由 gateway 按 chatId 路由——已有对应 thread 则投递，没有则**自动创建**一个 IM 驱动的 thread（盖上 chatId）。与出站的 originThreadId→imChannel 路由对称。Kanban 侧全程无需创建动作。
- 事件必须**幂等去重**（IM 平台 at-least-once 投递），出站 / 入站都要防重复。
- 身份：群机器人以 bot 身份收发即可覆盖两阶段的群场景；读用户个人资源才需 per-user 授权（扫码 / 授权链接产品化绑定，属另一议题）。
- human-in-the-loop：review / 高风险动作宜用 IM 交互卡片按钮做确认入口（飞书、钉钉均支持交互卡片）。
