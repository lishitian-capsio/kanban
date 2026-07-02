import { StorageService, defaultS3ClientFactory, normalizeConnId } from "../storage";
import type { StorageConnectionRecord } from "../storage";
import {
	loadStorageCredential,
	loadWorkspaceStorageConnections,
} from "../state/workspace-state";

const servicesByWorkspaceId = new Map<string, StorageService>();

/** Resolve (and memoize) the read-only storage service for a workspace. */
export function getWorkspaceStorageService(workspaceId: string): StorageService {
	const existing = servicesByWorkspaceId.get(workspaceId);
	if (existing) {
		return existing;
	}
	const loadConnection = async (connId: string): Promise<StorageConnectionRecord | null> => {
		const target = normalizeConnId(connId);
		const records = await loadWorkspaceStorageConnections(workspaceId);
		return records.find((r) => normalizeConnId(r.connId) === target) ?? null;
	};
	const created = new StorageService({
		createClient: defaultS3ClientFactory,
		loadConnection,
		loadCredential: (connId) => loadStorageCredential(connId),
	});
	servicesByWorkspaceId.set(workspaceId, created);
	return created;
}
