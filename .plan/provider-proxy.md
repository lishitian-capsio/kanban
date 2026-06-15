# Agent 级 Provider 配置 + Network Proxy 即时生效

## Context

**需求 1**: 每个 agent 有独立的 provider 配置层。Provider 是全局池（增删改查），每个 agent 可以关联多个 provider（官方固定 + 用户额外添加），并选择当前使用的。

**需求 2**: Network Proxy 配置修改后，已运行的所有 agent（包括 CLI agent）即时生效，无需重启 session。

## 架构概览

```
┌─ Provider 池（全局）─────────────────────────────┐
│  Anthropic, OpenAI, 自定义-阿里云, 自定义-xxx     │
│  增删改查: provider-settings-store.ts             │
└────────────────────┬─────────────────────────────┘
                     │ 引用
┌─ Agent 配置层（per agent）───────────────────────┐
│                                                  │
│  Claude Code:                                    │
│    官方: Anthropic (固定)                         │
│    额外: [自定义-阿里云] (用户关联)               │
│    当前选中: Anthropic                            │
│                                                  │
│  Codex:                                          │
│    官方: OpenAI (固定)                            │
│    额外: [自定义-xxx]                             │
│    当前选中: OpenAI                               │
│                                                  │
│  Pi:                                             │
│    官方: Kanban managed                           │
│    额外: [OpenAI, 自定义-阿里云]                  │
│    当前选中: Kanban managed                       │
│                                                  │
└──────────────────────────────────────────────────┘

┌─ Network Proxy ──────────────────────────────────┐
│  改配置 → 即时生效（所有 agent）                  │
└──────────────────────────────────────────────────┘
```

## 部分 1: Agent 级 Provider 配置层

### 数据模型

```typescript
// agent-provider-config.ts (新建)
interface AgentProviderConfig {
  agentId: string;                          // "claude" | "codex" | "pi" | ...
  availableProviders: string[];             // provider id 列表（从全局池引用）
  selectedProvider: string;                 // 当前选中的 provider id
  officialProvider?: string;                // 官方 provider id（固定，不可删）
}
```

存储: `~/.kanban/settings/agent_providers.json`
```json
{
  "agents": {
    "claude": {
      "availableProviders": ["anthropic", "custom-aliyun"],
      "selectedProvider": "anthropic",
      "officialProvider": "anthropic"
    },
    "codex": {
      "availableProviders": ["openai", "custom-xxx"],
      "selectedProvider": "openai",
      "officialProvider": "openai"
    }
  }
}
```

### 存储层

```typescript
// src/agent-sdk/kanban/agent-provider-config.ts (新建)

export async function getAgentProviderConfig(agentId: string): Promise<AgentProviderConfig>;
export async function saveAgentProviderConfig(config: AgentProviderConfig): Promise<void>;
export async function addProviderToAgent(agentId: string, providerId: string): Promise<void>;
export async function removeProviderFromAgent(agentId: string, providerId: string): Promise<void>;
export async function selectAgentProvider(agentId: string, providerId: string): Promise<void>;
```

内存缓存 + 即时写入（同 `provider-settings-store.ts` 模式）。

### 注入方式

每个 agent spawn 时，根据自身配置决定注入方式：

| Agent | 官方 provider | 额外 provider 注入 |
|---|---|---|
| Claude Code | `ANTHROPIC_API_KEY` 直连 | 启动 auth-gateway 实例（Anthropic→目标协议翻译），`ANTHROPIC_BASE_URL` 指向它 |
| Codex | `OPENAI_API_KEY` 直连 | `OPENAI_BASE_URL` 指向兼容端点，或 auth-gateway |
| Pi | 已有 provider 体系 | 直接通过 `pi-provider-config.ts` 的 provider settings |

**额外 provider 需要协议翻译时**（如 Claude Code 用 OpenAI 兼容 provider）：
- 启动一个**轻量 auth-gateway 实例**（仅做协议翻译，不做凭证管理）
- `ANTHROPIC_BASE_URL` → auth-gateway → 读取选中的 provider 配置 → 转发到 OpenAI 兼容端点
- 这个 auth-gateway 实例是 per-agent-session 的，跟着 session 生命周期走

**不需要翻译时**（如额外 provider 本身就是 Anthropic 兼容的）：
- 直接改 `ANTHROPIC_BASE_URL` 指向该 provider 的 baseUrl

### UI 交互

在 agent 设置或 task 创建时：
- 显示该 agent 可用的 provider 列表
- 用户可以添加全局池中的其他 provider 到该 agent
- 用户可以移除额外 provider（官方不可移除）
- 选中当前要用的 provider

