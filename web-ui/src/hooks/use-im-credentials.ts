// Orchestrates the machine-local IM outbound-channel credentials for the Settings UI.
//
// The backend `im` tRPC router exposes a secret-free surface: `status` (which platforms are
// configured + presence booleans), `setCredentials` (store a platform's bot token / webhook), and
// `clearCredentials` (remove a platform's credential). The credential values never cross the wire
// on read. This hook is a thin status query plus two per-platform mutations, leaving the view
// presentational (requirement ac99c, 阶段2). Mirrors `use-gitee-auth`.
import { useCallback, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { clearImCredentials, fetchImCredentialStatus, setImCredentials } from "@/runtime/runtime-config-query";
import type {
	RuntimeImCredentialPlatformStatus,
	RuntimeImCredentialStatusResponse,
	RuntimeImSetCredentialsRequest,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createLogger } from "@/utils/logger";

const log = createLogger("im-credentials");

type ImPlatform = RuntimeImSetCredentialsRequest["platform"];

export interface UseImCredentialsResult {
	/** Latest known per-platform status, or null before the first load completes. */
	status: RuntimeImCredentialStatusResponse | null;
	statusLoading: boolean;
	/** Set when the status query cannot reach the runtime (degraded / unreachable). */
	statusError: Error | null;
	/** The platform currently being saved / cleared, or null when idle. */
	pendingPlatform: ImPlatform | null;
	statusFor: (platform: ImPlatform) => RuntimeImCredentialPlatformStatus | null;
	/** Store a platform's outbound credential. Returns true on success. */
	saveCredentials: (input: RuntimeImSetCredentialsRequest) => Promise<boolean>;
	clearCredentials: (platform: ImPlatform) => Promise<void>;
	refreshStatus: () => Promise<void>;
}

function toMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return fallback;
}

export function useImCredentials(workspaceId: string | null): UseImCredentialsResult {
	const queryFn = useCallback(() => fetchImCredentialStatus(workspaceId), [workspaceId]);
	const statusQuery = useTrpcQuery<RuntimeImCredentialStatusResponse>({
		enabled: true,
		queryFn,
		// Keep the last good status visible if a later refresh hits a transient failure.
		retainDataOnError: true,
	});

	const [pendingPlatform, setPendingPlatform] = useState<ImPlatform | null>(null);

	const setDataRef = useRef(statusQuery.setData);
	setDataRef.current = statusQuery.setData;

	const saveCredentials = useCallback(
		async (input: RuntimeImSetCredentialsRequest): Promise<boolean> => {
			setPendingPlatform(input.platform);
			try {
				const response = await setImCredentials(workspaceId, input);
				setDataRef.current(response.status);
				showAppToast({ intent: "success", icon: "tick", message: "IM credential saved.", timeout: 4000 });
				return true;
			} catch (error) {
				log.warn("im.setCredentials failed", { error });
				showAppToast({
					intent: "danger",
					icon: "error",
					message: toMessage(error, "Could not save the IM credential."),
					timeout: 6000,
				});
				return false;
			} finally {
				setPendingPlatform(null);
			}
		},
		[workspaceId],
	);

	const clearCredentials = useCallback(
		async (platform: ImPlatform): Promise<void> => {
			setPendingPlatform(platform);
			try {
				const response = await clearImCredentials(workspaceId, platform);
				setDataRef.current(response.status);
				showAppToast({ intent: "success", icon: "tick", message: "IM credential removed.", timeout: 4000 });
			} catch (error) {
				log.warn("im.clearCredentials failed", { error });
				showAppToast({
					intent: "danger",
					icon: "error",
					message: toMessage(error, "Could not remove the IM credential."),
					timeout: 6000,
				});
			} finally {
				setPendingPlatform(null);
			}
		},
		[workspaceId],
	);

	const refetchRef = useRef(statusQuery.refetch);
	refetchRef.current = statusQuery.refetch;
	const refreshStatus = useCallback(async () => {
		await refetchRef.current();
	}, []);

	const statusData = statusQuery.data;
	const statusFor = useCallback(
		(platform: ImPlatform): RuntimeImCredentialPlatformStatus | null => {
			return statusData?.platforms.find((entry) => entry.platform === platform) ?? null;
		},
		[statusData],
	);

	return {
		status: statusData,
		statusLoading: statusQuery.isLoading,
		statusError: statusQuery.isError ? statusQuery.error : null,
		pendingPlatform,
		statusFor,
		saveCredentials,
		clearCredentials,
		refreshStatus,
	};
}
