import { ListChecks } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import type { VaultDoc } from "../data/vault-doc-model";
import { getStatusOption, getVaultTypeView } from "../data/vault-type-registry";
import { findCustomerBacklinks } from "./customer-ref";

interface CustomerBacklinksProps {
	customer: VaultDoc;
	/** Requirement docs to scan for a `customer` ref pointing at this customer. */
	requirements: VaultDoc[];
	onOpenRequirement: (id: string) => void;
}

/**
 * Reverse links on a customer: which requirements are anchored to it. Computed
 * client-side (scan loaded requirement docs) — the customer doc never stores the
 * back-reference, so the link can't drift out of sync with the requirement.
 */
export function CustomerBacklinks({
	customer,
	requirements,
	onOpenRequirement,
}: CustomerBacklinksProps): React.ReactElement {
	const requirementView = getVaultTypeView("requirement");
	const backlinks = useMemo(() => findCustomerBacklinks(customer, requirements), [customer, requirements]);

	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
				<ListChecks size={13} />
				Requirements
				<span className="font-normal normal-case text-text-tertiary">{backlinks.length}</span>
			</div>
			{backlinks.length === 0 ? (
				<p className="text-[13px] text-text-tertiary">
					No requirements reference this customer yet. Pick this customer on a requirement to link it.
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{backlinks.map((requirement) => {
						const status =
							typeof requirement.frontmatter.status === "string" ? requirement.frontmatter.status : "";
						const statusOption = requirementView ? getStatusOption(requirementView, status) : undefined;
						return (
							<li key={requirement.id}>
								<button
									type="button"
									onClick={() => onOpenRequirement(requirement.id)}
									className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-left text-[13px] text-text-primary outline-none hover:bg-surface-3"
								>
									<span className="min-w-0 flex-1 truncate">{requirement.name || "Untitled"}</span>
									{statusOption ? (
										<span className="shrink-0 text-[11px] text-text-tertiary">{statusOption.label}</span>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
