import { Check, X } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import { StatusBadge } from "@/components/requirements/requirement-meta";
import { buildUnifiedDiffRows, ReadOnlyUnifiedDiff } from "@/components/shared/diff-renderer";
import { Button } from "@/components/ui/button";
import type { DraftRequirementProposal } from "@/state/requirement-task-links-state";

interface DraftProposalRowProps {
	proposal: DraftRequirementProposal;
	onAccept: (requirementId: string) => void;
	onReject: (requirementId: string) => void;
}

export function DraftProposalRow({ proposal, onAccept, onReject }: DraftProposalRowProps): React.ReactElement {
	const { requirement } = proposal;
	const rows = useMemo(
		() => buildUnifiedDiffRows(null, requirement.description || "(no description)"),
		[requirement.description],
	);

	return (
		<div className="border-b border-border px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-[13px] text-text-primary">{requirement.title}</span>
						<StatusBadge status={requirement.status} />
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button variant="primary" size="sm" icon={<Check size={14} />} onClick={() => onAccept(requirement.id)}>
						Accept
					</Button>
					<Button
						variant="ghost"
						size="sm"
						icon={<X size={14} />}
						aria-label="Reject draft requirement"
						onClick={() => onReject(requirement.id)}
					>
						Reject
					</Button>
				</div>
			</div>
			<div className="mt-2 overflow-hidden rounded-md border border-border">
				<ReadOnlyUnifiedDiff rows={rows} path={requirement.title} />
			</div>
		</div>
	);
}
