import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Runtime externals.
 * - `bun:sqlite` and `bun` are Bun-specific and cannot be bundled.
 * - `bun-pty` (Windows-only PTY backend) loads a prebuilt native FFI library
 *   (`rust-pty/target/release/rust_pty.dll`) via a path resolved *relative to its
 *   own module location* in node_modules. Bundling it would break that relative
 *   resolution, so it must stay external and be loaded from node_modules at
 *   runtime. It is only dynamically imported on win32 (see pty-session.ts).
 * - `@xterm/headless` and `@xterm/addon-serialize` ship a browser build in
 *   `module` and the real Node/headless build in `main`, with no `exports` map.
 *   With `target: "bun"` the bundler prefers `module` and would inline the wrong
 *   (browser) build — `@xterm/addon-serialize`'s `.mjs` doesn't even expose the
 *   default export the source imports. Externalising them defers resolution to
 *   the Bun runtime, which resolves the correct headless build exactly like
 *   `bun src/cli.ts` does in dev. Both are runtime `dependencies`.
 *
 * Note: `ws` is deliberately NOT external here. esbuild used to CJS-wrap `ws`,
 * which hung `node:http` WebSocket upgrades, forcing `ws` external as a
 * workaround. With `target: "bun"`, Bun handles `ws` natively (it leaves the
 * import for its built-in `ws`, unwrapped), so the upgrade works and the explicit
 * workaround is gone — no `"ws"` entry is needed here.
 */
const external = ["bun:sqlite", "bun", "bun-pty", "@xterm/headless", "@xterm/addon-serialize"];

/** Bake OTEL telemetry env vars into the bundle at build time. */
const define = {
	"process.env.NODE_ENV": '"production"',
	"process.env.OTEL_TELEMETRY_ENABLED": JSON.stringify(process.env.OTEL_TELEMETRY_ENABLED ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_ENDPOINT": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ""),
	"process.env.OTEL_METRICS_EXPORTER": JSON.stringify(process.env.OTEL_METRICS_EXPORTER ?? ""),
	"process.env.OTEL_LOGS_EXPORTER": JSON.stringify(process.env.OTEL_LOGS_EXPORTER ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_PROTOCOL": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? ""),
	"process.env.OTEL_METRIC_EXPORT_INTERVAL": JSON.stringify(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_HEADERS": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? ""),
};

/**
 * CLI banner: the shebang that makes `dist/cli.js` directly executable under Bun.
 *
 * `-S` splits the args so Bun receives `--no-env-file`, which disables Bun's
 * default auto-loading of a `.env` in the invocation cwd. When the `kanban`
 * binary runs inside an arbitrary user repo / task worktree, a stray `.env` there
 * must NOT be injected into the runtime's env (KANBAN_*, proxy, credential-file
 * paths). Kanban never reads its own config from `.env`, so this is pure
 * hardening. `env -S` needs GNU coreutils >= 8.30 / macOS / BSD (not busybox);
 * the service launchers pass the same flag explicitly (see service-launch.ts).
 *
 * (The esbuild build also injected `var module = { exports: {} };` to stop Bun
 * from misclassifying the ESM bundle as CJS via Sentry's bundled `typeof module`
 * check. `target: "bun"` output carries a `// @bun` pragma so Bun trusts the ESM
 * format and no longer applies that heuristic, so the shim is no longer needed.)
 */
const CLI_SHEBANG = "#!/usr/bin/env -S bun --no-env-file";
const cliBanner = CLI_SHEBANG;

/**
 * Shared Bun.build options for both entry points.
 *
 * `target: "bun"` is what lets Bun handle `ws` natively (see the externals note)
 * — the whole point of moving off esbuild. The output runs under Bun anyway.
 */
const shared = {
	target: "bun",
	format: "esm",
	sourcemap: "linked",
	external,
	define,
	naming: "[name].[ext]",
	outdir: "dist",
	loader: { ".md": "text", ".html": "text" },
	throw: true,
};

await Bun.build({
	...shared,
	entrypoints: ["src/cli.ts"],
	banner: cliBanner,
});

await Bun.build({
	...shared,
	entrypoints: ["src/index.ts"],
});

// Bun may emit a `// @bun` pragma; ensure the shebang is still the first line so
// the `kanban` bin stays directly executable.
const cliPath = resolve("dist/cli.js");
const cliContents = await readFile(cliPath, "utf8");
if (!cliContents.startsWith(`${CLI_SHEBANG}\n`)) {
	const withoutShebang = cliContents.replace(new RegExp(`^${CLI_SHEBANG}\\n`, "m"), "");
	await writeFile(cliPath, `${CLI_SHEBANG}\n${withoutShebang}`);
}

console.log("Bun.build: bundled dist/cli.js and dist/index.js");
