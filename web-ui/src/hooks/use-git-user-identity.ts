import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { TaskOwner } from "@/types";

export interface UseGitUserIdentityResult {
	/** The workspace repo's current git identity, or null when none is configured. */
	identity: TaskOwner | null;
	isLoading: boolean;
}

/**
 * Reads the workspace repo's current git identity (`git config user.name`/`user.email`)
 * via `workspace.getGitUserIdentity`. The web-ui stamps this onto a new task as its
 * owner at creation time — the same creator-at-creation rule the CLI uses — so an
 * ownerless task is never backfilled later. Idle when no workspace is selected.
 */
export function useGitUserIdentity(workspaceId: string | null): UseGitUserIdentityResult {
	const enabled = workspaceId !== null;

	const query = useTrpcQuery({
		enabled,
		queryFn: async () => {
			if (!workspaceId) {
				throw new Error("Missing workspace.");
			}
			const result = await getRuntimeTrpcClient(workspaceId).workspace.getGitUserIdentity.query();
			return result.identity;
		},
		retainDataOnError: true,
	});

	return {
		identity: query.data ?? null,
		isLoading: query.isLoading,
	};
}
