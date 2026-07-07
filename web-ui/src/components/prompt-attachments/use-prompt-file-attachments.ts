import { safeRandomUUID } from "@runtime-safe-uuid";
import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { buildAttachmentMentionText, readFileAsBase64 } from "@/terminal/terminal-attachment-drop";

/** A non-image file attachment persisted to the workspace and shown as a chip. */
export interface PromptAttachment {
	id: string;
	/** Display name (original filename) shown on the chip. */
	name: string;
	/** Absolute on-disk path the file was written to. */
	path: string;
	/** The `@/path ` mention text — used by callers that inject it into the prompt. */
	mentionText: string;
}

export interface UsePromptFileAttachmentsOptions {
	/** Workspace whose repo root the files are written into. Null disables uploads. */
	workspaceId: string | null;
	/**
	 * The attachment scope id — a home thread id or a task id, minted up front by
	 * the caller so the files land in the owner's FINAL scope and are cleaned up
	 * when that owner is removed. When it changes, the collected chips reset.
	 */
	scopeId: string;
	/** Whether the collect channel is active (agent supports `@`-mentions + workspace present). */
	enabled: boolean;
	/** Toast de-dupe id for upload errors. */
	toastId?: string;
	/** Invoked after a successful upload (e.g. to inject the mention into the prompt). */
	onAttached?: (attachment: PromptAttachment) => void;
	/** Invoked when a chip is removed (e.g. to strip its mention from the prompt). */
	onRemoved?: (attachment: PromptAttachment) => void;
}

export interface UsePromptFileAttachmentsResult {
	attachments: PromptAttachment[];
	handleFilesSelected: (files: File[]) => void;
	handleRemoveAttachment: (id: string) => void;
	/**
	 * Record whether the current scope was committed to an owner. When submitted,
	 * {@link cleanupOrphanScope} leaves it alone. Pass `false` to roll back after a
	 * failed create so a later cancel still cleans up.
	 */
	markSubmitted: (submitted?: boolean) => void;
	/** Best-effort delete of the current scope's uploads unless it was submitted. */
	cleanupOrphanScope: () => void;
	/**
	 * Drop every collected chip and best-effort delete their uploads. Used when the
	 * attachment channel is turned off with files still staged (e.g. switching to an
	 * agent that can't consume them) so nothing orphans on disk.
	 */
	clearAttachments: () => void;
}

/**
 * Shared collection logic for non-image file attachments in prompt composers.
 * Uploads dropped/pasted files into `<repoRoot>/.kanban/attachments/<scopeId>/`
 * via the workspace-scoped mutation, tracks them as removable chips, and hands
 * back the persisted `@/path` so callers can inject a mention (at upload time)
 * or defer it (task create, where the mention is injected at launch by the
 * backend once the worktree exists). Cleanup of an abandoned scope (dialog
 * cancelled before submit) is exposed via {@link cleanupOrphanScope}.
 */
export function usePromptFileAttachments(options: UsePromptFileAttachmentsOptions): UsePromptFileAttachmentsResult {
	const { workspaceId, scopeId, enabled, toastId = "prompt-attachment-error" } = options;
	const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
	// Was the current scope committed to an owner? Cleared whenever the scope changes.
	const submittedRef = useRef(false);

	// Keep callbacks in refs so the handlers stay stable and never fire stale closures.
	const onAttachedRef = useRef(options.onAttached);
	const onRemovedRef = useRef(options.onRemoved);
	onAttachedRef.current = options.onAttached;
	onRemovedRef.current = options.onRemoved;

	// A new scope (new task/thread) starts with a clean chip list. The previous
	// scope, if any, is owned by whatever was just created — never deleted here.
	useEffect(() => {
		setAttachments([]);
		submittedRef.current = false;
	}, [scopeId]);

	const handleFilesSelected = useCallback(
		(files: File[]) => {
			if (!enabled || !workspaceId || files.length === 0) {
				return;
			}
			// Upload sequentially so injected mentions land in a stable order.
			void (async () => {
				for (const file of files) {
					const fileName = file.name || "attachment";
					const data = await readFileAsBase64(file);
					if (data === null) {
						showAppToast({ intent: "danger", message: `Could not read ${fileName}.` }, toastId);
						continue;
					}
					let result: { ok: boolean; path?: string; error?: string };
					try {
						result = await getRuntimeTrpcClient(workspaceId).runtime.writeWorkspaceAttachment.mutate({
							scopeId,
							name: fileName,
							data,
						});
					} catch (error) {
						result = { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
					if (result.ok && result.path) {
						const attachment: PromptAttachment = {
							id: safeRandomUUID(),
							name: fileName,
							path: result.path,
							mentionText: buildAttachmentMentionText(result.path),
						};
						setAttachments((prev) => [...prev, attachment]);
						onAttachedRef.current?.(attachment);
					} else {
						showAppToast({ intent: "danger", message: result.error ?? `Could not attach ${fileName}.` }, toastId);
					}
				}
			})();
		},
		[enabled, workspaceId, scopeId, toastId],
	);

	const handleRemoveAttachment = useCallback((id: string) => {
		setAttachments((prev) => {
			const chip = prev.find((attachment) => attachment.id === id);
			if (chip) {
				onRemovedRef.current?.(chip);
			}
			return prev.filter((attachment) => attachment.id !== id);
		});
	}, []);

	const markSubmitted = useCallback((submitted = true) => {
		submittedRef.current = submitted;
	}, []);

	const cleanupOrphanScope = useCallback(() => {
		if (submittedRef.current || !workspaceId || attachments.length === 0) {
			return;
		}
		void getRuntimeTrpcClient(workspaceId)
			.runtime.deleteWorkspaceAttachmentScope.mutate({ scopeId })
			.catch(() => {
				// Best-effort cleanup; a failed delete just leaves a small orphan dir.
			});
	}, [workspaceId, scopeId, attachments.length]);

	const clearAttachments = useCallback(() => {
		if (workspaceId && attachments.length > 0 && !submittedRef.current) {
			void getRuntimeTrpcClient(workspaceId)
				.runtime.deleteWorkspaceAttachmentScope.mutate({ scopeId })
				.catch(() => {
					// Best-effort cleanup; a failed delete just leaves a small orphan dir.
				});
		}
		setAttachments([]);
	}, [workspaceId, scopeId, attachments.length]);

	return {
		attachments,
		handleFilesSelected,
		handleRemoveAttachment,
		markSubmitted,
		cleanupOrphanScope,
		clearAttachments,
	};
}
