import { useCallback, useEffect, useState } from "react";

import type { RuntimeStorageObjectContent } from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

/** Fetch a single S3 object's content (text or binary/base64). */
export function useStorageObject(workspaceId: string | null, connId: string | null, key: string | null) {
	const [content, setContent] = useState<RuntimeStorageObjectContent | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!workspaceId || !connId || !key) {
			setContent(null);
			return;
		}
		setIsLoading(true);
		setErrorMessage(null);
		try {
			setContent(await getRuntimeTrpcClient(workspaceId).storage.readObject.query({ connId, key }));
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to read object.");
		} finally {
			setIsLoading(false);
		}
	}, [workspaceId, connId, key]);

	useEffect(() => {
		void load();
	}, [load]);

	return { content, isLoading, errorMessage, reload: load };
}
