import { GitBranch, Trash2 } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { GitCommitDiffPanel } from "@/components/git-history/git-commit-diff-panel";
import { GitCommitListPanel } from "@/components/git-history/git-commit-list-panel";
import { GitRefsPanel } from "@/components/git-history/git-refs-panel";
import type { UseGitHistoryDataResult } from "@/components/git-history/use-git-history-data";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Dialog,
	DialogBody,
	DialogFooter,
	DialogHeader,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ResizeHandle } from "@/resize/resize-handle";
import {
	clampGitCommitsPanelWidth,
	clampGitRefsPanelWidth,
	useGitHistoryLayout,
} from "@/resize/use-git-history-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import type { RuntimeGitCommit } from "@/runtime/types";
import { useWindowEvent } from "@/utils/react-use";

function CommitDiffHeader({ commit }: { commit: RuntimeGitCommit }): React.ReactElement {
	return (
		<div
			style={{
				padding: "10px 12px",
				borderBottom: "1px solid var(--color-divider)",
				background: "var(--color-surface-1)",
			}}
		>
			<div
				style={{
					fontSize: 14,
					color: "var(--color-text-primary)",
					marginBottom: 4,
					lineHeight: 1.4,
				}}
			>
				{commit.message}
			</div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					fontSize: 10,
					color: "var(--color-text-tertiary)",
				}}
			>
				<span>{commit.authorName}</span>
				<span>
					{new Date(commit.date).toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					})}
				</span>
				<code className="font-mono">{commit.shortHash}</code>
			</div>
		</div>
	);
}

interface GitHistoryViewProps {
	workspaceId: string | null;
	gitHistory: UseGitHistoryDataResult;
	onCheckoutBranch?: (branch: string) => void;
	onDiscardWorkingChanges?: () => void;
	isDiscardWorkingChangesPending?: boolean;
	/** Create a local tag at the given commitish (null ⇒ HEAD). Enables tag UI when set. */
	onCreateTag?: (input: { name: string; message: string; commitish: string | null }) => void;
	/** Delete a local tag by name. Enables the tag delete affordance when set. */
	onDeleteTag?: (name: string) => void;
	isTagActionPending?: boolean;
}

