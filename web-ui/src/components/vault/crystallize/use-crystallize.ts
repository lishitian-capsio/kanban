import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeVaultDocument } from "@/runtime/types";

export interface CrystallizeInput {
	/** The chat session id (the active home thread's task id). */
	sessionId: string;
	type: string;
	/** Keep only the trailing N messages. Omitted = the whole thread. */
	lastN?: number;
	/** Override the title derived from the conversation. */
	title?: string;
}

export interface UseCrystallizeResult {
	crystallize: (input: CrystallizeInput) => Promise<RuntimeVaultDocument | null>;
	isCrystallizing: boolean;
}

/**
 * Turn a home-chat transcript into a vault document via the backend
 * `workspace.crystallizeChatToDoc` endpoint (B4). The runtime reads the session's
 * unified transcript (whole thread or trailing N) and writes a new doc of the
 * chosen type; this hook owns only the request + pending state.
 */
export function useCrystallize(workspaceId: string | null): UseCrystallizeResult {
	const [isCrystallizing, setIsCrystallizing] = useState(false);

	const crystallize = useCallback(
		async (input: CrystallizeInput): Promise<RuntimeVaultDocument | null> => {
			if (!workspaceId) {
				return null;
			}
			setIsCrystallizing(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.crystallizeChatToDoc.mutate({
					sessionId: input.sessionId,
					type: input.type,
					lastN: input.lastN,
					title: input.title?.trim() ? input.title.trim() : undefined,
				});
				return result.document;
			} finally {
				setIsCrystallizing(false);
			}
		},
		[workspaceId],
	);

	return { crystallize, isCrystallizing };
}
