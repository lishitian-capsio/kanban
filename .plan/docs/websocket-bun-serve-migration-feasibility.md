# WebSocket: `node ws` → `Bun.serve` native WebSocket — Feasibility & Migration Plan

Status: **Research only. No runtime code changed.**
Date: 2026-07-02
Scope: evaluate migrating the WebSocket layer from the node `ws` package (running on `node:http`) to `Bun.serve`'s native WebSocket, its feasibility, risks, benefits, and a phased plan.

---

## 0. TL;DR

- **The task's premise is partly wrong, and that changes the whole calculus.** tRPC in this codebase is **HTTP-only** (`@trpc/server/adapters/standalone` server-side, `httpBatchLink` client-side). There are **no tRPC subscriptions and no tRPC ws adapter**. So "can `Bun.serve` native WS carry tRPC subscriptions" is moot — nothing to carry. The WS surface is **three bespoke, hand-written channels**, not tRPC.
- **Bun native WS is not a drop-in swap of `ws-server.ts`.** Bun's native WebSocket only exists **inside `Bun.serve`**; it cannot attach to a `node:http` server. Because our HTTP server *is* `node:http` (`createServer`/`createHttpsServer`), migrating WS **forces migrating the entire HTTP stack** — tRPC adapter, static asset serving, passcode/CORS/Host middleware, MCP OAuth callback, TLS — onto `Bun.serve`. That is the real blast radius.
- **Benefits are real but concentrated:** higher throughput on the hot `task_chat_message` token fan-out, native server-side **pub/sub** that can replace hand-rolled `Set<WebSocket>` fan-out, built-in heartbeat/idle-timeout, and elimination of the `ws` esbuild-external CJS-wrap hazard already documented in `scripts/build.mjs`.
- **The single highest-risk piece is backpressure.** The terminal I/O flow control (`src/terminal/ws-server.ts`) reaches into node `ws` internals — the raw `_socket` for `"drain"` events, plus `ws.bufferedAmount` — to implement VS Code-style pause/resume across multiple viewers of one PTY. Bun exposes analogous primitives (`getBufferedAmount()`, the `drain(ws)` callback, `send()` return value) but the mapping is non-trivial and must be re-verified against real PTY floods.
- **Recommendation:** worth doing, but **not as one migration**. Do it in phases, and **only if** we either (a) want the throughput/pub-sub win badly enough on the chat hot path, or (b) want to kill the `ws` external/CJS-wrap fragility. Otherwise the status quo is fine. See §7.

---

## 1. Current architecture (what actually exists)

### 1.1 The HTTP server is `node:http`, not `Bun.serve`

`src/server/runtime-server.ts`:

```ts
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
...
const server = tlsConfig
  ? createHttpsServer({ key, cert }, requestHandler)
  : createServer(requestHandler);
```

`requestHandler` is a classic `(req: IncomingMessage, res: ServerResponse)` handler that dispatches:

- passcode session issue / gate (cookie + bearer)
- MCP OAuth callback
- `/api/trpc/*` → `await trpcHttpHandler(req, res)` (the standalone node-http tRPC handler)
- other `/api/*` → 404
- everything else → static asset serving (`readAsset` → `res.writeHead/​end`)

**Consequence:** the whole request path is coupled to node `IncomingMessage`/`ServerResponse`. Any move to `Bun.serve` means rewriting this dispatcher against the Fetch `Request`/`Response` model.

### 1.2 tRPC is HTTP request/response only

- Server: `createHTTPHandler({ router, createContext })` — a node-http handler. No `applyWSSHandler`, no `@trpc/server/adapters/ws`.
- Client (`web-ui/src/runtime/trpc-client.ts`): a single `httpBatchLink`. No `wsLink`, no `splitLink`, no `createWSClient`.
- A codebase-wide grep for `subscription`/`observable`/`applyWSSHandler`/`createWSClient` finds only unrelated hits (agent-sdk internals, doc comments).

