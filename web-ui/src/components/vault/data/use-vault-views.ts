import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeVaultFilterGroup,
	RuntimeVaultSort,
	RuntimeVaultView,
	RuntimeVaultViewLayout,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const EMPTY_VIEWS: RuntimeVaultView[] = [];

export interface CreateVaultViewInput {
	type: string;
	name: string;
	icon?: string | null;
	order?: number;
	layout?: RuntimeVaultViewLayout;
	sort?: RuntimeVaultSort | null;
	listPropertiesDisplay?: string[];
	filters?: RuntimeVaultFilterGroup;
}

export interface VaultViewPatch {
	name?: string;
	icon?: string | null;
	order?: number;
	layout?: RuntimeVaultViewLayout;
	sort?: RuntimeVaultSort | null;
	listPropertiesDisplay?: string[];
	filters?: RuntimeVaultFilterGroup;
}

export interface UseVaultViewsResult {
	views: RuntimeVaultView[];
	isLoading: boolean;
	errorMessage: string | null;
	refetch: () => Promise<void>;
	createView: (input: CreateVaultViewInput) => Promise<RuntimeVaultView | null>;
	updateView: (id: string, patch: VaultViewPatch) => Promise<RuntimeVaultView | null>;
	deleteView: (id: string) => Promise<boolean>;
	isMutating: boolean;
}

/**
 * Owns the saved-view data for one document type in a workspace: lists via
 * `workspace.listViews` and exposes CRUD mutations that refetch afterwards.
 * Mirrors {@link useVaultDocs}; views are self-contained (not part of the
 * workspace-state save payload). Pass `type=null` to keep the hook idle.
 */
export function useVaultViews(workspaceId: string | null, type: string | null): UseVaultViewsResult {
	const [isMutating, setIsMutating] = useState(false);
	const enabled = workspaceId !== null && type !== null;

	const queryFn = useCallback(async () => {
		if (!workspaceId || !type) {
			throw new Error("Missing workspace or document type.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.listViews.query({ type });
		return result.views;
	}, [workspaceId, type]);

	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: true });

	const refetch = useCallback(async () => {
		await query.refetch();
	}, [query]);

	const createView = useCallback(
		async (input: CreateVaultViewInput): Promise<RuntimeVaultView | null> => {
			if (!workspaceId) {
				return null;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.createView.mutate(input);
				await refetch();
				return result.view;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	const updateView = useCallback(
		async (id: string, patch: VaultViewPatch): Promise<RuntimeVaultView | null> => {
			if (!workspaceId) {
				return null;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.updateView.mutate({ id, ...patch });
				await refetch();
				return result.view;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	const deleteView = useCallback(
		async (id: string): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.deleteView.mutate({ id });
				await refetch();
				return result.deleted;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, refetch],
	);

	return {
		views: query.data ?? EMPTY_VIEWS,
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Could not load views.") : null,
		refetch,
		createView,
		updateView,
		deleteView,
		isMutating,
	};
}
