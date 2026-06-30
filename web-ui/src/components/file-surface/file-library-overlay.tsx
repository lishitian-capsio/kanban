import * as RadixDialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import type React from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { FilesView } from "@/components/files/files-view";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

interface FileLibraryOverlayProps {
	open: boolean;
	workspaceId: string | null;
	onClose: () => void;
	/** Jump to the single-doc quick-open palette without leaving the surface. */
	onOpenPalette: () => void;
}

/**
 * The binary file library, rehomed out of the Vault sidebar into the File
 * surface (file-surface-migration-design §4). It wraps the shared
 * `components/files/FilesView` in a Radix-portaled overlay layered above a board
 * that never unmounts — the perf win over its old life as a board-*replacing*
 * page inside `VaultView` (where every open/close remounted the whole board).
 *
 * The overlay owns only the dialog chrome (a slim header with a close control
 * and a "quick-open a document" affordance so the markdown single-doc lane stays
 * reachable within the surface); `FilesView` is unchanged and still carries its
 * own toolbar. The library has no unsaved-edit concept (uploads/renames commit
 * immediately), so there is no dirty-guard — closing is always safe.
 */
export function FileLibraryOverlay({
	open,
	workspaceId,
	onClose,
	onOpenPalette,
}: FileLibraryOverlayProps): React.ReactElement {
	// Scoped to the mounted overlay: ⌘/Ctrl+K jumps to the document quick-open
	// palette. Registered here (not board-wide) so it can't collide with the
	// Vault-scoped ⌘K, which lives inside a separately-mounted VaultView.
	useHotkeys(
		"mod+k",
		() => onOpenPalette(),
		{ enabled: open, enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
		[open, onOpenPalette],
	);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			contentClassName="max-w-5xl w-[92vw] h-[85vh] p-0 overflow-hidden"
		>
			<RadixDialog.Title className="sr-only">Files</RadixDialog.Title>
			<div className="flex flex-1 min-h-0 flex-col">
				<div className="flex items-center justify-end gap-2 border-b border-[#5A6572] bg-surface-2 px-3 py-1.5 rounded-t-lg shrink-0">
					<Button variant="ghost" size="sm" icon={<Search size={14} />} onClick={onOpenPalette}>
						Open document
						<Kbd className="ml-1.5">⌘K</Kbd>
					</Button>
					<RadixDialog.Close
						className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-3 cursor-pointer"
						aria-label="Close"
					>
						<X size={16} />
					</RadixDialog.Close>
				</div>
				<FilesView workspaceId={workspaceId} />
			</div>
		</Dialog>
	);
}
