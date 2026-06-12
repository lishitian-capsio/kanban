import * as Popover from "@radix-ui/react-popover";
import { Check, Columns3 } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";

import type { VaultTypeView } from "../data/vault-type-registry";

/**
 * Toggle which frontmatter columns the table shows. An empty `listPropertiesDisplay`
 * means "all of the type's columns" (the default); toggling switches to an explicit
 * subset, and re-selecting every column collapses back to the default.
 */
export function ColumnsControl({
	view,
	listPropertiesDisplay,
	onChange,
}: {
	view: VaultTypeView;
	listPropertiesDisplay: string[];
	onChange: (keys: string[]) => void;
}): React.ReactElement {
	const nonTitle = view.columns.filter((column) => column.kind !== "title");
	const allKeys = nonTitle.map((column) => column.key);
	const isDefault = listPropertiesDisplay.length === 0;
	const selected = new Set(isDefault ? allKeys : listPropertiesDisplay);

	function toggle(key: string): void {
		const base = new Set(selected);
		if (base.has(key)) {
			base.delete(key);
		} else {
			base.add(key);
		}
		const next = allKeys.filter((candidate) => base.has(candidate));
		onChange(next.length === allKeys.length ? [] : next);
	}

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-text-secondary hover:text-text-primary"
				>
					<Columns3 size={13} />
					Columns
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 w-56 rounded-lg border border-border bg-surface-1 p-1.5 shadow-xl"
				>
					{nonTitle.map((column) => {
						const checked = selected.has(column.key);
						return (
							<button
								key={column.key}
								type="button"
								onClick={() => toggle(column.key)}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-surface-3"
							>
								<span
									className={cn(
										"flex h-4 w-4 items-center justify-center rounded border",
										checked ? "border-accent bg-accent text-white" : "border-border-bright",
									)}
								>
									{checked ? <Check size={12} /> : null}
								</span>
								{column.label}
							</button>
						);
					})}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
