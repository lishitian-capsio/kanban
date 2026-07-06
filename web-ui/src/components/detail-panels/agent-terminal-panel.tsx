import "@xterm/xterm/css/xterm.css";

import { Command, Maximize2, MessageSquare, Minimize2, X } from "lucide-react";
import type { DragEvent, MutableRefObject, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { agentSupportsFileAttachments } from "@/runtime/attachment-agents";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import {
	collectFilesFromDataTransfer,
	handleTerminalPasteEvent,
	processTerminalAttachments,
	readFileAsBase64,
} from "@/terminal/terminal-attachment-drop";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { isMacPlatform } from "@/utils/platform";

interface AgentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	isStopping: boolean;
	lastError: string | null;
	stopTerminal: () => Promise<void>;
	pasteText: (text: string) => boolean;
}

export interface AgentTerminalPanelProps {
	taskId: string;
	workspaceId: string | null;
	terminalEnabled?: boolean;
	summary: RuntimeTaskSessionSummary | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	taskColumnId?: string;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
	showSessionToolbar?: boolean;
	onClose?: () => void;
	autoFocus?: boolean;
	minimalHeaderTitle?: string;
	minimalHeaderSubtitle?: string | null;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	cursorColor?: string;
	isVisible?: boolean;
	onConnectionReady?: (taskId: string) => void;
	agentCommand?: string | null;
	onSendAgentCommand?: () => void;
	isExpanded?: boolean;
	onToggleExpand?: () => void;
}

function describeState(summary: RuntimeTaskSessionSummary | null): string {
	if (!summary) {
		return "No session yet";
	}
	if (summary.state === "running") {
		return "Running";
	}
	if (summary.state === "awaiting_review") {
		return "Ready for review";
	}
	if (summary.state === "interrupted") {
		return "Interrupted";
	}
	if (summary.state === "failed") {
		return "Failed";
	}
	return "Idle";
}

type StatusTagStyle = "neutral" | "success" | "warning" | "danger";

function getStateTagStyle(summary: RuntimeTaskSessionSummary | null): StatusTagStyle {
	if (!summary) {
		return "neutral";
	}
	if (summary.state === "running") {
		return "success";
	}
	if (summary.state === "awaiting_review") {
		return "warning";
	}
	if (summary.state === "interrupted" || summary.state === "failed") {
		return "danger";
	}
	return "neutral";
}

const statusTagColors: Record<StatusTagStyle, string> = {
	neutral: "bg-surface-3 text-text-secondary",
	success: "bg-status-green/15 text-status-green",
	warning: "bg-status-orange/15 text-status-orange",
	danger: "bg-status-red/15 text-status-red",
};

function AgentTerminalReviewActions({
	taskId,
	taskColumnId,
	onCommit,
	onOpenPr,
	isCommitLoading,
	isOpenPrLoading,
}: {
	taskId: string;
	taskColumnId: string;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading: boolean;
	isOpenPrLoading: boolean;
}): ReactElement | null {
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	const showReviewGitActions = taskColumnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;

	if (!showReviewGitActions) {
		return null;
	}

	return (
		<div style={{ display: "flex", gap: 6 }}>
			<Button
				variant="primary"
				size="sm"
				style={{ flex: "1 1 0" }}
				disabled={isCommitLoading || isOpenPrLoading}
				onClick={onCommit}
			>
				{isCommitLoading ? "..." : "Commit"}
			</Button>
			<Button
				variant="primary"
				size="sm"
				style={{ flex: "1 1 0" }}
				disabled={isCommitLoading || isOpenPrLoading}
				onClick={onOpenPr}
			>
				{isOpenPrLoading ? "..." : "Open PR"}
			</Button>
		</div>
	);
}

