import type React from "react";
import { useMemo } from "react";

import type { RuntimeVaultFrontmatterValue } from "@/runtime/types";

import type { VaultDoc } from "../data/vault-doc-model";
import { CustomerBacklinks } from "./customer-backlinks";
import { CustomerMaterials } from "./customer-materials";
import { readMaterialIds } from "./customer-ref";

interface CustomerAnchorPanelProps {
	workspaceId: string | null;
	customer: VaultDoc;
	/** Requirement docs, scanned for backlinks to this customer. */
	requirements: VaultDoc[];
	onPatchFrontmatter: (patch: Record<string, RuntimeVaultFrontmatterValue>) => void;
	onOpenRequirement: (id: string) => void;
}

/**
 * The customer-specific detail extras: which requirements anchor to this customer
 * (backlinks) and the files pinned under its name (materials). Rendered below the
 * generic properties panel on a `type:customer` document.
 */
export function CustomerAnchorPanel({
	workspaceId,
	customer,
	requirements,
	onPatchFrontmatter,
	onOpenRequirement,
}: CustomerAnchorPanelProps): React.ReactElement {
	const materialIds = useMemo(() => readMaterialIds(customer), [customer]);

	return (
		<div className="flex flex-col gap-6 border-b border-border px-5 py-4">
			<CustomerBacklinks customer={customer} requirements={requirements} onOpenRequirement={onOpenRequirement} />
			<CustomerMaterials
				workspaceId={workspaceId}
				materialIds={materialIds}
				onChange={(ids) => onPatchFrontmatter({ materials: ids })}
			/>
		</div>
	);
}
