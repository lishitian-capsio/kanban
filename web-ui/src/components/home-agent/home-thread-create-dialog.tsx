import { safeRandomUUID } from "@runtime-safe-uuid";
import { Check, MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { AgentAvatar } from "@/components/home-agent/agent-icon";
import { PromptAttachmentChips } from "@/components/prompt-attachments/prompt-attachment-chips";
import {
	appendMentionToPrompt,
	removeMentionFromPrompt,
} from "@/components/prompt-attachments/prompt-attachment-mentions";
import type { PromptAttachment } from "@/components/prompt-attachments/use-prompt-file-attachments";
import { usePromptFileAttachments } from "@/components/prompt-attachments/use-prompt-file-attachments";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { agentSupportsFileAttachments } from "@/runtime/attachment-agents";
import { isNativeAgentSelected } from "@/runtime/native-agent";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";
import type { TaskImage } from "@/types";
import { isMacPlatform } from "@/utils/platform";

interface HomeThreadCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	/**
	 * Workspace scope that powers the opening prompt's `@` file mentions. Without
	 * it the composer still works but the mention completion stays inert. (Slash
	 * commands are intentionally disabled here — see the composer below.)
	 */
	workspaceId?: string | null;
	onCreate: (input: {
		/**
		 * Client-generated thread id. Pre-session attachments are uploaded into this
		 * thread's attachments scope BEFORE it exists, so the created thread must adopt
		 * the same id for the injected `@/path` mentions to resolve and for the files to
		 * be cleaned up on close.
		 */
		threadId: string;
		description: string;
		agentId: RuntimeAgentId;
		images?: TaskImage[];
	}) => void | Promise<unknown>;
}

