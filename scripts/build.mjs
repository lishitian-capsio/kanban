import * as esbuild from "esbuild";

/**
 * Runtime externals.
 * - `ws` is externalised because Bun's `node:http` upgrade handling does not
 *   work with esbuild's CJS-wrapped `ws` package (WebSocket upgrades hang).
 * - `bun:sqlite` and `bun` are Bun-specific and cannot be bundled.
 * - `bun-pty` (Windows-only PTY backend) loads a prebuilt native FFI library
 *   (`rust-pty/target/release/rust_pty.dll`) via a path resolved *relative to its
 *   own module location* in node_modules. Bundling it would break that relative
 *   resolution, so it must stay external and be loaded from node_modules at
 *   runtime. It is only dynamically imported on win32 (see pty-session.ts).
 */
const external = ["bun:sqlite", "bun", "ws", "bun-pty"];

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

/** Shared esbuild options for both entry points. */
const shared = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	external,
	define,
	sourcemap: true,
	packages: "bundle",
	loader: { ".md": "text", ".html": "text" },
	plugins: [
		{
			name: "strip-import-attributes",
			setup(build) {
				// esbuild 0.27.x doesn't support `with { type: "text" }` import attributes.
				// Strip them from .md and .html imports so the text loader can handle them.
				build.onLoad({ filter: /\.(ts|js|mjs|mts)$/ }, async (args) => {
					const fs = await import("node:fs");
					let contents = fs.readFileSync(args.path, "utf8");
					// Remove `with { type: "text" }` from import statements
					contents = contents.replace(/\s+with\s*\{\s*type:\s*["']text["']\s*\}/g, "");
					return { contents, loader: args.path.endsWith(".ts") || args.path.endsWith(".mts") ? "ts" : "js" };
				});
			},
		},
	],
};

await Promise.all([
	// CLI binary
	esbuild.build({
		...shared,
		entryPoints: ["src/cli.ts"],
		outfile: "dist/cli.js",
		banner: {
			js: [
				"#!/usr/bin/env bun",
				// Sentry's bundled `isCjs()` contains a bare `typeof module` check
				// that causes Bun to classify the entire ESM file as CJS, which then
				// conflicts with ESM `import` statements.  Declaring a local `module`
				// binding before any code runs satisfies Bun's CJS heuristic without
				// affecting runtime behaviour (the Sentry code path correctly falls
				// through to `false`).
				"var module = { exports: {} };",
			].join("\n"),
		},
	}),
	// Library export
	esbuild.build({
		...shared,
		entryPoints: ["src/index.ts"],
		outfile: "dist/index.js",
	}),
]);

console.log("esbuild: bundled dist/cli.js and dist/index.js");