export function GitHistoryView({
	workspaceId,
	gitHistory,
	onCheckoutBranch,
	onDiscardWorkingChanges,
	isDiscardWorkingChangesPending = false,
	onCreateTag,
	onDeleteTag,
	isTagActionPending = false,
}: GitHistoryViewProps): React.ReactElement {
	const [isDiscardAlertOpen, setIsDiscardAlertOpen] = useState(false);
	const [isCreateTagOpen, setIsCreateTagOpen] = useState(false);
	const [tagName, setTagName] = useState("");
	const [tagMessage, setTagMessage] = useState("");
	const [tagToDelete, setTagToDelete] = useState<string | null>(null);

	// The create dialog tags whatever commit is currently selected in the history
	// (falling back to HEAD when the working copy / no commit is selected).
	const tagTargetCommit = gitHistory.viewMode === "commit" ? gitHistory.selectedCommit : null;

	const openCreateTag = useCallback(() => {
		setTagName("");
		setTagMessage("");
		setIsCreateTagOpen(true);
	}, []);

	const submitCreateTag = useCallback(() => {
		const name = tagName.trim();
		if (!name || !onCreateTag) {
			return;
		}
		onCreateTag({ name, message: tagMessage, commitish: tagTargetCommit?.hash ?? null });
		setIsCreateTagOpen(false);
	}, [onCreateTag, tagMessage, tagName, tagTargetCommit?.hash]);
	const [historyLayoutWidth, setHistoryLayoutWidth] = useState<number | null>(null);
	const historyLayoutRef = useRef<HTMLDivElement | null>(null);
	const { startDrag: startRefsPanelResize } = useResizeDrag();
	const { startDrag: startCommitsPanelResize } = useResizeDrag();
	const { displayRefsPanelWidth, displayCommitsPanelWidth, setRefsPanelWidth, setCommitsPanelWidth } =
		useGitHistoryLayout({
			containerWidth: historyLayoutWidth,
		});

	const updateHistoryLayoutWidth = useCallback(() => {
		const container = historyLayoutRef.current;
		if (!container) {
			return;
		}
		setHistoryLayoutWidth(Math.max(container.offsetWidth, 1));
	}, []);

	useEffect(() => {
		updateHistoryLayoutWidth();
	}, [updateHistoryLayoutWidth]);

	useWindowEvent("resize", updateHistoryLayoutWidth);

	const handleRefsSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = historyLayoutRef.current;
			if (!container) {
				return;
			}
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayRefsPanelWidth;
			startRefsPanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitRefsPanelWidth(startWidth + deltaX, containerWidth, displayCommitsPanelWidth);
					setRefsPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitRefsPanelWidth(startWidth + deltaX, containerWidth, displayCommitsPanelWidth);
					setRefsPanelWidth(nextWidth);
				},
			});
		},
		[displayCommitsPanelWidth, displayRefsPanelWidth, setRefsPanelWidth, startRefsPanelResize],
	);

	const handleCommitsSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = historyLayoutRef.current;
			if (!container) {
				return;
			}
			const containerWidth = Math.max(container.offsetWidth, 1);
			const startX = event.clientX;
			const startWidth = displayCommitsPanelWidth;
			startCommitsPanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitCommitsPanelWidth(startWidth + deltaX, containerWidth, displayRefsPanelWidth);
					setCommitsPanelWidth(nextWidth);
				},
				onEnd: (pointerX) => {
					const deltaX = pointerX - startX;
					const nextWidth = clampGitCommitsPanelWidth(startWidth + deltaX, containerWidth, displayRefsPanelWidth);
					setCommitsPanelWidth(nextWidth);
				},
			});
		},
		[displayCommitsPanelWidth, displayRefsPanelWidth, setCommitsPanelWidth, startCommitsPanelResize],
	);

	if (!workspaceId) {
		return (
			<div
				className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary"
				style={{ flex: 1, background: "var(--color-surface-0)" }}
			>
				<GitBranch size={48} />
				<h3 className="font-semibold text-text-primary">No project selected</h3>
			</div>
		);
	}

	return (
		<div
			ref={historyLayoutRef}
			style={{
				display: "flex",
				flex: "1 1 0",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			<GitRefsPanel
				refs={gitHistory.refs}
				selectedRefName={gitHistory.viewMode === "working-copy" ? null : (gitHistory.activeRef?.name ?? null)}
				isLoading={gitHistory.isRefsLoading}
				errorMessage={gitHistory.refsErrorMessage}
				panelWidth={displayRefsPanelWidth}
				workingCopyChanges={gitHistory.hasWorkingCopy ? gitHistory.workingCopyFileCount : null}
				isWorkingCopySelected={gitHistory.viewMode === "working-copy"}
				onSelectRef={gitHistory.selectRef}
				onSelectWorkingCopy={gitHistory.hasWorkingCopy ? gitHistory.selectWorkingCopy : undefined}
				onCheckoutRef={onCheckoutBranch}
				onCreateTag={onCreateTag ? openCreateTag : undefined}
				onDeleteTag={onDeleteTag ? setTagToDelete : undefined}
			/>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize git refs and commits panels"
				onMouseDown={handleRefsSeparatorMouseDown}
				className="z-10"
			/>
			<GitCommitListPanel
				commits={gitHistory.commits}
				totalCount={gitHistory.totalCommitCount}
				selectedCommitHash={gitHistory.viewMode === "commit" ? gitHistory.selectedCommitHash : null}
				isLoading={gitHistory.isLogLoading}
				isLoadingMore={gitHistory.isLoadingMoreCommits}
				canLoadMore={gitHistory.commits.length < gitHistory.totalCommitCount}
				errorMessage={gitHistory.logErrorMessage}
				refs={gitHistory.refs}
				panelWidth={displayCommitsPanelWidth}
				onSelectCommit={gitHistory.selectCommit}
				onLoadMore={gitHistory.loadMoreCommits}
			/>
			<ResizeHandle
				orientation="vertical"
				ariaLabel="Resize git commits and diff panels"
				onMouseDown={handleCommitsSeparatorMouseDown}
				className="z-10"
			/>
			<GitCommitDiffPanel
				diffSource={gitHistory.diffSource}
				isLoading={gitHistory.isDiffLoading}
				errorMessage={gitHistory.diffErrorMessage}
				selectedPath={gitHistory.selectedDiffPath}
				onSelectPath={gitHistory.selectDiffPath}
				headerContent={
					gitHistory.viewMode === "commit" && gitHistory.selectedCommit ? (
						<CommitDiffHeader commit={gitHistory.selectedCommit} />
					) : gitHistory.viewMode === "working-copy" ? (
						<div
							className="kb-git-working-copy-header"
							style={{
								display: "flex",
								alignItems: "center",
								padding: "10px 12px",
								borderBottom: "1px solid var(--color-border)",
								fontSize: 14,
								color: "var(--color-text-primary)",
							}}
						>
							<span style={{ flex: 1 }}>Working Copy Changes</span>
							{onDiscardWorkingChanges ? (
								<Button
									variant="danger"
									size="sm"
									icon={<Trash2 size={14} />}
									aria-label="Discard all changes"
									disabled={isDiscardWorkingChangesPending}
									onClick={() => setIsDiscardAlertOpen(true)}
								>
									{isDiscardWorkingChangesPending ? <Spinner size={14} /> : null}
								</Button>
							) : null}
						</div>
					) : null
				}
			/>
			<AlertDialog
				open={isDiscardAlertOpen}
				onOpenChange={(open) => {
					if (!open) setIsDiscardAlertOpen(false);
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Discard all changes?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						Are you sure you want to discard all working copy changes? This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button
							variant="default"
							onClick={() => setIsDiscardAlertOpen(false)}
							disabled={isDiscardWorkingChangesPending}
						>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isDiscardWorkingChangesPending}
							onClick={() => {
								setIsDiscardAlertOpen(false);
								onDiscardWorkingChanges?.();
							}}
						>
							{isDiscardWorkingChangesPending ? <Spinner size={14} /> : null}
							Discard All
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>

			<Dialog
				open={isCreateTagOpen}
				onOpenChange={(open) => {
					if (!open) setIsCreateTagOpen(false);
				}}
			>
				<DialogHeader title="Create tag" />
				<DialogBody className="flex flex-col gap-3">
					<label className="flex flex-col gap-1">
						<span className="text-xs font-medium text-text-secondary">Tag name</span>
						<input
							autoFocus
							className="h-8 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							placeholder="v1.0.0"
							value={tagName}
							onChange={(e) => setTagName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									submitCreateTag();
								}
							}}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs font-medium text-text-secondary">
							Message <span className="text-text-tertiary">(optional — annotated tag)</span>
						</span>
						<input
							className="h-8 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							placeholder="Leave empty for a lightweight tag"
							value={tagMessage}
							onChange={(e) => setTagMessage(e.target.value)}
						/>
					</label>
					<div className="text-xs text-text-tertiary">
						Target:{" "}
						{tagTargetCommit ? (
							<>
								<code className="font-mono text-text-secondary">{tagTargetCommit.shortHash}</code>{" "}
								{tagTargetCommit.message}
							</>
						) : (
							<span className="text-text-secondary">HEAD (current branch tip)</span>
						)}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="default" onClick={() => setIsCreateTagOpen(false)} disabled={isTagActionPending}>
						Cancel
					</Button>
					<Button variant="primary" onClick={submitCreateTag} disabled={isTagActionPending || !tagName.trim()}>
						{isTagActionPending ? <Spinner size={14} /> : null}
						Create tag
					</Button>
				</DialogFooter>
			</Dialog>

			<AlertDialog
				open={tagToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setTagToDelete(null);
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete tag?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						Delete the local tag <code className="font-mono">{tagToDelete}</code>? This only removes it locally; a
						tag already pushed to a remote is unaffected.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setTagToDelete(null)} disabled={isTagActionPending}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isTagActionPending}
							onClick={() => {
								const name = tagToDelete;
								setTagToDelete(null);
								if (name) {
									onDeleteTag?.(name);
								}
							}}
						>
							{isTagActionPending ? <Spinner size={14} /> : null}
							Delete tag
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
