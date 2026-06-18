import { createLogger } from "../logging";
import { DEFAULT_BOARD_BRANCH, isBoardDecouplingActive, readBoardRef } from "../state/board-ref";
import { commitBoardWorktree, fetchAndFastForwardBoardWorktree, pushBoardWorktree } from "./board-worktree";

const log = createLogger("board-sync");

/** Default debounce window coalescing a burst of board writes into one commit + push. */
const DEFAULT_BOARD_SYNC_DEBOUNCE_MS = 5_000;

const BOARD_SYNC_COMMIT_MESSAGE = "board: sync runtime state";

/** Identifies the workspace whose board changed (workspacePath is the repo root). */
export interface BoardSyncTarget {
	repoPath: string;
	workspaceId: string;
	workspacePath: string;
}

export interface CreateBoardSyncServiceDependencies {
	/**
	 * Re-read the board from disk and rebroadcast it to connected clients. Invoked after
	 * a sync pulls remote commits into the worktree, so the UI reflects the merged state.
	 * Reuses the existing `broadcastRuntimeWorkspaceStateUpdated` (no file watcher).
	 */
	broadcastWorkspaceState: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	/** Debounce window in ms (default {@link DEFAULT_BOARD_SYNC_DEBOUNCE_MS}); injectable for tests. */
	debounceMs?: number;
}

export interface BoardSyncService {
	/**
	 * Schedule a debounced commit + push for the workspace's board branch. A burst of
	 * writes within the debounce window collapses into a single sync. A no-op when
	 * board-branch decoupling is not active for the repo.
	 */
	scheduleSync: (target: BoardSyncTarget) => void;
	/**
	 * Run the one-time startup reconcile (fetch + fast-forward) for a workspace and
	 * rebroadcast if it pulled remote commits. Idempotent per repo for the process
	 * lifetime — safe to call eagerly at boot and again before the first push.
	 */
	syncOnStartup: (target: BoardSyncTarget) => Promise<void>;
	/** Run any pending sync for a repo immediately (used by tests / targeted flushes). */
	flush: (repoPath: string) => Promise<void>;
	/** Cancel timers and run a final commit + push for every known workspace (shutdown). */
	dispose: () => Promise<void>;
}

export function createBoardSyncService(deps: CreateBoardSyncServiceDependencies): BoardSyncService {
	const debounceMs = deps.debounceMs ?? DEFAULT_BOARD_SYNC_DEBOUNCE_MS;
	const timersByRepo = new Map<string, NodeJS.Timeout>();
	const latestTargetByRepo = new Map<string, BoardSyncTarget>();
	// Serializes all git work for a given repo so a debounced sync, a startup reconcile,
	// and a shutdown flush never run concurrently against the same worktree.
	const queueByRepo = new Map<string, Promise<void>>();
	const startupDoneByRepo = new Set<string>();

	const enqueue = (repoPath: string, work: () => Promise<void>): Promise<void> => {
		const previous = queueByRepo.get(repoPath) ?? Promise.resolve();
		const next = previous.then(work, work);
		// Keep the chain alive but swallow rejections so one failure doesn't poison the queue.
		queueByRepo.set(
			repoPath,
			next.catch(() => undefined),
		);
		return next;
	};

	const runStartupReconcile = async (target: BoardSyncTarget): Promise<void> => {
		if (startupDoneByRepo.has(target.repoPath)) {
			return;
		}
		startupDoneByRepo.add(target.repoPath);
		if (!isBoardDecouplingActive(target.repoPath)) {
			return;
		}
		try {
			const branch = (await readBoardRef(target.repoPath))?.branch.trim() || DEFAULT_BOARD_BRANCH;
			const { changed } = await fetchAndFastForwardBoardWorktree(target.repoPath, branch);
			if (changed) {
				await deps.broadcastWorkspaceState(target.workspaceId, target.workspacePath);
			}
		} catch (error) {
			log.warn("board startup reconcile failed", { repoPath: target.repoPath, error });
		}
	};

	const runCommitAndPush = async (target: BoardSyncTarget): Promise<void> => {
		if (!isBoardDecouplingActive(target.repoPath)) {
			return;
		}
		// A startup reconcile may still be pending if the first write beat the boot call.
		await runStartupReconcile(target);
		try {
			const branch = (await readBoardRef(target.repoPath))?.branch.trim() || DEFAULT_BOARD_BRANCH;
			await commitBoardWorktree(target.repoPath, BOARD_SYNC_COMMIT_MESSAGE);
			const push = await pushBoardWorktree(target.repoPath, branch);
			if (push.pulledChanges) {
				await deps.broadcastWorkspaceState(target.workspaceId, target.workspacePath);
			}
			if (push.status === "conflict") {
				log.warn("board sync surfaced a merge conflict; local data left intact, awaiting resolution", {
					repoPath: target.repoPath,
					branch,
				});
			}
		} catch (error) {
			log.warn("board commit/push failed", { repoPath: target.repoPath, error });
		}
	};

	const scheduleSync = (target: BoardSyncTarget): void => {
		if (!isBoardDecouplingActive(target.repoPath)) {
			return;
		}
		latestTargetByRepo.set(target.repoPath, target);
		const existing = timersByRepo.get(target.repoPath);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			timersByRepo.delete(target.repoPath);
			const latest = latestTargetByRepo.get(target.repoPath) ?? target;
			void enqueue(target.repoPath, () => runCommitAndPush(latest));
		}, debounceMs);
		timer.unref();
		timersByRepo.set(target.repoPath, timer);
	};

	const syncOnStartup = async (target: BoardSyncTarget): Promise<void> => {
		latestTargetByRepo.set(target.repoPath, target);
		await enqueue(target.repoPath, () => runStartupReconcile(target));
	};

	const flush = async (repoPath: string): Promise<void> => {
		const timer = timersByRepo.get(repoPath);
		if (timer) {
			clearTimeout(timer);
			timersByRepo.delete(repoPath);
		}
		const target = latestTargetByRepo.get(repoPath);
		if (!target) {
			await queueByRepo.get(repoPath);
			return;
		}
		await enqueue(repoPath, () => runCommitAndPush(target));
	};

	const dispose = async (): Promise<void> => {
		for (const timer of timersByRepo.values()) {
			clearTimeout(timer);
		}
		timersByRepo.clear();
		// Final commit + push for every workspace touched this session so the last writes
		// (including the shutdown coordinator's interrupted-session save) are published.
		const repos = new Set([...latestTargetByRepo.keys(), ...queueByRepo.keys()]);
		await Promise.all(
			[...repos].map(async (repoPath) => {
				const target = latestTargetByRepo.get(repoPath);
				if (target) {
					await enqueue(repoPath, () => runCommitAndPush(target));
				}
				await queueByRepo.get(repoPath);
			}),
		);
	};

	return { scheduleSync, syncOnStartup, flush, dispose };
}
