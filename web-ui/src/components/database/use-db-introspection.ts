import { useCallback, useRef, useState } from "react";

import type { RuntimeDbIntrospectResponse } from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { createLogger } from "@/utils/logger";
import { dbErrorMessage } from "./db-utils";

const log = createLogger("database-introspection");

export interface IntrospectionState {
	status: "loading" | "loaded" | "error";
	data?: RuntimeDbIntrospectResponse;
	errorMessage?: string;
}

export interface UseDbIntrospectionResult {
	stateByConnId: Record<string, IntrospectionState>;
	/** Introspect a connection if not already loaded/loading (first expand). */
	ensureLoaded: (connId: string) => void;
	/** Force a re-introspection (e.g. after a schema change). */
	reload: (connId: string) => void;
	/** Drop cached introspection for a connection (e.g. after it is deleted/edited). */
	forget: (connId: string) => void;
}

/**
 * Lazy, per-connection schema introspection. Each connection is introspected on demand (first
 * tree expand) and cached; the heavy full-catalog call never runs until the user opens a tree.
 */
export function useDbIntrospection(workspaceId: string | null): UseDbIntrospectionResult {
	const [stateByConnId, setStateByConnId] = useState<Record<string, IntrospectionState>>({});
	const stateRef = useRef(stateByConnId);
	stateRef.current = stateByConnId;

	const load = useCallback(
		async (connId: string) => {
			if (!workspaceId) {
				return;
			}
			setStateByConnId((prev) => ({ ...prev, [connId]: { status: "loading", data: prev[connId]?.data } }));
			try {
				const data = await getRuntimeTrpcClient(workspaceId).database.introspect.query({ connId });
				setStateByConnId((prev) => ({ ...prev, [connId]: { status: "loaded", data } }));
			} catch (error) {
				log.warn("introspection failed", { connId, error });
				setStateByConnId((prev) => ({
					...prev,
					[connId]: { status: "error", errorMessage: dbErrorMessage(error, "Introspection failed.") },
				}));
			}
		},
		[workspaceId],
	);

	const ensureLoaded = useCallback(
		(connId: string) => {
			const current = stateRef.current[connId];
			if (current && (current.status === "loading" || current.status === "loaded")) {
				return;
			}
			void load(connId);
		},
		[load],
	);

	const reload = useCallback((connId: string) => void load(connId), [load]);

	const forget = useCallback((connId: string) => {
		setStateByConnId((prev) => {
			if (!(connId in prev)) {
				return prev;
			}
			const next = { ...prev };
			delete next[connId];
			return next;
		});
	}, []);

	return { stateByConnId, ensureLoaded, reload, forget };
}
