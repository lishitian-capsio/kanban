# Home Thread IM Channel Binding — UI (设计)

- Date: 2026-07-06
- Depends on: **T4** (imChannel data model + tRPC bind/unbind/query) — already merged.
- Requirement: **ac99c** (类型 A:chat thread + 出站通知绑定).
- Scope: **frontend only, zero backend change.** Reuses T4's three endpoints as-is.

## 目标

在 new session / 新建会话弹窗加一个「绑定 IM(可选)」入口:选平台(飞书/钉钉)→ 填写群/单聊
的平台原生 chatId → 写入 `thread.imChannel`。已绑定态可展示并解绑。同时在已存在会话的 kebab
菜单里提供绑定/解绑管理。遵循 web-ui 设计规范(Radix 原语 + Tailwind 设计 token,dark theme)。

## 关键约束(来自 T4 现状)

- 绑定描述符只有 `ImChannelTarget = { platform: "lark" | "dingtalk", chatId: string }`。
- **后端没有列出/搜索群或单聊的能力**:provider 无 `listChats`,无 discovery tRPC,且运行时
  可能尚未注册任何 provider(foundation-only)。因此交互采用**粘贴 chatId + 类型推断**,不做
  实时会话列表选择器(那需要新后端,超出 T4)。
- tRPC(均在 `runtime.*`,输入/输出见 T4):
  - `bindHomeThreadImChannel({ id, channel })` → `{ ok, thread, error? }`
  - `unbindHomeThreadImChannel({ id })` → `{ ok, thread, error? }`
  - `getHomeThreadImChannel({ id })` → `{ ok, imChannel, error? }`(本设计**不使用**,因为本地
    thread 状态已带 `imChannel`)。
- 类型:web-ui 从 `@runtime-contract` 已能拿到 `RuntimeHomeChatThread`(含 `imChannel`)与
  `RuntimeHomeChatThreadBindImChannelRequest`。`ImChannelTarget` 类型未单独 re-export,故在 web-ui
  用 `RuntimeHomeChatThreadBindImChannelRequest["channel"]` 派生;平台联合用其 `["platform"]`。
  **无需新增后端 export。**

## 数据流

### 新建会话
- `HomeThreadCreateDialog` 本地维护 `imChannel: ImChannelTarget | null`(打开时随其它字段重置)。
- 提交时经 `onCreate` 透传 `imChannel`。`createThread`(`use-home-threads.ts`)先跑
  `createHomeThread`(不变),成功后若 `imChannel` 非空,再调 `bindHomeThreadImChannel`,并把返回的
  `thread` 合并进本地 `registryThreadsByWorkspace`。
- **绑定失败不回滚会话创建**:只 `notifyError`,会话已存在(可通过 kebab 补绑)。这样避免改动
  T4 的 `createHomeThread` 契约,符合「依赖 T4」与 YAGNI。

### 已存在会话
- kebab 菜单新增「绑定 IM」按钮 → 打开 `ImChannelBindDialog`。
- 已绑定 → 展示 chip +[解绑](`unbindThreadImChannel`)+ 可选重新绑定 picker。
- 未绑定 → picker +[绑定](`bindThreadImChannel`)。
- 两个 mutation 成功后更新本地 `registryThreadsByWorkspace` 里对应 thread 的 `imChannel`,失败
  `notifyError`。

## 组件(新增,`web-ui/src/components/im/`)

### `im-channel.ts`(纯函数,单测覆盖)
- 类型别名:
  - `ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"]`
  - `ImPlatform = ImChannelTarget["platform"]`
- `IM_PLATFORM_LABELS: Record<ImPlatform, string> = { lark: "飞书", dingtalk: "钉钉" }`
  (用 `Record<ImPlatform, …>` 保证编译期覆盖所有平台;options 由 `Object.entries` 派生)。
- `describeImChannel(target: ImChannelTarget): { platformLabel: string; kindLabel: string }`
  - 镜像后端 `inferLarkReceiveIdType`(`src/im/lark/lark-message-format.ts`):
    - lark:`oc_`→「群聊」、`ou_`→「单聊」、`on_`→「union」、含 `@`→「邮箱」、其余→「群聊」。
    - dingtalk:通用「群」标签(webhook 机器人无 chatId 类型概念)。
  - 逻辑与后端一致,但**在 web-ui 复制**(约 5 行的展示映射,不跨端 import 后端)。
- `inferLarkKindLabel(chatId: string): string`(供 picker 输入时实时提示,dingtalk 不调用)。

### `im-channel-picker.tsx`(受控)
- Props:`value: ImChannelTarget | null`、`onChange: (v: ImChannelTarget | null) => void`、
  `disabled?: boolean`。
- 渲染:Radix `Select`(平台,样式参照 `vault/views/vault-property-controls.tsx`)+ chatId 文本
  输入(样式参照 composer 输入 token)+ 实时识别类型提示行 + 帮助文案(「飞书群设置→更多→复制群 ID」)。
- 行为:chatId 非空 → `onChange({ platform, chatId })`;chatId 清空 → `onChange(null)`。平台切换保留
  已输入的 chatId。
- chatId 非空时提供一个清除(X)affordance → `onChange(null)`。

