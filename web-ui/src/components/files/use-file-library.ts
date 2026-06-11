import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileItem } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

import { readFileAsUploadPayload } from "./file-upload-utils";

const EMPTY_FILES: RuntimeFileItem[] = [];

export interface UploadResult {
	added: RuntimeFileItem[];
	skipped: string[];
}

export interface UseFileLibraryResult {
	files: RuntimeFileItem[];
	isLoading: boolean;
	errorMessage: string | null;
	refetch: () => Promise<void>;
	uploadFiles: (files: File[]) => Promise<UploadResult>;
	renameFile: (id: string, name: string) => Promise<RuntimeFileItem | null>;
	deleteFile: (id: string) => Promise<boolean>;
	isMutating: boolean;
}

/**
 * Owns the file-library data for a workspace: lists via `workspace.listFiles` and exposes
 * CRUD mutations that refetch the list afterwards. The backend is the source of truth (files
 * are not part of the workspace-state save payload), so this hook is self-contained.
 */
export function useFileLibrary(workspaceId: string | null): UseFileLibraryResult {
	const [isMutating, setIsMutating] = useState(false);

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		return await getRuntimeTrpcClient(workspaceId).workspace.listFiles.query();
	}, [workspaceId]);

	const query = useTrpcQuery({
		enabled: workspaceId !== null,
		queryFn,
		retainDataOnError: true,
	});

	const refetch = useCallback(async () => {
		await query.refetch();
	}, [query]);

	const uploadFiles = useCallback(
		async (incoming: File[]): Promise<UploadResult> => {
			if (!workspaceId || incoming.length === 0) {
				return { added: [], skipped: [] };
			}
			const client = getRuntimeTrpcClient(workspaceId);
			const added: RuntimeFileItem[] = [];
			const skipped: string[] = [];
			setIsMutating(true);
			try {
				for (const file of incoming) {
					const payload = await readFileAsUploadPayload(file);
					if (!payload) {
						skipped.push(file.name || "untitled");
						continue;
					}
					const result = await client.workspace.addFile.mutate({
						name: payload.name,
						data: payload.data,
						mime: payload.mime || undefined,
					});
					added.push(result.file);
				}
			} finally {
				setIsMutating(false);
			}
			await refetch();
			return { added, skipped };
		},
		[workspaceId, refetch],
	);

	const renameFile = useCallback(
		async (id: string, name: string): Promise<RuntimeFileItem | null> => {
			const trimmed = name.trim();
			if (!workspaceId || !trimmed) {
				return null;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.updateFile.mutate({ id, name: trimmed });
				await refetch();
				return result.file;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	const deleteFile = useCallback(
		async (id: string): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.deleteFile.mutate({ id });
				await refetch();
				return result.deleted;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	return {
		files: query.data?.files ?? EMPTY_FILES,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load files.") : null,
		refetch,
		uploadFiles,
		renameFile,
		deleteFile,
		isMutating,
	};
}