So **all realtime push is bespoke JSON over raw WebSockets**, not tRPC.

### 1.3 The three bespoke WebSocket channels

All use node `ws`'s `WebSocketServer({ noServer: true })` + manual `handleUpgrade`:

| Path | Owner | Purpose | Traffic profile |
|------|-------|---------|-----------------|
| `/api/runtime/ws` | `src/server/runtime-state-hub.ts` | Workspace-scoped state stream: initial `snapshot`, then deltas — `projects_updated`, `workspace_state_updated`, `workspace_metadata_updated`, **`task_chat_message` (streaming tokens — the hot path)**, `task_sessions_updated`, `task_ready_for_review`, `board_sync_status_updated`, `runtime_metrics_updated`, `mcp_auth_updated`, `kanban_session_context_updated`, `task_chat_cleared`, `error`. | Highest fan-out; token bursts. Server→client push only. |
| `/api/terminal/io` | `src/terminal/ws-server.ts` | Raw PTY bytes both directions (keystrokes up, output down). Binary. | High-volume, backpressure-sensitive. |
| `/api/terminal/control` | `src/terminal/ws-server.ts` | Control frames: `resize`, `stop`, `output_ack`, `restore_complete` (up); `state`, `exit`, `restore`, `error` (down). | Low volume. |

Client sockets (all plain browser `WebSocket`):
- `web-ui/src/runtime/use-runtime-state-stream.ts` — one socket to `/api/runtime/ws`, with exponential-backoff reconnect (`scheduleReconnect`, `STREAM_RECONNECT_*`).
- `web-ui/src/terminal/persistent-terminal-manager.ts` — `connectIo()` + `connectControl()`, `binaryType = "arraybuffer"`, per-`clientId` so multiple tabs viewing one PTY don't evict each other. On close it does **not** auto-reconnect the IO socket — it surfaces `"Terminal stream closed. Close and reopen to reconnect."` (see the `terminal-reconnect-after-hardkill` memory / follow-up).

### 1.4 The upgrade / dispatch flow (node `ws`)

`runtime-server.ts` registers **two** `server.on("upgrade", …)` handlers plus a catch-all:

1. First handler: Host/CORS gate (`handleSocketUpgrade`), then if path is `/api/runtime/ws`, apply the **passcode gate** (session cookie OR internal bearer), mark `request.__kanbanUpgradeHandled = true`, and call `runtimeStateHub.handleUpgrade(...)`.
2. `createTerminalWebSocketBridge` (`ws-server.ts`) registers its **own** `server.on("upgrade")` that handles `/api/terminal/io` and `/api/terminal/control`, re-runs the Host/CORS gate + passcode `validateUpgradeSession`, marks handled, and calls `targetServer.handleUpgrade(...)`.
3. Third handler: if `__kanbanUpgradeHandled` is still unset, `socket.destroy()`.

Inside each, the pattern is the node `ws` idiom:

```ts
wss.handleUpgrade(request, socket, head, (ws) => {
  wss.emit("connection", ws, context); // context carried manually
});
```

Per-connection context (`taskId`, `workspaceId`, `clientId`, `terminalManager`, or `requestedWorkspaceId`) is threaded through the `emit("connection", ws, context)` call.

### 1.5 Node `ws` internals we depend on

Grep for the leaky abstractions (`src/terminal/ws-server.ts`, `src/server/runtime-state-hub.ts`):

