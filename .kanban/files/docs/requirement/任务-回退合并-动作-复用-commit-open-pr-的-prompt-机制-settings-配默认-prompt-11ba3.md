---
_id: 11ba3
type: requirement
_created: 1783046135355
_updated: 1783059975191
priority: medium
status: clarified
title: 任务「回退合并」动作：复用 commit/open PR 的 prompt 机制，Settings 配默认 prompt
---
## 谁受影响

使用 Kanban 编排 coding agent 的用户（本人反馈）。

## 今天的痛点

用户反馈澄清后的精确需求：

> 有些任务卡片**已经执行了合并**（把任务分支的改动并进了代码分支）。当这次合并不该发生 / agent 改坏了，我需要一个动作，让它把这次合并**回退掉**。

现状：改动已经落到代码分支上，`/rewind`（只回退对话）救不了——要撤销的是**已完成的那次合并本身**，目前没有产品化入口。

## 实现方式（关键方向：不走「硬控」）

**不做**后端硬编码的 git 回退逻辑（不写死 revert/reset 的确定性按钮）。而是**复用 commit / open PR 那一套 prompt 驱动机制**：

- 「回退合并」和 commit / open PR 一样，是一个**由 prompt 驱动、交给 agent 执行**的整合类动作。触发时把对应 prompt 发给 agent，由 agent 完成回退。
- 在 **Settings 里提供一个可编辑的默认 prompt**（就像 commit / open PR 的 prompt 那样），用户可按需改写。默认 prompt 描述期望行为即可，不把 git 命令写死在代码里。
- 实现应**镜像现有 commit / open PR 的 prompt / Settings 落点**（同样的配置位置、同样的下发路径），保持一致、避免另起一套。

> 建议默认 prompt 的意图（写进 prompt 文本，非硬编码）：以**非破坏性**方式撤销该任务合并进代码分支的改动（倾向 `git revert -m 1 <mergeCommit>` 保留历史；已 push 时尤其如此），不静默丢数据、回退前状态可找回。

## 成功的样子

- 「回退合并」动作放在**现有 commit / open PR 旁边**——同属「整合」动作区，回退是其逆操作，同处一区最易发现。
- 触发后按**可配置的默认 prompt** 让 agent 执行回退合并，无需用户手动敲 git。
- **Settings** 里能看到并编辑这条默认 prompt，机制与 commit / open PR 的 prompt 一致。
- 行为可预期、不静默丢数据（由默认 prompt 的意图保证）。

## 范围说明

本需求聚焦**撤销已完成的合并**，且**采用 prompt 驱动 + Settings 默认 prompt** 的方式（非硬控）。相邻但不同的问题：对话回退（`/rewind` 已覆盖）、合并前把 worktree 回退到检查点、看板状态回退（误删/误移列）。
