# 设计方案：Kanban 需求条目管理（Requirement Items）

> 本文档为**调研 + 方案设计**交付物。不包含实现代码，目标是给出可直接拆分为多个 Kanban task 的实现计划。
> 建议落盘位置：`.plan/docs/requirement-items-design.md`（本计划文件是 plan-mode 工作副本）。

## Context

用户希望在 Kanban 中维护一份独立于 task 卡片的「需求条目」清单（类似 PRD / 需求项），支持增删改查、写描述、设优先级、设生命周期状态。

- **需求条目 ≠ task 卡片**：task 是交给 coding agent 执行的工作单元；需求条目是产品侧的需求记录。
- 后续可能把需求条目关联 / 拆分到 task，但**本期只聚焦需求条目本身的 CRUD 管理**，schema 需为后续关联预留扩展位。

### 已确认的决策（来自用户）
1. **作用域**：按项目 / 工作区（per git-repo workspace），与 task 卡片一致。
2. **UI 形态**：独立『需求』视图（类似现有 Git History 的全屏切换）。
3. **字段**：含生命周期 `status` 字段 + `priority` 枚举。

---

## 1. 数据模型与存储

### 1.1 关键现状（调研结论）
- task 数据是 **JSON 文件持久化**，不是 SQLite。每个 workspace 一个目录 `~/.kanban/workspaces/{workspaceId}/`，内含 `board.json` / `sessions.json` / `meta.json`。
- 持久化抽象在 `src/fs/locked-file-system.ts`（`proper-lockfile` + `writeJsonFileAtomic` + `withLock`）。
- workspace 读写、乐观锁（`revision`）、原子保存都集中在 `src/state/workspace-state.ts`（`loadWorkspaceState` / `saveWorkspaceState` / `mutateWorkspaceState`）。
- 所有契约 schema（Zod）单一来源：`src/core/api-contract.ts`。
- **没有传统 migration 系统**；`meta.json` 只有 `revision`。新数据文件缺失时需在读取层做「默认空值」兜底（向后兼容旧 workspace）。
- ID 生成：`src/core/task-id.ts` 的 `createUniqueTaskId(existingIds, randomUuid)`（5 字符短 ID + 冲突重试）。**直接复用**。

### 1.2 推荐存储方案
新增独立文件 `requirements.json`，与 `board.json` 同目录、同级，但**复用现有 workspace-state 的锁 / revision / 原子写 / WebSocket 广播管线**——物理隔离、机制复用，避免重建一套并发与同步基础设施。

具体做法：把 `requirements` 作为 workspace state 的一个**兄弟字段**（与 `board`、`sessions` 平级），而**不是**塞进 `runtimeBoardDataSchema`（避免污染 board 契约、避免每次 board 改动牵动需求）。

### 1.3 新增 Zod schema（`src/core/api-contract.ts`）
```ts
export const runtimeRequirementPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const runtimeRequirementStatusSchema = z.enum(["draft", "active", "done", "archived"]);

export const runtimeRequirementItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  priority: runtimeRequirementPrioritySchema.default("medium"),
  status: runtimeRequirementStatusSchema.default("draft"),
  // 为后续「关联/拆分到 task」预留，本期不写入也不渲染：
  linkedTaskIds: z.array(z.string()).default([]),
  order: z.number().default(0),          // 手动排序用
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RuntimeRequirementItem = z.infer<typeof runtimeRequirementItemSchema>;

export const runtimeRequirementsDataSchema = z.object({
  items: z.array(runtimeRequirementItemSchema).default([]),
});
```
- 扩展 `runtimeWorkspaceStateResponseSchema` 与 `runtimeWorkspaceStateSaveRequestSchema`，各加一个 `requirements: runtimeRequirementsDataSchema`（用 `.default({ items: [] })` 保证向后兼容）。
- 在 WebSocket 的 `snapshot` / `workspace_state_updated` 消息中已经带 `workspaceState`，因此需求数据会随 state 一起流式下发，无需新增独立 WS 消息类型。

