import { safeRandomUUID } from "@runtime-safe-uuid";
import { Check, FileText, MessageSquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { AgentAvatar } from "@/components/home-agent/agent-icon";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { agentSupportsFileAttachments } from "@/runtime/attachment-agents";
import { isNativeAgentSelected } from "@/runtime/native-agent";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";
import { buildAttachmentMentionText, readFileAsBase64 } from "@/terminal/terminal-attachment-drop";
import type { TaskImage } from "@/types";
import { isMacPlatform } from "@/utils/platform";

/** A file attachment persisted to disk and mentioned as `@/path` in the prompt. */
interface PromptAttachment {
	id: string;
	/** Display name (original filename) shown on the chip. */
	name: string;
	/** Absolute on-disk path the mention points at. */
	path: string;
	/** Exact `@/path ` text injected into the prompt, so removal can strip it. */
	mentionText: string;
}

/** Append a mention to the prompt, keeping a single separating space. */
function appendMentionToPrompt(prompt: string, mention: string): string {
	if (prompt.length === 0 || /\s$/.test(prompt)) {
		return `${prompt}${mention}`;
	}
	return `${prompt} ${mention}`;
}

/**
 * Remove the first occurrence of an injected mention from the prompt. Falls back to
 * the space-trimmed form in case the user edited the trailing space away.
 */
function removeMentionFromPrompt(prompt: string, mention: string): string {
	const index = prompt.indexOf(mention);
	if (index >= 0) {
		return `${prompt.slice(0, index)}${prompt.slice(index + mention.length)}`;
	}
	const trimmed = mention.trimEnd();
	const trimmedIndex = trimmed.length > 0 ? prompt.indexOf(trimmed) : -1;
	if (trimmedIndex >= 0) {
		return `${prompt.slice(0, trimmedIndex)}${prompt.slice(trimmedIndex + trimmed.length)}`;
	}
	return prompt;
}

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
	const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
	const [agentId, setAgentId] = useState<RuntimeAgentId | null>(resolvedDefaultAgentId);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (open) {
			setDescription("");
			setImages([]);
			setAttachments([]);
			setAgentId(resolvedDefaultAgentId);
			setIsSubmitting(false);
		}
	}, [open, resolvedDefaultAgentId]);

	// Non-image file attachments are only meaningful for CLI agents that read
	// `@/path` mentions (currently claude) and only with a workspace to write into.
	// The file lands in the workspace repo root's `.kanban/attachments/`, which is
	// exactly the cwd this thread's session will run in, so the mention resolves.
	const attachmentsEnabled = Boolean(workspaceId) && agentSupportsFileAttachments(agentId);

	const handleFilesSelected = useCallback(
		(files: File[]) => {
			if (!attachmentsEnabled || !workspaceId || files.length === 0) {
				return;
			}
			// Upload sequentially so injected mentions land in a stable order.
			void (async () => {
				for (const file of files) {
					const fileName = file.name || "attachment";
					const data = await readFileAsBase64(file);
					if (data === null) {
						showAppToast(
							{ intent: "danger", message: `Could not read ${fileName}.` },
							"home-thread-attachment-error",
						);
						continue;
					}
					let result: { ok: boolean; path?: string; error?: string };
					try {
						result = await getRuntimeTrpcClient(workspaceId).runtime.writeWorkspaceAttachment.mutate({
							name: fileName,
							data,
						});
					} catch (error) {
						result = { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
					if (result.ok && result.path) {
						const path = result.path;
						const mentionText = buildAttachmentMentionText(path);
						setDescription((prev) => appendMentionToPrompt(prev, mentionText));
						setAttachments((prev) => [...prev, { id: safeRandomUUID(), name: fileName, path, mentionText }]);
					} else {
						showAppToast(
							{ intent: "danger", message: result.error ?? `Could not attach ${fileName}.` },
							"home-thread-attachment-error",
						);
					}
				}
			})();
		},
		[attachmentsEnabled, workspaceId],
	);

	const handleRemoveAttachment = useCallback(
		(id: string) => {
			const chip = attachments.find((attachment) => attachment.id === id);
			setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
			if (chip) {
				setDescription((prev) => removeMentionFromPrompt(prev, chip.mentionText));
			}
		},
		[attachments],
	);

	const trimmedDescription = description.trim();
	const canSubmit = trimmedDescription.length > 0 && !isSubmitting && agentId !== null;

	const handleSubmit = async () => {
		if (!canSubmit || agentId === null) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onCreate({ description: trimmedDescription, agentId, images: images.length > 0 ? images : undefined });
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
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
					{attachments.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{attachments.map((attachment) => (
								<span
									key={attachment.id}
									className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-secondary"
								>
									<FileText size={13} className="shrink-0 text-text-tertiary" />
									<span className="max-w-[180px] truncate" title={attachment.path}>
										{attachment.name}
									</span>
									<button
										type="button"
										onClick={() => handleRemoveAttachment(attachment.id)}
										aria-label={`Remove ${attachment.name}`}
										className="shrink-0 cursor-pointer text-text-tertiary transition-colors hover:text-text-primary"
									>
										<X size={12} />
									</button>
								</span>
							))}
						</div>
					) : null}
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
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
					Create
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
