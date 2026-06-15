# Provider 协议标签系统重构

## Context

当前 provider 管理存在几个问题：
1. **没有协议概念** — 用户给 Claude Code 选了阿里云 provider（Qwen 协议），Claude Code 拿 Qwen 的 key 请求 Anthropic 端点导致 403
2. **管理入口分散** — provider 创建只在 kanban-setup-section（pi 的设置）里有，agent 选择器里的 "New Provider" 没接通
3. **无法自动获取模型** — 创建 provider 时需要手动输入模型列表

**目标：**
- Provider 标注支持的协议（Anthropic/OpenAI）
- Settings 里加独立 "Providers" 导航项，集中管理所有 provider
- Agent 选择器按协议过滤
- 创建时支持自动 fetch 模型列表

## Task 1: 新建协议类型与工具函数

**新建 `src/agent-sdk/kanban/provider-protocol.ts`**

```ts
export type ProviderProtocol = "anthropic" | "openai";
export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ["anthropic", "openai"];

// Agent → 支持的协议
export const AGENT_PROTOCOL_COMPATIBILITY: Record<string, ProviderProtocol[]> = {
  claude: ["anthropic"], codex: ["openai"], droid: ["anthropic"],
  pi: ["openai"], gemini: [], opencode: ["openai", "anthropic"], kiro: ["anthropic"],
};

// 协议 → env var 名
export const PROTOCOL_ENV_MAP: Record<ProviderProtocol, { baseUrl: string; apiKey: string }> = {
  anthropic: { baseUrl: "ANTHROPIC_BASE_URL", apiKey: "ANTHROPIC_API_KEY" },
  openai:    { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
};

// 内置 provider 的默认协议（迁移用）
export const BUNDLED_PROVIDER_DEFAULT_PROTOCOLS: Record<string, ProviderProtocol[]> = {
  anthropic: ["anthropic"], openai: ["openai"], google: [],
  "amazon-bedrock": ["anthropic"], ollama: ["openai"],
  openrouter: ["openai", "anthropic"], cline: ["openai"],
};

export function resolveProtocolEnvVars(providerProtocols: ProviderProtocol[], agentId: string)
  : { baseUrl: string; apiKey: string } | null
```

## Task 2: Storage 层加 protocols 字段

**修改 `src/agent-sdk/kanban/provider-settings-store.ts`**

- `ProviderSettings` 接口加 `protocols?: ProviderProtocol[]`
- `readStore()` 中自动迁移：无 `protocols` 的 provider 查 `BUNDLED_PROVIDER_DEFAULT_PROTOCOLS`，找不到默认 `["openai"]`

## Task 3: API 合约加 protocols

**修改 `src/core/api-contract.ts`**

- `runtimeKanbanProviderCatalogItemSchema` 加 `protocols: z.array(z.enum(["anthropic","openai"])).default(["openai"])`
- `runtimeKanbanAddProviderRequestSchema` 加 `protocols`（required, default `["openai"]`）
- `runtimeKanbanUpdateProviderRequestSchema` 加 `protocols`（optional）

## Task 4: Service 层传递 protocols

**修改 `src/agent-sdk/kanban/provider-service.ts`**

- `getProviderCatalog()` 构建 catalog item 时加 `protocols` 字段
- `addCustomProvider()` 存 `protocols` 到 settings
- `updateCustomProvider()` 更新 `protocols`

## Task 5: env-injector 用协议解析替代硬编码

**修改 `src/unified-proxy/env-injector.ts`**

- 删除 `AGENT_ENV_MAP` 硬编码
- `buildAgentProviderEnv()` 的 env var 分支改用 `resolveProtocolEnvVars(settings.protocols, agentId)`
- Claude Code settings.json 写入逻辑不变

## Task 6: Settings 加独立 Providers 导航项

**修改 `web-ui/src/components/runtime-settings-dialog.tsx`**

- `SettingsNavId` 加 `"providers"`
- `SETTINGS_NAV_ITEMS` 加 `{ id: "providers", label: "Providers", icon: <Key size={16} /> }`
- 新增 Provider 管理 section：
  - 显示所有 provider 列表（从 catalog 获取）
  - 每个 provider 行显示：名称、协议标签、Base URL、删除按钮
  - "Add Provider" 按钮打开创建对话框
  - 点击 provider 行打开编辑对话框

## Task 7: Provider 创建/编辑对话框重构

**修改 `web-ui/src/components/shared/kanban-add-provider-dialog.tsx`**

- 标题改为通用文案 "Add provider" / "Edit provider"
- `FormState` 加 `protocols: ProviderProtocol[]`
- 新增协议选择区域（OpenAI-compatible / Anthropic-compatible 按钮）
- Base URL 旁加 "Fetch models" 按钮：拼接 `${baseUrl}/models` 自动获取模型列表
- `handleSubmit` 提交 `protocols`

## Task 8: Hook 层接口更新

**修改 `web-ui/src/hooks/use-runtime-settings-kanban-controller.ts`**

- `AddKanbanProviderInput` / `UpdateKanbanProviderInput` 加 `protocols`

## Task 9: Agent Provider 选择器协议过滤

**修改 `web-ui/src/components/shared/agent-provider-selector.tsx`**

- 从 catalog item 读取 `protocols`
- 根据 `AGENT_PROTOCOL_COMPATIBILITY[agentId]` 过滤
- 兼容的 provider 正常显示，不兼容的分组标注 "protocol mismatch"
- "New Provider..." 按钮改为跳转到 Settings 的 Providers 导航项

## Task 10: 自动模型获取 tRPC 端点

**修改 `src/trpc/runtime-api.ts`** + **`web-ui/src/runtime/runtime-config-query.ts`**

- 新增或复用 `fetchProviderModels` tRPC 端点，接受 `baseUrl` + `protocols` 参数
- 后端根据协议选择端点路径（OpenAI: `${baseUrl}/models`，Anthropic: `${baseUrl}/v1/models`）
- 前端 "Fetch models" 按钮调用此端点

## Task 11: 测试更新

- `test/runtime/unified-proxy/env-injector.test.ts` — 更新测试用例适配 protocols
- `test/runtime/agent-sdk/provider-settings-store.test.ts` — 测试迁移逻辑
- 新建 `test/runtime/agent-sdk/provider-protocol.test.ts` — 协议解析工具函数测试

## Verification

1. `bunx tsc --noEmit -p tsconfig.json` 无新增错误
2. `bunx vitest run test/runtime/unified-proxy/env-injector.test.ts` 通过
3. `bunx vitest run test/runtime/agent-sdk/provider-protocol.test.ts` 通过
4. 启动 Kanban → Settings → 左侧有 "Providers" 导航项
5. Providers 页面可添加/编辑/删除 provider
6. Agent 选择器只显示协议兼容的 provider
7. 给 Claude 选 Anthropic 协议 provider → `~/.claude/settings.json` 正确写入
