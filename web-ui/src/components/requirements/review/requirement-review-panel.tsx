import { Inbox, Link2, ListChecks } from "lucide-react";
import type React from "react";

import type { RuntimeRequirementItem } from "@/runtime/types";
import type { PendingProposals } from "@/state/requirement-task-links-state";

import { DraftProposalRow } from "./draft-proposal-row";
import { LinkProposalRow } from "./link-proposal-row";

interface RequirementReviewPanelProps {
	proposals: PendingProposals;
	reattachTargets: RuntimeRequirementItem[];
	onConfirmLink: (requirementId: string, taskId: string) => void;
	onRejectLink: (requirementId: string, taskId: string) => void;
	onReattachLink: (requirementId: string, taskId: string, newRequirementId: string) => void;
	onAcceptDraft: (requirementId: string) => void;
	onRejectDraft: (requirementId: string) => void;
}

function Section({
	icon,
	title,
	count,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	count: number;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<section className="border-b border-border">
			<header className="flex items-center gap-2 bg-surface-1 px-4 py-2 text-text-secondary">
				{icon}
				<h3 className="text-[12px] font-semibold uppercase tracking-wide">{title}</h3>
				<span className="text-[12px] text-text-tertiary">{count}</span>
			</header>
			{children}
		</section>
	);
}

export function RequirementReviewPanel({
	proposals,
	reattachTargets,
	onConfirmLink,
	onRejectLink,
	onReattachLink,
	onAcceptDraft,
	onRejectDraft,
}: RequirementReviewPanelProps): React.ReactElement {
	const total = proposals.links.length + proposals.drafts.length + proposals.inbox.length;

	if (total === 0) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-0 px-4 text-center text-[13px] text-text-tertiary">
				No proposals to review.
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-y-auto bg-surface-0">
			{proposals.links.length > 0 ? (
				<Section icon={<Link2 size={14} />} title="Proposed links" count={proposals.links.length}>
					{proposals.links.map((proposal) => (
						<LinkProposalRow
							key={`${proposal.link.requirementId}:${proposal.link.taskId}`}
							proposal={proposal}
							reattachTargets={reattachTargets}
							onConfirm={onConfirmLink}
							onReject={onRejectLink}
							onReattach={onReattachLink}
						/>
					))}
				</Section>
			) : null}

			{proposals.drafts.length > 0 ? (
				<Section icon={<ListChecks size={14} />} title="Draft requirements" count={proposals.drafts.length}>
					{proposals.drafts.map((proposal) => (
						<DraftProposalRow
							key={proposal.requirement.id}
							proposal={proposal}
							onAccept={onAcceptDraft}
							onReject={onRejectDraft}
						/>
					))}
				</Section>
			) : null}

			{proposals.inbox.length > 0 ? (
				<Section icon={<Inbox size={14} />} title="Inbox" count={proposals.inbox.length}>
					{proposals.inbox.map((proposal) => (
						<LinkProposalRow
							key={`inbox:${proposal.link.requirementId}:${proposal.link.taskId}`}
							proposal={proposal}
							reattachTargets={reattachTargets}
							onConfirm={onConfirmLink}
							onReject={onRejectLink}
							onReattach={onReattachLink}
						/>
					))}
				</Section>
			) : null}
		</div>
	);
}