### 1.4 纯函数 mutation（新建 `src/core/requirement-mutations.ts`）
镜像 `src/core/task-board-mutations.ts` 的不可变更新风格：
- `addRequirement(data, input): RuntimeRequirementsData`
- `updateRequirement(data, id, patch): { data, item }`
- `deleteRequirement(data, id): { data, removed }`
- `reorderRequirement(data, id, newOrder)`（可选，UI 排序）

### 1.5 持久化层改动（`src/state/workspace-state.ts`）
- 新增常量 `REQUIREMENTS_FILENAME = "requirements.json"`。
- `readWorkspaceRequirements(workspaceId)`：文件不存在 → 返回 `{ items: [] }`（兼容旧 workspace）。
- 在 `loadWorkspaceState` 聚合返回里带上 `requirements`。
- 在 `saveWorkspaceState` 的锁内、与 board/sessions/meta 一起原子写 `requirements.json`，并参与同一个 `revision` 递增（沿用现有乐观锁，无需第二套版本号）。
- `mutateWorkspaceState` 的回调结果类型扩展，允许返回新的 `requirements`。

---

## 2. CLI 命令设计

### 2.1 现状
- CLI 用 **Commander.js**（`src/cli.ts`）。子命令以 `registerXxxCommand(program)` 注册，业务逻辑在 `src/commands/`。
- 模板就是 `src/commands/task.ts`：通过 tRPC client + `mutateWorkspaceState` 读写，统一 JSON 输出（`printJson`，`{ ok, ... }` / `{ ok:false, error }`），`runTaskCommand()` 包裹错误。

### 2.2 新增 `requirement` 命令组
新建 `src/commands/requirement.ts`，在 `src/cli.ts` 注册 `registerRequirementCommand(program)`，对齐 task 命令风格：

| 命令 | 选项 | 说明 |
|---|---|---|
| `requirement list` | `--project-path`, `--status`, `--priority` | 列出需求（支持按状态 / 优先级过滤）|
| `requirement create` | `--title`(必填), `--description`, `--priority`, `--status`, `--project-path` | 新建，返回带 id 的条目 |
| `requirement update` | `--id`(必填), `--title`, `--description`, `--priority`, `--status` | 局部更新 |
| `requirement delete` | `--id`(必填) | 删除 |
| `requirement show` | `--id`(必填) | 查看单条详情 |

- 别名：`program.command("requirement").alias("req").alias("requirements")`。
- 复用：`resolveRuntimeWorkspace` / `createRuntimeTrpcClient` / `updateRuntimeWorkspaceState` / `notifyRuntimeWorkspaceStateUpdated`（从 task.ts 抽取或直接复用现有导出）。
- 枚举解析：仿照 `parseListColumn` / `parseAgentId` 写 `parsePriority` / `parseStatus`。
- 输出形态与 task 完全一致：`{ ok: true, requirement|requirements, count?, workspacePath }`。

---

## 3. 后端 / runtime 接口设计

### 3.1 现状
- 传输是 **tRPC**（`src/trpc/app-router.ts`），HTTP 在 `src/server/runtime-server.ts`，实时走原生 **WebSocket**（`/api/runtime/ws`）下发 `snapshot` / `workspace_state_updated` 等。
- web-ui 直接用 tRPC proxy client（`web-ui/src/runtime/trpc-client.ts`），无 react-query；状态通过 `web-ui/src/runtime/use-runtime-state-stream.ts` 的 reducer 合并 WS 消息。
- 写路径：`workspace.saveState`（带 `expectedRevision` 乐观锁）→ 持久化 → WS 广播全量 state → 所有客户端刷新。

