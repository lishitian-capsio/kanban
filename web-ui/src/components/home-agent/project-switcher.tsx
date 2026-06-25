// Project switcher for the unified Kanban-agent sidebar header.
//
// This is the spatial successor to the standalone project-navigation column:
// project navigation now lives as a header control inside the (dockable /
// floatable / collapsible) agent sidebar rather than a permanent vertical
// column. The trigger shows the current project; the popover lists every
// project (select to enter it, per-item menu to remove) and offers Add Project.
//
// The project rows + removal-confirmation flow were relocated here verbatim
// from the old `project-navigation-panel.tsx`; only the always-on column shell
// (resize handle, collapse, mobile drawer, shortcuts card) was dropped — those
// responsibilities are now owned by the dock/float chrome of the agent sidebar.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import { Bot, ChevronDown, Ellipsis, Plus } from "lucide-react";
import { useState } from "react";

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
import type { RuntimeProjectSummary } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

interface SidebarProjectSwitcherProps {
	projects: RuntimeProjectSummary[];
	isLoadingProjects: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	onSelectProject: (projectId: string) => void;
	onAddProject: () => void;
	onRemoveProject: (projectId: string) => Promise<boolean>;
}

export function SidebarProjectSwitcher({
	projects,
	isLoadingProjects,
	currentProjectId,
	removingProjectId,
	onSelectProject,
	onAddProject,
	onRemoveProject,
}: SidebarProjectSwitcherProps): React.ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [pendingProjectRemoval, setPendingProjectRemoval] = useState<RuntimeProjectSummary | null>(null);

	const sortedProjects = [...projects].sort((a, b) => a.path.localeCompare(b.path));
	const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
	const triggerLabel = currentProject?.name ?? (isLoadingProjects ? "Loading…" : "Select project");

	const isProjectRemovalPending = pendingProjectRemoval !== null && removingProjectId === pendingProjectRemoval.id;
	const pendingProjectTaskCount = pendingProjectRemoval
		? pendingProjectRemoval.taskCounts.backlog +
			pendingProjectRemoval.taskCounts.in_progress +
			pendingProjectRemoval.taskCounts.review +
			pendingProjectRemoval.taskCounts.trash
		: 0;

	return (
		<div className="flex min-w-0 flex-1 items-center gap-1">
			<RadixPopover.Root open={isOpen} onOpenChange={setIsOpen}>
				<RadixPopover.Trigger asChild>
					<button
						type="button"
						aria-label="Kanban Agent — switch project"
						className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left outline-none hover:bg-surface-3 data-[state=open]:bg-surface-3"
					>
						<Bot size={14} className="shrink-0 text-text-secondary" />
						<span className="shrink-0 text-[13px] font-medium text-text-primary">Kanban Agent</span>
						<span aria-hidden="true" className="shrink-0 text-text-tertiary">
							·
						</span>
						<span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary">{triggerLabel}</span>
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
					</button>
				</RadixPopover.Trigger>
				<RadixPopover.Portal>
					<RadixPopover.Content
						side="bottom"
						align="start"
						sideOffset={4}
						className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[240px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
						style={{ animation: "kb-tooltip-show 100ms ease" }}
					>
						<div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto overscroll-contain">
							{sortedProjects.length === 0 && isLoadingProjects
								? Array.from({ length: 3 }).map((_, index) => (
										<ProjectRowSkeleton key={`project-skeleton-${index}`} />
									))
								: null}

							{sortedProjects.map((project) => (
								<ProjectRow
									key={project.id}
									project={project}
									isCurrent={currentProjectId === project.id}
									removingProjectId={removingProjectId}
									onSelect={(projectId) => {
										setIsOpen(false);
										onSelectProject(projectId);
									}}
									onRemove={(projectId) => {
										const found = sortedProjects.find((item) => item.id === projectId);
										if (!found) {
											return;
										}
										setPendingProjectRemoval(found);
									}}
								/>
							))}

							{!isLoadingProjects ? (
								<button
									type="button"
									className="kb-project-row flex cursor-pointer items-center gap-1.5 rounded-md text-text-secondary hover:text-text-primary"
									style={{ padding: "6px 8px" }}
									onClick={() => {
										setIsOpen(false);
										onAddProject();
									}}
									disabled={removingProjectId !== null}
								>
									<Plus size={14} className="shrink-0" />
									<span className="text-sm">Add Project</span>
								</button>
							) : null}
						</div>
					</RadixPopover.Content>
				</RadixPopover.Portal>
			</RadixPopover.Root>
			<button
				type="button"
				aria-label="Add project"
				className="flex shrink-0 cursor-pointer items-center rounded-sm p-1.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
				onClick={() => {
					setIsOpen(false);
					onAddProject();
				}}
				disabled={removingProjectId !== null}
			>
				<Plus size={14} />
			</button>

			<AlertDialog
				open={pendingProjectRemoval !== null}
				onOpenChange={(open) => {
					if (!open && !isProjectRemovalPending) {
						setPendingProjectRemoval(null);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove Project</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription asChild>
						<div className="flex flex-col gap-3">
							<p>{pendingProjectRemoval ? pendingProjectRemoval.name : "This project"}</p>
							<p className="text-text-primary">
								This will delete all project tasks ({pendingProjectTaskCount}), remove task
								workspaces/worktrees, and stop any running processes for this project.
							</p>
							<p className="text-text-primary">This action cannot be undone.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button
							variant="default"
							disabled={isProjectRemovalPending}
							onClick={() => {
								if (!isProjectRemovalPending) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isProjectRemovalPending}
							onClick={async () => {
								if (!pendingProjectRemoval) {
									return;
								}
								const removed = await onRemoveProject(pendingProjectRemoval.id);
								if (removed) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							{isProjectRemovalPending ? (
								<>
									<Spinner size={14} />
									Removing...
								</>
							) : (
								"Remove Project"
							)}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}

interface TaskCountBadge {
	id: string;
	title: string;
	shortLabel: string;
	toneClassName: string;
	count: number;
}

function ProjectRowSkeleton(): React.ReactElement {
	return (
		<div
			className="flex items-center gap-1.5"
			style={{
				padding: "6px 8px",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className="kb-skeleton"
					style={{
						height: 14,
						width: "58%",
						borderRadius: 3,
						marginBottom: 6,
					}}
				/>
				<div
					className="kb-skeleton font-mono"
					style={{
						height: 10,
						width: "86%",
						borderRadius: 3,
						marginBottom: 6,
					}}
				/>
				<div className="flex gap-1">
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
				</div>
			</div>
		</div>
	);
}

function ProjectRow({
	project,
	isCurrent,
	removingProjectId,
	onSelect,
	onRemove,
}: {
	project: RuntimeProjectSummary;
	isCurrent: boolean;
	removingProjectId: string | null;
	onSelect: (id: string) => void;
	onRemove: (id: string) => void;
}): React.ReactElement {
	const displayPath = formatPathForDisplay(project.path);
	const isRemovingProject = removingProjectId === project.id;
	const hasAnyProjectRemoval = removingProjectId !== null;
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const taskCountBadges: TaskCountBadge[] = [
		{
			id: "backlog",
			title: "Backlog",
			shortLabel: "B",
			toneClassName: "bg-text-primary/15 text-text-primary",
			count: project.taskCounts.backlog,
		},
		{
			id: "in_progress",
			title: "In Progress",
			shortLabel: "IP",
			toneClassName: "bg-accent/20 text-accent",
			count: project.taskCounts.in_progress,
		},
		{
			id: "review",
			title: "Review",
			shortLabel: "R",
			toneClassName: "bg-accent-2/20 text-accent-2",
			count: project.taskCounts.review,
		},
		{
			id: "trash",
			title: "Done",
			shortLabel: "D",
			toneClassName: "bg-status-red/20 text-status-red",
			count: project.taskCounts.trash,
		},
	].filter((item) => item.count > 0);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onSelect(project.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect(project.id);
				}
			}}
			className={cn("kb-project-row cursor-pointer rounded-md", isCurrent && "kb-project-row-selected")}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "6px 8px",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className={cn(
						"font-medium whitespace-nowrap overflow-hidden text-ellipsis text-sm",
						isCurrent ? "text-accent-fg" : "text-text-primary",
					)}
				>
					{project.name}
				</div>
				<div
					className={cn(
						"font-mono text-[10px] whitespace-nowrap overflow-hidden text-ellipsis",
						isCurrent ? "text-accent-fg/60" : "text-text-secondary",
					)}
				>
					{displayPath}
				</div>
				{taskCountBadges.length > 0 ? (
					<div className="flex gap-1 mt-1">
						{taskCountBadges.map((badge) => (
							<span
								key={badge.id}
								className={cn(
									"inline-flex items-center gap-1 rounded-full text-[10px] px-1.5 py-px font-medium",
									isCurrent ? "bg-accent-fg/20 text-accent-fg" : badge.toneClassName,
								)}
								title={badge.title}
							>
								<span>{badge.shortLabel}</span>
								<span style={{ opacity: 0.4 }}>|</span>
								<span>{badge.count}</span>
							</span>
						))}
					</div>
				) : null}
			</div>
			<div className="kb-project-row-actions flex items-center" style={isMenuOpen ? { opacity: 1 } : undefined}>
				<DropdownMenu.Root open={isMenuOpen} onOpenChange={setIsMenuOpen}>
					<DropdownMenu.Trigger asChild>
						<Button
							variant="ghost"
							size="sm"
							icon={isRemovingProject ? <Spinner size={12} /> : <Ellipsis size={14} />}
							disabled={hasAnyProjectRemoval && !isRemovingProject}
							className={
								isCurrent
									? "text-accent-fg hover:bg-accent-fg/20 hover:text-accent-fg active:bg-accent-fg/30"
									: undefined
							}
							onClick={(e) => {
								e.stopPropagation();
							}}
							aria-label="Project actions"
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							side="bottom"
							align="end"
							sideOffset={4}
							className="z-50 min-w-[140px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
							onCloseAutoFocus={(event) => event.preventDefault()}
						>
							<DropdownMenu.Item
								className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-status-red cursor-pointer outline-none data-[highlighted]:bg-surface-3"
								onSelect={() => onRemove(project.id)}
							>
								Delete
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
		</div>
	);
}
