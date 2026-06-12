import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { FilesView } from "@/components/files/files-view";

import { buildDocFromTemplate } from "./create/build-doc-from-template";
import { CustomerAnchorPanel } from "./customer/customer-anchor-panel";
import { type UseVaultDocsResult, useVaultDocs, type VaultDocPatch } from "./data/use-vault-docs";
import type { VaultDoc } from "./data/vault-doc-model";
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
 *
 * The customer↔requirement anchor needs cross-type data, so `customer` and
 * `requirement` docs are loaded as standing relation sources (used for the picker
 * and a customer's backlinks); the active type's docs drive the table/board/detail.
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

	// Standing relation sources for the customer anchor; one fetch each.
	const customerDocs = useVaultDocs(workspaceId, "customer");
	const requirementDocs = useVaultDocs(workspaceId, "requirement");
	// Any other active type (decision/note/future) gets its own source; idle when the
	// active type is already covered by a relation source above.
	const otherType = activeType && activeType !== "customer" && activeType !== "requirement" ? activeType : null;
	const otherDocs = useVaultDocs(workspaceId, otherType);

	const active: UseVaultDocsResult =
		activeType === "customer" ? customerDocs : activeType === "requirement" ? requirementDocs : otherDocs;
	const { docs, isLoading, errorMessage, isMutating, createDoc, updateDoc, deleteDoc } = active;

	const selectedDoc = useMemo(() => docs.find((doc) => doc.id === selectedDocId) ?? null, [docs, selectedDocId]);

	const handleSelectSurface = useCallback((next: VaultSelection) => {
		setSelection(next);
		setSelectedDocId(null);
	}, []);

	const handleOpenDoc = useCallback((type: string, id: string) => {
		setSelection({ kind: "type", type });
		setSelectedDocId(id);
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

	const renderDetailExtras = useCallback(
		(doc: VaultDoc): React.ReactNode => {
			if (doc.type !== "customer") {
				return null;
			}
			return (
				<CustomerAnchorPanel
					workspaceId={workspaceId}
					customer={doc}
					requirements={requirementDocs.docs}
					onPatchFrontmatter={(patch) => handlePatch(doc.id, { frontmatter: patch })}
					onOpenRequirement={(id) => handleOpenDoc("requirement", id)}
				/>
			);
		},
		[workspaceId, requirementDocs.docs, handlePatch, handleOpenDoc],
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
					customers={customerDocs.docs}
					isLoading={isLoading}
					errorMessage={errorMessage}
					isMutating={isMutating}
					selectedDoc={selectedDoc}
					onSelectDoc={setSelectedDocId}
					onCreate={handleCreate}
					onPatch={handlePatch}
					onDelete={handleDelete}
					onCardMove={handleCardMove}
					renderDetailExtras={renderDetailExtras}
				/>
			) : (
				<div className="flex flex-1 items-center justify-center bg-surface-0 text-[13px] text-text-tertiary">
					Unknown document type.
				</div>
			)}
		</div>
	);
}
