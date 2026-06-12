import { useCallback, useMemo } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

import { toVaultDoc, type VaultDoc } from "../data/vault-doc-model";
import { buildWikilinkResolver, type WikilinkResolver } from "./wikilink-resolution";

const EMPTY_DOCS: VaultDoc[] = [];

export interface UseVaultWikilinksResult {
	/** Every vault doc across types (autocomplete candidate pool). */
	candidates: VaultDoc[];
	/** Resolve a `[[target]]` to its document, backed by the backend link engine. */
	resolve: WikilinkResolver;
}

/**
 * Data layer for body wikilinks: lists every vault doc (for `[[` autocomplete)
 * and pulls the active doc's resolved outgoing links from the B1
 * `workspace.getDocumentLinks` engine (for chip resolution). Resolution is never
 * re-derived on the client — only indexed. `refreshKey` (e.g. the doc's
 * `updatedAt`) re-runs both queries after the body is saved or a doc is created.
 */
export function useVaultWikilinks(
	workspaceId: string | null,
	docId: string | null,
	refreshKey: number,
): UseVaultWikilinksResult {
	const candidatesQueryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		// `refreshKey` participates so newly created/renamed docs re-list.
		void refreshKey;
		const result = await getRuntimeTrpcClient(workspaceId).workspace.listDocuments.query({});
		return result.documents.map(toVaultDoc);
	}, [workspaceId, refreshKey]);

	const candidatesQuery = useTrpcQuery({
		enabled: workspaceId !== null,
		queryFn: candidatesQueryFn,
		retainDataOnError: true,
	});

	const linksQueryFn = useCallback(async () => {
		if (!workspaceId || !docId) {
			throw new Error("Missing workspace or document.");
		}
		void refreshKey;
		return await getRuntimeTrpcClient(workspaceId).workspace.getDocumentLinks.query({ id: docId });
	}, [workspaceId, docId, refreshKey]);

	const linksQuery = useTrpcQuery({
		enabled: workspaceId !== null && docId !== null,
		queryFn: linksQueryFn,
		retainDataOnError: true,
	});

	const resolve = useMemo(
		() => buildWikilinkResolver(linksQuery.data?.outgoing ?? []),
		[linksQuery.data],
	);

	return {
		candidates: candidatesQuery.data ?? EMPTY_DOCS,
		resolve,
	};
}