function AgentTerminalPanelLayout({
	taskId,
	workspaceId,
	summary,
	onSummary: _onSummary,
	onCommit,
	onOpenPr,
	isCommitLoading = false,
	isOpenPrLoading = false,
	taskColumnId = "in_progress",
	onMoveToTrash,
	isMoveToTrashLoading = false,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash,
	showSessionToolbar = true,
	onClose,
	autoFocus: _autoFocus = false,
	minimalHeaderTitle = "Terminal",
	minimalHeaderSubtitle = null,
	panelBackgroundColor = "var(--color-surface-1)",
	terminalBackgroundColor = "var(--color-surface-1)",
	cursorColor: _cursorColor = "var(--color-text-primary)",
	isVisible: _isVisible = true,
	onConnectionReady: _onConnectionReady,
	agentCommand,
	onSendAgentCommand,
	isExpanded = false,
	onToggleExpand,
	sessionControls,
}: AgentTerminalPanelProps & { sessionControls: AgentTerminalSessionControls }): ReactElement {
	const { containerRef, lastError, isStopping, clearTerminal, stopTerminal, pasteText } = sessionControls;
	const canStop = summary?.state === "running" || summary?.state === "awaiting_review";
	// Only claude sessions get drag/paste-to-attachment (the surface understands
	// `@/path` mentions). Other CLI agents fall through to xterm's default paste.
	const attachmentsEnabled = Boolean(workspaceId) && agentSupportsFileAttachments(summary?.agentId);
	const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);

	const handleAttachmentFiles = useCallback(
		(files: File[]) => {
			if (!attachmentsEnabled || !workspaceId || files.length === 0) {
				return;
			}
			void processTerminalAttachments({
				files,
				upload: async (file) => {
					const data = await readFileAsBase64(file);
					if (data === null) {
						return { ok: false, error: `Could not read ${file.name || "file"}.` };
					}
					return await getRuntimeTrpcClient(workspaceId).runtime.writeTaskSessionAttachment.mutate({
						taskId,
						name: file.name || "attachment",
						data,
					});
				},
				inject: (text) => {
					pasteText(text);
				},
				onError: (message) => {
					showAppToast({ intent: "danger", message }, "terminal-attachment-error");
				},
			});
		},
		[attachmentsEnabled, pasteText, taskId, workspaceId],
	);

	const handleAttachmentDrop = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			if (!attachmentsEnabled) {
				return;
			}
			const files = collectFilesFromDataTransfer(event.dataTransfer);
			if (files.length === 0) {
				setIsAttachmentDragOver(false);
				return;
			}
			event.preventDefault();
			setIsAttachmentDragOver(false);
			handleAttachmentFiles(files);
		},
		[attachmentsEnabled, handleAttachmentFiles],
	);

	// Paste-to-attachment must be a CAPTURE-phase NATIVE listener on the terminal
	// container: xterm registers its own bubble-phase `paste` handlers directly on
	// its textarea/element and calls `stopPropagation()`, so React's
	// `onPasteCapture` on an outer div never sees a file paste. Attaching on the
	// container (an ancestor of xterm's textarea) with `capture: true` runs before
	// xterm's target-phase handlers; `handleTerminalPasteEvent` then intercepts
	// file/image pastes and lets plain text fall through to xterm untouched.
	useEffect(() => {
		const container = containerRef.current;
		if (!attachmentsEnabled || !container) {
			return;
		}
		const onNativePaste = (event: globalThis.ClipboardEvent): void => {
			handleTerminalPasteEvent(event, handleAttachmentFiles);
		};
		container.addEventListener("paste", onNativePaste, { capture: true });
		return () => {
			container.removeEventListener("paste", onNativePaste, { capture: true });
		};
	}, [attachmentsEnabled, containerRef, handleAttachmentFiles]);
	const statusLabel = useMemo(() => describeState(summary), [summary]);
	const statusTagStyle = useMemo(() => getStateTagStyle(summary), [summary]);
	const agentLabel = useMemo(() => {
		const normalizedCommand = agentCommand?.trim();
		if (!normalizedCommand) {
			return null;
		}
		return normalizedCommand.split(/\s+/)[0] ?? null;
	}, [agentCommand]);
	const isTerminalEmpty = !summary?.lastOutputAt && summary?.state !== "running" && summary?.state !== "idle";
	const sessionErrorMessage =
		lastError ??
		(summary?.state === "failed"
			? (summary.warningMessage ?? "Session failed to start.")
			: isTerminalEmpty && summary?.pid === null
				? "Agent exited without producing output. Check that the required API key is configured and try again."
				: null);

	return (
		<div
			style={{
				display: "flex",
				flex: "1 1 0",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				background: panelBackgroundColor,
			}}
		>
			{showSessionToolbar ? (
				<>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "8px 12px",
						}}
					>
						<div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
							<span
								className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusTagColors[statusTagStyle]}`}
							>
								{statusLabel}
							</span>
						</div>
						<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
							<Button variant="default" size="sm" onClick={clearTerminal}>
								Clear
							</Button>
							<Button
								variant="default"
								size="sm"
								onClick={() => {
									void stopTerminal();
								}}
								disabled={!canStop || isStopping}
							>
								Stop
							</Button>
						</div>
					</div>
					<div className="h-px bg-border" />
				</>
			) : onClose ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "6px 0 0 3px",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
						<span className="text-text-secondary" style={{ fontSize: 12 }}>
							{minimalHeaderTitle}
						</span>
						{minimalHeaderSubtitle ? (
							<span
								className="truncate font-mono text-text-secondary"
								style={{ fontSize: 10 }}
								title={minimalHeaderSubtitle}
							>
								{minimalHeaderSubtitle}
							</span>
						) : null}
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 2, marginRight: "-6px" }}>
						{agentLabel && onSendAgentCommand ? (
							<Tooltip side="top" content={`Run ${agentLabel}`}>
								<Button
									icon={<MessageSquare size={12} />}
									variant="ghost"
									size="sm"
									onClick={onSendAgentCommand}
									aria-label={`Run ${agentLabel}`}
								/>
							</Tooltip>
						) : null}
						{onToggleExpand ? (
							<Tooltip
								side="top"
								content={
									<span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
										<span>{isExpanded ? "Collapse" : "Expand"}</span>
										<span
											style={{ display: "inline-flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}
										>
											<span>(</span>
											{isMacPlatform ? <Command size={11} /> : <span style={{ fontSize: 11 }}>Ctrl</span>}
											<span>+ M)</span>
										</span>
									</span>
								}
							>
								<Button
									icon={isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
									variant="ghost"
									size="sm"
									onClick={onToggleExpand}
									aria-label={isExpanded ? "Collapse terminal" : "Expand terminal"}
								/>
							</Tooltip>
						) : null}
						<Button
							icon={<X size={14} />}
							variant="ghost"
							size="sm"
							onClick={onClose}
							aria-label="Close terminal"
						/>
					</div>
				</div>
			) : null}
			<div
				style={{
					flex: "1 1 0",
					minHeight: 0,
					overflow: "hidden",
					padding: "3px 1.5px 3px 3px",
					position: "relative",
				}}
				onDragEnter={
					attachmentsEnabled
						? (event) => {
								event.preventDefault();
								setIsAttachmentDragOver(true);
							}
						: undefined
				}
				onDragOver={
					attachmentsEnabled
						? (event) => {
								event.preventDefault();
								setIsAttachmentDragOver(true);
							}
						: undefined
				}
				onDragLeave={
					attachmentsEnabled
						? (event) => {
								if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
									return;
								}
								setIsAttachmentDragOver(false);
							}
						: undefined
				}
				onDrop={attachmentsEnabled ? handleAttachmentDrop : undefined}
			>
				<div
					ref={containerRef}
					className="kb-terminal-container"
					style={{ height: "100%", width: "100%", background: terminalBackgroundColor }}
				/>
				{isAttachmentDragOver ? (
					<div
						style={{
							position: "absolute",
							inset: 3,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							borderRadius: 6,
							border: "2px dashed var(--color-accent)",
							background: "rgba(0, 132, 255, 0.08)",
							color: "var(--color-text-primary)",
							fontSize: 13,
							pointerEvents: "none",
							zIndex: 2,
						}}
					>
						Drop to attach — the file path is inserted for the agent to read.
					</div>
				) : null}
				{!summary && !lastError && !sessionErrorMessage ? (
					<div
						style={{
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							gap: 8,
							background: "rgba(0, 0, 0, 0.3)",
							zIndex: 1,
						}}
					>
						<Spinner size={16} />
						<span style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>Starting session…</span>
					</div>
				) : null}
			</div>
			{sessionErrorMessage ? (
				<div className="flex gap-2 rounded-none border-t border-status-red/30 bg-status-red/10 p-3 text-[13px] text-status-red">
					{sessionErrorMessage}
				</div>
			) : null}
			{showMoveToTrash && onMoveToTrash ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 12px" }}>
					<AgentTerminalReviewActions
						taskId={taskId}
						taskColumnId={taskColumnId}
						onCommit={onCommit}
						onOpenPr={onOpenPr}
						isCommitLoading={isCommitLoading}
						isOpenPrLoading={isOpenPrLoading}
					/>
					{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
						<Button variant="default" fill onClick={onCancelAutomaticAction}>
							{cancelAutomaticActionLabel}
						</Button>
					) : null}
					<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
						{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function AgentTerminalPanel(props: AgentTerminalPanelProps): ReactElement {
	// enabled gates whether this panel should keep a live persistent terminal connection.
	// We disable it for non-active task contexts so backlog and trash views do not keep extra websocket sockets open.
	const sessionControls = usePersistentTerminalSession({
		taskId: props.taskId,
		workspaceId: props.workspaceId,
		enabled: props.terminalEnabled ?? true,
		onSummary: props.onSummary,
		onConnectionReady: props.onConnectionReady,
		autoFocus: props.autoFocus,
		isVisible: props.isVisible,
		sessionStartedAt: props.summary?.startedAt ?? null,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
	});

	return <AgentTerminalPanelLayout {...props} sessionControls={sessionControls} />;
}
