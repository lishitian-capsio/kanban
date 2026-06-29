import type React from "react";
import { type ReactNode, useCallback, useMemo } from "react";

import type { KanbanMarkdownWikilinks } from "@/components/detail-panels/kanban-markdown-content";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

import { toVaultDoc } from "../data/vault-doc-model";
import { buildCandidateWikilinkResolver } from "../links/candidate-wikilink-resolver";
import { ChatWikilinkContext } from "./chat-wikilink-context";
import { useOpenVaultFile } from "./use-vault-file-dialog";

/**
 * Makes vault `[[wikilinks]]` in chat markdown clickable → open the quick
 * dialog. Lists the vault doc pool once per workspace (the design's "shared
 * resolver backed by listDocuments") and builds a STABLE binding so it never
 * defeats chat markdown memoization. Must be nested inside
 * `VaultFileDialogProvider` (it consumes `useOpenVaultFile`).
 *
 * `enabled` gates the doc list so a workspace with the vault turned off pays no
 * extra `listDocuments` query and renders plain markdown.
 */
export function ChatWikilinkProvider({
	workspaceId,
	enabled,
	children,
}: {
	workspaceId: string | null;
	enabled: boolean;
	children: ReactNode;
}): React.ReactElement {
	const openVaultFile = useOpenVaultFile();

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.listDocuments.query({});
		return result.documents.map(toVaultDoc);
	}, [workspaceId]);

	const candidatesQuery = useTrpcQuery({
		enabled: enabled && workspaceId !== null,
		queryFn,
		retainDataOnError: true,
	});

	const candidates = candidatesQuery.data;

	const binding = useMemo<KanbanMarkdownWikilinks | undefined>(() => {
		if (!enabled || !candidates) {
			return undefined;
		}
		const resolve = buildCandidateWikilinkResolver(candidates);
		return {
			resolve,
			onOpen: (resolution) => openVaultFile(resolution.id),
		};
	}, [enabled, candidates, openVaultFile]);

	return <ChatWikilinkContext.Provider value={binding}>{children}</ChatWikilinkContext.Provider>;
}