### `im-channel-chip.tsx`(展示)
- Props:`channel: ImChannelTarget`、`onUnbind?: () => void`、`className?`。
- 紧凑展示 `飞书 · 群聊 · oc_…`(截断),右侧 `X` 解绑按钮(有 `onUnbind` 时)。镜像
  `prompt-attachments/prompt-attachment-chips.tsx` 的 chip 样式与可访问性(`aria-label`)。

### `im-channel-bind-dialog.tsx`(已存在会话的绑定/解绑弹窗)
- Props:`open`、`onOpenChange`、`thread: HomeThread`、`onBind: (channel) => Promise<void>`、
  `onUnbind: () => Promise<void>`。
- 内容:
  - 已绑定 → `ImChannelChip`(带解绑)+ 分隔 + 「重新绑定」`ImChannelPicker` +[更新绑定]。
  - 未绑定 → `ImChannelPicker` +[绑定]。
- 用 `@/components/ui/dialog` 的 `Dialog/DialogHeader/DialogBody/DialogFooter`,`Button` 主/次样式。
- 提交/解绑期间 disable,完成后 `onOpenChange(false)`。

## 改动(现有文件)

### `web-ui/src/components/home-agent/home-thread-create-dialog.tsx`
- 新增 `imChannel` state(`useState<ImChannelTarget | null>(null)`),在 open 的 reset effect 里
  置 `null`。
- `DialogBody` 内 Agent 区块之后新增「绑定 IM(可选)」区:`<span>` 标签 + `<ImChannelPicker>`。
- `onCreate` 输入类型新增 `imChannel?: ImChannelTarget | null`;`handleSubmit` 里透传
  `imChannel: imChannel ?? undefined`。

### `web-ui/src/hooks/use-home-threads.ts`
- `createThread` 输入新增 `imChannel?: ImChannelTarget | null`;`UseHomeThreadsResult.createThread`
  的签名同步更新。create 成功后若 `imChannel` 非空:
  - 调 `runtime.bindHomeThreadImChannel.mutate({ id: created.id, channel: imChannel })`;
  - `ok && thread` → 用返回 thread 合并本地状态(替换刚插入的那条);否则 `notifyError`(不抛,会话保留)。
- 新增 `bindThreadImChannel(threadId, channel): Promise<void>` 与
  `unbindThreadImChannel(threadId): Promise<void>`:调对应 tRPC,成功后 `map` 更新
  `registryThreadsByWorkspace` 里该 thread 的 `imChannel`,失败 `notifyError`。跳过
  `DEFAULT_HOME_THREAD_ID`(合成默认线程不可绑定)。
- 在返回对象里导出这两个方法。

### `web-ui/src/components/home-agent/home-sidebar-agent-panel.tsx`
- 给 `HomeThreadBar` 透传 `onBindThreadImChannel={homeThreads.bindThreadImChannel}` 与
  `onUnbindThreadImChannel={homeThreads.unbindThreadImChannel}`。

### `web-ui/src/components/home-agent/home-thread-bar.tsx`
- 新增 props:`onBindThreadImChannel`、`onUnbindThreadImChannel`。
- 新增 state `imChannelTarget: HomeThread | null`(镜像 `renameTarget`/`closeTarget`)。
- 每个非默认线程的 `DropdownMenu.Item` 行动区,在 Rename(Pencil)前/后加一个「绑定 IM」按钮
  (Lucide 图标,如 `Radio`/`Send`/`MessageCircle`,`size={12}`,样式沿用现有 action button;已绑定
  时图标着重色以示状态),`onClick` → `stopPropagation` + `setMenuOpen(false)` + `setImChannelTarget(thread)`。
- 渲染 `<ImChannelBindDialog>`,`onBind`/`onUnbind` 包装 `onBindThreadImChannel(target.id, …)` /
  `onUnbindThreadImChannel(target.id)`(镜像现有 rename/close 弹窗的挂载方式)。

## 测试

- `im-channel.test.ts`(vitest):`describeImChannel`/`inferLarkKindLabel` 各分支(oc_/ou_/on_/@/
  其它、dingtalk)、`IM_PLATFORM_LABELS` 覆盖联合。
- picker:渲染 + 输入 chatId 触发 `onChange({platform, chatId})`、清空触发 `onChange(null)`、
  识别类型提示随输入更新(沿用现有 dialog/组件测试模式,聚焦不铺开)。
- 新建弹窗绑定流:mock `onCreate`,断言带 `imChannel` 透传(轻量,不重复 hook 层)。

## 设计 token / 规范

- Radix `Select`/`Dialog`/`DropdownMenu` 原语,Lucide 图标(12–16px)。
- `bg-surface-{0..4}`、`text-text-{primary,secondary,tertiary}`、`border-border{,-bright,-focus}`、
  `rounded-{sm,md,lg}`、`accent`/`status-*`。始终 dark theme,无 `dark:` 前缀。
- chip 镜像 `prompt-attachment-chips.tsx`;Select 镜像 `vault-property-controls.tsx`;弹窗镜像
  `home-thread-rename-dialog`/`home-thread-close-dialog` 的挂载与关闭语义。

## 明确不做(YAGNI)

- 不做实时会话列表/搜索选择器(需新后端)。
- 不改 `createHomeThread` tRPC 契约(用 create 后补绑)。
- 不加 IM 凭证配置 UI(独立议题)。
- 不使用 `getHomeThreadImChannel`(本地 thread 已带 `imChannel`)。
- 不触碰后端 `src/im/`、`src/core/api-contract.ts`。
