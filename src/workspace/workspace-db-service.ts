import { DatabaseService, normalizeConnId, PoolManager, QueryExecutor } from "../db";
import type { ConnectionRecord } from "../db";
import { loadDbCredential, loadWorkspaceDbConnections } from "../state/workspace-state";

/**
 * The per-workspace database stack. This wiring lives OUTSIDE `src/db` on purpose: the DB core
 * must stay free of any `workspace-state` dependency (that would be an import cycle), so the
 * workspace scoping — "which connections + credentials does this workspace see" — is injected here.
 */
export interface WorkspaceDbStack {
	service: DatabaseService;
	executor: QueryExecutor;
}

const stacksByWorkspaceId = new Map<string, WorkspaceDbStack>();

function buildStack(workspaceId: string): WorkspaceDbStack {
	// One pool per workspace so two workspaces that happen to reuse a connId never share a driver.
	const poolManager = new PoolManager();
	const loadConnection = async (connId: string): Promise<ConnectionRecord | null> => {
		const target = normalizeConnId(connId);
		const records = await loadWorkspaceDbConnections(workspaceId);
		return records.find((r) => normalizeConnId(r.connId) === target) ?? null;
	};
	const service = new DatabaseService({
		poolManager,
		loadConnection,
		// Credentials are machine-home and keyed by the (globally unique) connId.
		loadCredential: (connId) => loadDbCredential(connId),
	});
	const executor = new QueryExecutor({ service, loadConnection });
	return { service, executor };
}

/**
 * Resolve (and memoize) the database stack for a workspace. The human Database UI always runs
 * with `caller: "human"`, so writes are gated solely by the connection's `allowWrites` flag via
 * the policy chokepoint inside {@link DatabaseService}.
 */
export function getWorkspaceDbStack(workspaceId: string): WorkspaceDbStack {
	const existing = stacksByWorkspaceId.get(workspaceId);
	if (existing) {
		return existing;
	}
	const created = buildStack(workspaceId);
	stacksByWorkspaceId.set(workspaceId, created);
	return created;
}
