import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Dialog,
	DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import { DocEditor } from "../vault/editor/doc-editor";
import type { FileRecent } from "./use-file-recents";
import { useFileDoc } from "./use-file-doc";

interface FileOverlayProps {
	open: boolean;
	fileId: string | null;
	workspaceId: string | null;
	onClose: () => void;
	/** Called once the open file's real title is known, to record it in recents. */
	onFileOpened?: (recent: FileRecent) => void;
}

/**
 * The single File surface editor overlay. The board never unmounts behind it —
 * Radix portals the content as a sibling layered above (file-surface-design §2,
 * §8). The editable body (`FileOverlayBody`) is only mounted while `open`, so the
 * markdown editor + drafts are created on open and released on close (no
 * `forceMount`), keeping first paint and memory unaffected.
 *
 * Close routes through a dirty-guard: the body reports its dirty state into
 * `dirtyRef`, and any close gesture (Esc / overlay / ✕ / Close button) is
 * intercepted to confirm via an `AlertDialog` before discarding unsaved edits.
 */
export function FileOverlay({
	open,
	fileId,
	workspaceId,
	onClose,
	onFileOpened,
}: FileOverlayProps): React.ReactElement {
	const dirtyRef = useRef(false);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const close = useCallback(() => {
		dirtyRef.current = false;
		setConfirmOpen(false);
		onClose();
	}, [onClose]);

	const requestClose = useCallback(() => {
		if (dirtyRef.current) {
			setConfirmOpen(true);
			return;
		}
		close();
	}, [close]);

	const setDirty = useCallback((dirty: boolean) => {
		dirtyRef.current = dirty;
	}, []);

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) {
						requestClose();
					}
				}}
				onEscapeKeyDown={(event) => {
					if (dirtyRef.current) {
						event.preventDefault();
						setConfirmOpen(true);
					}
				}}
				contentClassName="max-w-3xl w-[90vw] h-[80vh] p-0"
			>
				{fileId ? (
					<FileOverlayBody
						key={fileId}
						fileId={fileId}
						workspaceId={workspaceId}
						onDirtyChange={setDirty}
						onRequestClose={requestClose}
						onFileOpened={onFileOpened}
					/>
				) : null}
			</Dialog>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This file has edits that haven’t been saved. Closing now will discard them.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setConfirmOpen(false)}>
							Keep editing
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="danger" onClick={close}>
							Discard
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}

interface FileOverlayBodyProps {
	fileId: string;
	workspaceId: string | null;
	onDirtyChange: (dirty: boolean) => void;
	onRequestClose: () => void;
	onFileOpened?: (recent: FileRecent) => void;
}

/**
 * Overlay body: title (commit-on-blur) + markdown editor (commit-on-blur) +
 * footer (explicit Save + Close). Local-buffer pattern — same as
 * `VaultDocDetail` — so a patch never round-trips per keystroke. Mounted only
 * while the overlay is open, so this state is created on open / discarded on
 * close.
 */
function FileOverlayBody({
	fileId,
	workspaceId,
	onDirtyChange,
	onRequestClose,
	onFileOpened,
}: FileOverlayBodyProps): React.ReactElement {
	const { loadState, doc, loadErrorMessage, saveState, save } = useFileDoc(workspaceId, fileId);

	const [draftTitle, setDraftTitle] = useState("");
	const [draftBody, setDraftBody] = useState("");

	// Re-seed local buffers when the doc loads or is saved (mirrors VaultDocDetail).
	useEffect(() => {
		if (doc) {
			setDraftTitle(doc.title);
			setDraftBody(doc.body);
		}
	}, [doc]);

	// Record the file in recents once its authoritative title is known. Done here
	// (not at openFile time) so every entry path — wikilink, URL, palette — gets a
	// real label, and so the opener seam stays a bare `(id) => void`.
	useEffect(() => {
		if (loadState === "ready" && doc) {
			onFileOpened?.({ id: doc.id, title: doc.title });
		}
	}, [loadState, doc, onFileOpened]);

	const dirty = doc !== null && (draftTitle.trim() !== doc.title || draftBody !== doc.body);
	useEffect(() => {
		onDirtyChange(dirty);
	}, [dirty, onDirtyChange]);
	// A closing body must never leave a stale "dirty" flag latched in the parent.
	useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

	const commitTitle = useCallback(() => {
		if (!doc) {
			return;
		}
		const trimmed = draftTitle.trim();
		if (!trimmed || trimmed === doc.title) {
			setDraftTitle(doc.title);
			return;
		}
		void save({ title: trimmed });
	}, [doc, draftTitle, save]);

	const commitBody = useCallback(() => {
		if (!doc || draftBody === doc.body) {
			return;
		}
		void save({ body: draftBody });
	}, [doc, draftBody, save]);

	const handleSave = useCallback(() => {
		if (!doc) {
			return;
		}
		const trimmed = draftTitle.trim();
		void save({ title: trimmed || doc.title, body: draftBody });
	}, [doc, draftTitle, draftBody, save]);

	const isSaving = saveState === "saving";

	return (
		<>
			<div className="flex items-center gap-2 px-3 py-2 bg-surface-2 border-b border-[#5A6572] shrink-0 rounded-t-lg">
				<RadixDialog.Title asChild>
					<input
						value={draftTitle}
						onChange={(event) => setDraftTitle(event.target.value)}
						onBlur={commitTitle}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.currentTarget.blur();
							}
						}}
						disabled={loadState !== "ready"}
						placeholder="Untitled"
						aria-label="File title"
						className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold text-text-primary outline-none hover:border-border focus:border-border-focus focus:bg-surface-1 disabled:opacity-60"
					/>
				</RadixDialog.Title>
				<RadixDialog.Close
					className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-3 cursor-pointer"
					aria-label="Close"
				>
					<X size={16} />
				</RadixDialog.Close>
			</div>

			<div className="flex flex-1 min-h-0 flex-col bg-surface-1">
				{loadState === "loading" ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner size={24} />
					</div>
				) : loadState === "error" ? (
					<div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-text-secondary">
						{loadErrorMessage ?? "Could not load the file."}
					</div>
				) : (
					<DocEditor value={draftBody} onChange={setDraftBody} onBlur={commitBody} />
				)}
			</div>

			<DialogFooter>
				<span
					className={cn(
						"mr-auto self-center text-xs",
						saveState === "error" ? "text-status-red" : "text-text-tertiary",
					)}
				>
					{saveState === "error" ? "Save failed — try again." : dirty ? "Unsaved changes" : "All changes saved"}
				</span>
				<Button variant="default" onClick={onRequestClose}>
					Close
				</Button>
				<Button
					variant="primary"
					onClick={handleSave}
					disabled={loadState !== "ready" || isSaving || !dirty}
					icon={isSaving ? <Spinner size={14} /> : undefined}
				>
					Save
				</Button>
			</DialogFooter>
		</>
	);
}
