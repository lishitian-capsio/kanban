import { Download, Plus } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import type { RuntimeVaultBacklink, RuntimeVaultOutgoingLink } from "@/runtime/types";

import { Spinner } from "@/components/ui/spinner";
import { VaultBoard } from "./board/vault-board";
import { groupDocsByStatus } from "./board/vault-status-columns";
import { NewDocDialog } from "./create/new-doc-dialog";
import type { VaultDocPatch } from "./data/use-vault-docs";
import { useVaultExport } from "./data/use-vault-export";
import { frontmatterString, type VaultDoc } from "./data/vault-doc-model";
import { applyVaultView } from "./data/vault-filter";
import type { VaultTypeView } from "./data/vault-type-registry";
import { VaultDocDetail } from "./detail/vault-doc-detail";
import type { VaultWikilinkBinding } from "./links/vault-wikilink-binding";
import { withEffectiveColumns } from "./views/effective-view";
import { useVaultViewState } from "./views/use-vault-view-state";
import { PriorityDot, StatusBadge } from "./views/vault-property-controls";
import { VaultTableView } from "./views/vault-table-view";
import { VaultViewBar } from "./views/vault-view-bar";

function BoardCardBody({ view, doc }: { view: VaultTypeView; doc: VaultDoc }): React.ReactElement {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[13px] font-medium leading-snug text-text-primary">{doc.name || "Untitled"}</span>
			<div className="flex items-center gap-2">
				<StatusBadge view={view} status={frontmatterString(doc, view.statusKey) || null} />
				<PriorityDot view={view} priority={frontmatterString(doc, "priority") || null} />
			</div>
		</div>
	);
}

interface VaultContentProps {
	workspaceId: string | null;
	view: VaultTypeView;
	docs: VaultDoc[];
	/** `type:customer` docs, for the customer picker on requirement-like detail views. */
	customers: VaultDoc[];
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	selectedDoc: VaultDoc | null;
	onSelectDoc: (id: string | null) => void;
	onCreate: (title: string) => Promise<void>;
	onPatch: (id: string, patch: VaultDocPatch) => void;
	onDelete: (id: string) => void;
	onCardMove: (docId: string, toColumnId: string) => void;
	/** Type-specific detail sections (e.g. the customer anchor panel). */
	renderDetailExtras?: (doc: VaultDoc) => React.ReactNode;
	/** Body `[[wikilink]]` binding for the open document's editor. */
	wikilinks?: VaultWikilinkBinding;
	/** The open document's outgoing links (with typed relations), for the detail links panel. */
	outgoingLinks?: RuntimeVaultOutgoingLink[];
	/** The open document's backlinks (with typed relations), for the detail links panel. */
	backlinks?: RuntimeVaultBacklink[];
	/** Navigate to a linked document from the detail links panel. */
	onOpenLinkedDoc?: (type: string, id: string) => void;
}

export function VaultContent({
	workspaceId,
	view,
	docs,
	customers,
	isLoading,
	errorMessage,
	isMutating,
	selectedDoc,
	onSelectDoc,
	onCreate,
	onPatch,
	onDelete,
	onCardMove,
	renderDetailExtras,
	wikilinks,
	outgoingLinks,
	backlinks,
	onOpenLinkedDoc,
}: VaultContentProps): React.ReactElement {
	// Only status-bearing types get a board; flat types (Customer, Note) are table-only.
	const supportsBoard = view.statuses.length > 0;
	const viewState = useVaultViewState(workspaceId, view.type);
	const { isExporting, exportDoc, exportDocs } = useVaultExport(workspaceId);
	const [isNewOpen, setIsNewOpen] = useState(false);
	const [isCreating, setIsCreating] = useState(false);

	const { draft } = viewState;
	const displayDocs = useMemo(
		() => applyVaultView(docs, { filters: draft.filters, sort: draft.sort }),
		[docs, draft.filters, draft.sort],
	);
	const tableView = useMemo(
		() => withEffectiveColumns(view, draft.listPropertiesDisplay),
		[view, draft.listPropertiesDisplay],
	);
	const grouped = useMemo(() => groupDocsByStatus(view, displayDocs), [view, displayDocs]);

	const effectiveLayout = supportsBoard ? draft.layout : "table";
	const ViewIcon = view.icon;
	const isFiltered = displayDocs.length !== docs.length;

	async function handleCreate(title: string): Promise<void> {
		setIsCreating(true);
		try {
			await onCreate(title);
			setIsNewOpen(false);
		} finally {
			setIsCreating(false);
		}
	}

	if (selectedDoc) {
		return (
			<VaultDocDetail
				view={view}
				doc={selectedDoc}
				customers={customers}
				extras={renderDetailExtras?.(selectedDoc)}
				wikilinks={wikilinks}
				outgoingLinks={outgoingLinks}
				backlinks={backlinks}
				onOpenLinkedDoc={onOpenLinkedDoc}
				onPatch={onPatch}
				onDelete={onDelete}
				onBack={() => onSelectDoc(null)}
				onDownload={(doc) => void exportDoc(doc)}
				isDownloading={isExporting}
			/>
		);
	}

	return (
		<div className="flex flex-1 min-h-0 flex-col bg-surface-0">
			<div className="flex items-center gap-3 border-b border-border bg-surface-1 px-5 py-3">
				<div className="flex items-center gap-2 text-text-primary">
					<ViewIcon size={16} />
					<h2 className="text-sm font-semibold">{view.pluralLabel}</h2>
					<span className="text-[12px] text-text-tertiary">
						{isFiltered ? `${displayDocs.length} of ${docs.length}` : docs.length}
					</span>
				</div>
				<div className="ml-auto flex items-center gap-2">
					{isMutating || viewState.isMutating ? <Spinner size={14} /> : null}
					<button
						type="button"
						onClick={() => void exportDocs(displayDocs, view.pluralLabel)}
						disabled={isExporting || displayDocs.length === 0}
						title={
							isFiltered
								? `Export the ${displayDocs.length} filtered ${view.pluralLabel.toLowerCase()} as a zip`
								: `Export all ${view.pluralLabel.toLowerCase()} as a zip`
						}
						className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-[13px] font-medium text-text-primary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<Download size={14} />
						Export
					</button>
					<button
						type="button"
						onClick={() => setIsNewOpen(true)}
						className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-medium text-white hover:bg-accent-hover"
					>
						<Plus size={14} />
						New {view.label}
					</button>
				</div>
			</div>

			<VaultViewBar view={view} state={viewState} supportsBoard={supportsBoard} />

			<div className="flex flex-1 min-h-0 flex-col">
				{isLoading && docs.length === 0 ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner size={24} />
					</div>
				) : errorMessage && docs.length === 0 ? (
					<div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-[13px] text-status-red">
						{errorMessage}
					</div>
				) : effectiveLayout === "table" ? (
					<VaultTableView view={tableView} docs={displayDocs} selectedDocId={null} onSelect={onSelectDoc} />
				) : (
					<VaultBoard
						columns={grouped.columns}
						cardsByColumn={grouped.cardsByColumn}
						onCardMove={onCardMove}
						onCardClick={onSelectDoc}
						renderCard={(doc) => <BoardCardBody view={view} doc={doc} />}
					/>
				)}
			</div>

			<NewDocDialog
				view={view}
				open={isNewOpen}
				isSaving={isCreating}
				onOpenChange={setIsNewOpen}
				onCreate={(title) => {
					void handleCreate(title);
				}}
			/>
		</div>
	);
}