- **`ws.bufferedAmount`** — read to decide pause (`OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES`) / resume (`_LOW_WATER_MARK_`).
- **`(ws as … )._socket`** (`getWebSocketTransportSocket`) — the raw node `Socket`, used to `.once("drain", …)` / `.removeListener("drain", …)` for prompt resume, and `socket.setNoDelay(true)` on `connection`/`upgrade`.
- **`ws.readyState` / `ws.OPEN`** — guard every send.
- **`ws.send(Buffer | string)`** — binary chunks (terminal) and JSON strings (state/control).
- **`ws.terminate()`** — hard close on shutdown.
- **`ws.close(code, reason)`** — replace-by-newer-tab, error close.
- **`WebSocketServer({ noServer: true })` + `handleUpgrade` + `emit("connection")`** — the manual upgrade path.
- **`server.on("connection", (socket: net.Socket) => socket.setNoDelay(true))`** — TCP tuning at the raw socket level, plus tracking `activeSockets` for forced destroy on shutdown.

### 1.6 The existing `ws`/esbuild friction (documented)

`scripts/build.mjs` externalizes `ws`:

```
// `ws` is externalised because Bun's `node:http` upgrade handling does not
//   work with esbuild's CJS-wrapped `ws` package (WebSocket upgrades hang).
const external = ["bun:sqlite", "bun", "ws", "bun-pty"];
```

This is exactly the "esbuild-ws CJS 包装的坑" the task references. Migrating to Bun native WS removes `ws` from the dependency set and deletes this externalization footgun.

---

## 2. What `Bun.serve` native WebSocket requires

Bun 1.3.14 (our pinned floor: `engines.bun >= 1.3.14`). Native WS shape:

```ts
Bun.serve({
  port, hostname,
  tls,                       // { key, cert } — replaces createHttpsServer
  fetch(req, server) {
    // ALL http + the upgrade decision happens here.
    if (isWsPath(req)) {
      const ok = server.upgrade(req, { data: { kind, taskId, workspaceId, clientId } });
      if (ok) return undefined;         // upgraded — do not return a Response
      return new Response("…", { status: 401 });
    }
    return handleHttp(req);             // must return a Response
  },
  websocket: {
    // ONE handler object for the whole server — multiplex on ws.data.kind
    open(ws)  { /* ws.data is the { kind, … } from upgrade() */ },
    message(ws, msg) { /* string | Buffer */ },
    drain(ws) { /* backpressure relief — replaces the _socket "drain" listener */ },
    close(ws, code, reason) {},
    // built-ins:
    idleTimeout,               // seconds; auto ping/pong keepalive
    maxPayloadLength,
    backpressureLimit, closeOnBackpressureLimit,
    publishToSelf,
    perMessageDeflate,
  },
});
```

Key differences from node `ws`:

| Concern | node `ws` (today) | `Bun.serve` native |
|---------|-------------------|--------------------|
| Attaches to | any `node:http` server via `noServer` + `handleUpgrade` | **only `Bun.serve`** (owns the port) |
| Per-connection context | passed via `emit("connection", ws, ctx)`, stored in closures | `ws.data` set at `server.upgrade(req, { data })` |
| Multiple paths | one `WebSocketServer` per path | **one `websocket` handler** for the whole server → dispatch on `ws.data.kind` |
| Send | `ws.send(bufferOrString)` | `ws.send(data)` returns `-1` (backpressured) / `0` (dropped, closing) / `>0` bytes |
| Backpressure signal | `ws.bufferedAmount` + raw `_socket` `"drain"` event | `ws.getBufferedAmount()` + `drain(ws)` callback + send() return value |
| Raw socket / `setNoDelay` | `ws._socket.setNoDelay(true)` | **not exposed**; Bun manages TCP options internally |
| Fan-out / broadcast | manual iterate `Set<WebSocket>` + `ws.send` | native pub/sub: `ws.subscribe(topic)` / `server.publish(topic, data)` (or keep manual) |
| Heartbeat | none server-side | `idleTimeout` + automatic ping/pong |
| Hard close | `ws.terminate()` | `ws.terminate()` (abrupt) / `ws.close(code, reason)` |
| Upgrade auth | in `on("upgrade")` before `handleUpgrade` | in `fetch()` before `server.upgrade()` |

