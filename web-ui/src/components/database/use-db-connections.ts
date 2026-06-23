import { useCallback, useState } from "react";

import type {
	RuntimeDbConnection,
	RuntimeDbTestConnectionRequest,
	RuntimeDbTestConnectionResponse,
	RuntimeDbUpsertConnectionRequest,
} from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseDbConnectionsResult {
	connections: RuntimeDbConnection[];
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	refetch: () => Promise<void>;
	upsertConnection: (input: RuntimeDbUpsertConnectionRequest) => Promise<RuntimeDbConnection>;
	deleteConnection: (connId: string) => Promise<boolean>;
	testConnection: (input: RuntimeDbTestConnectionRequest) => Promise<RuntimeDbTestConnectionResponse>;
}

/** Connection registry CRUD + connectivity test, via the self-contained `database` tRPC router. */
export function useDbConnections(workspaceId: string | null): UseDbConnectionsResult {
	const [isMutating, setIsMutating] = useState(false);

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		return await getRuntimeTrpcClient(workspaceId).database.listConnections.query();
	}, [workspaceId]);

	const query = useTrpcQuery({ enabled: workspaceId !== null, queryFn, retainDataOnError: true });
	const { refetch: rawRefetch } = query;
	const refetch = useCallback(async () => {
		await rawRefetch();
	}, [rawRefetch]);

	const upsertConnection = useCallback(
		async (input: RuntimeDbUpsertConnectionRequest) => {
			if (!workspaceId) {
				throw new Error("Missing workspace.");
			}
			setIsMutating(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).database.upsertConnection.mutate(input);
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
				const result = await getRuntimeTrpcClient(workspaceId).database.deleteConnection.mutate({ connId });
				await rawRefetch();
				return result.deleted;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, rawRefetch],
	);

	const testConnection = useCallback(
		async (input: RuntimeDbTestConnectionRequest) => {
			if (!workspaceId) {
				throw new Error("Missing workspace.");
			}
			return await getRuntimeTrpcClient(workspaceId).database.testConnection.mutate(input);
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
