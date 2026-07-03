export function createGitTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Hooks can export GIT_* vars that redirect git commands away from test cwd.
		if (key.startsWith("GIT_")) {
			continue;
		}
		// Running the suite inside a Kanban agent session (or against a live
		// runtime) leaks KANBAN_* vars — e.g. KANBAN_RUNTIME_HOST binds the
		// spawned test server to a LAN IP instead of 127.0.0.1, and
		// KANBAN_SESSION_* / KANBAN_INTERNAL_AUTH_TOKEN cross-wire it to the host
		// session. Strip them so each test gets a clean runtime; tests that need a
		// specific value pass it explicitly via `overrides` (applied last).
		if (key.startsWith("KANBAN_")) {
			continue;
		}
		sanitized[key] = value;
	}
	return {
		...sanitized,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
		...overrides,
	};
}
