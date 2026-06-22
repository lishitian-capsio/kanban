import type {
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

// The metadata monitor's git refresh is already event-driven for the cases that
// matter: board mutations, agent commits (turn checkpoints) and hook firings all
// call back into `updateWorkspaceState`, which refreshes immediately. The interval
// timer is a *fallback* poll that catches changes which emit no event — chiefly an
// agent actively writing files in a worktree, or a manual external edit. Polling
// every tracked task once per second spawned git probes unconditionally even when
// nothing was happening, which is a continuous O(N tasks) idle CPU cost.
//
// So the poll cadence is adaptive: it starts fast, and while consecutive refreshes
// detect no change it backs off exponentially toward a cap. The instant a refresh
// observes a change (or an event-driven refresh arrives) the cadence snaps back to
// the fast base interval. Tradeoff: a purely external edit made while the board is
// open and otherwise idle is reflected after up to the max interval instead of 1s —
// acceptable for git-status freshness, and self-correcting (the first detected delta
// restores the 1s cadence for the duration of the activity).
export const WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000;
export const WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS = 5_000;
const WORKSPACE_METADATA_POLL_BACKOFF_FACTOR = 2;

export function computeNextPollIntervalMs(currentIntervalMs: number, changed: boolean): number {
	if (changed) {
		return WORKSPACE_METADATA_POLL_INTERVAL_MS;
	}
	return Math.min(currentIntervalMs * WORKSPACE_METADATA_POLL_BACKOFF_FACTOR, WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS);
}

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
}

interface WorkspaceMetadataEntry {
	workspacePath: string;
	trackedTasks: TrackedTaskWorkspace[];
	subscriberCount: number;
	pollTimer: NodeJS.Timeout | null;
	pollLoopActive: boolean;
	pollIntervalMs: number;
	lastRefreshChanged: boolean;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
}

export interface WorkspaceMetadataMonitor {
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	disconnectWorkspace: (workspaceId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorkspace[] {
	const tracked: TrackedTaskWorkspace[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need git metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
			});
		}
	}
	return tracked;
}

function areGitSummariesEqual(a: RuntimeGitSyncSummary | null, b: RuntimeGitSyncSummary | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.currentBranch === b.currentBranch &&
		a.upstreamBranch === b.upstreamBranch &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.aheadCount === b.aheadCount &&
		a.behindCount === b.behindCount
	);
}

function areTaskMetadataEqual(a: RuntimeTaskWorkspaceMetadata, b: RuntimeTaskWorkspaceMetadata): boolean {
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.stateVersion === b.stateVersion
	);
}

function areWorkspaceMetadataEqual(a: RuntimeWorkspaceMetadata, b: RuntimeWorkspaceMetadata): boolean {
	if (!areGitSummariesEqual(a.homeGitSummary, b.homeGitSummary)) {
		return false;
	}
	if (a.homeGitStateVersion !== b.homeGitStateVersion) {
		return false;
	}
	if (a.taskWorkspaces.length !== b.taskWorkspaces.length) {
		return false;
	}
	for (let index = 0; index < a.taskWorkspaces.length; index += 1) {
		const left = a.taskWorkspaces[index];
		const right = b.taskWorkspaces[index];
		if (!left || !right || !areTaskMetadataEqual(left, right)) {
			return false;
		}
	}
	return true;
}

function createEmptyWorkspaceMetadata(): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: [],
	};
}

function createWorkspaceEntry(workspacePath: string): WorkspaceMetadataEntry {
	return {
		workspacePath,
		trackedTasks: [],
		subscriberCount: 0,
		pollTimer: null,
		pollLoopActive: false,
		pollIntervalMs: WORKSPACE_METADATA_POLL_INTERVAL_MS,
		lastRefreshChanged: false,
		refreshPromise: null,
		homeGit: {
			summary: null,
			stateToken: null,
			stateVersion: 0,
		},
		taskMetadataByTaskId: new Map<string, CachedTaskWorkspaceMetadata>(),
	};
}

function buildWorkspaceMetadataSnapshot(entry: WorkspaceMetadataEntry): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		taskWorkspaces: entry.trackedTasks
			.map((task) => entry.taskMetadataByTaskId.get(task.taskId)?.data ?? null)
			.filter((task): task is RuntimeTaskWorkspaceMetadata => task !== null),
	};
}

async function loadHomeGitMetadata(entry: WorkspaceMetadataEntry): Promise<CachedHomeGitMetadata> {
	try {
		const probe = await probeGitWorkspaceState(entry.workspacePath);
		if (entry.homeGit.stateToken === probe.stateToken) {
			return entry.homeGit;
		}
		const summary = await getGitSyncSummary(entry.workspacePath, { probe });
		return {
			summary,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
		};
	} catch {
		return entry.homeGit;
	}
}

