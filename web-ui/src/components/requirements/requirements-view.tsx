import { ListChecks, Plus } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type {
	RuntimeRequirementPriority,
	RuntimeRequirementsData,
	RuntimeRequirementStatus,
} from "@/runtime/types";
import {
	addRequirement,
	deleteRequirement,
	type RequirementDraft,
	type RequirementPatch,
	sortRequirements,
	updateRequirement,
} from "@/state/requirements-state";

import { RequirementDetailPanel } from "./requirement-detail-panel";
import { RequirementFormDialog } from "./requirement-form-dialog";
import { RequirementList } from "./requirement-list";
import {
	PRIORITY_LABELS,
	REQUIREMENT_PRIORITIES,
	REQUIREMENT_STATUSES,
	RequirementSelect,
	STATUS_LABELS,
} from "./requirement-meta";

interface RequirementsViewProps {
	workspaceId: string | null;
	requirements: RuntimeRequirementsData;
	/** Persisted workspace revision; bumps after each save so version history can refetch. */
	revision: number;
	onRequirementsChange: (next: RuntimeRequirementsData) => void;
}

type StatusFilter = RuntimeRequirementStatus | "all";
type PriorityFilter = RuntimeRequirementPriority | "all";

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = { all: "All statuses", ...STATUS_LABELS };
const PRIORITY_FILTER_LABELS: Record<PriorityFilter, string> = { all: "All priorities", ...PRIORITY_LABELS };

export function RequirementsView({
	workspaceId,
	requirements,
	revision,
	onRequirementsChange,
}: RequirementsViewProps): React.ReactElement {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
	const [isFormOpen, setIsFormOpen] = useState(false);

	const visibleRequirements = useMemo(() => {
		const filtered = requirements.items.filter(
			(item) =>
				(statusFilter === "all" || item.status === statusFilter) &&
				(priorityFilter === "all" || item.priority === priorityFilter),
		);
		return sortRequirements(filtered);
	}, [requirements.items, statusFilter, priorityFilter]);

	const selected = useMemo(
		() => requirements.items.find((item) => item.id === selectedId) ?? null,
		[requirements.items, selectedId],
	);

	function handleCreate(draft: RequirementDraft): void {
		const result = addRequirement(requirements, draft);
		onRequirementsChange(result.data);
		setSelectedId(result.requirement.id);
	}

	function handlePatch(id: string, patch: RequirementPatch): void {
		const result = updateRequirement(requirements, id, patch);
		if (result.updated) {
			onRequirementsChange(result.data);
		}
	}

	function handleDelete(id: string): void {
		const result = deleteRequirement(requirements, id);
		if (result.removed) {
			onRequirementsChange(result.data);
			if (selectedId === id) {
				setSelectedId(null);
			}
		}
	}

	if (!workspaceId) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-0 py-12 text-text-tertiary">
				<ListChecks size={48} />
				<h3 className="font-semibold text-text-primary">No project selected</h3>
				<p className="text-[13px]">Select a project to manage its requirements.</p>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col bg-surface-0">
			<div className="flex items-center gap-3 border-b border-border bg-surface-1 px-5 py-3">
				<div className="flex items-center gap-2 text-text-primary">
					<ListChecks size={16} />
					<h2 className="text-sm font-semibold">Requirements</h2>
					<span className="text-[12px] text-text-tertiary">{requirements.items.length}</span>
				</div>
				<div className="ml-auto flex items-center gap-2">
					<RequirementSelect
						value={statusFilter}
						options={["all", ...REQUIREMENT_STATUSES]}
						labels={STATUS_FILTER_LABELS}
						onValueChange={setStatusFilter}
						ariaLabel="Filter by status"
						className="w-36"
					/>
					<RequirementSelect
						value={priorityFilter}
						options={["all", ...REQUIREMENT_PRIORITIES]}
						labels={PRIORITY_FILTER_LABELS}
						onValueChange={setPriorityFilter}
						ariaLabel="Filter by priority"
						className="w-36"
					/>
					<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setIsFormOpen(true)}>
						New
					</Button>
				</div>
			</div>

			<div className="flex flex-1 min-h-0">
				<div className={cn("flex w-80 shrink-0 flex-col border-r border-border", "min-h-0")}>
					<RequirementList requirements={visibleRequirements} selectedId={selectedId} onSelect={setSelectedId} />
				</div>
				{selected ? (
					<RequirementDetailPanel
						requirement={selected}
						workspaceId={workspaceId}
						revision={revision}
						onPatch={handlePatch}
						onDelete={handleDelete}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center bg-surface-0 px-4 text-center text-[13px] text-text-tertiary">
						{requirements.items.length === 0
							? "No requirements yet. Create your first one."
							: "Select a requirement to view and edit its details."}
					</div>
				)}
			</div>

			<RequirementFormDialog open={isFormOpen} onOpenChange={setIsFormOpen} onCreate={handleCreate} />
		</div>
	);
}
