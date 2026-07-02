# Backend bundling: esbuild → Bun.build

**Date:** 2026-07-02
**Status:** Approved (design)
**Scope:** Build toolchain only. No runtime/`src` behavior change. web-ui (Vite/rolldown) out of scope.

## Goal

Replace esbuild with Bun's native bundler (`Bun.build`) for the two backend
entry points (`dist/cli.js`, `dist/index.js`) to:

1. Speed up the backend build.
2. Eliminate the `ws` CJS-wrapping workaround (esbuild wraps `ws` as CJS, which
   makes `node:http` WebSocket upgrades hang, so `ws` is currently forced
   external). Bun's bundler handles `ws` correctly with `target: "bun"`, so `ws`
   can be bundled and the workaround removed.

## Current state (confirmed)

- `scripts/build.mjs` is the **only** esbuild consumer; esbuild is referenced
  nowhere else in the repo.
- The build runs `node scripts/build.mjs`, producing `dist/cli.js` (+ shebang +
  Sentry `module` banner hack) and `dist/index.js`, both ESM, external
  `["bun:sqlite", "bun", "ws", "bun-pty"]`, with OTEL env vars baked in via
  `define`, external sourcemaps, and a `.md`/`.html` text loader.
- A `strip-import-attributes` esbuild plugin strips `with { type: "text" }`
  because esbuild 0.27.x doesn't support import attributes.
- All 15+ `.md`/`.html` text imports in `src/` use `with { type: "text" }`; none
  rely on a bare loader. Bun supports the attribute natively.
- Runtime is **Bun-only** (`#!/usr/bin/env bun`, `engines.bun >= 1.3.14`), so
  `target: "bun"` is correct — and is exactly what makes bundled `ws` work.
