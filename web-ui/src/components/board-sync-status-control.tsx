import { AlertTriangle, ArrowDown, ArrowUp, Check, GitBranch, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { BoardConflictDialog } from "@/components/board-conflict-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardSyncRunningAction } from "@/hooks/use-board-sync";
import type { RuntimeBoardSyncState, RuntimeBoardSyncStatus } from "@/runtime/types";

export interface BoardSyncStatusControlProps {
	status: RuntimeBoardSyncStatus;
	runningAction: BoardSyncRunningAction;
	isTogglingPause: boolean;
	onPush: () => void;
	onPull: () => void;
	onTogglePause: () => void;
}

interface StateAppearance {
	label: string;
	toneClassName: string;
	icon: React.ReactNode;
}

function describeState(state: RuntimeBoardSyncState): StateAppearance {
	switch (state) {
		case "syncing":
			return { label: "Syncing…", toneClassName: "text-text-secondary", icon: <Spinner size={12} /> };
		case "conflict":
			return { label: "Conflict", toneClassName: "text-status-red", icon: <AlertTriangle size={12} /> };
		case "error":
			return { label: "Sync error", toneClassName: "text-status-orange", icon: <AlertTriangle size={12} /> };
		case "diverged":
			return { label: "Diverged", toneClassName: "text-status-orange", icon: <GitBranch size={12} /> };
		case "behind":
			return { label: "Behind", toneClassName: "text-status-blue", icon: <ArrowDown size={12} /> };
		case "ahead":
			return { label: "Ahead", toneClassName: "text-status-gold", icon: <ArrowUp size={12} /> };
		case "local-only":
			return { label: "Local only", toneClassName: "text-text-tertiary", icon: <GitBranch size={12} /> };
		default:
			return { label: "Synced", toneClassName: "text-status-green", icon: <Check size={12} /> };
	}
}

/**
 * The board-branch sync badge in the top bar. Shows the current sync state (from
 * `probeGitWorkspaceState` ahead/behind, surfaced as `RuntimeBoardSyncStatus`) and
 * offers manual push/pull and a pause-auto-sync toggle. Rendered only when board-
 * branch decoupling is active for the workspace; callers gate on `status.decoupled`.
 */
export function BoardSyncStatusControl({
	status,
	runningAction,
	isTogglingPause,
	onPush,
	onPull,
	onTogglePause,
}: BoardSyncStatusControlProps): React.ReactElement {
	const appearance = describeState(status.state);
	const branchLabel = status.branch ?? "kanban/board";
	const needsAttention = status.state === "conflict" || status.state === "error";
	const [detailOpen, setDetailOpen] = useState(false);

	// Close the detail dialog once the sync recovers (a retry succeeded, or a remote
	// fetch moved the state out of conflict/error), so it never lingers stale.
	useEffect(() => {
		if (!needsAttention && detailOpen) {
			setDetailOpen(false);
		}
	}, [needsAttention, detailOpen]);

	const tooltipLines = [`Board branch: ${branchLabel}`];
	if (status.aheadCount > 0) {
		tooltipLines.push(
			`${status.aheadCount} local commit${status.aheadCount === 1 ? "" : "s"} committed, awaiting Push.`,
		);
	}
	if (status.hasRemote) {
		tooltipLines.push("Behind count refreshes when you Pull.");
	}
	if (status.autoSyncPaused) {
		tooltipLines.push("Auto-commit is paused.");
	}
	if (status.lastError) {
		tooltipLines.push(status.lastError);
	}
	if (needsAttention) {
		tooltipLines.push("Click for details.");
	}

	const badgeClassName = cn(
		"inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-xs whitespace-nowrap",
		appearance.toneClassName,
		needsAttention && "cursor-pointer hover:bg-surface-3",
	);

	return (
		<div className="flex items-center min-w-0 gap-1">
			<div className="w-px h-5 bg-border mx-1" />
			<Tooltip
				side="bottom"
				content={
					<span className="inline-flex flex-col gap-0.5">
						{tooltipLines.map((line) => (
							<span key={line}>{line}</span>
						))}
					</span>
				}
			>
				{needsAttention ? (
					<button
						type="button"
						className={badgeClassName}
						data-testid="board-sync-badge"
						data-board-sync-state={status.state}
						onClick={() => setDetailOpen(true)}
						aria-label={`${appearance.label} — show board sync details`}
					>
						{appearance.icon}
						<span>{appearance.label}</span>
					</button>
				) : (
					<span className={badgeClassName} data-testid="board-sync-badge" data-board-sync-state={status.state}>
						{appearance.icon}
						<span>{appearance.label}</span>
					</span>
				)}
			</Tooltip>

			{needsAttention ? (
				<BoardConflictDialog
					open={detailOpen}
					onOpenChange={setDetailOpen}
					status={status}
					runningAction={runningAction}
					onPush={onPush}
					onPull={onPull}
				/>
			) : null}

			{status.hasRemote ? (
				<div className="flex gap-0">
					<Tooltip
						side="bottom"
						content={
							status.behindCount > 0
								? `Pull ${status.behindCount} board commit${status.behindCount === 1 ? "" : "s"} from the remote.`
								: "Pull the board branch from the remote."
						}
					>
						<Button
							variant="ghost"
							size="sm"
							icon={runningAction === "pull" ? <Spinner size={14} /> : <ArrowDown size={14} />}
							onClick={onPull}
							disabled={runningAction !== null}
							aria-label="Pull board branch"
						>
							{status.behindCount > 0 ? <span className="text-text-tertiary">{status.behindCount}</span> : null}
						</Button>
					</Tooltip>
					<Tooltip
						side="bottom"
						content={
							status.aheadCount > 0
								? `Push ${status.aheadCount} local board commit${status.aheadCount === 1 ? "" : "s"} to the remote.`
								: "Push the board branch to the remote."
						}
					>
						<Button
							variant="ghost"
							size="sm"
							icon={runningAction === "push" ? <Spinner size={14} /> : <ArrowUp size={14} />}
							onClick={onPush}
							disabled={runningAction !== null}
							aria-label="Push board branch"
						>
							{status.aheadCount > 0 ? <span className="text-text-tertiary">{status.aheadCount}</span> : null}
						</Button>
					</Tooltip>
					<Tooltip
						side="bottom"
						content={status.autoSyncPaused ? "Resume automatic board commits." : "Pause automatic board commits."}
					>
						<Button
							variant="ghost"
							size="sm"
							icon={
								isTogglingPause ? (
									<Spinner size={14} />
								) : status.autoSyncPaused ? (
									<Play size={14} />
								) : (
									<Pause size={14} />
								)
							}
							onClick={onTogglePause}
							disabled={isTogglingPause}
							aria-label={
								status.autoSyncPaused ? "Resume automatic board commits" : "Pause automatic board commits"
							}
							className={cn(status.autoSyncPaused && "text-status-orange")}
						/>
					</Tooltip>
				</div>
			) : null}
		</div>
	);
}
