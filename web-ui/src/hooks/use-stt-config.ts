// Drives the Settings "Voice input (speech-to-text)" card. Reads the secret-free
// `stt.status` (masked key preview + configured flag) and exposes save/clear actions.
// The API key is only ever sent to the backend on save — it never comes back over the
// wire, mirroring the saved-provider / GitHub-auth conventions.

import { useCallback, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { clearSttConfig, fetchSttStatus, saveSttConfig } from "@/runtime/runtime-config-query";
import type { RuntimeSttSaveRequest, RuntimeSttStatus } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createLogger } from "@/utils/logger";

const log = createLogger("stt-config");

export interface UseSttConfigResult {
	status: RuntimeSttStatus | null;
	statusLoading: boolean;
	statusError: Error | null;
	isSaving: boolean;
	isClearing: boolean;
	save: (request: RuntimeSttSaveRequest) => Promise<boolean>;
	clear: () => Promise<void>;
	refreshStatus: () => Promise<void>;
}

function toMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return fallback;
}

export function useSttConfig(workspaceId: string | null): UseSttConfigResult {
	const queryFn = useCallback(() => fetchSttStatus(workspaceId), [workspaceId]);
	const statusQuery = useTrpcQuery<RuntimeSttStatus>({ enabled: true, queryFn, retainDataOnError: true });
	const [isSaving, setIsSaving] = useState(false);
	const [isClearing, setIsClearing] = useState(false);

	const save = useCallback(
		async (request: RuntimeSttSaveRequest): Promise<boolean> => {
			setIsSaving(true);
			try {
				const next = await saveSttConfig(workspaceId, request);
				statusQuery.setData(next);
				showAppToast({ intent: "success", icon: "tick", message: "Voice input settings saved.", timeout: 4000 });
				return true;
			} catch (error) {
				log.warn("stt.save failed", { error });
				showAppToast({
					intent: "danger",
					icon: "error",
					message: toMessage(error, "Could not save voice input settings."),
					timeout: 6000,
				});
				return false;
			} finally {
				setIsSaving(false);
			}
		},
		[statusQuery.setData, workspaceId],
	);

	const clear = useCallback(async (): Promise<void> => {
		setIsClearing(true);
		try {
			const next = await clearSttConfig(workspaceId);
			statusQuery.setData(next);
			showAppToast({ intent: "success", icon: "tick", message: "Voice input settings removed.", timeout: 4000 });
		} catch (error) {
			log.warn("stt.clear failed", { error });
			showAppToast({
				intent: "danger",
				icon: "error",
				message: toMessage(error, "Could not remove voice input settings."),
				timeout: 6000,
			});
		} finally {
			setIsClearing(false);
		}
	}, [statusQuery.setData, workspaceId]);

	const refreshStatus = useCallback(async () => {
		await statusQuery.refetch();
	}, [statusQuery.refetch]);

	return {
		status: statusQuery.data,
		statusLoading: statusQuery.isLoading,
		statusError: statusQuery.isError ? statusQuery.error : null,
		isSaving,
		isClearing,
		save,
		clear,
		refreshStatus,
	};
}
