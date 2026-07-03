import { ImagePlus, Paperclip } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useKanbanComposerCompletion } from "@/components/detail-panels/use-kanban-composer-completion";
import { InlineCompletionPicker } from "@/components/inline-completion-picker";
import {
	ACCEPTED_TASK_IMAGE_INPUT_ACCEPT,
	collectImageFilesFromDataTransfer,
	extractImagesFromDataTransfer,
	fileToTaskImage,
} from "@/components/task-image-input-utils";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { TaskImage } from "@/types";

const TEXTAREA_MAX_HEIGHT = 200;

interface TaskPromptComposerProps {
	id?: string;
	value: string;
	onValueChange: (value: string) => void;
	images?: TaskImage[];
	onImagesChange?: (images: TaskImage[]) => void;
	onSubmit?: () => void;
	onSubmitAndStart?: () => void;
	onEscape?: () => void;
	placeholder?: string;
	disabled?: boolean;
	enabled?: boolean;
	autoFocus?: boolean;
	workspaceId?: string | null;
	showAttachImageButton?: boolean;
	/**
	 * Opt-in `/` slash-command completion (off by default so task-creation forms
	 * stay mention-only). `@` file mentions are always available when a
	 * `workspaceId` is supplied.
	 */
	enableSlashCommands?: boolean;
}

export function TaskPromptComposer({
	id,
	value,
	onValueChange,
	images = [],
	onImagesChange,
	onSubmit,
	onSubmitAndStart,
	onEscape,
	placeholder,
	disabled,
	enabled = true,
	autoFocus = false,
	workspaceId = null,
	showAttachImageButton = true,
	enableSlashCommands = false,
}: TaskPromptComposerProps): ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);

	const {
		setCursorIndex,
		showCompletionPicker,
		completionItems,
		selectedCompletionIndex,
		setSelectedCompletionIndex,
		isCompletionLoading,
		completionLoadingMessage,
		completionEmptyMessage,
		onSelectCompletionItem,
		handleCompletionKeyDown,
	} = useKanbanComposerCompletion({
		value,
		onValueChange,
		textareaRef,
		workspaceId,
		enabled,
		enableSlashCommands,
	});

	const autoResizeTextarea = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
	}, []);

	useEffect(() => {
		autoResizeTextarea();
	}, [autoResizeTextarea, value]);

	useEffect(() => {
		if (!autoFocus || disabled || !enabled) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (!textareaRef.current) {
				return;
			}
			const cursor = textareaRef.current.value.length;
			textareaRef.current.focus();
			textareaRef.current.setSelectionRange(cursor, cursor);
			setCursorIndex(cursor);
		});
	}, [autoFocus, disabled, enabled, setCursorIndex]);

	const handleTextareaKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey && onSubmitAndStart) {
					onSubmitAndStart();
					return;
				}
				onSubmit?.();
				return;
			}

			if (handleCompletionKeyDown(event)) {
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				onEscape?.();
			}
		},
		[handleCompletionKeyDown, onEscape, onSubmit, onSubmitAndStart],
	);

	const appendImages = useCallback(
		(newImages: TaskImage[]) => {
			if (!onImagesChange || newImages.length === 0) {
				return;
			}
			onImagesChange([...images, ...newImages]);
		},
		[images, onImagesChange],
	);

	const handlePaste = useCallback(
		(event: ClipboardEvent<HTMLTextAreaElement>) => {
			if (!onImagesChange || !event.clipboardData) {
				return;
			}
			const imageFiles = collectImageFilesFromDataTransfer(event.clipboardData);
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const newImages = await extractImagesFromDataTransfer(event.clipboardData);
				appendImages(newImages);
			})();
		},
		[appendImages, onImagesChange],
	);

	const handleDrop = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			setIsDragOver(false);
			if (!onImagesChange || !event.dataTransfer) {
				return;
			}
			const imageFiles = collectImageFilesFromDataTransfer(event.dataTransfer);
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const newImages = await extractImagesFromDataTransfer(event.dataTransfer);
				appendImages(newImages);
			})();
		},
		[appendImages, onImagesChange],
	);

	const handleDragOver = useCallback(
		(event: DragEvent<HTMLDivElement>) => {
			if (!onImagesChange) {
				return;
			}
			const hasFiles = event.dataTransfer.types.includes("Files");
			if (!hasFiles) {
				return;
			}
			event.preventDefault();
			setIsDragOver(true);
		},
		[onImagesChange],
	);

	const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
		// Only clear drag state when leaving the drop zone container,
		// not when moving between child elements within it.
		if (event.currentTarget.contains(event.relatedTarget as Node)) {
			return;
		}
		setIsDragOver(false);
	}, []);

	const handleRemoveImage = useCallback(
		(imageId: string) => {
			onImagesChange?.(images.filter((image) => image.id !== imageId));
		},
		[images, onImagesChange],
	);

	const handleAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileInputChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			if (!onImagesChange || !event.currentTarget.files) {
				return;
			}
			const files = Array.from(event.currentTarget.files);
			void (async () => {
				const newImages: TaskImage[] = [];
				for (const file of files) {
					const image = await fileToTaskImage(file);
					if (image) {
						newImages.push(image);
					}
				}
				appendImages(newImages);
				event.currentTarget.value = "";
			})();
		},
		[appendImages, onImagesChange],
	);

	return (
		<div>
			<div className="relative" onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
				<InlineCompletionPicker
					open={showCompletionPicker}
					items={completionItems}
					selectedIndex={selectedCompletionIndex}
					onSelectItem={onSelectCompletionItem}
					onHoverItem={setSelectedCompletionIndex}
					isLoading={isCompletionLoading}
					loadingMessage={completionLoadingMessage}
					emptyMessage={completionEmptyMessage}
				>
					<textarea
						id={id}
						ref={textareaRef}
						value={value}
						onChange={(event) => {
							onValueChange(event.target.value);
							setCursorIndex(event.target.selectionStart ?? event.target.value.length);
						}}
						onKeyDown={handleTextareaKeyDown}
						onClick={(event) =>
							setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
						}
						onKeyUp={(event) =>
							setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
						}
						onPaste={handlePaste}
						placeholder={placeholder ?? "Describe the task"}
						disabled={disabled}
						className={cn(
							"w-full rounded-md border bg-surface-3 p-3 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
							isDragOver ? "border-accent border-dashed" : "border-border-bright",
						)}
						style={{
							minHeight: 80,
							maxHeight: TEXTAREA_MAX_HEIGHT,
							resize: "none",
							overflowY: "auto",
						}}
					/>
				</InlineCompletionPicker>
				{isDragOver ? (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-accent/5">
						<div className="flex items-center gap-1.5 text-[12px] text-accent font-medium">
							<ImagePlus size={14} />
							<span>Drop image here</span>
						</div>
					</div>
				) : null}
			</div>

			{images.length > 0 ? (
				<TaskImageStrip images={images} onRemoveImage={handleRemoveImage} className="mt-1.5" />
			) : null}

			{onImagesChange && showAttachImageButton ? (
				<>
					<input
						ref={fileInputRef}
						type="file"
						accept={ACCEPTED_TASK_IMAGE_INPUT_ACCEPT}
						multiple
						className="hidden"
						onChange={handleFileInputChange}
					/>
					<div className={images.length > 0 ? "mt-1" : "mt-1.5"}>
						<Button
							variant="ghost"
							size="sm"
							icon={<Paperclip size={14} />}
							onClick={handleAttachClick}
							disabled={disabled || !enabled}
						>
							Attach image
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}
