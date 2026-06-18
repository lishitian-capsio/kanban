import { Files, Search } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/kbd";
import type { RuntimeVaultMode } from "@/runtime/types";

import type { VaultTypeView } from "./data/vault-type-registry";
import { VaultModeSelect } from "./vault-mode-select";

/** Which surface the vault is showing: a document type's views, or the binary file library. */
export type VaultSelection = { kind: "type"; type: string } | { kind: "files" };

export function isSameSelection(a: VaultSelection, b: VaultSelection): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	return a.kind === "files" || a.type === (b as { type: string }).type;
}

function SidebarItem({
	icon,
	label,
	active,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-2 hover:text-text-primary",
				active && "bg-surface-2 text-text-primary",
			)}
		>
			<span className={cn(active ? "text-accent" : "text-text-tertiary")}>{icon}</span>
			<span className="truncate">{label}</span>
		</button>
	);
}

export function VaultSidebar({
	types,
	selection,
	onSelect,
	onOpenSearch,
	vaultMode,
	onVaultModeChange,
	vaultModeDisabled = false,
}: {
	types: VaultTypeView[];
	selection: VaultSelection;
	onSelect: (selection: VaultSelection) => void;
	onOpenSearch: () => void;
	vaultMode: RuntimeVaultMode;
	onVaultModeChange: (next: RuntimeVaultMode) => void;
	vaultModeDisabled?: boolean;
}): React.ReactElement {
	return (
		<aside className="flex w-[240px] shrink-0 flex-col gap-4 border-r border-border bg-surface-1 px-3 py-4">
			<button
				type="button"
				onClick={onOpenSearch}
				className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-left text-[13px] text-text-tertiary hover:border-border-bright hover:text-text-secondary"
			>
				<Search size={14} className="shrink-0" />
				<span className="flex-1 truncate">Search…</span>
				<Kbd>⌘⇧F</Kbd>
			</button>
			<div className="flex flex-col gap-1">
				<span className="px-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
					Documents
				</span>
				{types.map((type) => {
					const TypeIcon = type.icon;
					return (
						<SidebarItem
							key={type.type}
							icon={<TypeIcon size={15} />}
							label={type.pluralLabel}
							active={selection.kind === "type" && selection.type === type.type}
							onClick={() => onSelect({ kind: "type", type: type.type })}
						/>
					);
				})}
			</div>
			<div className="flex flex-col gap-1">
				<span className="px-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Library</span>
				<SidebarItem
					icon={<Files size={15} />}
					label="All files"
					active={selection.kind === "files"}
					onClick={() => onSelect({ kind: "files" })}
				/>
			</div>
			<div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
				<span className="px-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
					Management
				</span>
				<div className="px-2.5">
					<VaultModeSelect mode={vaultMode} onChange={onVaultModeChange} disabled={vaultModeDisabled} />
				</div>
			</div>
		</aside>
	);
}
