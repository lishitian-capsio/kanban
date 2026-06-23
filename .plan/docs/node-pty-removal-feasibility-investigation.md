# node-pty Removal Feasibility Investigation

Date: June 23, 2026

> **OUTCOME (decided & implemented, June 23, 2026):** The original investigation
> below concluded "cannot remove" *because the Electron desktop app was the one
> Node-runtime consumer*. The user then confirmed **the desktop app is not being
> shipped**, which removes the only reason to keep a Node runtime. We therefore
> **removed node-pty and deleted the `packages/desktop` Electron package**, making
> **Bun the sole runtime**. See "Implementation" at the bottom for exactly what
> changed. The body below is preserved as the rationale for *why* the desktop app
> was the deciding factor.

Goal of the task: remove `node-pty` (the project's last native-compiled dependency) so
terminal / agent spawning uses only Bun's native `Terminal` API
(`Bun.spawn(..., { terminal })`). The mandate was **investigate first, conclude, and only
delete if feasible** — do not blindly remove.

## Conclusion (decision)

**Do NOT remove `node-pty`. It is still required.**

The shipped product (the Electron desktop app) runs the Kanban runtime **under Node, not
Bun**. Bun's native `Terminal` API does not exist under Node, so `node-pty` is the *only*
PTY backend on the production distribution path. Removing it would leave
`PtySession.spawn` with **no backend under Node** and break terminal / CLI-agent
spawning entirely in the packaged desktop app.

This is the explicit "仍需 Node、不能移除" branch of the task: stop at the conclusion,
keep `node-pty`, and record the reason (this document).

## Why — the dual-runtime distribution model

Kanban runs the *same* `dist/cli.js` bundle under **two different runtimes**:

| Path | Runtime | PTY backend |
|------|---------|-------------|
| Dev / direct CLI (`bun src/cli.ts`) | **Bun** | Bun native `Terminal` (preferred) |
| Shipped Electron desktop app | **Node** (Electron) | **`node-pty`** (only option) |

The bundle is deliberately built to be runtime-agnostic. `scripts/build.mjs`:

```js
const external = ["node-pty", "bun:sqlite", "bun", "ws"];
// ...
platform: "node",
target:   "node22",
```

Both the Bun-only modules (`bun`, `bun:sqlite`) **and** `node-pty` are externalized — the
single bundle is meant to load whichever set its host runtime provides. `node-pty` is the
Node-side counterpart to Bun's `Terminal`; they are not redundant, they cover two
different runtimes.

### Evidence the desktop app is a Node runtime

1. **It spawns the CLI as a Node subprocess.**
   `packages/desktop/src/runtime-child.ts` spawns the staged shim and documents:
   > "The runtime hosts all agent sessions, message repositories, and **PTY processes**
   > in one **Node process**" — and sets `--max-old-space-size` (a V8 / Node flag).

2. **The launch shim runs `node`, not `bun`.**
   `packages/desktop/test/cli-shim.test.ts` asserts the macOS/Linux shim contains
   `exec node` and `cli/cli.js`, the Windows shim contains `node` + `cli\cli.js`, and that
   it prefers the **bundled Electron binary via `ELECTRON_RUN_AS_NODE=1`** over system
   node. No `bun` anywhere in the shim. There is no Bun binary bundled in the desktop app.

3. **The packaged bundle is staged as a Node ESM module.**
   `packages/desktop/scripts/stage-cli.mjs` copies `dist/` → `cli/` and drops a
   `{ "type": "module" }` package.json so **Node** treats `cli.js` as ESM.

4. **node-pty's native binding is unpacked specifically for the packaged Node runtime.**
   `packages/desktop/scripts/patch-node-pty.mjs` (run in desktop `postinstall` alongside
   `electron-builder install-app-deps`) patches node-pty's `unixTerminal.js` for the
   asar-unpacked layout. `packages/desktop/package.json` lists `node-pty` as a real
   dependency. This entire machinery exists *only* because the desktop runtime uses
   node-pty.

### What the runtime does at spawn time

`src/terminal/pty-session.ts` `PtySession.spawn`:

- `checkBunTerminalAvailable()` → `isBunRuntime()` checks `typeof globalThis.Bun !==
  "undefined"`. Under Node/Electron this is **false**, so the Bun branch is skipped.
- It then falls through to the `node-pty` branch (`pty.spawn(...)`).

So under the desktop's Node runtime, the node-pty branch is the **live** code path, not a
dead fallback. Deleting it removes the only backend that runtime has.

## On Bun-native API coverage (the contract the Bun path already satisfies)

For completeness, the Bun native path already meets the `PtySession` contract on the Bun
runtime, including the Windows `.cmd`/`.bat` shim wrapping (修法 A) added in
`src/core/windows-cmd-launch.ts` and wired through `resolveWindowsCmdLaunch` in
`pty-session.ts`:

- **spawn**: `Bun.spawn(argv, { cwd, env, terminal: { cols, rows, data } })`
- **resize**: `proc.terminal.resize(cols, rows)`
- **write**: `proc.terminal.write(...)`
- **kill / interrupt**: `proc.kill()` + POSIX process-group `process.kill(-pid, SIGTERM)`
- **exit code / signal**: `await proc.exited` + `proc.signalCode` mapped to a numeric signal
- **Windows .cmd shim**: routed through `cmd.exe /d /s /c "..."` via `buildWindowsCmdArgsArray`

Gaps vs node-pty on the Bun path are minor and already accepted: `pause()`/`resume()` are
no-ops (Bun has no flow-control equivalent), and pixel-dimension resize is dropped. These
are non-issues *for the Bun runtime* — but none of this changes the conclusion, because
**the desktop ships on Node**, where the Bun API is simply absent.

## What would have to change before node-pty could ever be removed

This is recorded so a future reader knows the precondition, not as a recommendation:

- The Electron desktop app would have to run the runtime under **Bun** instead of Node
  (e.g. bundle/spawn a Bun binary, or Electron would have to expose Bun's `Terminal`
  API — it does not). That is a substantial distribution change spanning
  `packages/desktop` (shim, stage-cli, electron-builder packaging, asar handling) and the
  `bun:sqlite`/`bun` externals, and it is out of scope for this task.

Until that happens, `node-pty` stays.

## Items intentionally left untouched

Because the conclusion is "keep node-pty", the following from the task's step 2 were **not**
done, by design:

- node-pty backend + static `import * as pty from "node-pty"` in `pty-session.ts` — **kept**
- `node-pty` in `package.json` / `packages/desktop/package.json` — **kept**
- `KANBAN_FORCE_NODE_PTY` test switch (`pty-session.ts` `isNodePtyForced`) — **kept**; it
  still has meaning (lets Bun-hosted tests exercise the node-pty backend that production
  Node desktop builds rely on, e.g. `test/runtime/terminal/pty-session.test.ts`).
- The node-pty patch/unpack machinery in `packages/desktop/` — **kept**.

## Implementation (what actually changed)

Once the desktop app was dropped, removal touched these surfaces:

**Runtime — collapsed to the Bun backend only**
- `src/terminal/pty-session.ts`: deleted the `import * as pty from "node-pty"`, the
  entire node-pty backend, and its helpers (`attachIgnorablePtyWriteErrorHandler`,
  `PtyErrorSocket`/`PtyInternalSockets`, `terminatePtyProcess`, `isNodePtyForced`).
  `PtySession` now wraps a single `BunTerminalProcess`. The public contract is
  unchanged (`spawn`/`pid`/`write`/`resize`/`pause`/`resume`/`stop`/`wasInterrupted`,
  `onData`/`onExit`). **New behavior:** if the Bun Terminal API is unavailable,
  `spawn` now *throws* (`"Bun native Terminal API is unavailable — Kanban must run
  under Bun…"`) instead of falling back. `pause()`/`resume()` are documented no-ops
  (Bun has no flow-control equivalent); pixel-dimension resize args are accepted but
  ignored. The Windows `.cmd`/`.bat` cmd.exe wrapping (修法 A) is preserved — it is
  now the only launch-rewrite path (argv form via `buildWindowsCmdArgsArray`).
- `src/core/windows-cmd-launch.ts`: removed `buildWindowsCmdArgsCommandLine` (the
  single-string commandLine form was only consumed by the node-pty backend; Bun uses
  the argv-array form).

**Build / deps**
- `package.json`: dropped the `node-pty` dependency; `install:all` no longer installs
  `packages/desktop`.
- `scripts/build.mjs`: removed `node-pty` from esbuild `external` (now
  `["bun:sqlite", "bun", "ws"]`).
- `package-lock.json`: regenerated (node-pty entries gone).

**Desktop package — deleted**
- Removed the entire `packages/desktop/` Electron package (and the now-empty
  `packages/`), including its `node-pty` dependency, the `patch-node-pty.mjs`
  asar-unpack machinery, the CLI shim, and electron-builder packaging.
- `.github/workflows/test.yml`: removed the desktop install/typecheck/test steps, the
  `packages/desktop/node_modules` cache entry, and the macOS Python/node-gyp pin
  (node-pty was the last native addon, so there is no longer anything to compile).
- `.github/workflows/build-release.yml`: removed the now-dead "Install desktop
  dependencies (if exists)" step (the release pipeline builds the npm tgz, not a DMG).
- `.gitignore`: removed the `packages/desktop/*` artifact entries (kept `/kanban-*.tgz`,
  which is `npm pack` output).

**Tests — moved to the Bun-only contract** (the suite runs `bun vitest run` locally and
`npx vitest run` under Node in CI; both work because the tests inject a fake
`globalThis.Bun` rather than depending on a real one)
- `vitest.config.ts`: removed the `KANBAN_FORCE_NODE_PTY = "1"` shim (the flag no longer
  exists in the code).
- `test/runtime/terminal/pty-session.test.ts`: rewritten to exercise the Bun backend
  (launch argv incl. Windows wrapping, onData Buffer delivery, write/resize delegation
  and error-ignoring, exit code + signal mapping, kill, pause/resume no-ops).
- `test/runtime/terminal/pty-session-unavailable.test.ts`: new — asserts `spawn` throws
  when `globalThis.Bun` is absent (own file because availability is memoized per module).
- `test/runtime/terminal/pty-session-bun-backend.test.ts`: deleted (merged in).
- `test/runtime/terminal/session-manager-auto-restart.test.ts`: unchanged — it mocks
  `PtySession` wholesale, so it never touches a backend.

**Verification:** `npm run build` succeeds (bundle has no node-pty external);
`npm run typecheck` adds **zero** new errors vs. the pre-existing baseline; the reworked
PtySession/windows-cmd-launch/session-manager tests pass **30/30**. (The repo-wide
typecheck baseline and the `ws-server`/`agent-session-adapters` terminal test failures
are pre-existing and unrelated — verified by re-running against the unmodified HEAD.)

## Key files referenced

- `src/terminal/pty-session.ts` — dual-backend `PtySession` (Bun preferred, node-pty fallback)
- `src/core/windows-cmd-launch.ts` — shared Windows `.cmd`/`.bat` launch wrapping (修法 A)
- `scripts/build.mjs` — node22 bundle, `node-pty`/`bun`/`bun:sqlite`/`ws` externalized
- `packages/desktop/src/runtime-child.ts` — spawns the runtime as a Node subprocess
- `packages/desktop/test/cli-shim.test.ts` — proves the shim runs `node` / Electron-as-node
- `packages/desktop/scripts/stage-cli.mjs` — stages the bundle as a Node ESM module
- `packages/desktop/scripts/patch-node-pty.mjs` — unpacks node-pty's native binding for asar
