---
_id: ac99c
type: requirement
_created: 1783323546359
_updated: 1783323546359
priority: medium
status: proposed
title: 会话可绑定 IM 渠道（飞书 / 钉钉），从 IM 侧远程感知与操控 Kanban agent
---
## 谁受影响

用 Kanban 编排 coding agent 的用户，尤其是 **runtime 跑在服务器 / 远程 / LAN、人不在那台机器前**的场景（local-first + 远程访问是 Kanban 的常态）。

## 今天的痛点

要感知或推进一个 agent 会话，用户必须**打开 Kanban 界面盯着**。人在外面、只带手机时：

- 任务完成、agent 有产出、需要 review，**没有任何主动触达**——只能事后回去看板才发现。
- 想给某个会话补一句指令 / 确认，也**必须回到 Kanban UI**，无法从随身的 IM 里完成。

而团队日常沟通本就在飞书 / 钉钉里，Kanban 与这些 IM 之间是断开的。

## 客户需要什么

**新建会话时可选择绑定一个 IM 渠道（某个飞书群/钉钉群或单聊）**，建立会话与 IM 会话的一一对应，从而：

### 阶段 1 — 出站通知绑定（先交付）
- 绑定后，该会话的关键进展（任务完成、进入 review、agent 结束一轮）**主动推送到所绑定的 IM 会话**。
- 用户无需盯着 Kanban，也能随时被动知晓进度。
- 单向（Kanban → IM），不依赖任何常驻监听或 headless 唤醒。

### 阶段 2 — 双向遥控绑定（后续）
- 在所绑定的 IM 会话里发消息 → 作为输入进入对应 Kanban 会话；agent 的回复回推 IM。
- 实现「用手机 IM 远程操控一个 Kanban agent 会话」。

### 平台范围
- **支持飞书（Lark）与钉钉（DingTalk）两家**；两家均具备长连接事件能力，入站对两家统一可行。
- **明确不做微信**：个人微信无官方开放 API，第三方接入违反 ToS；企业微信本轮也排除在范围外。
- IM 应做成**可插拔的渠道抽象**（provider / adapter 按平台 keyed），新增平台是加一个 adapter，而非改造主流程。

## 成功的样子

- 新建会话弹窗有一个「绑定 IM（可选）」入口，可选飞书 / 钉钉的某个群或单聊。
- 阶段 1：绑定后，该会话进度自动出现在所绑定的 IM 会话里；一次渠道抽象同时覆盖飞书与钉钉。
- 阶段 2：能从所绑定的 IM 会话里发消息驱动该 Kanban 会话，并收到 agent 回复。
- 绑定关系随会话持久化；解绑后推送/遥控停止。

## 范围说明与交付注记（非需求本身）

- 绑定信息可挂在会话（home thread）上，形如 `boundImChannel: { platform: 'lark'|'dingtalk', chatId, ... }`，随 thread registry 持久化。
- 出站三平台形态一致（群机器人 webhook / 发消息 API），是抽象的最小公共面；应优先落地，风险最低。
- 入站（阶段 2）需要一个**常驻路由进程**接收 IM 事件并按 chatId→threadId 投递，且要求**会话背后的 agent 能被 headless 唤醒**——飞书 WebSocket / 钉钉 Stream 长连接契合 headless/LAN 形态；这是阶段 2 的核心工程依赖，需单独设计。
- 事件必须**幂等去重**（IM 平台 at-least-once 投递），出站/入站都要防重复。
- 身份：群机器人以 bot 身份收发即可覆盖阶段 1；读用户个人资源才需 per-user 授权（如需，用扫码/授权链接的产品化绑定，属另一议题）。
- human-in-the-loop：review/高风险动作宜用 IM 交互卡片按钮做确认入口（飞书、钉钉均支持交互卡片）。
