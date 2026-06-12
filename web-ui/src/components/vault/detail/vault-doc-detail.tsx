import { ArrowLeft, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";

import type { VaultDocPatch } from "../data/use-vault-docs";
import type { VaultDoc } from "../data/vault-doc-model";
import type { VaultTypeView } from "../data/vault-type-registry";
import { DocEditor } from "../editor/doc-editor";
import type { VaultWikilinkBinding } from "../links/vault-wikilink-binding";
import { VaultPropertiesPanel } from "./vault-properties-panel";

interface VaultDocDetailProps {
	view: VaultTypeView;
	doc: VaultDoc;
	/** `type:customer` docs, for the customer picker on requirement-like types. */
	customers: VaultDoc[];
	/** Type-specific sections rendered between the properties panel and the editor. */
	extras?: React.ReactNode;
	/** Body `[[wikilink]]` autocomplete + render binding (omitted ⇒ plain markdown). */
	wikilinks?: VaultWikilinkBinding;
	onPatch: (id: string, patch: VaultDocPatch) => void;
	onDelete: (id: string) => void;
	onBack: () => void;
}

/**
 * Document detail surface: title (commit-on-blur), structured properties, and the
 * body markdown editor. Mirrors `RequirementDetailPanel`'s local-buffer pattern —
 * edits are buffered locally and committed on blur so a patch never round-trips
 * per keystroke.
 */
export function VaultDocDetail({
	view,
	doc,
	customers,
	extras,
	wikilinks,
	onPatch,
	onDelete,
	onBack,
}: VaultDocDetailProps): React.ReactElement {
	const [title, setTitle] = useState(doc.name);
	const [body, setBody] = useState(doc.body);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	// Re-seed local buffers when a different document is selected or saved.
	useEffect(() => {
		setTitle(doc.name);
		setBody(doc.body);
	}, [doc.id, doc.name, doc.body]);

	function commitTitle(): void {
		const trimmed = title.trim();
		if (!trimmed || trimmed === doc.name) {
			setTitle(doc.name);
			return;
		}
		onPatch(doc.id, { title: trimmed });
	}

	function commitBody(): void {
		if (body === doc.body) {
			return;
		}
		onPatch(doc.id, { body });
	}

	return (
		<div className="flex flex-1 min-h-0 flex-col bg-surface-0">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<Button
					variant="ghost"
					size="sm"
					icon={<ArrowLeft size={16} />}
					onClick={onBack}
					aria-label="Back to list"
				/>
				<input
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					onBlur={commitTitle}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.currentTarget.blur();
						}
					}}
					className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold text-text-primary outline-none hover:border-border focus:border-border-focus focus:bg-surface-2"
				/>
				<Button
					variant="danger"
					size="sm"
					icon={<Trash2 size={14} />}
					aria-label={`Delete ${view.label.toLowerCase()}`}
					onClick={() => setIsDeleteOpen(true)}
				/>
			</div>

			<VaultPropertiesPanel
				view={view}
				doc={doc}
				customers={customers}
				onPatchFrontmatter={(patch) => onPatch(doc.id, { frontmatter: patch })}
			/>

			{extras}

			<DocEditor value={body} onChange={setBody} onBlur={commitBody} wikilinks={wikilinks} />

			<AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {view.label.toLowerCase()}?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						“{doc.name}” will be permanently removed. This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsDeleteOpen(false)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								setIsDeleteOpen(false);
								onDelete(doc.id);
							}}
						>
							Delete
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
