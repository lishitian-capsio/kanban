---
_id: 3b691
type: requirement
_created: 1781164080598
_updated: 1781164146901
priority: high
related_tasks:
  - fb8a7
status: clarified
title: 侧边栏支持多条并行 home 聊天线(产任务不再独苗串行)
---
背景/问题:当前 home(侧边栏)聊天会话每个工作区+agent 只有唯一一条,session id 形如 __home_agent__:<workspaceId>:<agentId>,导致产任务的聊天只有一条独苗、串行——上一轮在跑时无法再开第二条并行聊天继续产任务。服务层(TerminalSessionManager / PiTaskSessionService)本身已是按 taskId 多路复用,任务执行与聊天并不互相阻塞;真正的限制在于 home 会话被设计成单例。

目标(方案 A):把唯一的 home 会话泛化成可管理的集合,支持每个工作区开多条并行的聊天线,各自独立、可同时运行。

关键设计要点:
1) session id 增加线程维度:__home_agent__:<workspaceId>:<agentId>:<threadId>。
2) 新增 home 聊天线注册表/持久化:每条线的 id、所用 agentId、名称、创建时间;重启后仍在(消息已通过 session journal 持久化)。
3) 每条聊天线可各自选择 agent(顺带解决'聊天与任务想用不同 agent'的子需求)。
4) 侧边栏 UI:聊天线列表/标签,支持 新建/切换/重命名/关闭;多条可并行运行。
5) API/contract:列出/创建/关闭 home 聊天线。

默认决定(可改):每条线可独立选 agent=是;重启后保留=是;并行条数不设硬上限(必要时给软提示)。
