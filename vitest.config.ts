import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";
// Force node-pty backend in tests so PtySession mocks work correctly
// even when running vitest under Bun.
process.env.KANBAN_FORCE_NODE_PTY = "1";

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
		],
		testTimeout: 15_000,
	},
});
