import type React from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import type { VaultTypeView } from "../data/vault-type-registry";

/**
 * Title prompt for creating a new document. The body + frontmatter come from the
 * type's markdown template (built by the caller), so this dialog only collects the
 * human-meaningful title.
 */
export function NewDocDialog({
	view,
	open,
	isSaving,
	onOpenChange,
	onCreate,
}: {
	view: VaultTypeView;
	open: boolean;
	isSaving: boolean;
	onOpenChange: (open: boolean) => void;
	onCreate: (title: string) => void;
}): React.ReactElement {
	const [title, setTitle] = useState("");

	useEffect(() => {
		if (open) {
			setTitle("");
		}
	}, [open]);

	const canSave = title.trim().length > 0 && !isSaving;
	const ViewIcon = view.icon;

	function submit(): void {
		if (!canSave) {
			return;
		}
		onCreate(title.trim());
	}

	return (
		<Dialog
			open={open}
			contentAriaDescribedBy={undefined}
			onOpenChange={(next) => {
				if (!isSaving) {
					onOpenChange(next);
				}
			}}
		>
			<DialogHeader title={`New ${view.label}`} icon={<ViewIcon size={16} />} />
			<DialogBody>
				<input
					autoFocus
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							submit();
						}
					}}
					placeholder={`${view.label} title`}
					disabled={isSaving}
					className="h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
				/>
			</DialogBody>
			<DialogFooter>
				<Button onClick={() => onOpenChange(false)} disabled={isSaving}>
					Cancel
				</Button>
				<Button variant="primary" onClick={submit} disabled={!canSave}>
					{isSaving ? (
						<>
							<Spinner size={12} />
							Creating…
						</>
					) : (
						"Create"
					)}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
