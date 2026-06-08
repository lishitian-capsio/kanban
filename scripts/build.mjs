import * as esbuild from "esbuild";

/**
 * Runtime externals. `node-pty` is a native addon with a compiled binding
 * and a spawn-helper binary that must live on disk, so it can't be bundled.
 * Everything else esbuild can inline.
 */
const external = ["node-pty", "bun:sqlite", "bun"];

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
		banner: { js: "#!/usr/bin/env bun" },
	}),
	// Library export
	esbuild.build({
		...shared,
		entryPoints: ["src/index.ts"],
		outfile: "dist/index.js",
	}),
]);

console.log("esbuild: bundled dist/cli.js and dist/index.js");
