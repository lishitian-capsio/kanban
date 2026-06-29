import { useCallback, useEffect, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeVaultDocument } from "@/runtime/types";

export type FileDocLoadState = "loading" | "ready" | "error";
export type FileDocSaveState = "idle" | "saving" | "error";

export interface FileDocPatch {
	title?: string;
	body?: string;
}

export interface UseFileDocResult {
	loadState: FileDocLoadState;
	doc: RuntimeVaultDocument | null;
	loadErrorMessage: string | null;
	saveState: FileDocSaveState;
	save: (patch: FileDocPatch) => Promise<RuntimeVaultDocument | null>;
}

/**
 * Read + patch exactly ONE vault document by id, via the existing workspace
 * tRPC CRUD. Deliberately NOT a list hook — listing every doc of a type is
 * heavy and re-imports the browsing concern the File surface avoids. The
 * surface needs one `getDocument` read + one `updateDocument` patch.
 *
 * `updateDocument` has patch semantics: sending `{ id, title, body }` leaves
 * `frontmatter` untouched, so the surface edits body/title without any risk of
 * corrupting frontmatter (properties editing is a documented Phase 2 extension).
 */
export function useFileDoc(workspaceId: string | null, fileId: string | null): UseFileDocResult {
	const [loadState, setLoadState] = useState<FileDocLoadState>("loading");
	const [doc, setDoc] = useState<RuntimeVaultDocument | null>(null);
	const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<FileDocSaveState>("idle");

	useEffect(() => {
		if (!workspaceId || !fileId) {
			return;
		}
		let cancelled = false;
		setLoadState("loading");
		setLoadErrorMessage(null);
		setDoc(null);
		setSaveState("idle");
		void (async () => {
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.getDocument.query({ id: fileId });
				if (cancelled) {
					return;
				}
				if (!result.document) {
					setLoadState("error");
					setLoadErrorMessage("This file no longer exists.");
					return;
				}
				setDoc(result.document);
				setLoadState("ready");
			} catch (error) {
				if (cancelled) {
					return;
				}
				setLoadState("error");
				setLoadErrorMessage(error instanceof Error ? error.message : "Could not load the file.");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId, fileId]);

	const save = useCallback(
		async (patch: FileDocPatch): Promise<RuntimeVaultDocument | null> => {
			if (!workspaceId || !fileId) {
				return null;
			}
			setSaveState("saving");
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.updateDocument.mutate({
					id: fileId,
					title: patch.title,
					body: patch.body,
				});
				setDoc(result.document);
				setSaveState("idle");
				return result.document;
			} catch {
				setSaveState("error");
				return null;
			}
		},
		[workspaceId, fileId],
	);

	return { loadState, doc, loadErrorMessage, saveState, save };
}
