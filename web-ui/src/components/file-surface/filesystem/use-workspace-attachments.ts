import { useCallback, useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkspaceAttachmentScope } from "@/runtime/types";
import { createLogger } from "@/utils/logger";

const log = createLogger("workspace-attachments");

export interface UseWorkspaceAttachmentsResult {
	/** Attachment scopes (sessions), each with its files, newest-first. */
	scopes: RuntimeWorkspaceAttachmentScope[];
	/** True during the initial load (not on background reloads). */
	isLoading: boolean;
	/** A load error message, or null. */
	errorMessage: string | null;
	/** Refetch the grouped listing. */
	reload: () => Promise<void>;
	/** Delete a single attachment file; resolves true on success. */
	deleteFile: (scopeId: string, fileName: string) => Promise<boolean>;
	/** Delete an entire scope directory (all of a session's attachments). */
	deleteScope: (scopeId: string) => Promise<boolean>;
}

/**
 * Read/manage the workspace's uploaded chat attachments, grouped by session via
 * the dedicated `runtime.listWorkspaceAttachments` / `deleteWorkspaceAttachment*`
 * endpoints. These are the ONLY window into `.kanban/attachments/` — the general
 * file explorer keeps all of `.kanban` hidden. Download/preview reuse the existing
 * `workspaceFs` read path (the returned repo-relative paths point into `.kanban`).
 */
export function useWorkspaceAttachments(workspaceId: string | null, active: boolean): UseWorkspaceAttachmentsResult {
	const [scopes, setScopes] = useState<RuntimeWorkspaceAttachmentScope[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [loadedOnce, setLoadedOnce] = useState(false);

	const reload = useCallback(async (): Promise<void> => {
		if (!workspaceId) {
			setScopes([]);
			return;
		}
		if (!loadedOnce) {
			setIsLoading(true);
		}
		try {
			const result = await getRuntimeTrpcClient(workspaceId).runtime.listWorkspaceAttachments.query();
			if (result.ok) {
				setScopes(result.scopes);
				setErrorMessage(null);
			} else {
				setErrorMessage(result.error ?? "Could not load attachments.");
			}
		} catch (error) {
			log.error("Failed to list workspace attachments", { workspaceId, error });
			setErrorMessage("Could not load attachments.");
		} finally {
			setIsLoading(false);
			setLoadedOnce(true);
		}
	}, [workspaceId, loadedOnce]);

	// Load when the surface becomes visible; refresh again on each re-open so newly
	// uploaded/removed files show up without a manual refresh.
	useEffect(() => {
		if (active && workspaceId) {
			void reload();
		}
	}, [active, workspaceId, reload]);

	const deleteFile = useCallback(
		async (scopeId: string, fileName: string): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			try {
				const result = await getRuntimeTrpcClient(workspaceId).runtime.deleteWorkspaceAttachment.mutate({
					scopeId,
					fileName,
				});
				if (!result.ok) {
					setErrorMessage(result.error ?? "Could not delete the attachment.");
					return false;
				}
				await reload();
				return true;
			} catch (error) {
				log.error("Failed to delete attachment", { workspaceId, scopeId, fileName, error });
				setErrorMessage("Could not delete the attachment.");
				return false;
			}
		},
		[workspaceId, reload],
	);

	const deleteScope = useCallback(
		async (scopeId: string): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			try {
				const result = await getRuntimeTrpcClient(workspaceId).runtime.deleteWorkspaceAttachmentScope.mutate({
					scopeId,
				});
				if (!result.ok) {
					setErrorMessage(result.error ?? "Could not delete the attachments.");
					return false;
				}
				await reload();
				return true;
			} catch (error) {
				log.error("Failed to delete attachment scope", { workspaceId, scopeId, error });
				setErrorMessage("Could not delete the attachments.");
				return false;
			}
		},
		[workspaceId, reload],
	);

	return { scopes, isLoading, errorMessage, reload, deleteFile, deleteScope };
}
