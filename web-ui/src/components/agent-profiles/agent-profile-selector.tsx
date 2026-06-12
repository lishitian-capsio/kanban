// Presentational profile switcher: a compact trigger showing the active profile
// and a dropdown to switch (click a row) or manage (new / edit / rename /
// duplicate / delete). All state and effects live in AgentProfileControl.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Copy, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeAgentProfile } from "@/runtime/types";

interface RowActionProps {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
	danger?: boolean;
}

function RowAction({ label, onClick, children, danger = false }: RowActionProps): React.ReactElement {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={cn(
				"cursor-pointer rounded-sm p-1 text-text-tertiary hover:bg-surface-4",
				danger ? "hover:text-status-red" : "hover:text-text-primary",
			)}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
		>
			{children}
		</button>
	);
}

export interface AgentProfileSelectorProps {
	profiles: readonly RuntimeAgentProfile[];
	selectedProfileId: string | null;
	isLoading: boolean;
	disabled?: boolean;
	onSelect: (profileId: string) => void;
	onNew: () => void;
	onEdit: (profile: RuntimeAgentProfile) => void;
	onRename: (profile: RuntimeAgentProfile) => void;
	onDuplicate: (profile: RuntimeAgentProfile) => void;
	onDelete: (profile: RuntimeAgentProfile) => void;
}

export function AgentProfileSelector({
	profiles,
	selectedProfileId,
	isLoading,
	disabled = false,
	onSelect,
	onNew,
	onEdit,
	onRename,
	onDuplicate,
	onDelete,
}: AgentProfileSelectorProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selected = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
	const triggerLabel = isLoading ? "Loading profiles…" : (selected?.name ?? "No profile");

	const close = (): void => setOpen(false);

	return (
		<DropdownMenu.Root open={open} onOpenChange={setOpen}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label="Switch config profile"
					className="flex min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-left text-[13px] text-text-secondary outline-none hover:bg-surface-4 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-surface-4 data-[state=open]:text-text-primary"
				>
					<SlidersHorizontal size={13} className="shrink-0" />
					<span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
					<ChevronDown size={13} className="shrink-0" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					side="top"
					align="start"
					sideOffset={4}
					className="z-50 max-h-[60vh] w-[280px] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					<div className="px-1.5 py-1 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
						Profiles
					</div>
					{profiles.length === 0 ? (
						<div className="px-1.5 py-1.5 text-[13px] text-text-tertiary">
							{isLoading ? "Loading…" : "No profiles yet"}
						</div>
					) : (
						profiles.map((profile) => {
							const isActive = profile.id === selectedProfileId;
							const subtitle = profile.modelId ?? profile.providerId ?? "No model";
							return (
								<DropdownMenu.Item
									key={profile.id}
									className={cn(
										"flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-3",
										isActive ? "text-text-primary" : "text-text-secondary",
									)}
									onSelect={(event) => {
										event.preventDefault();
										onSelect(profile.id);
										close();
									}}
								>
									<Check size={14} className={cn("shrink-0", isActive ? "text-accent" : "opacity-0")} />
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate">{profile.name}</span>
										<span className="truncate text-[11px] text-text-tertiary">{subtitle}</span>
									</span>
									<span className="flex shrink-0 items-center gap-0.5">
										<RowAction
											label="Edit profile"
											onClick={() => {
												close();
												onEdit(profile);
											}}
										>
											<SlidersHorizontal size={12} />
										</RowAction>
										<RowAction
											label="Rename"
											onClick={() => {
												close();
												onRename(profile);
											}}
										>
											<Pencil size={12} />
										</RowAction>
										<RowAction
											label="Duplicate"
											onClick={() => {
												close();
												onDuplicate(profile);
											}}
										>
											<Copy size={12} />
										</RowAction>
										<RowAction
											label="Delete"
											danger
											onClick={() => {
												close();
												onDelete(profile);
											}}
										>
											<Trash2 size={12} />
										</RowAction>
									</span>
								</DropdownMenu.Item>
							);
						})
					)}
					<div className="my-1 border-t border-border" />
					<DropdownMenu.Item
						className="flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1.5 text-[13px] text-text-secondary outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text-primary"
						onSelect={(event) => {
							event.preventDefault();
							onNew();
							close();
						}}
					>
						<Plus size={14} className="shrink-0" />
						<span>New profile</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
