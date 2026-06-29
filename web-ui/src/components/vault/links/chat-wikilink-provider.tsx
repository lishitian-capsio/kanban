import type React from "react";
import { type ReactNode, useCallback, useMemo } from "react";

import type { KanbanMarkdownWikilinks } from "@/components/detail-panels/kanban-markdown-content";
import { useOpenFile } from "@/components/file-surface";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

import { toVaultDoc } from "../data/vault-doc-model";
import { buildCandidateWikilinkResolver } from "./candidate-wikilink-resolver";
import { ChatWikilinkContext } from "./chat-wikilink-context";

/**
 * Makes vault `[[wikilinks]]` in chat markdown clickable → open the File surface
 * overlay. Lists the vault doc pool once per workspace (the design's "shared
 * resolver backed by listDocuments") and builds a STABLE binding so it never
 * defeats chat markdown memoization. Must be nested inside `FileSurfaceProvider`
 * (it consumes `useOpenFile`).
 *
 * This stays in the vault domain (it builds a candidate resolver from vault
 * docs); it only *consumes* the neutral `useOpenFile` seam (file-surface-design
 * §5.3, §7).
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
	const openFile = useOpenFile();

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
			onOpen: (resolution) => openFile(resolution.id),
		};
	}, [enabled, candidates, openFile]);

	return <ChatWikilinkContext.Provider value={binding}>{children}</ChatWikilinkContext.Provider>;
}
