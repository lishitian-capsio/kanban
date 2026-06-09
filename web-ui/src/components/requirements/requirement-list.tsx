import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeRequirementItem } from "@/runtime/types";

import { PriorityDot, StatusBadge } from "./requirement-meta";

interface RequirementListProps {
	requirements: RuntimeRequirementItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}

export function RequirementList({ requirements, selectedId, onSelect }: RequirementListProps): React.ReactElement {
	if (requirements.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-[13px] text-text-tertiary">
				No requirements match the current filters.
			</div>
		);
	}
	return (
		<div className="flex flex-1 flex-col overflow-y-auto">
			{requirements.map((requirement) => {
				const isSelected = requirement.id === selectedId;
				return (
					<button
						key={requirement.id}
						type="button"
						onClick={() => onSelect(requirement.id)}
						className={cn(
							"flex w-full flex-col gap-1 border-b border-border px-4 py-3 text-left outline-none",
							isSelected ? "bg-surface-3" : "hover:bg-surface-2",
						)}
					>
						<div className="flex items-center gap-2">
							<PriorityDot priority={requirement.priority} />
							<span
								className={cn(
									"min-w-0 flex-1 truncate text-[13px]",
									isSelected ? "text-text-primary" : "text-text-secondary",
								)}
							>
								{requirement.title}
							</span>
							<StatusBadge status={requirement.status} />
						</div>
						{requirement.description ? (
							<span className="truncate pl-4 text-[12px] text-text-tertiary">{requirement.description}</span>
						) : null}
					</button>
				);
			})}
		</div>
	);
}
