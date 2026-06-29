import { useCallback } from "react";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useJsonLocalStorageValue } from "@/utils/react-use";

/** How many recently-opened files to keep per workspace. */
export const FILE_RECENTS_LIMIT = 12;

/**
 * A recently-opened file. We store the title alongside the routing `id` so the
 * palette's zero-query "recents" list renders with NO network (no per-id
 * `getDocument`, no `listDocuments` — the latter is the heavy browsing concern
 * the surface avoids). Frontend-only; not a wire type.
 *
 * (Deviation from file-surface-design §6.1's bare `string[]`: storing the label
 * keeps the zero-query state truly instant. Routing/identity is still the `id`.)
 */
export interface FileRecent {
	id: string;
	title: string;
}

/** Coerce arbitrary stored JSON back into a clean, de-duplicated recents list. */
export function normalizeRecents(value: unknown): FileRecent[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const result: FileRecent[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const { id, title } = entry as { id?: unknown; title?: unknown };
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
			continue;
		}
		seen.add(id);
		result.push({ id, title: typeof title === "string" ? title : "" });
		if (result.length >= FILE_RECENTS_LIMIT) {
			break;
		}
	}
	return result;
}

/** Move a file to the front (most-recent-first), de-duplicated by id and capped. */
export function pushRecent(existing: FileRecent[], recent: FileRecent): FileRecent[] {
	const next = [recent, ...existing.filter((entry) => entry.id !== recent.id)];
	return next.slice(0, FILE_RECENTS_LIMIT);
}

export interface UseFileRecentsResult {
	recents: FileRecent[];
	addRecent: (recent: FileRecent) => void;
}

/**
 * Recently-opened File-surface files, per workspace, in `localStorage`.
 * Frontend-only — no backend, no wire type (file-surface-design §6.1). Gives the
 * quick-open palette a useful zero-query state. A `null` workspace yields an
 * empty, inert list.
 */
export function useFileRecents(workspaceId: string | null): UseFileRecentsResult {
	const key = workspaceId
		? `${LocalStorageKey.FileSurfaceRecentsPrefix}.${workspaceId}`
		: LocalStorageKey.FileSurfaceRecentsPrefix;
	const [recents, setRecents] = useJsonLocalStorageValue<FileRecent[]>(key, [], normalizeRecents);

	const addRecent = useCallback(
		(recent: FileRecent) => {
			if (!workspaceId || !recent.id) {
				return;
			}
			setRecents((current) => pushRecent(current, recent));
		},
		[workspaceId, setRecents],
	);

	return { recents, addRecent };
}
