import { useCallback, useEffect, useState } from "react";

import type { RuntimeStorageEntry } from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

/** Single-level S3 object listing with continuation-token paging. */
export function useStorageTree(workspaceId: string | null, connId: string | null) {
	const [prefix, setPrefix] = useState("");
	const [entries, setEntries] = useState<RuntimeStorageEntry[]>([]);
	const [isTruncated, setIsTruncated] = useState(false);
	const [token, setToken] = useState<string | undefined>(undefined);
	const [isLoading, setIsLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const load = useCallback(
		async (nextPrefix: string, continuationToken?: string) => {
			if (!workspaceId || !connId) {
				return;
			}
			setIsLoading(true);
			setErrorMessage(null);
			try {
				const res = await getRuntimeTrpcClient(workspaceId).storage.listObjects.query({
					connId,
					prefix: nextPrefix,
					continuationToken,
				});
				setPrefix(res.prefix);
				setEntries((prev) => (continuationToken ? [...prev, ...res.entries] : res.entries));
				setIsTruncated(res.isTruncated);
				setToken(res.nextContinuationToken);
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Failed to list objects.");
			} finally {
				setIsLoading(false);
			}
		},
		[workspaceId, connId],
	);

	// Reset to bucket root whenever the connection changes.
	useEffect(() => {
		setPrefix("");
		setEntries([]);
		setErrorMessage(null);
		setIsTruncated(false);
		setToken(undefined);
		if (connId) {
			void load("");
		}
	}, [connId, load]);

	const enter = useCallback((p: string) => void load(p), [load]);
	const loadMore = useCallback(() => {
		if (isTruncated && token) {
			void load(prefix, token);
		}
	}, [isTruncated, token, prefix, load]);

	const reload = useCallback(() => void load(prefix), [load, prefix]);

	return {
		prefix,
		entries,
		isTruncated,
		isLoading,
		errorMessage,
		enter,
		loadMore,
		reload,
	};
}
