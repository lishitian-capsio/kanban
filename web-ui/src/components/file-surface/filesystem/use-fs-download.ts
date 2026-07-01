import { useCallback, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { downloadBase64 } from "@/utils/download";
import { createLogger } from "@/utils/logger";

const log = createLogger("fs-download");

export interface UseFsDownloadResult {
	/** True while a download payload is being fetched (menu items can disable). */
	isDownloading: boolean;
	/**
	 * Fetch a working-tree entry's bytes and trigger a browser download — a single
	 * file directly, or a directory as a zip. All zipping happens server-side; this
	 * only decodes the base64 payload and saves it via an anchor click.
	 */
	downloadEntry: (path: string) => Promise<void>;
}

/**
 * Download entries from the filesystem explorer via `workspaceFs.downloadEntry`.
 * The backend returns a uniform `{ fileName, mimeType, data }` envelope for both
 * files and directories (zip), so there is one client code path for both.
 */
export function useFsDownload(workspaceId: string | null): UseFsDownloadResult {
	const [isDownloading, setIsDownloading] = useState(false);

	const downloadEntry = useCallback(
		async (path: string): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsDownloading(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspaceFs.downloadEntry.query({ path });
				if (!result.ok) {
					notifyError(result.error ?? "Could not download the entry.");
					return;
				}
				if (result.tooLarge || !result.data) {
					notifyError(
						result.isDirectory
							? "This folder is too large to download."
							: "This file is too large to download.",
					);
					return;
				}
				downloadBase64(result.fileName, result.data, result.mimeType);
				showAppToast(
					{ intent: "success", icon: "download", message: `Downloading “${result.fileName}”.`, timeout: 2500 },
					"fs-download-success",
				);
			} catch (error) {
				log.error("Failed to download working-tree entry", { path, error });
				notifyError("Could not download the entry.");
			} finally {
				setIsDownloading(false);
			}
		},
		[workspaceId],
	);

	return { isDownloading, downloadEntry };
}