### 3.2 推荐接口方案：复用 `workspace.saveState`，不新增独立写端点
因为需求随 workspace state 一起读 / 写 / 广播：
- **读**：`workspace.loadState` 自动带回 `requirements`（schema 扩展即可，无新端点）。
- **写**：前端复用现有 `saveWorkspaceState` 流程（把改后的 `requirements` 连同 `board`/`sessions` 一起提交，乐观锁与广播零改动）。
- **实时同步**：WS `snapshot` / `workspace_state_updated` 已携带 `workspaceState`，需求变更天然推送给所有客户端。

> 这样 CLI 与 web-ui 共享同一条写链路与同一份乐观锁，避免两套并发模型不一致。

可选增强（非必须，本期可不做）：若想给 CLI / 外部更细粒度的入口，可在 runtime-api 增加 `createRequirement` / `updateRequirement` / `deleteRequirement` 薄封装，内部仍调用 `mutateWorkspaceState`。**默认不做**，遵循「避免薄壳转发」的架构约定。

---

## 4. web-ui 前端方案

### 4.1 现状
- 单页应用，无 react-router；视图切换靠 `App.tsx` 里的 state 条件渲染（如 `isGitHistoryOpen ? <GitHistoryView/> : <KanbanBoard/>`）。
- UI 栈：Tailwind v4 + Radix + lucide-react + sonner；primitives 在 `web-ui/src/components/ui/`；设计 token 在 `globals.css @theme`。
- 状态：React state + `useSyncExternalStore` 自定义 store + WS reducer，无 zustand/redux。

### 4.2 推荐：独立『需求』全屏视图（对比与理由）

| 方案 | 利 | 弊 |
|---|---|---|
| **A. 独立视图（推荐）** | 与 task 看板解耦，符合「独立实体」定位；有充足空间做列表+详情+过滤；不挤占看板 | 需新增一个 top-bar 入口与一处视图切换 |
| B. 集成进看板侧栏 | 改动小、上下文集中 | 与 task 抢空间；CRUD 交互局促；概念上把两个独立实体糅在一起 |

→ 采用 **A**。在 `top-bar.tsx` 增加「需求 / Requirements」入口按钮（lucide 图标，如 `ListChecks`），在 `App.tsx` 增加 `isRequirementsOpen` state，仿 `isGitHistoryOpen` 模式切换到 `<RequirementsView/>`。

### 4.3 UI 结构示意
```
RequirementsView (全屏，替换 KanbanBoard 区域)
├── 顶部工具条：标题 + [新建需求] 按钮(primary) + 过滤器(status / priority 下拉)
├── 左侧 RequirementList（可滚动）
│   └── RequirementRow ×N
│       ├── 优先级色点(status-* token: urgent→red, high→orange, medium→blue, low→tertiary)
│       ├── 标题 + 状态徽章(draft/active/done/archived)
│       └── hover 操作: 编辑 / 删除
└── 右侧 RequirementDetailPanel（选中时）
    ├── 标题(可编辑) + 优先级下拉 + 状态下拉
    ├── 描述（多行 textarea，Markdown 友好）
    └── [保存] / [删除(AlertDialog 确认)]
```

### 4.4 新增组件与文件（`web-ui/src/`）
- `components/requirements/requirements-view.tsx` — 视图容器（布局 + 过滤 state）
- `components/requirements/requirement-list.tsx` + `requirement-row.tsx`
- `components/requirements/requirement-detail-panel.tsx`
- `components/requirements/requirement-form-dialog.tsx`（新建用 `Dialog`）
- `hooks/use-requirements.ts` — 封装读（从 workspaceState 取 `requirements`）与写（复用 `saveWorkspaceState` 链路 + 乐观更新）的领域逻辑
- 复用现有 primitives：`Button` / `Dialog` / `AlertDialog` / `Tooltip` / Radix `Select`、`cn`、设计 token（`bg-surface-*`、`text-text-*`、`status-*`）。删除确认用 `AlertDialog`，操作反馈用 `sonner` toast。

### 4.5 类型
`web-ui/src/types/board.ts` / `runtime/types.ts` 已是从 `api-contract` re-export，新增的 `RuntimeRequirementItem` 等类型同样从 `api-contract` 透出，前端不重复定义。