export function HomeThreadCreateDialog({
	open,
	onOpenChange,
	agents,
	defaultAgentId,
	workspaceId = null,
	onCreate,
}: HomeThreadCreateDialogProps): React.ReactElement {
	// The native/main agent (pi) is always running and singular, so threads can
	// only be created for the additional CLI agents.
	const selectableAgents = useMemo(() => agents.filter((agent) => !isNativeAgentSelected(agent.id)), [agents]);

	// Fall back to the first selectable agent when the incoming default is the
	// native agent (or otherwise not selectable), so the form never opens with a
	// hidden or empty selection.
	const resolvedDefaultAgentId = useMemo<RuntimeAgentId | null>(() => {
		if (selectableAgents.some((agent) => agent.id === defaultAgentId)) {
			return defaultAgentId;
		}
		return selectableAgents[0]?.id ?? null;
	}, [selectableAgents, defaultAgentId]);

	const descriptionId = useId();
	const descriptionHelpId = useId();
	const [description, setDescription] = useState("");
	const [images, setImages] = useState<TaskImage[]>([]);
	const [agentId, setAgentId] = useState<RuntimeAgentId | null>(resolvedDefaultAgentId);
	const [isSubmitting, setIsSubmitting] = useState(false);
	// The thread id is minted up front so pre-session attachments upload into this
	// thread's FINAL attachments scope; the created thread adopts the same id.
	const [threadId, setThreadId] = useState<string>(() => safeRandomUUID());

	// Non-image file attachments are only meaningful for CLI agents that read
	// `@/path` mentions (currently claude) and only with a workspace to write into.
	// The file lands in the workspace repo root's `.kanban/attachments/`, which is
	// exactly the cwd this thread's session will run in, so the mention resolves —
	// so here (unlike the task create dialog) the mention is injected at UPLOAD time.
	const attachmentsEnabled = Boolean(workspaceId) && agentSupportsFileAttachments(agentId);

	const { attachments, handleFilesSelected, handleRemoveAttachment, markSubmitted, cleanupOrphanScope } =
		usePromptFileAttachments({
			workspaceId,
			scopeId: threadId,
			enabled: attachmentsEnabled,
			toastId: "home-thread-attachment-error",
			onAttached: useCallback((attachment: PromptAttachment) => {
				setDescription((prev) => appendMentionToPrompt(prev, attachment.mentionText));
			}, []),
			onRemoved: useCallback((attachment: PromptAttachment) => {
				setDescription((prev) => removeMentionFromPrompt(prev, attachment.mentionText));
			}, []),
		});

	// Reset the form each time the dialog opens (with a fresh thread id). The
	// attachment chips reset themselves when the thread id (scope) changes.
	useEffect(() => {
		if (open) {
			setDescription("");
			setImages([]);
			setAgentId(resolvedDefaultAgentId);
			setIsSubmitting(false);
			setThreadId(safeRandomUUID());
		}
	}, [open, resolvedDefaultAgentId]);

	const trimmedDescription = description.trim();
	const canSubmit = trimmedDescription.length > 0 && !isSubmitting && agentId !== null;

	const handleSubmit = async () => {
		if (!canSubmit || agentId === null) {
			return;
		}
		setIsSubmitting(true);
		try {
			// Mark submitted first so the ensuing close doesn't delete the attachments
			// scope the new thread now owns.
			markSubmitted();
			await onCreate({
				threadId,
				description: trimmedDescription,
				agentId,
				images: images.length > 0 ? images : undefined,
			});
			onOpenChange(false);
		} catch (error) {
			// Creation failed: the thread doesn't exist, so the pre-session uploads are
			// orphaned — allow the next close to clean them up.
			markSubmitted(false);
			showAppToast(
				{ intent: "danger", message: error instanceof Error ? error.message : String(error) },
				"home-thread-create-error",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	// Cancelling the dialog after uploading (but not submitting) would orphan the
	// files in `.kanban/attachments/<threadId>/` — no thread will ever adopt the scope
	// to clean it on close. Delete the scope on that cancel, best-effort.
	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) {
				cleanupOrphanScope();
			}
			onOpenChange(next);
		},
		[cleanupOrphanScope, onOpenChange],
	);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange} contentClassName="max-w-md">
			<DialogHeader title="New chat thread" icon={<MessageSquarePlus size={16} />} />
			<DialogBody className="flex flex-col gap-5">
				<div className="flex flex-col gap-2">
					<label htmlFor={descriptionId} className="text-[12px] font-medium text-text-secondary">
						Opening prompt
					</label>
					{/* Reuse the task composer so the kickoff prompt gets the same
					    affordances as the in-conversation chat input: image paste
					    (⌘/Ctrl+V), drag-and-drop, an attach-image button + thumbnail
					    strip, and `@` file mentions. Passing the workspace scope
					    enables the mention completion; Enter inserts a newline,
					    ⌘/Ctrl+Enter submits. Slash commands are intentionally left
					    off here (no `enableSlashCommands`) — a kickoff prompt doesn't
					    run `/` commands, so the menu would only be noise. */}
					<TaskPromptComposer
						id={descriptionId}
						value={description}
						onValueChange={setDescription}
						images={images}
						onImagesChange={setImages}
						onFilesSelected={attachmentsEnabled ? handleFilesSelected : undefined}
						onSubmit={() => void handleSubmit()}
						placeholder="Describe the work, question, or next step for this thread..."
						disabled={isSubmitting}
						autoFocus
						workspaceId={workspaceId}
					/>
					<PromptAttachmentChips attachments={attachments} onRemove={handleRemoveAttachment} />
					<p id={descriptionHelpId} className="text-[11px] text-text-tertiary">
						The thread's agent works from this opening prompt and names the thread itself. Type{" "}
						<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">@</code> to reference files.
						Paste or drag images{attachmentsEnabled ? " or files" : ""} to attach them.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<span className="text-[12px] font-medium text-text-secondary">Agent</span>
					{selectableAgents.length === 0 ? (
						<p className="rounded-md border border-dashed border-border bg-surface-2 px-2.5 py-2 text-[12px] text-text-tertiary">
							No additional agents are available.
						</p>
					) : (
						<div className="flex flex-wrap gap-2">
							{selectableAgents.map((agent) => {
								const selected = agent.id === agentId;
								return (
									<button
										key={agent.id}
										type="button"
										aria-pressed={selected}
										onClick={() => setAgentId(agent.id)}
										className={cn(
											"inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
											selected
												? "border-accent bg-accent/10 text-text-primary"
												: "border-border bg-surface-2 text-text-secondary hover:border-border-bright hover:bg-surface-3 hover:text-text-primary",
										)}
									>
										{/* Agent-type identity (⑥): the same boxed avatar treatment, leading the label. */}
										<AgentAvatar agents={agents} agentId={agent.id} size="sm" />
										{agent.label}
										{selected ? <Check size={13} className="text-accent" /> : null}
									</button>
								);
							})}
						</div>
					)}
				</div>
			</DialogBody>
			<DialogFooter>
				<span className="mr-auto hidden items-center gap-1 text-[11px] text-text-tertiary sm:flex">
					<Kbd>{isMacPlatform ? "⌘" : "Ctrl"}</Kbd>
					<Kbd>↵</Kbd>
					to create
				</span>
				<Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
					Create
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
