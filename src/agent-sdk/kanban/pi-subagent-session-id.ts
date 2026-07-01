// Pure, side-effect-free helpers for the composite transcript id of a Pi subagent.
//
// A Pi subagent (spawned via the `task` tool → a child Agent run) gets its own transcript
// that rides the EXISTING per-taskId chat channel. To do that it needs a distinct "taskId"
// derived from its parent session's taskId plus its own subagentId. The frontend never
// builds this id — the backend mints it and hands it back as `RuntimeTaskSubagent.sessionId`,
// so the id scheme stays entirely backend-owned.
//
// Format: `pi-sub#<parentTaskId>#<subagentId>`. The parent taskId is arbitrary (the Pi home
// session id contains `:` and `_`); the subagentId is a controlled `[A-Za-z0-9_-]+` token, so
// parsing splits on the LAST separator and is robust even if the parent contains a `#`.
// (The on-disk journal dir hashes any id outside `[A-Za-z0-9_-]` — that's fine; round-trip
// parsing happens in memory, never from the filesystem.)

const PI_SUBAGENT_PREFIX = "pi-sub#";
const PI_SUBAGENT_SEP = "#";
const SUBAGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ParsedPiSubagentSessionId {
	parentTaskId: string;
	subagentId: string;
}

/** Build the composite transcript id for a subagent of `parentTaskId`. */
export function createPiSubagentSessionId(parentTaskId: string, subagentId: string): string {
	if (!SUBAGENT_ID_PATTERN.test(subagentId)) {
		throw new Error(`Invalid subagentId (must match ${SUBAGENT_ID_PATTERN}): ${subagentId}`);
	}
	return `${PI_SUBAGENT_PREFIX}${parentTaskId}${PI_SUBAGENT_SEP}${subagentId}`;
}

/** True when `id` is a composite Pi-subagent transcript id. */
export function isPiSubagentSessionId(id: string): boolean {
	return parsePiSubagentSessionId(id) !== null;
}

/** Parse a composite id back into its parent taskId + subagentId, or null when not one. */
export function parsePiSubagentSessionId(id: string): ParsedPiSubagentSessionId | null {
	if (!id.startsWith(PI_SUBAGENT_PREFIX)) {
		return null;
	}
	const rest = id.slice(PI_SUBAGENT_PREFIX.length);
	const lastSep = rest.lastIndexOf(PI_SUBAGENT_SEP);
	if (lastSep <= 0 || lastSep === rest.length - 1) {
		return null;
	}
	const parentTaskId = rest.slice(0, lastSep);
	const subagentId = rest.slice(lastSep + 1);
	if (!SUBAGENT_ID_PATTERN.test(subagentId)) {
		return null;
	}
	return { parentTaskId, subagentId };
}
