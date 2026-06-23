import { useCallback, useState } from "react";

import type { RuntimeDbColumnValue } from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export interface UseDbRowMutationsResult {
	isMutating: boolean;
	updateRow: (args: {
		schema: string;
		table: string;
		assignments: RuntimeDbColumnValue[];
		where: RuntimeDbColumnValue[];
	}) => Promise<number | null>;
	insertRow: (args: { schema: string; table: string; values: RuntimeDbColumnValue[] }) => Promise<number | null>;
	deleteRow: (args: { schema: string; table: string; where: RuntimeDbColumnValue[] }) => Promise<number | null>;
}

/** Structured row writes (UPDATE/INSERT/DELETE). The runtime builds the SQL from the PK key. */
export function useDbRowMutations(workspaceId: string | null, connId: string | null): UseDbRowMutationsResult {
	const [isMutating, setIsMutating] = useState(false);

	const run = useCallback(
		async <T>(fn: (connId: string, ws: string) => Promise<T>): Promise<T> => {
			if (!workspaceId || !connId) {
				throw new Error("Missing workspace or connection.");
			}
			setIsMutating(true);
			try {
				return await fn(connId, workspaceId);
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, connId],
	);

	const updateRow = useCallback<UseDbRowMutationsResult["updateRow"]>(
		(args) =>
			run(async (cid, ws) => {
				const result = await getRuntimeTrpcClient(ws).database.updateRow.mutate({ connId: cid, ...args });
				return result.affectedRows;
			}),
		[run],
	);

	const insertRow = useCallback<UseDbRowMutationsResult["insertRow"]>(
		(args) =>
			run(async (cid, ws) => {
				const result = await getRuntimeTrpcClient(ws).database.insertRow.mutate({ connId: cid, ...args });
				return result.affectedRows;
			}),
		[run],
	);

	const deleteRow = useCallback<UseDbRowMutationsResult["deleteRow"]>(
		(args) =>
			run(async (cid, ws) => {
				const result = await getRuntimeTrpcClient(ws).database.deleteRow.mutate({ connId: cid, ...args });
				return result.affectedRows;
			}),
		[run],
	);

	return { isMutating, updateRow, insertRow, deleteRow };
}