async function loadTaskWorkspaceMetadata(
	workspacePath: string,
	task: TrackedTaskWorkspace,
	current: CachedTaskWorkspaceMetadata | null,
): Promise<CachedTaskWorkspaceMetadata | null> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: workspacePath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});

	if (!pathInfo.exists) {
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}

	try {
		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		const summary = await getGitSyncSummary(pathInfo.path, { probe });
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: probe.currentBranch,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				headCommit: probe.headCommit,
				changedFiles: summary.changedFiles,
				additions: summary.additions,
				deletions: summary.deletions,
				stateVersion: Date.now(),
			},
			stateToken: probe.stateToken,
		};
	} catch {
		if (current) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	const workspaces = new Map<string, WorkspaceMetadataEntry>();

	const stopPollLoop = (entry: WorkspaceMetadataEntry) => {
		entry.pollLoopActive = false;
		entry.pollIntervalMs = WORKSPACE_METADATA_POLL_INTERVAL_MS;
		if (entry.pollTimer) {
			clearTimeout(entry.pollTimer);
			entry.pollTimer = null;
		}
	};

	const refreshWorkspace = async (workspaceId: string): Promise<RuntimeWorkspaceMetadata> => {
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return createEmptyWorkspaceMetadata();
		}
		if (entry.refreshPromise) {
			return await entry.refreshPromise;
		}

		entry.refreshPromise = (async () => {
			const previousSnapshot = buildWorkspaceMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);

			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map(async (task) => {
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
					return next ? [task.taskId, next] : null;
				}),
			);

			entry.taskMetadataByTaskId = new Map(
				nextTaskEntries.filter(
					(candidate): candidate is [string, CachedTaskWorkspaceMetadata] => candidate !== null,
				),
			);

			const nextSnapshot = buildWorkspaceMetadataSnapshot(entry);
			const changed = !areWorkspaceMetadataEqual(previousSnapshot, nextSnapshot);
			entry.lastRefreshChanged = changed;
			if (changed) {
				deps.onMetadataUpdated(workspaceId, nextSnapshot);
			}
			return nextSnapshot;
		})().finally(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.refreshPromise = null;
			}
		});

		return await entry.refreshPromise;
	};

	const updateWorkspaceEntry = (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}): WorkspaceMetadataEntry => {
		const existing = workspaces.get(input.workspaceId) ?? createWorkspaceEntry(input.workspacePath);
		existing.workspacePath = input.workspacePath;
		existing.trackedTasks = collectTrackedTasks(input.board);
		workspaces.set(input.workspaceId, existing);
		return existing;
	};

	// Arm a single fallback poll at the entry's current (possibly backed-off)
	// interval. Self-rescheduling via setTimeout rather than a fixed setInterval so
	// each tick can pick its own next delay.
	const armPollTimer = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		if (entry.pollTimer) {
			clearTimeout(entry.pollTimer);
			entry.pollTimer = null;
		}
		const timer = setTimeout(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.pollTimer = null;
			}
			void runPollTick(workspaceId);
		}, entry.pollIntervalMs);
		timer.unref();
		entry.pollTimer = timer;
	};

	const runPollTick = async (workspaceId: string): Promise<void> => {
		const entry = workspaces.get(workspaceId);
		if (!entry || !entry.pollLoopActive) {
			return;
		}
		await refreshWorkspace(workspaceId);
		const current = workspaces.get(workspaceId);
		if (!current || !current.pollLoopActive) {
			return;
		}
		current.pollIntervalMs = computeNextPollIntervalMs(current.pollIntervalMs, current.lastRefreshChanged);
		armPollTimer(workspaceId, current);
	};

	const ensurePollLoop = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		if (entry.pollLoopActive) {
			return;
		}
		entry.pollLoopActive = true;
		entry.pollIntervalMs = WORKSPACE_METADATA_POLL_INTERVAL_MS;
		armPollTimer(workspaceId, entry);
	};

	// An event-driven signal (board mutation, etc.) means something just changed, so
	// reset the fallback cadence to the fast base interval and re-arm immediately.
	const wakePollLoop = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		if (!entry.pollLoopActive) {
			return;
		}
		entry.pollIntervalMs = WORKSPACE_METADATA_POLL_INTERVAL_MS;
		armPollTimer(workspaceId, entry);
	};

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			entry.subscriberCount += 1;
			ensurePollLoop(workspaceId, entry);
			return await refreshWorkspace(workspaceId);
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			if (entry.subscriberCount === 0) {
				return buildWorkspaceMetadataSnapshot(entry);
			}
			// A workspace-state broadcast is an event-driven change signal, so refresh
			// now and restore the fast fallback cadence in case the loop had backed off.
			wakePollLoop(workspaceId, entry);
			return await refreshWorkspace(workspaceId);
		},
		disconnectWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
			if (entry.subscriberCount > 0) {
				return;
			}
			stopPollLoop(entry);
			workspaces.delete(workspaceId);
		},
		disposeWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			stopPollLoop(entry);
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopPollLoop(entry);
			}
			workspaces.clear();
		},
	};
}
