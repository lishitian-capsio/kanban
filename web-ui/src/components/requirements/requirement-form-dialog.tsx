import { ListChecks } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { RuntimeRequirementPriority, RuntimeRequirementStatus } from "@/runtime/types";
import type { RequirementDraft } from "@/state/requirements-state";

import {
	PRIORITY_LABELS,
	REQUIREMENT_PRIORITIES,
	REQUIREMENT_STATUSES,
	RequirementSelect,
	STATUS_LABELS,
} from "./requirement-meta";

interface RequirementFormDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreate: (draft: RequirementDraft) => void;
}

export function RequirementFormDialog({ open, onOpenChange, onCreate }: RequirementFormDialogProps): React.ReactElement {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [priority, setPriority] = useState<RuntimeRequirementPriority>("medium");
	const [status, setStatus] = useState<RuntimeRequirementStatus>("draft");

	const trimmedTitle = title.trim();
	const canSubmit = trimmedTitle.length > 0;

	function resetAndClose(): void {
		setTitle("");
		setDescription("");
		setPriority("medium");
		setStatus("draft");
		onOpenChange(false);
	}

	function handleSubmit(): void {
		if (!canSubmit) {
			return;
		}
		onCreate({ title: trimmedTitle, description, priority, status });
		resetAndClose();
	}

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : resetAndClose())}>
			<DialogHeader title="New requirement" icon={<ListChecks size={16} />} />
			<DialogBody className="flex flex-col gap-4">
				<label className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">Title</span>
					<input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								handleSubmit();
							}
						}}
						placeholder="e.g. Support phone-number login"
						className="h-9 rounded-md border border-border-bright bg-surface-2 px-3 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
					/>
				</label>
				<label className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">Description</span>
					<textarea
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						placeholder="What is the requirement? Acceptance criteria, context, links…"
						rows={5}
						className="resize-y rounded-md border border-border-bright bg-surface-2 px-3 py-2 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
					/>
				</label>
				<div className="flex gap-4">
					<div className="flex flex-1 flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">Priority</span>
						<RequirementSelect
							value={priority}
							options={REQUIREMENT_PRIORITIES}
							labels={PRIORITY_LABELS}
							onValueChange={setPriority}
							ariaLabel="Priority"
						/>
					</div>
					<div className="flex flex-1 flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">Status</span>
						<RequirementSelect
							value={status}
							options={REQUIREMENT_STATUSES}
							labels={STATUS_LABELS}
							onValueChange={setStatus}
							ariaLabel="Status"
						/>
					</div>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" onClick={resetAndClose}>
					Cancel
				</Button>
				<Button variant="primary" disabled={!canSubmit} onClick={handleSubmit}>
					Create
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
