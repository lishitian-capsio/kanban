import { LayoutGrid, Plus, Table as TableIcon } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { VaultBoard } from "./board/vault-board";
import { groupDocsByStatus } from "./board/vault-status-columns";
import { NewDocDialog } from "./create/new-doc-dialog";
import type { VaultDocPatch } from "./data/use-vault-docs";
import { frontmatterString, type VaultDoc } from "./data/vault-doc-model";
import type { VaultTypeView } from "./data/vault-type-registry";
import { VaultDocDetail } from "./detail/vault-doc-detail";
import { PriorityDot, StatusBadge } from "./views/vault-property-controls";
import { VaultTableView } from "./views/vault-table-view";

type ViewMode = "table" | "board";

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

function ViewModeToggle({
	mode,
	onChange,
}: {
	mode: ViewMode;
	onChange: (mode: ViewMode) => void;
}): React.ReactElement {
	return (
		<div className="flex items-center rounded-md border border-border bg-surface-2 p-0.5">
			<button
				type="button"
				aria-label="Table view"
				onClick={() => onChange("table")}
				className={cn(
					"flex h-7 items-center gap-1.5 rounded px-2 text-[12px] text-text-secondary hover:text-text-primary",
					mode === "table" && "bg-surface-3 text-text-primary",
				)}
			>
				<TableIcon size={14} />
				Table
			</button>
			<button
				type="button"
				aria-label="Board view"
				onClick={() => onChange("board")}
				className={cn(
					"flex h-7 items-center gap-1.5 rounded px-2 text-[12px] text-text-secondary hover:text-text-primary",
					mode === "board" && "bg-surface-3 text-text-primary",
				)}
			>
				<LayoutGrid size={14} />
				Board
			</button>
		</div>
	);
}

interface VaultContentProps {
	view: VaultTypeView;
	docs: VaultDoc[];
	isLoading: boolean;
	errorMessage: string | null;
	isMutating: boolean;
	selectedDoc: VaultDoc | null;
	onSelectDoc: (id: string | null) => void;
	onCreate: (title: string) => Promise<void>;
	onPatch: (id: string, patch: VaultDocPatch) => void;
	onDelete: (id: string) => void;
	onCardMove: (docId: string, toColumnId: string) => void;
}

export function VaultContent({
	view,
	docs,
	isLoading,
	errorMessage,
	isMutating,
	selectedDoc,
	onSelectDoc,
	onCreate,
	onPatch,
	onDelete,
	onCardMove,
}: VaultContentProps): React.ReactElement {
	const [mode, setMode] = useState<ViewMode>("table");
	const [isNewOpen, setIsNewOpen] = useState(false);
	const [isCreating, setIsCreating] = useState(false);

	const grouped = useMemo(() => groupDocsByStatus(view, docs), [view, docs]);
	const ViewIcon = view.icon;

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
				onPatch={onPatch}
				onDelete={onDelete}
				onBack={() => onSelectDoc(null)}
			/>
		);
	}

	return (
		<div className="flex flex-1 min-h-0 flex-col bg-surface-0">
			<div className="flex items-center gap-3 border-b border-border bg-surface-1 px-5 py-3">
				<div className="flex items-center gap-2 text-text-primary">
					<ViewIcon size={16} />
					<h2 className="text-sm font-semibold">{view.pluralLabel}</h2>
					<span className="text-[12px] text-text-tertiary">{docs.length}</span>
				</div>
				<div className="ml-auto flex items-center gap-2">
					{isMutating ? <Spinner size={14} /> : null}
					<ViewModeToggle mode={mode} onChange={setMode} />
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

			<div className="flex flex-1 min-h-0 flex-col">
				{isLoading && docs.length === 0 ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner size={24} />
					</div>
				) : errorMessage && docs.length === 0 ? (
					<div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-[13px] text-status-red">
						{errorMessage}
					</div>
				) : mode === "table" ? (
					<VaultTableView view={view} docs={docs} selectedDocId={null} onSelect={onSelectDoc} />
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
