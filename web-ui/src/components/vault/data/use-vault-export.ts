import { useCallback, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { downloadBase64, downloadText, safeFileSlug } from "@/utils/download";
import { createLogger } from "@/utils/logger";

import type { VaultDoc } from "./vault-doc-model";

const log = createLogger("vault-export");

export interface UseVaultExportResult {
	/** True while an export request is in flight (download buttons disable). */
	isExporting: boolean;
	/** Download one document's raw `.md` (byte-identical to the on-disk file). */
	exportDoc: (doc: VaultDoc) => Promise<void>;
	/** Download many documents as a zip mirroring `docs/<type>/<file>`; `archiveName` is the zip basename. */
	exportDocs: (docs: VaultDoc[], archiveName: string) => Promise<void>;
}

/**
 * Vault document export. Both the raw `.md` text and the zip archive are produced
 * server-side (reusing the canonical serializer / on-disk bytes), so this hook only
 * fetches the payload and triggers the browser download — no frontend frontmatter
 * reconstruction, no client-side zipping.
 */
export function useVaultExport(workspaceId: string | null): UseVaultExportResult {
	const [isExporting, setIsExporting] = useState(false);

	const exportDoc = useCallback(
		async (doc: VaultDoc): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			setIsExporting(true);
			try {
				const { document } = await getRuntimeTrpcClient(workspaceId).workspace.exportDocument.query({ id: doc.id });
				if (!document) {
					notifyError(`“${doc.name}” could not be found.`);
					return;
				}
				downloadText(document.fileName, document.content);
			} catch (error) {
				log.error("Failed to export vault document", { docId: doc.id, error });
				notifyError("Could not download the document.");
			} finally {
				setIsExporting(false);
			}
		},
		[workspaceId],
	);

	const exportDocs = useCallback(
		async (docs: VaultDoc[], archiveName: string): Promise<void> => {
			if (!workspaceId) {
				return;
			}
			if (docs.length === 0) {
				notifyError("There is nothing to export.");
				return;
			}
			setIsExporting(true);
			try {
				const { data, documentCount } = await getRuntimeTrpcClient(workspaceId).workspace.exportArchive.query({
					ids: docs.map((doc) => doc.id),
				});
				if (documentCount === 0) {
					notifyError("There is nothing to export.");
					return;
				}
				downloadBase64(`${safeFileSlug(archiveName, "vault")}.zip`, data, "application/zip");
			} catch (error) {
				log.error("Failed to export vault archive", { count: docs.length, error });
				notifyError("Could not export the documents.");
			} finally {
				setIsExporting(false);
			}
		},
		[workspaceId],
	);

	return { isExporting, exportDoc, exportDocs };
}