tRPC over Bun: `@trpc/server/adapters/fetch` **is present** in the installed `@trpc/server@11` (`node_modules/@trpc/server/dist/adapters/fetch`). So the tRPC handler can move from `createHTTPHandler` (node req/res) to `fetchRequestHandler` (Request→Response) with no version bump.

---

## 3. Feasibility per goal

### 3.1 tRPC subscriptions / bidirectional streaming over Bun WS

**Not applicable as posed.** We do not use tRPC subscriptions. If we ever *wanted* them, `@trpc/server/adapters/ws` expects a node `ws` `WebSocketServer` and is **not** compatible with Bun's native WS out of the box (as of tRPC 11). There is no first-party "tRPC + Bun native WS" adapter today; you would hand-write a bridge or keep `ws` just for tRPC. **But we don't need any of this** — realtime is bespoke JSON, and should stay bespoke.

### 3.2 Can Bun native WS carry our three bespoke channels?

**Yes, mechanically.** All three are plain send/receive of strings/buffers with per-connection state. Bun's `ws.data` cleanly replaces the `emit("connection", ws, ctx)` context threading. Multiplexing three paths through one `websocket` handler via `ws.data.kind` is straightforward. The state-hub fan-out maps naturally onto Bun pub/sub (topic per workspace, and per-`taskId` for chat) — potentially *simpler and faster* than the current `Set` iteration.

The friction is **not** the channels themselves; it's (a) the forced HTTP-stack migration (§4) and (b) backpressure (§5.5).

---

## 4. Blast radius: WS migration drags the whole HTTP server

Because Bun native WS lives only inside `Bun.serve`, and `Bun.serve` must own the listening port, **you cannot run Bun native WS alongside the existing `node:http` server**. Everything on that port moves together:

1. **tRPC** — `createHTTPHandler(req,res)` → `fetchRequestHandler({ req, router, createContext, endpoint })`. Context builder currently reads node `req` (headers, cookies) — must read `Request.headers` instead. The stall-watchdog breadcrumb (`markStall("trpc", …)`) stays.
2. **Static assets** — `readAsset` + `res.writeHead/end` → return `new Response(asset.content, { headers })`. Bun also has `Bun.file()` fast-path if desired.
3. **Passcode** — session issue (`Set-Cookie`), the gate (cookie + bearer), rate-limit, all currently written against `req/res`. Rewrite against `Request`/`Response` + `Headers`. The **upgrade** passcode gate moves into `fetch()` before `server.upgrade()`.
4. **Host/CORS middleware** (`src/server/middleware.ts`) — `handleHttpRequest`/`handleSocketUpgrade` take `IncomingMessage`/`ServerResponse`/`Duplex`. The **pure** evaluators (`evaluateCors`, `evaluateHost`, `buildAllowedHostHeaders`, `buildAllowedOrigins`) are already framework-agnostic and unit-tested — **those stay**. Only the thin req/res adapters get rewritten. This is the cleanest part.
5. **MCP OAuth callback** (`handleMcpOauthCallback`) — returns a `{statusCode, body}` already; trivial to wrap in `Response`.
6. **TLS** — `createHttpsServer({key,cert})` → `Bun.serve({ tls: { key, cert } })`.
7. **Shutdown** — `server.close()` + `activeSockets` destroy → `server.stop(true)` (Bun) which closes connections. The `ws.terminate()` loops become `server.stop()` + per-`ws` close.
8. **`server.address()`** — used to derive the bound port after `listen(0)`. `Bun.serve` returns `server.port`/`server.hostname` synchronously — actually *simpler*.

**Net:** the mechanical HTTP rewrite is moderate and mostly well-typed (Request/Response are standard). The pure middleware core is reusable. The risk is concentrated in tRPC context, passcode cookie semantics, and WS backpressure.

---

## 5. Risk register

