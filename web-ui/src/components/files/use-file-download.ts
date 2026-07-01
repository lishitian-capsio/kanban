import { useCallback, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { downloadBase64 } from "@/utils/download";
import { createLogger } from "@/utils/logger";

const log = createLogger("file-download");

export interface UseFileDownloadResult {
	/** True while a file's bytes are being fetched for download. */
	isDownloading: boolean;
	/** Fetch a library file's bytes via `workspace.getFileBytes` and save it locally. */
	downloadFile: (fileId: string, fileName: string) => Promise<void>;
}

/**
 * Download a file from the upload library. The bytes ride the same
 * `workspace.getFileBytes` base64 channel the media preview already uses, so no
 * new backend surface is needed — this decodes the payload and triggers a save.
 */
export function useFileDownload(workspaceId: string | null): UseFileDownloadResult {
	const [isDownloading, setIsDownloading] = useState(false);

	const downloadFile = useCallback(
		async (fileId: string, fileName: string): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsDownloading(true);
			try {
				const result = await getRuntimeTrpcClient(workspaceId).workspace.getFileBytes.query({ id: fileId });
				if (!result.data) {
					notifyError("Could not download the file.");
					return;
				}
				downloadBase64(fileName, result.data, result.mimeType ?? "application/octet-stream");
			} catch (error) {
				log.error("Failed to download library file", { fileId, error });
				notifyError("Could not download the file.");
			} finally {
				setIsDownloading(false);
			}
		},
		[workspaceId],
	);

	return { isDownloading, downloadFile };
}
