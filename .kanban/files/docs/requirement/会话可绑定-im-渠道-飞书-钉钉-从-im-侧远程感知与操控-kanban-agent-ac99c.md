---
_id: ac99c
type: requirement
_created: 1783323546359
_updated: 1783323840830
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

**new session（新建会话）入口并列提供两种创建类型**：

### 类型 A — New chat thread（现状）
- 在 Kanban 里输入 prompt 创建，transcript / composer 都在 Kanban。
- 可**额外绑定一个 IM 出站通知渠道**：该会话的关键进展（任务完成、进入 review、agent 结束一轮）主动推送到所绑定的飞书 / 钉钉会话。单向（Kanban → IM），不依赖常驻监听或 headless 唤醒。

### 类型 B — New IM thread（新增）
- 创建时**只选择一个 IM 渠道（飞书 / 钉钉的某个群或单聊），无需输入任何内容**即可建立。
- 它的"前端"就是那个 IM 会话：**第一句指令与后续对话都在 IM 里发**，agent 的回复回推 IM。等于把整个 agent 会话搬到 IM 里遥控。
- **关键推论**：因为创建时不输入内容，第一句指令必然来自 IM，故此类型**天然依赖入站能力**（见阶段 2）。没有入站，IM thread 收不到任何指令。

### 平台范围
- **支持飞书（Lark）与钉钉（DingTalk）两家**；两家均具备长连接事件能力，入站对两家统一可行。
- **明确不做微信**：个人微信无官方开放 API，第三方接入违反 ToS；企业微信本轮也排除在范围外。
- IM 应做成**可插拔的渠道抽象**（provider / adapter 按平台 keyed），新增平台是加一个 adapter，而非改造主流程。

## 分阶段（由上面两种类型的依赖自然划分）

- **阶段 1 — chat thread 出站通知绑定**：类型 A 的绑定能力。单向、零常驻依赖，一次渠道抽象同时覆盖飞书 + 钉钉。风险最低，先交付。
- **阶段 2 — New IM thread（双向遥控）**：类型 B 独立创建入口，随入站双向能力一起上线。

## 成功的样子

- new session 入口能看到并列的「New chat thread」与「New IM thread」两个创建类型。
- 阶段 1：类型 A 会话可绑定飞书 / 钉钉渠道，进度自动推送到该 IM 会话；一次抽象覆盖两家。
- 阶段 2：类型 B 不输入内容即可创建；在所绑定 IM 会话里发消息即可驱动该 Kanban 会话并收到 agent 回复。
- 绑定 / 渠道关系随会话持久化；关闭或解绑后推送 / 遥控停止。

## 范围说明与交付注记（非需求本身）

- 绑定 / 渠道信息挂在会话（home thread）上，形如 `imChannel: { platform: 'lark'|'dingtalk', chatId, ... }`，随 thread registry 持久化；类型 B 可用一个标记区分“IM 驱动、无 Kanban composer”。
- 出站两平台形态一致（群机器人 webhook / 发消息 API），是抽象的最小公共面；应优先落地。
- 入站（阶段 2 / 类型 B）需要一个**常驻路由进程**接收 IM 事件并按 chatId→threadId 投递，且要求**会话背后的 agent 能被 headless 唤醒**——飞书 WebSocket / 钉钉 Stream 长连接契合 headless/LAN 形态；这是阶段 2 的核心工程依赖，需单独设计。
- 事件必须**幂等去重**（IM 平台 at-least-once 投递），出站 / 入站都要防重复。
- 身份：群机器人以 bot 身份收发即可覆盖两阶段的群场景；读用户个人资源才需 per-user 授权（扫码 / 授权链接产品化绑定，属另一议题）。
- human-in-the-loop：review / 高风险动作宜用 IM 交互卡片按钮做确认入口（飞书、钉钉均支持交互卡片）。
