---
_id: 9c87a
type: requirement
_created: 1781156024184
_updated: 1781156101848
priority: high
related_tasks:
  - b6e2d
  - a986a
  - 1ce0d
  - bc4da
status: clarified
title: 会话持久化与续聊（统一消息模型，先攻 claude code）
---
目标：重启 Kanban 后能【查看】并【接着聊】之前的 claude code 会话。这是"不同 agent 消息模型统一"的第一步，也是未来飞书聊天桥的地基。

根因（已确认）：CLI agent 输出只在内存终端镜像 terminal-state-mirror.ts（1万行 scrollback），重启即丢；落盘仅 RuntimeTaskSessionSummary 状态；Kanban 未捕获 claude 原生 session id（现有 --continue 仅恢复目录最近会话，不精确）。pi 的 messages 也只在内存（PiMessageStore）。

两个能力：
① 持久化会话记录（查看）——把 pi 的 KanbanTaskMessage[] 提升为 agent 无关的会话消息模型；给 CLI agent 加轻量转录捕获；消息增量落盘到 ~/.kanban/workspaces/<id>/sessions/<taskId>/messages.jsonl；重启后读盘并在侧边栏/任务卡渲染。
② 捕获原生 session id + resume（接着聊）——RuntimeTaskSessionSummary 新增 agentSessionId 并落盘；启动 claude 时用 --session-id <uuid> 主动指定；重启用 --resume <uuid> 续接（注入点 agent-session-adapters.ts 各 adapter 已有 !hasCliOption 检查）。

本期范围：仅 claude code 跑通查看+续聊 + 统一消息模型落盘。
后续（已留缝）：其它 CLI agent 的 resume、home agent 多会话管理、飞书聊天桥。

关键文件：src/agent-sdk/kanban/session-state.ts (KanbanTaskMessage)、pi-task-session-service.ts (PiMessageStore)、src/terminal/session-manager.ts、terminal-state-mirror.ts、agent-session-adapters.ts、src/core/api-contract.ts (RuntimeTaskSessionSummary)、src/state/workspace-state.ts (sessions.json)、src/server/runtime-state-hub.ts (WS 广播)。
