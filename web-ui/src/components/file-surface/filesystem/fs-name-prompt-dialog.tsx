import type React from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";

export interface FsNamePromptDialogProps {
	open: boolean;
	title: string;
	label: string;
	/** Pre-filled value (the current name when renaming). */
	initialValue: string;
	submitLabel: string;
	/**
	 * Perform the action. Resolve with an error message to keep the dialog open
	 * and show it inline, or `null`/`undefined` on success (the dialog closes).
	 */
	onSubmit: (name: string) => Promise<string | null | undefined>;
	onClose: () => void;
}

/**
 * A minimal single-field prompt for naming a new file/folder or renaming an
 * entry. Validation of illegal names lives on the backend (path separators,
 * reserved dirs, collisions); this dialog surfaces those errors inline and only
 * blocks the trivially-empty case client-side.
 */
export function FsNamePromptDialog({
	open,
	title,
	label,
	initialValue,
	submitLabel,
	onSubmit,
	onClose,
}: FsNamePromptDialogProps): React.ReactElement {
	const [value, setValue] = useState(initialValue);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Reset the field whenever the dialog (re)opens for a new target.
	useEffect(() => {
		if (open) {
			setValue(initialValue);
			setError(null);
			setSubmitting(false);
		}
	}, [open, initialValue]);

	// Select the base name (before the extension) so renaming is quick.
	useEffect(() => {
		if (!open) {
			return;
		}
		const input = inputRef.current;
		if (!input) {
			return;
		}
		input.focus();
		const dot = initialValue.lastIndexOf(".");
		input.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
	}, [open, initialValue]);

	const submit = async (): Promise<void> => {
		const trimmed = value.trim();
		if (trimmed === "") {
			setError("Name cannot be empty.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const message = await onSubmit(trimmed);
		if (message) {
			setError(message);
			setSubmitting(false);
			return;
		}
		onClose();
	};

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())} contentClassName="max-w-sm">
			<DialogHeader title={title} />
			<DialogBody>
				<label className="flex flex-col gap-1.5 text-[12px] text-text-secondary">
					{label}
					<input
						ref={inputRef}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void submit();
							}
						}}
						spellCheck={false}
						autoComplete="off"
						className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-border-focus"
					/>
				</label>
				{error ? <p className="mt-2 text-[12px] text-status-red">{error}</p> : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" onClick={() => void submit()} disabled={submitting}>
					{submitLabel}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
