import type {
	RuntimeBoardBranchUpdateResponse,
	RuntimeBoardSyncActionResponse,
	RuntimeBoardSyncStatus,
} from "../core/api-contract";
import { createLogger } from "../logging";
import {
	BOARD_REF_VERSION,
	DEFAULT_BOARD_BRANCH,
	isBoardDecouplingActive,
	readBoardRef,
	writeBoardRef,
} from "../state/board-ref";
import {
	commitBoardRefUpdate,
	commitBoardWorktree,
	getBoardWorktreeAheadBehind,
	getBoardWorktreePath,
	pullBoardWorktree,
	pushBoardWorktree,
	renameBoardBranch,
} from "./board-worktree";

const log = createLogger("board-sync");

/** Default debounce window coalescing a burst of board writes into one local commit. */
const DEFAULT_BOARD_SYNC_DEBOUNCE_MS = 5_000;

const BOARD_SYNC_COMMIT_MESSAGE = "board: sync runtime state";

const CONFLICT_MESSAGE =
	"The board branch diverged from the remote with a content conflict. Local data is intact; resolve and retry.";

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
	/**
	 * Push the freshly-computed board sync status to connected clients (the top-bar
	 * badge). Called after every status transition — startup reconcile, each commit/push,
	 * a manual push/pull, the pause toggle, and a branch rename — so the UI stays live
	 * without polling. Optional: the in-memory/test default broadcasts nothing.
	 */
	onStatusChanged?: (target: BoardSyncTarget, status: RuntimeBoardSyncStatus) => Promise<void> | void;
	/** Debounce window in ms (default {@link DEFAULT_BOARD_SYNC_DEBOUNCE_MS}); injectable for tests. */
	debounceMs?: number;
}

export interface BoardSyncService {
	/**
	 * Schedule a debounced **local commit** for the workspace's board branch. A burst of
	 * writes within the debounce window collapses into a single commit. This path is
	 * purely local — it never pushes, fetches, or otherwise touches the network (push and
	 * pull are explicit, user-only actions). A no-op when board-branch decoupling is not
	 * active for the repo. While auto-commit is paused the debounce only refreshes the
	 * status (so the badge tracks the growing ahead count) without committing.
	 */
	scheduleSync: (target: BoardSyncTarget) => void;
	/** Read the current board sync status (reflects in-memory pause/conflict/in-flight flags). */
	getStatus: (target: BoardSyncTarget) => Promise<RuntimeBoardSyncStatus>;
	/** Manually commit + push now, bypassing the debounce. The only push entry point. Returns the post-action status. */
	pushNow: (target: BoardSyncTarget) => Promise<RuntimeBoardSyncActionResponse>;
	/** Manually fetch + integrate the remote now. The only fetch entry point. Returns the post-action status. */
	pullNow: (target: BoardSyncTarget) => Promise<RuntimeBoardSyncActionResponse>;
	/** Pause or resume the debounced auto-commit for a repo (session-scoped). */
	setAutoSyncPaused: (target: BoardSyncTarget, paused: boolean) => Promise<RuntimeBoardSyncStatus>;
	/** Rename the board branch via the non-destructive migration, then repoint board-ref. */
	renameBranch: (target: BoardSyncTarget, newBranch: string) => Promise<RuntimeBoardBranchUpdateResponse>;
	/** Run any pending local commit for a repo immediately (used by tests / targeted flushes). */
	flush: (repoPath: string) => Promise<void>;
	/** Cancel timers and run a final **local commit** for every known workspace (shutdown). No network I/O. */
	dispose: () => Promise<void>;
}

interface BoardSyncLastResult {
	conflict: boolean;
	error: string | null;
}

