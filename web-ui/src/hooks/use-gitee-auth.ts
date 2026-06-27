// Orchestrates the Kanban-hosted Gitee git PAT auth for the Settings UI.
//
// The backend `gitee` tRPC router exposes a secret-free surface: `status` (who is signed in),
// `setToken` (store a pasted PAT + optional username), and `logout`. The PAT never crosses the
// wire on read. Gitee has NO OAuth device flow (decision cf0d6), so — unlike `use-github-auth`
// — there is no device-code state machine, no polling, and no refresh-resilience logic. This
// hook is a thin status query plus two mutations, leaving the view presentational.
import { useCallback, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { fetchGiteeAuthStatus, logoutGitee, setGiteeToken } from "@/runtime/runtime-config-query";
import type { RuntimeGiteeAuthStatus } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createLogger } from "@/utils/logger";

const log = createLogger("gitee-auth");

export interface UseGiteeAuthResult {
	/** Latest known auth status, or null before the first load completes. */
	status: RuntimeGiteeAuthStatus | null;
	statusLoading: boolean;
	/** Set when the status query cannot reach the runtime (degraded / unreachable). */
	statusError: Error | null;
	isSaving: boolean;
	isLoggingOut: boolean;
	/** Store a pasted PAT (+ optional username). Returns true on success. */
	saveToken: (input: { token: string; username?: string }) => Promise<boolean>;
	logout: () => Promise<void>;
	refreshStatus: () => Promise<void>;
}

function toMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return fallback;
}

export function useGiteeAuth(workspaceId: string | null): UseGiteeAuthResult {
	const queryFn = useCallback(() => fetchGiteeAuthStatus(workspaceId), [workspaceId]);
	const statusQuery = useTrpcQuery<RuntimeGiteeAuthStatus>({
		enabled: true,
		queryFn,
		// Keep the last good status visible if a later refresh hits a transient failure.
		retainDataOnError: true,
	});

	const [isSaving, setIsSaving] = useState(false);
	const [isLoggingOut, setIsLoggingOut] = useState(false);

	const setDataRef = useRef(statusQuery.setData);
	setDataRef.current = statusQuery.setData;

	const saveToken = useCallback(
		async (input: { token: string; username?: string }): Promise<boolean> => {
			const token = input.token.trim();
			if (!token) {
				showAppToast({ intent: "danger", icon: "error", message: "Paste a Gitee token first.", timeout: 4000 });
				return false;
			}
			setIsSaving(true);
			try {
				const response = await setGiteeToken(workspaceId, { token, username: input.username?.trim() || undefined });
				setDataRef.current(response.status);
				showAppToast({
					intent: "success",
					icon: "tick",
					message: response.status.login
						? `Signed in to Gitee as ${response.status.login}.`
						: "Gitee token saved.",
					timeout: 4000,
				});
				return true;
			} catch (error) {
				log.warn("gitee.setToken failed", { error });
				showAppToast({
					intent: "danger",
					icon: "error",
					message: toMessage(error, "Could not save the Gitee token."),
					timeout: 6000,
				});
				return false;
			} finally {
				setIsSaving(false);
			}
		},
		[workspaceId],
	);

	const logout = useCallback(async () => {
		setIsLoggingOut(true);
		try {
			const response = await logoutGitee(workspaceId);
			setDataRef.current(response.status);
			showAppToast({ intent: "success", icon: "tick", message: "Signed out of Gitee.", timeout: 4000 });
		} catch (error) {
			log.warn("gitee.logout failed", { error });
			showAppToast({
				intent: "danger",
				icon: "error",
				message: toMessage(error, "Could not sign out of Gitee."),
				timeout: 6000,
			});
		} finally {
			setIsLoggingOut(false);
		}
	}, [workspaceId]);

	const refetchRef = useRef(statusQuery.refetch);
	refetchRef.current = statusQuery.refetch;
	const refreshStatus = useCallback(async () => {
		await refetchRef.current();
	}, []);

	return {
		status: statusQuery.data,
		statusLoading: statusQuery.isLoading,
		statusError: statusQuery.isError ? statusQuery.error : null,
		isSaving,
		isLoggingOut,
		saveToken,
		logout,
		refreshStatus,
	};
}
