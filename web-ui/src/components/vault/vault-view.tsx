import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { FilesView } from "@/components/files/files-view";

import { buildDocFromTemplate } from "./create/build-doc-from-template";
import { useVaultDocs, type VaultDocPatch } from "./data/use-vault-docs";
import { getVaultTypeView, listVaultTypeViews } from "./data/vault-type-registry";
import { VaultContent } from "./vault-content";
import { type VaultSelection, VaultSidebar } from "./vault-sidebar";

/** Which entry point opened the vault (top-bar Files vs Requirements). */
export type VaultInitialView = "files" | "requirements";

function selectionFromInitial(initialView: VaultInitialView): VaultSelection {
	if (initialView === "requirements") {
		return { kind: "type", type: "requirement" };
	}
	return { kind: "files" };
}

/**
 * The unified vault surface. One component backs both top-bar entry points: `Files`
 * opens the All-files (binary) library, `Requirements` opens the `requirement` type
 * board/table. The left rail switches between document types and the file library.
 */
export function VaultView({
	workspaceId,
	initialView,
}: {
	workspaceId: string | null;
	initialView: VaultInitialView;
}): React.ReactElement {
	const types = useMemo(() => listVaultTypeViews(), []);
	const [selection, setSelection] = useState<VaultSelection>(() => selectionFromInitial(initialView));
	const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

	// Re-point the rail when the top-bar entry point changes (Files ↔ Requirements).
	useEffect(() => {
		setSelection(selectionFromInitial(initialView));
		setSelectedDocId(null);
	}, [initialView]);

	const activeType = selection.kind === "type" ? selection.type : null;
	const view = activeType ? getVaultTypeView(activeType) : undefined;
	const { docs, isLoading, errorMessage, isMutating, createDoc, updateDoc, deleteDoc } = useVaultDocs(
		workspaceId,
		activeType,
	);

	const selectedDoc = useMemo(() => docs.find((doc) => doc.id === selectedDocId) ?? null, [docs, selectedDocId]);

	const handleSelectSurface = useCallback((next: VaultSelection) => {
		setSelection(next);
		setSelectedDocId(null);
	}, []);

	const handleCreate = useCallback(
		async (title: string) => {
			if (!view) {
				return;
			}
			const created = await createDoc(buildDocFromTemplate(view, title));
			if (created) {
				setSelectedDocId(created.id);
			}
		},
		[view, createDoc],
	);

	const handlePatch = useCallback(
		(id: string, patch: VaultDocPatch) => {
			void updateDoc(id, patch);
		},
		[updateDoc],
	);

	const handleDelete = useCallback(
		(id: string) => {
			void (async () => {
				const removed = await deleteDoc(id);
				if (removed && selectedDocId === id) {
					setSelectedDocId(null);
				}
			})();
		},
		[deleteDoc, selectedDocId],
	);

	const handleCardMove = useCallback(
		(docId: string, toColumnId: string) => {
			if (!view) {
				return;
			}
			void updateDoc(docId, { frontmatter: { [view.statusKey]: toColumnId } });
		},
		[view, updateDoc],
	);

	return (
		<div className="flex flex-1 min-h-0">
			<VaultSidebar types={types} selection={selection} onSelect={handleSelectSurface} />
			{selection.kind === "files" ? (
				<FilesView workspaceId={workspaceId} />
			) : view ? (
				<VaultContent
					view={view}
					docs={docs}
					isLoading={isLoading}
					errorMessage={errorMessage}
					isMutating={isMutating}
					selectedDoc={selectedDoc}
					onSelectDoc={setSelectedDocId}
					onCreate={handleCreate}
					onPatch={handlePatch}
					onDelete={handleDelete}
					onCardMove={handleCardMove}
				/>
			) : (
				<div className="flex flex-1 items-center justify-center bg-surface-0 text-[13px] text-text-tertiary">
					Unknown document type.
				</div>
			)}
		</div>
	);
}
