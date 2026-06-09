import { Trash2 } from "lucide-react";
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
import type { RuntimeRequirementItem, RuntimeRequirementPriority, RuntimeRequirementStatus } from "@/runtime/types";
import type { RequirementPatch } from "@/state/requirements-state";

import {
	PRIORITY_LABELS,
	REQUIREMENT_PRIORITIES,
	REQUIREMENT_STATUSES,
	RequirementSelect,
	STATUS_LABELS,
} from "./requirement-meta";

interface RequirementDetailPanelProps {
	requirement: RuntimeRequirementItem;
	onPatch: (id: string, patch: RequirementPatch) => void;
	onDelete: (id: string) => void;
}

export function RequirementDetailPanel({
	requirement,
	onPatch,
	onDelete,
}: RequirementDetailPanelProps): React.ReactElement {
	const [title, setTitle] = useState(requirement.title);
	const [description, setDescription] = useState(requirement.description);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	// Re-seed local edit buffers when a different requirement is selected.
	useEffect(() => {
		setTitle(requirement.title);
		setDescription(requirement.description);
	}, [requirement.id, requirement.title, requirement.description]);

	function commitTitle(): void {
		const trimmed = title.trim();
		if (!trimmed || trimmed === requirement.title) {
			setTitle(requirement.title);
			return;
		}
		onPatch(requirement.id, { title: trimmed });
	}

	function commitDescription(): void {
		if (description === requirement.description) {
			return;
		}
		onPatch(requirement.id, { description });
	}

	return (
		<div className="flex flex-1 flex-col overflow-y-auto bg-surface-0">
			<div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
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
					aria-label="Delete requirement"
					onClick={() => setIsDeleteOpen(true)}
				/>
			</div>

			<div className="flex gap-6 border-b border-border px-5 py-4">
				<div className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">Priority</span>
					<RequirementSelect
						value={requirement.priority}
						options={REQUIREMENT_PRIORITIES}
						labels={PRIORITY_LABELS}
						onValueChange={(priority: RuntimeRequirementPriority) => onPatch(requirement.id, { priority })}
						ariaLabel="Priority"
						className="w-36"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">Status</span>
					<RequirementSelect
						value={requirement.status}
						options={REQUIREMENT_STATUSES}
						labels={STATUS_LABELS}
						onValueChange={(status: RuntimeRequirementStatus) => onPatch(requirement.id, { status })}
						ariaLabel="Status"
						className="w-36"
					/>
				</div>
			</div>

			<div className="flex flex-1 flex-col gap-1.5 px-5 py-4">
				<span className="text-[12px] font-medium text-text-secondary">Description</span>
				<textarea
					value={description}
					onChange={(event) => setDescription(event.target.value)}
					onBlur={commitDescription}
					placeholder="No description yet. Add acceptance criteria, context, links…"
					className="min-h-[12rem] flex-1 resize-none rounded-md border border-border-bright bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
				/>
			</div>

			<AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete requirement?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						“{requirement.title}” will be permanently removed. This cannot be undone.
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
								onDelete(requirement.id);
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
