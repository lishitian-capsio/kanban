import { AlertTriangle, ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { BoardSyncRunningAction } from "@/hooks/use-board-sync";
import type { RuntimeBoardSyncStatus } from "@/runtime/types";

export interface BoardConflictDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	status: RuntimeBoardSyncStatus;
	runningAction: BoardSyncRunningAction;
	onPush: () => void;
	onPull: () => void;
}

/**
 * The conflict / error detail surface opened from the top-bar sync badge.
 *
 * A board push/pull that hits a genuine content conflict is **surfaced, never
 * auto-resolved** (the runtime `merge --abort`s to keep the shard tree clean — see
 * `board-worktree.ts` / `.plan/docs/board-branch-decoupling.md` §3.7). The badge alone
 * can't carry the explanation, the reassurance that local data is intact, or the
 * board-worktree path a user needs to resolve by hand, so a conflict expands into this
 * dialog. For a plain `"error"` (offline, etc.) it just explains the auto-retry.
 */
export function BoardConflictDialog({
	open,
	onOpenChange,
	status,
	runningAction,
	onPush,
	onPull,
}: BoardConflictDialogProps): React.ReactElement {
	const isConflict = status.state === "conflict";
	const title = isConflict ? "Board sync conflict" : "Board sync error";

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title={title} icon={<AlertTriangle size={16} className="text-status-red" />} />
			<DialogBody className="flex flex-col gap-3 text-sm text-text-secondary">
				<p>
					{status.lastError ??
						(isConflict
							? "The board branch diverged from the remote with a content conflict."
							: "The last board sync failed.")}
				</p>
				<p className="text-status-green">Your local board data is intact — nothing was lost or overwritten.</p>
				{isConflict ? (
					<>
						<p>
							Most concurrent edits merge automatically because each task is its own file. This conflict touched
							the same task or layout on both sides, so it needs a manual decision. Resolve it in the board
							worktree, then retry:
						</p>
						{status.worktreePath ? (
							<code className="block rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary break-all">
								{status.worktreePath}
							</code>
						) : null}
					</>
				) : (
					<p>This usually clears on its own — the next automatic sync retries. You can also retry now.</p>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="default" size="sm" onClick={() => onOpenChange(false)}>
					Close
				</Button>
				{status.hasRemote ? (
					<>
						<Button
							variant="default"
							size="sm"
							icon={runningAction === "pull" ? <Spinner size={14} /> : <ArrowDown size={14} />}
							onClick={onPull}
							disabled={runningAction !== null}
						>
							Retry pull
						</Button>
						<Button
							variant="primary"
							size="sm"
							icon={runningAction === "push" ? <Spinner size={14} /> : <ArrowUp size={14} />}
							onClick={onPush}
							disabled={runningAction !== null}
						>
							Retry push
						</Button>
					</>
				) : null}
			</DialogFooter>
		</Dialog>
	);
}
