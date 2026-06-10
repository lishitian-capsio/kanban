import { ListChecks, Plus } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type {
	RuntimeRequirementPriority,
	RuntimeRequirementTaskLinksData,
	RuntimeRequirementsData,
	RuntimeRequirementStatus,
} from "@/runtime/types";
import {
	confirmLink,
	reattachLink,
	rejectLink,
	selectPendingProposals,
} from "@/state/requirement-task-links-state";
import {
	addRequirement,
	deleteRequirement,
	type RequirementDraft,
	type RequirementPatch,
	sortRequirements,
	updateRequirement,
} from "@/state/requirements-state";
import type { BoardData } from "@/types";

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
import { RequirementReviewPanel } from "./review/requirement-review-panel";

interface RequirementsViewProps {
	workspaceId: string | null;
	requirements: RuntimeRequirementsData;
	/** Persisted workspace revision; bumps after each save so version history can refetch. */
	revision: number;
	requirementTaskLinks: RuntimeRequirementTaskLinksData;
	board: BoardData;
	onRequirementsChange: (next: RuntimeRequirementsData) => void;
	onRequirementTaskLinksChange: (next: RuntimeRequirementTaskLinksData) => void;
}

type StatusFilter = RuntimeRequirementStatus | "all";
type PriorityFilter = RuntimeRequirementPriority | "all";

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = { all: "All statuses", ...STATUS_LABELS };
const PRIORITY_FILTER_LABELS: Record<PriorityFilter, string> = { all: "All priorities", ...PRIORITY_LABELS };

export function RequirementsView({
	workspaceId,
	requirements,
	revision,
	requirementTaskLinks,
	board,
	onRequirementsChange,
	onRequirementTaskLinksChange,
}: RequirementsViewProps): React.ReactElement {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
	const [isFormOpen, setIsFormOpen] = useState(false);
	const [viewMode, setViewMode] = useState<"list" | "review">("list");

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

	const proposals = useMemo(
		() => selectPendingProposals(requirementTaskLinks, requirements, board),
		[requirementTaskLinks, requirements, board],
	);
	const pendingCount = proposals.links.length + proposals.drafts.length + proposals.inbox.length;
	const reattachTargets = useMemo(
		() => requirements.items.filter((item) => item.status !== "draft"),
		[requirements.items],
	);

	function handleConfirmLink(requirementId: string, taskId: string): void {
		const result = confirmLink(requirementTaskLinks, requirements, requirementId, taskId);
		if (result.changed) {
			onRequirementTaskLinksChange(result.links);
			onRequirementsChange(result.requirements);
		}
	}

	function handleRejectLink(requirementId: string, taskId: string): void {
		const result = rejectLink(requirementTaskLinks, requirements, requirementId, taskId);
		if (result.changed) {
			onRequirementTaskLinksChange(result.links);
			onRequirementsChange(result.requirements);
		}
	}

	function handleReattachLink(requirementId: string, taskId: string, newRequirementId: string): void {
		const result = reattachLink(requirementTaskLinks, requirementId, taskId, newRequirementId);
		if (result.changed) {
			onRequirementTaskLinksChange(result.links);
		}
	}

	function handleAcceptDraft(id: string): void {
		handlePatch(id, { status: "active" });
	}

	function handleRejectDraft(id: string): void {
		handleDelete(id);
	}

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
					<div className="flex items-center rounded-md border border-border-bright bg-surface-2 p-0.5">
						<button
							type="button"
							onClick={() => setViewMode("list")}
							aria-pressed={viewMode === "list"}
							className={cn(
								"rounded-sm px-2.5 py-1 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-2",
								viewMode === "list" ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:text-text-primary",
							)}
						>
							List
						</button>
						<button
							type="button"
							onClick={() => setViewMode("review")}
							aria-pressed={viewMode === "review"}
							className={cn(
								"flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-2",
								viewMode === "review" ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:text-text-primary",
							)}
						>
							Review
							{pendingCount > 0 ? (
								<span className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
									{pendingCount}
								</span>
							) : null}
						</button>
					</div>
					{viewMode === "list" ? (
						<>
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
						</>
					) : null}
					<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setIsFormOpen(true)}>
						New
					</Button>
				</div>
			</div>

			{viewMode === "review" ? (
				<RequirementReviewPanel
					proposals={proposals}
					reattachTargets={reattachTargets}
					onConfirmLink={handleConfirmLink}
					onRejectLink={handleRejectLink}
					onReattachLink={handleReattachLink}
					onAcceptDraft={handleAcceptDraft}
					onRejectDraft={handleRejectDraft}
				/>
			) : (
				<div className="flex flex-1 min-h-0">
					<div className={cn("flex w-80 shrink-0 flex-col border-r border-border", "min-h-0")}>
						<RequirementList
							requirements={visibleRequirements}
							selectedId={selectedId}
							onSelect={setSelectedId}
						/>
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
			)}

			<RequirementFormDialog open={isFormOpen} onOpenChange={setIsFormOpen} onCreate={handleCreate} />
		</div>
	);
}