export function createBoardSyncService(deps: CreateBoardSyncServiceDependencies): BoardSyncService {
	const debounceMs = deps.debounceMs ?? DEFAULT_BOARD_SYNC_DEBOUNCE_MS;
	const timersByRepo = new Map<string, NodeJS.Timeout>();
	const latestTargetByRepo = new Map<string, BoardSyncTarget>();
	// Serializes all git work for a given repo so a debounced commit, a manual push/pull,
	// and a shutdown flush never run concurrently against the same worktree.
	const queueByRepo = new Map<string, Promise<unknown>>();
	const autoSyncPausedByRepo = new Set<string>();
	const inFlightByRepo = new Set<string>();
	const lastResultByRepo = new Map<string, BoardSyncLastResult>();

	const enqueue = <T>(repoPath: string, work: () => Promise<T>): Promise<T> => {
		const previous = queueByRepo.get(repoPath) ?? Promise.resolve();
		const next = previous.then(work, work);
		// Keep the chain alive but swallow rejections so one failure doesn't poison the queue.
		queueByRepo.set(
			repoPath,
			next.catch(() => undefined),
		);
		return next;
	};

	const resolveBranch = async (repoPath: string): Promise<string> => {
		return (await readBoardRef(repoPath))?.branch.trim() || DEFAULT_BOARD_BRANCH;
	};

	const recordResult = (repoPath: string, result: BoardSyncLastResult): void => {
		lastResultByRepo.set(repoPath, result);
	};

	const buildStatus = async (target: BoardSyncTarget): Promise<RuntimeBoardSyncStatus> => {
		const { repoPath } = target;
		if (!isBoardDecouplingActive(repoPath)) {
			return {
				state: "disabled",
				decoupled: false,
				branch: null,
				hasRemote: false,
				aheadCount: 0,
				behindCount: 0,
				autoSyncPaused: false,
				lastError: null,
				worktreePath: null,
			};
		}
		const branch = await resolveBranch(repoPath);
		const ab = await getBoardWorktreeAheadBehind(repoPath, branch);
		const autoSyncPaused = autoSyncPausedByRepo.has(repoPath);
		const last = lastResultByRepo.get(repoPath);

		let state: RuntimeBoardSyncStatus["state"];
		if (inFlightByRepo.has(repoPath)) {
			state = "syncing";
		} else if (last?.conflict) {
			state = "conflict";
		} else if (last?.error) {
			state = "error";
		} else if (!ab.hasRemote) {
			state = "local-only";
		} else if (ab.aheadCount > 0 && ab.behindCount > 0) {
			state = "diverged";
		} else if (ab.behindCount > 0) {
			state = "behind";
		} else if (ab.aheadCount > 0) {
			state = "ahead";
		} else {
			state = "synced";
		}

		return {
			state,
			decoupled: true,
			branch,
			hasRemote: ab.hasRemote,
			aheadCount: ab.aheadCount,
			behindCount: ab.behindCount,
			autoSyncPaused,
			lastError: last?.conflict ? (last.error ?? CONFLICT_MESSAGE) : (last?.error ?? null),
			worktreePath: getBoardWorktreePath(repoPath),
		};
	};

	const emitStatus = async (target: BoardSyncTarget): Promise<RuntimeBoardSyncStatus> => {
		const status = await buildStatus(target);
		try {
			await deps.onStatusChanged?.(target, status);
		} catch (error) {
			log.warn("board sync status broadcast failed", { repoPath: target.repoPath, error });
		}
		return status;
	};

	/**
	 * The automatic hot-path action: a purely local board commit, nothing else.
	 *
	 * INVARIANT (load-bearing — see `.plan/docs/board-sync-redesign.md` §4/§5.1): this
	 * function must NEVER call `scheduleSync`, `broadcastWorkspaceState`, `pushBoardWorktree`,
	 * `pullBoardWorktree`, or `fetch`/`merge` git ops. `commitBoardWorktree` is a local
	 * `git add -A` + `git commit` only — it never rebroadcasts or reschedules — so the
	 * commit path is provably free of the broadcast→saveState→scheduleSync feedback loop
	 * (and the push-failure retry storm) that pegged CPU on move-to-done. Push and pull are
	 * explicit, user-only actions; the network is touched there and ONLY there.
	 */
	const runCommitOnly = async (target: BoardSyncTarget): Promise<void> => {
		if (!isBoardDecouplingActive(target.repoPath)) {
			return;
		}
		inFlightByRepo.add(target.repoPath);
		try {
			await commitBoardWorktree(target.repoPath, BOARD_SYNC_COMMIT_MESSAGE);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recordResult(target.repoPath, { conflict: false, error: message });
			log.warn("board commit failed", { repoPath: target.repoPath, error });
		} finally {
			inFlightByRepo.delete(target.repoPath);
		}
		await emitStatus(target);
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
			if (autoSyncPausedByRepo.has(target.repoPath)) {
				// Paused means even the local commit is skipped; we only refresh the badge so
				// the ahead count still tracks the accumulating (uncommitted) local writes.
				void enqueue(target.repoPath, () => emitStatus(latest).then(() => undefined));
				return;
			}
			void enqueue(target.repoPath, () => runCommitOnly(latest));
		}, debounceMs);
		timer.unref();
		timersByRepo.set(target.repoPath, timer);
	};

	const getStatus = async (target: BoardSyncTarget): Promise<RuntimeBoardSyncStatus> => {
		latestTargetByRepo.set(target.repoPath, target);
		return await buildStatus(target);
	};

	// The ONLY push entry point — runs only when the user clicks Push. A single attempt:
	// the underlying git sub-calls carry a per-invocation timeout (see board-worktree.ts)
	// so a hung network op can't wedge the per-repo serial queue, and any failure is just
	// surfaced via `recordResult` — NEVER auto-retried (no backoff loop, no self-spin). The
	// `inFlightByRepo` guard + the frontend disabling the button during `runningAction`
	// prevent concurrent re-entry.
	const runManualPush = async (target: BoardSyncTarget): Promise<RuntimeBoardSyncActionResponse> => {
		if (!isBoardDecouplingActive(target.repoPath)) {
			return { ok: false, status: await buildStatus(target), error: "Board-branch decoupling is not active." };
		}
		inFlightByRepo.add(target.repoPath);
		await emitStatus(target);
		let ok = true;
		let error: string | undefined;
		try {
			const branch = await resolveBranch(target.repoPath);
			await commitBoardWorktree(target.repoPath, BOARD_SYNC_COMMIT_MESSAGE);
			const push = await pushBoardWorktree(target.repoPath, branch);
			if (push.pulledChanges) {
				await deps.broadcastWorkspaceState(target.workspaceId, target.workspacePath);
			}
			if (push.status === "conflict") {
				recordResult(target.repoPath, { conflict: true, error: CONFLICT_MESSAGE });
				ok = false;
				error = CONFLICT_MESSAGE;
			} else if (push.status === "error") {
				const message = push.error ?? "Board push failed.";
				recordResult(target.repoPath, { conflict: false, error: message });
				ok = false;
				error = message;
			} else {
				recordResult(target.repoPath, { conflict: false, error: null });
			}
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			recordResult(target.repoPath, { conflict: false, error: message });
			ok = false;
			error = message;
		} finally {
			inFlightByRepo.delete(target.repoPath);
		}
		const status = await emitStatus(target);
		return { ok, status, error };
	};

	// The ONLY fetch entry point — runs only when the user clicks Pull. Like the push path
	// it is a single attempt with timed-out git sub-calls and NO auto-retry: a failure or a
	// real merge conflict is surfaced via `recordResult` (local data left intact), never
	// retried on a loop.
	const runManualPull = async (target: BoardSyncTarget): Promise<RuntimeBoardSyncActionResponse> => {
		if (!isBoardDecouplingActive(target.repoPath)) {
			return { ok: false, status: await buildStatus(target), error: "Board-branch decoupling is not active." };
		}
		inFlightByRepo.add(target.repoPath);
		await emitStatus(target);
		let ok = true;
		let error: string | undefined;
		try {
			const branch = await resolveBranch(target.repoPath);
			// Commit any pending local writes first so the merge has a clean tree.
			await commitBoardWorktree(target.repoPath, BOARD_SYNC_COMMIT_MESSAGE);
			const pull = await pullBoardWorktree(target.repoPath, branch);
			if (pull.pulledChanges) {
				await deps.broadcastWorkspaceState(target.workspaceId, target.workspacePath);
			}
			if (pull.status === "conflict") {
				recordResult(target.repoPath, { conflict: true, error: CONFLICT_MESSAGE });
				ok = false;
				error = CONFLICT_MESSAGE;
			} else if (pull.status === "error") {
				const message = pull.error ?? "Board pull failed.";
				recordResult(target.repoPath, { conflict: false, error: message });
				ok = false;
				error = message;
			} else {
				recordResult(target.repoPath, { conflict: false, error: null });
			}
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			recordResult(target.repoPath, { conflict: false, error: message });
			ok = false;
			error = message;
		} finally {
			inFlightByRepo.delete(target.repoPath);
		}
		const status = await emitStatus(target);
		return { ok, status, error };
	};

	const runRename = async (target: BoardSyncTarget, newBranch: string): Promise<RuntimeBoardBranchUpdateResponse> => {
		if (!isBoardDecouplingActive(target.repoPath)) {
			return {
				ok: false,
				status: await buildStatus(target),
				archivedTag: null,
				error: "Board-branch decoupling is not active.",
			};
		}
		inFlightByRepo.add(target.repoPath);
		await emitStatus(target);
		let result: RuntimeBoardBranchUpdateResponse;
		try {
			const oldBranch = await resolveBranch(target.repoPath);
			const renamed = await renameBoardBranch(target.repoPath, oldBranch, newBranch);
			if (renamed.ok) {
				// Repoint the authoritative pointer ONLY after the migration succeeds, then
				// commit it to the code branch so the new name travels with a clone.
				await writeBoardRef(target.repoPath, { version: BOARD_REF_VERSION, branch: newBranch.trim() });
				await commitBoardRefUpdate(target.repoPath);
				recordResult(target.repoPath, { conflict: false, error: null });
			}
			result = {
				ok: renamed.ok,
				status: await buildStatus(target),
				archivedTag: renamed.archivedTag,
				error: renamed.error,
			};
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			log.warn("board branch rename failed", { repoPath: target.repoPath, error: caught });
			result = { ok: false, status: await buildStatus(target), archivedTag: null, error: message };
		} finally {
			inFlightByRepo.delete(target.repoPath);
		}
		await emitStatus(target);
		return result;
	};

	const pushNow = (target: BoardSyncTarget): Promise<RuntimeBoardSyncActionResponse> => {
		latestTargetByRepo.set(target.repoPath, target);
		return enqueue(target.repoPath, () => runManualPush(target));
	};

	const pullNow = (target: BoardSyncTarget): Promise<RuntimeBoardSyncActionResponse> => {
		latestTargetByRepo.set(target.repoPath, target);
		return enqueue(target.repoPath, () => runManualPull(target));
	};

	const setAutoSyncPaused = async (target: BoardSyncTarget, paused: boolean): Promise<RuntimeBoardSyncStatus> => {
		latestTargetByRepo.set(target.repoPath, target);
		if (paused) {
			autoSyncPausedByRepo.add(target.repoPath);
			const timer = timersByRepo.get(target.repoPath);
			if (timer) {
				clearTimeout(timer);
				timersByRepo.delete(target.repoPath);
			}
		} else {
			autoSyncPausedByRepo.delete(target.repoPath);
			// Resuming: flush whatever accumulated while paused.
			scheduleSync(target);
		}
		return await emitStatus(target);
	};

	const renameBranch = (target: BoardSyncTarget, newBranch: string): Promise<RuntimeBoardBranchUpdateResponse> => {
		latestTargetByRepo.set(target.repoPath, target);
		return enqueue(target.repoPath, () => runRename(target, newBranch));
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
		await enqueue(repoPath, () => runCommitOnly(target));
	};

	const dispose = async (): Promise<void> => {
		for (const timer of timersByRepo.values()) {
			clearTimeout(timer);
		}
		timersByRepo.clear();
		// Final **local commit** (no push) for every workspace touched this session so the
		// last writes — including the shutdown coordinator's interrupted-session save — are
		// captured on the board branch. Unpushed commits stay durable locally and the user
		// can Push them next session; shutdown never touches the network.
		const repos = new Set([...latestTargetByRepo.keys(), ...queueByRepo.keys()]);
		await Promise.all(
			[...repos].map(async (repoPath) => {
				const target = latestTargetByRepo.get(repoPath);
				if (target && !autoSyncPausedByRepo.has(repoPath)) {
					await enqueue(repoPath, () => runCommitOnly(target));
				}
				await queueByRepo.get(repoPath);
			}),
		);
	};

	return {
		scheduleSync,
		getStatus,
		pushNow,
		pullNow,
		setAutoSyncPaused,
		renameBranch,
		flush,
		dispose,
	};
}