### 5.1 Connection lifecycle & context
- **Risk:** `ws.data` is set once at `upgrade()`; you cannot mutate the identity later the way closures capture it today. **Mitigation:** put the immutable identity (`kind`, `taskId`, `workspaceId`, `clientId`) in `ws.data`; keep mutable per-viewer state in the existing server-side maps keyed by that identity (as `ws-server.ts` already does with `TerminalStreamState`/`TerminalViewerState`). Low risk.
- **Risk:** one `websocket` handler for all channels → a dispatch bug could cross-wire terminal and state streams. **Mitigation:** discriminated `ws.data.kind`; unit-test the dispatcher.

### 5.2 Heartbeat / reconnect (see `terminal-reconnect-after-hardkill`)
- Today: **no server-side ping**; client reconnects with backoff (state stream) or shows "closed, reopen" (terminal IO).
- Bun `idleTimeout` + auto ping/pong is a **net improvement** (detects half-open sockets we currently don't). **Risk:** a too-low `idleTimeout` kills idle-but-healthy terminal sessions. **Mitigation:** set generous `idleTimeout` (e.g. 120s) and rely on auto-ping; verify the client reconnect path still fires on Bun-initiated closes; preserve close codes/reasons the client switches on.

### 5.3 Passcode / Host validation
- Moves from `on("upgrade")` to `fetch()` pre-`upgrade()`. **Risk:** subtle cookie-parsing / bearer differences (`extractSessionTokenFromCookie`, `validateSession`, `validateInternalToken`) when reading from `Request.headers.get("cookie")` vs node `req.headers.cookie`. **Mitigation:** those helpers are pure string parsers — feed them the header string from either source; add a test that the same cookie authorizes under both. Low-moderate risk.
- **Risk:** `server.upgrade()` returning `false` must produce the right 401 (parity with the current `HTTP/1.1 401` raw write). **Mitigation:** return `new Response(null, { status: 401 })`.

### 5.4 Broadcast fan-out
- Today: iterate `runtimeStateClientsByWorkspaceId.get(ws)` `Set<WebSocket>` and `client.send(JSON)`; a per-`taskId` chat batcher already collapses token bursts (`task-chat-message-batcher.ts`, 50ms) — **keep that regardless**.
- Bun **pub/sub** (`ws.subscribe(`ws:${workspaceId}`)`, `server.publish(topic, json)`) can replace the `Set` iteration and is implemented in native code (faster, less GC). **Risk:** our filtering is finer than one topic — workspace-scoped *and* per-`taskId` chat *and* process-global (ops metrics). **Mitigation:** model topics as `ws:${workspaceId}`, `chat:${workspaceId}:${taskId}`, and a global `runtime:*`; subscribe/unsubscribe on connect/close and on workspace switch. Or **defer pub/sub** and keep the `Set` iteration in phase 1 (lowest risk), adopt pub/sub in a later phase as the perf win.

### 5.5 Backpressure — **highest risk**
The terminal IO flow control (`createIoOutputState`) is VS Code-style and leaky:
- reads `ws.bufferedAmount` for high/low-water decisions,
- listens on the **raw `_socket` `"drain"`** event for prompt resume,
- also tracks `unacknowledgedOutputBytes` via the client `output_ack` control frames (this half is transport-agnostic and **stays**),
- pauses/resumes the shared PTY across multiple viewers (`backpressuredViewerIds`).

Bun mapping:
- `ws.bufferedAmount` → `ws.getBufferedAmount()`.
- raw `_socket` `"drain"` → the `drain(ws)` **websocket handler callback** (fires when the socket drains below the backpressure limit). This is a *different shape* (one central callback vs per-socket listener), so `checkResumeAfterBackpressure`/`scheduleResumeCheck` must be re-architected to route from the central `drain(ws)` to the right viewer via `ws.data`.
- `send()` return value (`-1` = backpressured) gives an *additional*, more direct pause signal than reading `bufferedAmount` after the fact.
- `setNoDelay` is gone — Bun manages Nagle internally; need to confirm interactive-latency parity (the `LOW_LATENCY_*` immediate-send path assumes `TCP_NODELAY`).

**This is the piece most likely to regress** (terminal feels laggy, or floods the browser). It needs a dedicated port + a real "cat a huge file in the PTY" stress test on both a fast and a throttled client, on macOS and Linux. It is also the most unit-testable-in-isolation piece if we keep the ack-based half unchanged and only swap the buffered/drain half.

### 5.6 Binary framing
- Terminal IO is binary (`binaryType = "arraybuffer"` client-side; `ws.send(Buffer)` server-side). Bun `ws.send(Uint8Array/Buffer)` sends binary; strings send text. **Risk:** low — parity is direct. Verify the client still receives `ArrayBuffer` (it decodes via `decodeTerminalSocketChunk`).

### 5.7 Test harness
- Existing tests use node `ws` semantics and (per AGENTS.md) run under both `bun vitest` and `npx vitest` (Node CI). **Risk:** Bun native WS **cannot run under Node CI** — any test that boots the real server WS would become Bun-only. **Mitigation:** keep the pure logic (dispatch, backpressure decisions, topic routing) in framework-free modules with vitest coverage under Node; gate the live-socket integration tests to Bun only (precedent exists: pi persistence is Bun-round-trip tested, `bun-pty` uses injected fakes). This mirrors the `pty-session` two-backend testing approach.

### 5.8 The `handleSocketUpgrade`/`__kanbanUpgradeHandled` chain
- Three cooperating `on("upgrade")` handlers + a sentinel flag disappear entirely — Bun has one `fetch()` that decides. This is a **simplification**, but it means the terminal bridge and the state hub can no longer register upgrade handling independently; they must expose a `tryUpgrade(req, server)` the single `fetch()` calls in order. Moderate refactor of the seam between `runtime-server.ts`, `runtime-state-hub.ts`, and `ws-server.ts`.

---

## 6. Expected performance & benefits

Rough expectations (order-of-magnitude, to be measured, not promised):
- **Chat token fan-out** (the hottest path): Bun's native `send`/`publish` avoids the `ws` JS framing overhead and per-send GC pressure. Combined with existing 50ms batching, expect meaningfully lower main-loop time per token burst and lower RSS churn — this is where the `bun-event-loop-busywait-freeze` / `perf-terminal` work has shown the runtime is most sensitive.
- **Terminal throughput:** native binary send should match or beat `ws`; the win depends on getting backpressure right (§5.5). Neutral-to-positive if done carefully; negative if rushed.
- **Fewer moving parts:** drop the `ws` dependency and its esbuild externalization; delete the `_socket` reach-through; delete the sentinel-flag upgrade chain; gain built-in heartbeat.
- **Simpler fan-out** if pub/sub is adopted.

Benefits that are certain regardless of perf numbers:
1. Removes the documented `ws` + esbuild CJS-wrap footgun (`scripts/build.mjs`).
2. Removes reliance on undocumented `ws` internals (`_socket`).
3. Aligns with the "Bun-only runtime, no Node fallback" direction already established (node-pty removal, `#!/usr/bin/env bun`).

---

## 7. Recommendation & phased plan

**Recommendation:** Worth doing for the codebase-health + chat-throughput reasons, but it is a **HTTP-stack migration**, not a WS swap — size it accordingly (est. **3–6 focused days** incl. tests and stress-testing, dominated by §5.5 backpressure and §5.3 passcode parity). **Do not** attempt it as a single big-bang PR. If neither the throughput win nor the `ws` footgun is currently painful, this is a legitimate **"later"** — the current stack works.

Phased plan (each phase independently shippable / revertible):

- **Phase 0 — De-risk in isolation (no behavior change).**
  - Extract the transport-agnostic cores that are already close: backpressure decision logic (buffered/ack water-mark math), the upgrade auth predicates, and the fan-out topic model. Add vitest coverage. This makes the later swap mechanical and Node-CI-safe.

- **Phase 1 — Move HTTP to `Bun.serve`, keep `ws` for WebSockets *if possible*.**
  - *Reality check first:* verify whether node `ws` `handleUpgrade` can run against a `Bun.serve`-owned socket. It likely **cannot** (Bun.serve doesn't emit node `upgrade`), which means Phase 1 and Phase 2 collapse into one. If confirmed impossible, skip to Phase 2. Document the finding.
  - Migrate tRPC → `fetchRequestHandler`, static assets → `Response`, passcode/CORS/Host adapters → Request/Response (reusing the pure evaluators), TLS → Bun `tls`, shutdown → `server.stop()`. Ship with realtime still on… (see caveat above).

- **Phase 2 — WebSockets to Bun native.**
  - Single `websocket` handler multiplexing the three channels on `ws.data.kind`.
  - Port the state-hub first (server→client push only; **lowest** backpressure risk). Keep `Set`-iteration fan-out initially.
  - Port terminal control (low volume).
  - Port terminal IO **last**, with the dedicated backpressure re-architecture (§5.5) and a PTY-flood stress test on macOS + Linux, fast + throttled client.
  - Update the client only where close-code/reconnect semantics differ (should be minimal — the client already uses the standard browser `WebSocket`).

- **Phase 3 — Adopt native pub/sub (optional perf follow-up).**
  - Replace `Set<WebSocket>` iteration with `subscribe`/`publish` topics (`ws:${workspaceId}`, `chat:${workspaceId}:${taskId}`, global). Measure before/after on the chat hot path.

- **Cross-cutting:** delete `ws` from deps + `scripts/build.mjs` external once Phase 2 lands; keep live WS integration tests Bun-only; keep pure logic Node-CI-covered.

---

## 8. Open questions to resolve before committing

1. **Can `ws.handleUpgrade` work on a `Bun.serve` socket at all?** (Determines whether Phase 1 can be independent.) Strong prior: **no**.
2. Does Bun native WS `drain(ws)` + `getBufferedAmount()` give us **fast enough** resume for interactive terminals without `setNoDelay`? (Stress test.)
3. Does `fetchRequestHandler` reproduce the exact tRPC context we build from node `req` (headers, cookies, workspace-id header)? (Parity test.)
4. Any consumer that depends on the current `Set-Cookie`/`SameSite=Strict`/`Secure` passcode cookie flags behaving identically under `Bun.serve`'s `Response`? (Remote-mode passcode test.)
5. `idleTimeout` value that keeps idle terminals alive but reaps half-open sockets — and confirmation the client reconnects on Bun-initiated idle close.

---

## 9. Files in scope (for whoever implements)

Server:
- `src/server/runtime-server.ts` — HTTP server creation, `requestHandler`, all `on("upgrade")` handlers, passcode gate, shutdown.
- `src/server/runtime-state-hub.ts` — state-stream WS, fan-out, `handleUpgrade`.
- `src/terminal/ws-server.ts` — terminal IO/control WS, **backpressure** (`_socket`, `bufferedAmount`).
- `src/server/middleware.ts` — Host/CORS (pure core reusable; req/res adapters rewritten).
- tRPC context builder (createContext) wherever it reads node `req`.
- `scripts/build.mjs` — drop `ws` external after migration.

Client (should need minimal change):
- `web-ui/src/runtime/use-runtime-state-stream.ts` — reconnect/backoff.
- `web-ui/src/terminal/persistent-terminal-manager.ts` — IO/control sockets, ack/backpressure client half.

Reusable as-is: `evaluateCors`, `evaluateHost`, `buildAllowedHostHeaders`, `buildAllowedOrigins`, `task-chat-message-batcher.ts`, the `output_ack`-based half of terminal flow control.
