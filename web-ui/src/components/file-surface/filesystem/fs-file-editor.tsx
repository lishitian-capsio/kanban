import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { notifyError } from "@/components/app-toaster";
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
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { DocEditor } from "@/components/vault/editor/doc-editor";
import type { RuntimeFsReadFileResponse } from "@/runtime/types";

import { CodeEditorLazy } from "./code-editor-lazy";
import { useFsWrite } from "./use-fs-write";

type SaveState = "idle" | "saving" | "error";

interface FsFileEditorProps {
	workspaceId: string | null;
	/** Repo-relative POSIX path (the parent keys this component by it — remounts on switch). */
	path: string;
	/** Base name, drives the code language mapping. */
	name: string;
	/** Which editor to render (design §5.1). */
	kind: "code" | "markdown";
	/** Content the file was read at — the initial draft + saved baseline. */
	initialContent: string;
	/** Mtime the file was read at — the optimistic-concurrency baseline. */
	initialMtimeMs: number;
	/** Re-read the file from disk (used by the conflict "reload" path). */
	refetch: () => Promise<RuntimeFsReadFileResponse | null>;
	/** Report the unsaved-changes state up so navigation away can be guarded. */
	onDirtyChange: (dirty: boolean) => void;
}

/**
 * Editable body for one working-tree text/markdown file. Owns a local draft
 * buffer (mirrors `FileOverlayBody`), an explicit Save (⌘S) and the
 * optimistic-concurrency baseline: it sends the mtime it opened at, and on a
 * `conflict` prompts the user to overwrite (force) or reload from disk. Mounted
 * per path (keyed by the parent), so switching files remounts with fresh props.
 */
export function FsFileEditor({
	workspaceId,
	path,
	name,
	kind,
	initialContent,
	initialMtimeMs,
	refetch,
	onDirtyChange,
}: FsFileEditorProps): React.ReactElement {
	const { write } = useFsWrite(workspaceId);

	const [draft, setDraft] = useState(initialContent);
	// The last content known to be on disk — dirty is measured against this, and
	// it advances on every successful save / reload.
	const [savedContent, setSavedContent] = useState(initialContent);
	const [baselineMtime, setBaselineMtime] = useState(initialMtimeMs);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [conflictOpen, setConflictOpen] = useState(false);

	const dirty = draft !== savedContent;

	// Bubble dirty up (for the navigation guard), and clear it on unmount so a
	// closing editor never leaves a stale "dirty" flag latched in the parent.
	useEffect(() => {
		onDirtyChange(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

	const adoptFromDisk = useCallback((fresh: RuntimeFsReadFileResponse) => {
		const content = fresh.content ?? "";
		setDraft(content);
		setSavedContent(content);
		setBaselineMtime(fresh.mtimeMs);
	}, []);

	// A single save attempt. `force` re-sends without the mtime baseline after the
	// user chose to overwrite from the conflict dialog.
	const runSave = useCallback(
		async (force: boolean) => {
			setSaveState("saving");
			const result = await write(path, draft, {
				encoding: "utf8",
				expectedMtimeMs: force ? undefined : baselineMtime,
			});
			if (result.ok) {
				setSavedContent(draft);
				if (result.mtimeMs !== undefined) {
					setBaselineMtime(result.mtimeMs);
				}
				setSaveState("idle");
				setConflictOpen(false);
				return;
			}
			if (result.conflict) {
				setSaveState("idle");
				setConflictOpen(true);
				return;
			}
			setSaveState("error");
			notifyError(result.error ?? "Failed to save the file.");
		},
		[write, path, draft, baselineMtime],
	);

	const handleSave = useCallback(() => {
		if (!dirty || saveState === "saving") {
			return;
		}
		void runSave(false);
	}, [dirty, saveState, runSave]);

	const handleReload = useCallback(async () => {
		setConflictOpen(false);
		const fresh = await refetch();
		if (fresh?.ok && !fresh.tooLarge) {
			adoptFromDisk(fresh);
		}
	}, [refetch, adoptFromDisk]);

	// ⌘/Ctrl+S saves. enableOnContentEditable is required — CodeMirror's editing
	// surface is contentEditable, and the markdown textarea is a form tag.
	useHotkeys(
		"mod+s",
		() => handleSave(),
		{ enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
		[handleSave],
	);

	const isSaving = saveState === "saving";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-hidden">
				{kind === "markdown" ? (
					<DocEditor value={draft} onChange={setDraft} />
				) : (
					<CodeEditorLazy value={draft} fileName={name} editable onChange={setDraft} />
				)}
			</div>

			<div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
				<span className={cn("text-[12px]", saveState === "error" ? "text-status-red" : "text-text-tertiary")}>
					{saveState === "error"
						? "Save failed — try again."
						: isSaving
							? "Saving…"
							: dirty
								? "Unsaved changes"
								: "All changes saved"}
				</span>
				<Button
					className="ml-auto"
					variant="primary"
					size="sm"
					onClick={handleSave}
					disabled={!dirty || isSaving}
					icon={isSaving ? <Spinner size={14} /> : undefined}
				>
					Save
				</Button>
			</div>

			<AlertDialog open={conflictOpen} onOpenChange={setConflictOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>File changed on disk</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						<span className="font-medium text-text-primary">{name}</span> was modified outside the editor since
						you opened it. Overwrite it with your changes, or reload the on-disk version and lose your edits.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="ghost" size="sm">
							Keep editing
						</Button>
					</AlertDialogCancel>
					<Button variant="default" size="sm" onClick={() => void handleReload()}>
						Reload from disk
					</Button>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							size="sm"
							onClick={(event) => {
								event.preventDefault();
								void runSave(true);
							}}
						>
							Overwrite
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
