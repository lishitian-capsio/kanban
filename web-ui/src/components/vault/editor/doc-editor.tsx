import "@uiw/react-md-editor/markdown-editor.css";

import MDEditor from "@uiw/react-md-editor";
import { Eye, Pencil } from "lucide-react";
import type React from "react";
import { type ComponentRef, useRef, useState } from "react";

import { InlineCompletionPicker } from "@/components/inline-completion-picker";
import { cn } from "@/components/ui/cn";

import { useWikilinkEditorCompletion } from "../links/use-wikilink-editor-completion";
import type { VaultWikilinkBinding } from "../links/vault-wikilink-binding";
import { DocPreview } from "./doc-preview";

const EMPTY_CANDIDATES: VaultWikilinkBinding["candidates"] = [];

/**
 * Body-only markdown editor backed by `@uiw/react-md-editor`. Frontmatter is
 * edited separately (properties panel), so this editor can never corrupt it.
 * The preview tab delegates to `KanbanMarkdownContent` (via `DocPreview`) rather
 * than the editor's bundled preview, keeping markdown rendering consistent and
 * the editor's own CSS constrained to the dark-token wrapper below.
 *
 * When a `wikilinks` binding is supplied, typing `[[` opens a fuzzy doc picker and
 * the preview renders `[[links]]` as interactive chips.
 */
export function DocEditor({
	value,
	onChange,
	onBlur,
	wikilinks,
}: {
	value: string;
	onChange: (next: string) => void;
	onBlur?: () => void;
	wikilinks?: VaultWikilinkBinding;
}): React.ReactElement {
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const editorRef = useRef<ComponentRef<typeof MDEditor> | null>(null);

	const completion = useWikilinkEditorCompletion({
		value,
		onChange,
		candidates: wikilinks?.candidates ?? EMPTY_CANDIDATES,
		currentDocId: wikilinks?.currentDocId ?? "",
		getTextarea: () => editorRef.current?.textarea ?? null,
	});
	const completionEnabled = Boolean(wikilinks);
	const showPicker = completionEnabled && completion.open;

	return (
		<div className="flex flex-1 min-h-0 flex-col">
			<div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
				<button
					type="button"
					onClick={() => setMode("edit")}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-text-secondary hover:bg-surface-2",
						mode === "edit" && "bg-surface-2 text-text-primary",
					)}
				>
					<Pencil size={13} />
					Edit
				</button>
				<button
					type="button"
					onClick={() => setMode("preview")}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-text-secondary hover:bg-surface-2",
						mode === "preview" && "bg-surface-2 text-text-primary",
					)}
				>
					<Eye size={13} />
					Preview
				</button>
			</div>
			{mode === "edit" ? (
				<InlineCompletionPicker
					open={showPicker}
					items={completion.items}
					selectedIndex={completion.selectedIndex}
					onSelectItem={(item) => completion.selectItem(item)}
					onHoverItem={completion.setSelectedIndex}
					emptyMessage={completion.emptyMessage}
					side="bottom"
				>
					<div className="kb-md-editor flex-1 overflow-auto p-1" data-color-mode="dark" onBlur={onBlur}>
						<MDEditor
							ref={editorRef}
							value={value}
							onChange={(next) => {
								onChange(next ?? "");
								if (completionEnabled) {
									completion.syncCaret();
								}
							}}
							preview="edit"
							visibleDragbar={false}
							height="100%"
							textareaProps={{
								placeholder: "Write the document body in markdown…",
								...(completionEnabled
									? {
											onKeyDown: completion.handleKeyDown,
											onKeyUp: () => completion.syncCaret(),
											onClick: () => completion.syncCaret(),
										}
									: {}),
							}}
						/>
					</div>
				</InlineCompletionPicker>
			) : (
				<div className="flex-1 overflow-auto px-4 py-3">
					<DocPreview body={value} wikilinks={wikilinks?.rendering} />
				</div>
			)}
		</div>
	);
}
