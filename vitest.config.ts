import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// `packages/**` excluded: those workspaces have their own vitest
		// configs and runtime shapes (e.g. Electron) and are run explicitly by
		// CI. New workspaces under `packages/` MUST get matching install/test
		// steps in .github/workflows/test.yml or they fall out of CI coverage.
		exclude: [
			"apps/**",
			"packages/**",
			"web-ui/**",
			"third_party/**",
			"**/node_modules/**",
			"**/dist/**",
			".worktrees/**",
			// Bun-only suites (bun:sqlite et al.) run via `npm run test:bun`; they
			// cannot be collected under plain Node `vitest`.
			"test/bun/**",
			// Vendored omp (`src/agent-sdk/`) ships its own `bun test` suites that
			// import the `bun:test` runner API. That module is only injected by the
			// `bun test` runner, never by vitest (even when vitest runs under Bun),
			// so these must not be collected here. Kanban-owned vitest tests live
			// under `test/`.
			"src/agent-sdk/**",
		],
		testTimeout: 15_000,
	},
});