## 部分 2: Network Proxy 即时生效

### 问题

当前 CLI agent 的 `HTTP_PROXY` 在 spawn 时注入，之后不可变。改 Network Proxy 后已运行的 CLI agent 不生效。

### 方案: 本地代理桥接

```
CLI agent
  │ HTTP_PROXY=127.0.0.1:<port> (spawn 时注入，不变)
  ▼
Local Proxy (轻量 HTTP/CONNECT 代理)
  │ 每次请求时动态读取 RuntimeProxyState holder
  ▼
出境代理 or 直连
```

**原理**: env vars 的值不变（指向本地代理），但代理内部每次请求时读取最新配置。

### 实现

```typescript
// src/unified-proxy/network-bridge.ts (新建)

export function startNetworkBridge(): { url: string; close(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const proxyState = getRuntimeProxyState();  // 动态读取
      if (proxyState.enabled && proxyState.proxyUrl) {
        return forwardViaProxy(req, proxyState.proxyUrl);
      }
      return forwardDirect(req);
    }
  });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop() };
}
```

CONNECT 隧道同理：
```typescript
function handleConnect(req, clientSocket, head) {
  const { host, port } = parseConnectTarget(req.url);
  const proxyState = getRuntimeProxyState();
  if (proxyState.enabled && !shouldBypass(host, proxyState.noProxy)) {
    tunnelViaProxy(proxyState.proxyUrl, host, port, clientSocket, head);
  } else {
    tunnelDirect(host, port, clientSocket, head);
  }
}
```

### 集成

spawn CLI agent 时：
- 如果 Network Proxy 启用 → `HTTP_PROXY` 指向 network bridge
- 如果 Network Proxy 未启用 → 不设 `HTTP_PROXY`（或指向直连 bridge）

进程内请求继续走 `installProxyFetch()`（已有 holder 即时生效机制，无需改动）。

## 新建文件

```
src/agent-sdk/kanban/agent-provider-config.ts    # Agent 级 provider 配置
src/unified-proxy/network-bridge.ts              # Network Proxy 即时生效桥接
```

## 修改的现有文件

- `src/agent-sdk/kanban/provider-settings-store.ts` — 不变，Agent 配置层引用它
- `src/terminal/agent-session-adapters.ts` — spawn 时读 agent provider 配置，决定 `*_BASE_URL`
- `src/terminal/session-manager.ts` — 传递 network bridge URL
- `src/config/proxy-env.ts` — `buildProxyEnvVars` 改为指向 network bridge
- `src/cli.ts` — 启动 network bridge
- `src/agent-sdk/ai/auth-gateway/server.ts` — 可能需要支持轻量模式（per-session 实例）

## Task 1: Agent Provider Config 存储层

**文件**: `src/agent-sdk/kanban/agent-provider-config.ts`

- 数据模型 `AgentProviderConfig`
- 存储: `~/.kanban/settings/agent_providers.json`
- 内存缓存 + 即时写入
- API: get/save/add/remove/select

## Task 2: Agent spawn 时注入 provider

**文件**: `src/terminal/agent-session-adapters.ts`

spawn 时：
1. 读取 `getAgentProviderConfig(agentId)`
2. 根据 `selectedProvider` 获取 provider 设置
3. 如果是官方 provider → 直连（现有逻辑）
4. 如果是额外 provider → 判断是否需要协议翻译
   - 需要: 启动轻量 auth-gateway，`*_BASE_URL` 指向它
   - 不需要: 直接 `*_BASE_URL` = provider.baseUrl

## Task 3: Network Bridge

**文件**: `src/unified-proxy/network-bridge.ts`

- 轻量 HTTP 代理 + CONNECT 隧道
- 每次请求动态读取 `getRuntimeProxyState()`
- `startNetworkBridge()` / `stopNetworkBridge()`

## Task 4: 集成到 spawn 流程

**文件**: `src/terminal/session-manager.ts`, `src/config/proxy-env.ts`

- `buildProxyEnvVars` 改为指向 network bridge URL
- 如果没有启用 Network Proxy，bridge 做直连转发

## Task 5: UI — Agent Provider 选择

- Agent 设置界面显示可用 provider 列表
- 添加/移除/选择 provider

## 验证方式

1. `npm run typecheck` — 编译通过
2. `npm run test` — 现有 + 新增测试
3. 手动:
   - 给 Claude Code 添加额外 provider → spawn → 验证走额外 provider
   - 改 Network Proxy → 验证 CLI agent 即时生效
   - 切换 agent 的 selected provider → 验证下次 spawn 用新的
