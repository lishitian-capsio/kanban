import { useCallback, useState } from "react";

import type {
	RuntimeStorageConnection,
	RuntimeStorageTestConnectionResponse,
	RuntimeStorageUpsertConnectionRequest,
} from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseStorageConnectionsResult {
	connections: RuntimeStorageConnection[];
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	refetch: () => Promise<void>;
	upsertConnection: (input: RuntimeStorageUpsertConnectionRequest) => Promise<RuntimeStorageConnection>;
	deleteConnection: (connId: string) => Promise<boolean>;
	testConnection: (connId: string) => Promise<RuntimeStorageTestConnectionResponse>;
}

/** Connection registry CRUD + connectivity test, via the self-contained `storage` tRPC router. */
export function useStorageConnections(workspaceId: string | null): UseStorageConnectionsResult {
	const [isMutating, setIsMutating] = useState(false);

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		return await getRuntimeTrpcClient(workspaceId).storage.listConnections.query();
	}, [workspaceId]);

	const query = useTrpcQuery({ enabled: workspaceId !== null, queryFn, retainDataOnError: true });
	const { refetch: rawRefetch } = query;
	const refetch = useCallback(async () => {
		await rawRefetch();
	}, [rawRefetch]);

	const upsertConnection = useCallback(
		async (input: RuntimeStorageUpsertConnectionRequest) => {
			if (!workspaceId) {
				throw new Error("Missing workspace.");
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).storage.upsertConnection.mutate(input);
				await rawRefetch();
				return result.connection;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, rawRefetch],
	);

	const deleteConnection = useCallback(
		async (connId: string) => {
			if (!workspaceId) {
				throw new Error("Missing workspace.");
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).storage.deleteConnection.mutate({ connId });
				await rawRefetch();
				return result.deleted;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, rawRefetch],
	);

	const testConnection = useCallback(
		async (connId: string) => {
			if (!workspaceId) {
				throw new Error("Missing workspace.");
			}
			return await getRuntimeTrpcClient(workspaceId).storage.testConnection.mutate({ connId });
		},
		[workspaceId],
	);

	return {
		connections: query.data?.connections ?? [],
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Failed to load connections.") : null,
		isMutating,
		refetch,
		upsertConnection,
		deleteConnection,
		testConnection,
	};
}
