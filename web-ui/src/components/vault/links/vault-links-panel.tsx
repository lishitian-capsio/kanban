import { ArrowRight, Link2 } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import type { RuntimeVaultBacklink, RuntimeVaultOutgoingLink } from "@/runtime/types";

import { groupBacklinks, groupOutgoingLinks } from "./link-relation-groups";

interface VaultLinksPanelProps {
	outgoing: RuntimeVaultOutgoingLink[];
	backlinks: RuntimeVaultBacklink[];
	/** Open a linked document (only resolved outgoing links and backlinks navigate). */
	onOpenDoc: (type: string, id: string) => void;
}

/**
 * Read-out of a document's typed relations: outgoing links (what this doc points at)
 * and backlinks (who points here), each grouped under a human relationship heading.
 * When a link's frontmatter field is a declared relation the heading is the relation's
 * label / inverseLabel; otherwise it falls back to the bare `frontmatter:<field>` key.
 * Renders nothing when the document has no links either way.
 */
export function VaultLinksPanel({ outgoing, backlinks, onOpenDoc }: VaultLinksPanelProps): React.ReactElement | null {
	const outgoingGroups = useMemo(() => groupOutgoingLinks(outgoing), [outgoing]);
	const backlinkGroups = useMemo(() => groupBacklinks(backlinks), [backlinks]);

	if (outgoingGroups.length === 0 && backlinkGroups.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-4 border-b border-border px-5 py-4">
			{outgoingGroups.map((group) => (
				<RelationGroup key={`out:${group.key}`} label={group.label}>
					{group.links.map((link, index) => {
						const { resolvedId, resolvedType } = link;
						const canOpen = resolvedId !== null && resolvedType !== null;
						return (
							<LinkRow
								key={`${link.target}:${index}`}
								title={link.resolvedTitle ?? link.label ?? link.target}
								onOpen={canOpen ? () => onOpenDoc(resolvedType, resolvedId) : undefined}
							/>
						);
					})}
				</RelationGroup>
			))}
			{backlinkGroups.map((group) => (
				<RelationGroup key={`in:${group.key}`} label={group.label} incoming>
					{group.links.map((link) => (
						<LinkRow
							key={link.sourceId}
							title={link.sourceTitle}
							onOpen={() => onOpenDoc(link.sourceType, link.sourceId)}
						/>
					))}
				</RelationGroup>
			))}
		</div>
	);
}

function RelationGroup({
	label,
	incoming,
	children,
}: {
	label: string;
	incoming?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<section className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
				{incoming ? <Link2 size={13} /> : <ArrowRight size={13} />}
				<span>{label}</span>
			</div>
			<ul className="flex flex-col gap-1">{children}</ul>
		</section>
	);
}

function LinkRow({ title, onOpen }: { title: string; onOpen?: () => void }): React.ReactElement {
	if (!onOpen) {
		return (
			<li className="flex items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-tertiary">
				<span className="min-w-0 flex-1 truncate">{title}</span>
				<span className="shrink-0 text-[11px]">unresolved</span>
			</li>
		);
	}
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-left text-[13px] text-text-primary outline-none hover:bg-surface-3"
			>
				<span className="min-w-0 flex-1 truncate">{title}</span>
			</button>
		</li>
	);
}
