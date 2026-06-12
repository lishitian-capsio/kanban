import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeVaultFrontmatterValue } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

import { toVaultDoc, type VaultDoc } from "./vault-doc-model";

const EMPTY_DOCS: VaultDoc[] = [];

export interface CreateVaultDocInput {
	type: string;
	title: string;
	body?: string;
	frontmatter?: Record<string, RuntimeVaultFrontmatterValue>;
}

export interface VaultDocPatch {
	title?: string;
	body?: string;
	/** Merged key-wise with the existing frontmatter by the store. */
	frontmatter?: Record<string, RuntimeVaultFrontmatterValue>;
}

export interface UseVaultDocsResult {
	docs: VaultDoc[];
	isLoading: boolean;
	errorMessage: string | null;
	refetch: () => Promise<void>;
	createDoc: (input: CreateVaultDocInput) => Promise<VaultDoc | null>;
	updateDoc: (id: string, patch: VaultDocPatch) => Promise<VaultDoc | null>;
	deleteDoc: (id: string) => Promise<boolean>;
	isMutating: boolean;
}

/**
 * Owns the vault-document data for one type in a workspace: lists via
 * `workspace.listDocuments` and exposes CRUD mutations that refetch afterwards.
 * Self-contained (docs are not part of the workspace-state save payload), exactly
 * like `useFileLibrary`. Pass `type=null` to keep the hook idle (e.g. on the
 * "All files" tab where the binary library renders instead).
 */
export function useVaultDocs(workspaceId: string | null, type: string | null): UseVaultDocsResult {
	const [isMutating, setIsMutating] = useState(false);

	const enabled = workspaceId !== null && type !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId || !type) {
			throw new Error("Missing workspace or document type.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.listDocuments.query({ type });
		return result.documents.map(toVaultDoc);
	}, [workspaceId, type]);

	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: true });

	const refetch = useCallback(async () => {
		await query.refetch();
	}, [query]);

	const createDoc = useCallback(
		async (input: CreateVaultDocInput): Promise<VaultDoc | null> => {
			if (!workspaceId) {
				return null;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.createDocument.mutate({
					type: input.type,
					title: input.title,
					body: input.body,
					frontmatter: input.frontmatter,
				});
				await refetch();
				return toVaultDoc(result.document);
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	const updateDoc = useCallback(
		async (id: string, patch: VaultDocPatch): Promise<VaultDoc | null> => {
			if (!workspaceId) {
				return null;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.updateDocument.mutate({
					id,
					title: patch.title,
					body: patch.body,
					frontmatter: patch.frontmatter,
				});
				await refetch();
				return toVaultDoc(result.document);
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	const deleteDoc = useCallback(
		async (id: string): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.deleteDocument.mutate({ id });
				await refetch();
				return result.deleted;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	return {
		docs: query.data ?? EMPTY_DOCS,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load documents.") : null,
		refetch,
		createDoc,
		updateDoc,
		deleteDoc,
		isMutating,
	};
}
