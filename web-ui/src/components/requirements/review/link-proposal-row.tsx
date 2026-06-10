import { Check, X } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeRequirementItem } from "@/runtime/types";
import type { ProposedLinkProposal } from "@/state/requirement-task-links-state";

import { ReattachRequirementPopover } from "./reattach-requirement-popover";

interface LinkProposalRowProps {
	proposal: ProposedLinkProposal;
	reattachTargets: RuntimeRequirementItem[];
	onConfirm: (requirementId: string, taskId: string) => void;
	onReject: (requirementId: string, taskId: string) => void;
	onReattach: (requirementId: string, taskId: string, newRequirementId: string) => void;
}

const INBOX_REASON_LABEL: Record<NonNullable<ProposedLinkProposal["inboxReason"]>, string> = {
	"draft-target": "Target requirement is still a draft",
	dangling: "Task or requirement no longer exists",
};

export function LinkProposalRow({
	proposal,
	reattachTargets,
	onConfirm,
	onReject,
	onReattach,
}: LinkProposalRowProps): React.ReactElement {
	const { link, requirement, taskTitle, inboxReason } = proposal;
	const canConfirm = inboxReason === null;
	const reasonLabel = inboxReason ? INBOX_REASON_LABEL[inboxReason] : "";

	const confirmButton = (
		<Button
			variant="primary"
			size="sm"
			icon={<Check size={14} />}
			disabled={!canConfirm}
			onClick={() => onConfirm(link.requirementId, link.taskId)}
		>
			Accept
		</Button>
	);

	return (
		<div className="flex items-start gap-3 border-b border-border px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] text-text-primary">{taskTitle ?? link.taskId}</span>
					<span
						className={cn(
							"shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
							link.source === "agent"
								? "border-status-purple/40 text-status-purple"
								: "border-border-bright text-text-secondary",
						)}
					>
						{link.source}
					</span>
				</div>
				<p className="mt-0.5 truncate text-[12px] text-text-tertiary">→ {requirement?.title ?? link.requirementId}</p>
				{inboxReason ? <p className="mt-1 text-[12px] text-status-orange">{reasonLabel}</p> : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{confirmButton}
				<ReattachRequirementPopover
					targets={reattachTargets}
					currentRequirementId={link.requirementId}
					onReattach={(newRequirementId) => onReattach(link.requirementId, link.taskId, newRequirementId)}
				/>
				<Button
					variant="ghost"
					size="sm"
					icon={<X size={14} />}
					aria-label="Reject link"
					onClick={() => onReject(link.requirementId, link.taskId)}
				>
					Reject
				</Button>
			</div>
		</div>
	);
}