- `bufferutil` / `utf-8-validate` (ws's optional native addons) are **not
  installed**; ws `require()`s them inside try/catch and falls back to pure JS.
- The full `build` npm script also runs `web:build`, copies `web-ui/dist/*` into
  `dist/web-ui`, uploads Sentry sourcemaps (`scripts/upload-sentry-sourcemaps.mjs`),
  and `chmod +x dist/cli.js`. These stages are unchanged except the bundler step.

## Approach

Rewrite `scripts/build.mjs` to use the global `Bun.build(...)` API and run it via
`bun scripts/build.mjs`. Chosen over the `bun build` CLI because we need
per-entry banners (cli gets the shebang + Sentry `module` hack; index gets none)
and the programmatic OTEL `define` map — both awkward as CLI flags. Two separate
`Bun.build` calls, mirroring the current two-build structure.

### Option mapping (esbuild → Bun.build)

| esbuild | Bun.build |
|---|---|
| `platform: "node", target: "node22"` | `target: "bun"` (key change; fixes `ws`) |
| `format: "esm"` | `format: "esm"` |
| `bundle: true, packages: "bundle"` | default (bundles all non-external) |
| `sourcemap: true` | `sourcemap: "linked"` (external `.map` + comment) |
| `external: ["bun:sqlite","bun","ws","bun-pty"]` | `["bun:sqlite","bun","bun-pty","@xterm/headless","@xterm/addon-serialize"]` — **drop `ws`** (Bun handles it natively under `target:"bun"`), add the two `@xterm` packages (see below) |
| `define: { ...OTEL... }` | same `define` |
| `loader: { ".md":"text", ".html":"text" }` | keep (belt-and-suspenders; import attributes are primary) |
| `strip-import-attributes` plugin | **removed** (Bun handles `with { type: "text" }`) |
| per-build `outfile` | `outdir: "dist"` + `naming: "[name].js"` (entries `cli`/`index` → `dist/cli.js`/`dist/index.js`) |
| `banner.js` (shebang + module hack) | `banner` string, cli entry only |

### `external` rationale

- `bun:sqlite`, `bun` — Bun-specific, cannot be bundled.
- `bun-pty` — Windows-only PTY backend; loads a prebuilt native FFI lib by a path
  relative to its own node_modules location, so bundling would break resolution.
  Only dynamically imported on win32 (see `src/terminal/pty-session.ts`).
- `@xterm/headless`, `@xterm/addon-serialize` — **new externals, required by
  `target:"bun"`.** Neither ships an `exports` map; both put a browser build in
  `module` and the real Node/headless build in `main`. `target:"bun"` prefers
  `module`, so it bundled the wrong build (and `@xterm/addon-serialize`'s `.mjs`
  has no default export, which hard-errored the build). Externalizing them defers
  resolution to the **Bun runtime**, which picks the correct headless build —
  exactly as `bun src/cli.ts` does in dev. Both are runtime `dependencies`.
- `ws` — **no longer listed.** esbuild had to be told `ws` was external to avoid
  its CJS-wrapping (which hung upgrades). Under `target:"bun"` Bun leaves the
  `ws` import for its own native handling automatically, so no entry is needed and
  the workaround is gone. Verified: WebSocket upgrade connects in ~15ms and
  receives the state snapshot.

### Why `target:"bun"`, not `target:"node"`

Both run under Bun (the bin is `#!/usr/bin/env bun`). But `target:"node"`
**bundles+CJS-wraps `ws`**, which reproduces the exact upgrade hang the workaround
existed for (confirmed empirically). Only `target:"bun"` avoids it. The cost is
the `@xterm` resolution quirk above, handled by externalizing those two packages.

## Risks & mitigations (verify during implementation)

1. **Shebang must be line 1.** Bun may inject a `// @bun` pragma; if it lands
   above the banner, `#!/usr/bin/env bun` won't be on line 1 and the bin breaks.
   *Mitigation:* after building `dist/cli.js`, read it, assert the shebang is
   line 1, and hoist it if not. Small post-write guard in the script.
2. **Sentry `var module = { exports: {} }` hack — DROPPED.** This was a Bun
   *runtime-load* fix (`typeof module` in Sentry's `isCjs()` misclassified the ESM
   file as CJS). `target:"bun"` output carries a `// @bun` pragma so Bun trusts the
   ESM format and no longer applies the heuristic. Verified: the CLI loads and runs
   without the shim. The banner is now just the shebang.
3. **`ws` native handling.** `ws` is not bundled under `target:"bun"` — Bun keeps
   the import for its built-in handling, so its optional-native `require()`s
   (`bufferutil`/`utf-8-validate`, not installed) never enter the graph. No
   external entry for them is needed.

## Changes

- `scripts/build.mjs` — rewritten to `Bun.build`; removes the `ws` external entry,
  removes the `strip-import-attributes` plugin, adds the shebang post-write guard.
- `package.json`:
  - `build` script: `node scripts/build.mjs` → `bun scripts/build.mjs`.
  - Remove `esbuild` from `devDependencies` (unused after this).
  - `upload-sentry-sourcemaps.mjs` stays `node` (unchanged, out of scope).
  - `ws` stays in `dependencies` (harmless; not migrating it).
- No `src` / runtime changes. web-ui build untouched.

## Verification

1. `npm run build` succeeds; `dist/cli.js` + `.map`, `dist/index.js` + `.map`,
   and `dist/web-ui/*` are all present.
2. `dist/cli.js` line 1 is the shebang; file is executable (`chmod +x`).
3. Boot the built runtime and confirm a real **WebSocket upgrade connects**
   (the core goal) — via `dogfood` or a direct `bun dist/cli.js` start + a ws
   client handshake against the runtime state hub.
4. CLI executes: `bun dist/cli.js --help` (and one no-op command) returns the
   expected envelope.
5. `dist/index.js` imports cleanly (library export path).
6. `npm test` / `npm run typecheck` unaffected (no `src` changes).

## Out of scope

- web-ui (Vite/rolldown) bundling.
- Moving `ws` to devDependencies.
- Any runtime/`src` behavior change.