---

## 5. 实现任务拆分与依赖图

### 任务清单
- **T1 — 数据层与契约**（基础，阻塞其余全部）
  - `api-contract.ts` 新增 requirement schema + 扩展 workspace state 读/写契约
  - 新建 `src/core/requirement-mutations.ts`
  - `src/state/workspace-state.ts` 增加 `requirements.json` 读/写（含旧 workspace 兜底）+ 纳入 revision/原子写
  - 单测：mutations 纯函数、读取缺失文件兜底、save/load round-trip
- **T2 — CLI 命令**（依赖 T1）
  - 新建 `src/commands/requirement.ts`（list/create/update/delete/show）+ 在 `cli.ts` 注册
  - 单测/手测 JSON 输出契约
- **T3 — 后端接口验证**（依赖 T1；工作量很小）
  - 确认 `workspace.loadState` / `saveState` 带 requirements 正常往返
  - 确认 WS `snapshot` / `workspace_state_updated` 携带 requirements
  - （可选）runtime-api 细粒度封装——默认不做
- **T4 — web-ui 视图**（依赖 T1 + T3）
  - `use-runtime-state-stream` reducer / App state 接住 `requirements`
  - top-bar 入口 + App 视图切换
  - RequirementsView / List / DetailPanel / FormDialog + `use-requirements` hook
  - 走 `saveWorkspaceState` 写链路（乐观更新 + 冲突回退）

### 依赖图
```
            ┌─────────────┐
            │ T1 数据层/契约 │  (基础，最先做)
            └──────┬──────┘
        ┌──────────┼───────────┐
        ▼          ▼           ▼
   ┌────────┐ ┌────────┐  ┌──────────┐
   │ T2 CLI │ │ T3 后端 │  │          │
   └────────┘ └───┬────┘  │          │
                  └───────►│ T4 web-ui │
                           └──────────┘
```
- T1 完成后，**T2 / T3 可并行**。
- T4 依赖 T1（类型）与 T3（确认端点往返），是收口任务。
- 关联 / 拆分到 task 的能力**不在本期**，schema 已预留 `linkedTaskIds`。

---

## 6. 验证方式（端到端）
1. **数据层**：`npm test`（或项目对应命令）跑 T1 新增单测；手动在一个新 workspace 与一个**旧**（无 `requirements.json`）workspace 上各跑一次 `loadWorkspaceState`，确认兜底为空数组、无报错。
2. **CLI**：
   - `kanban requirement create --title "X" --priority high` → 校验返回 `{ ok:true, requirement:{ id, ... } }`
   - `kanban requirement list --status draft` → 校验过滤
   - `update` / `show` / `delete` 往返；确认对应 `requirements.json` 落盘且 `meta.json` revision 递增。
3. **后端 / 同步**：起 runtime，CLI 改一条需求 → 确认已连接的 web-ui 通过 WS 自动刷新（无需手动 reload）。
4. **web-ui**：打开『需求』视图，新建 / 编辑 / 改优先级与状态 / 删除（AlertDialog 确认）；确认乐观更新 + 落盘 + 多客户端同步；样式符合 dark 主题与 `status-*` token。

---

## 7. 关键复用点（避免重复造轮子）
- ID：`src/core/task-id.ts` 的 `createUniqueTaskId`
- 不可变 mutation 风格：`src/core/task-board-mutations.ts`
- 锁/原子写：`src/fs/locked-file-system.ts`
- 读写/乐观锁/广播：`src/state/workspace-state.ts`（`saveWorkspaceState`/`mutateWorkspaceState`）
- CLI 模板：`src/commands/task.ts`（`printJson` / `runTaskCommand` / workspace 解析）
- 视图切换模板：`App.tsx` 的 `isGitHistoryOpen` + `GitHistoryView`
- 契约单一来源：`src/core/api-contract.ts`（前端 re-export，不重复定义类型）
