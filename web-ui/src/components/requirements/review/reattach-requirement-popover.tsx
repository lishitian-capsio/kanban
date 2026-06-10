import * as Popover from "@radix-ui/react-popover";
import { Link2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeRequirementItem } from "@/runtime/types";

interface ReattachRequirementPopoverProps {
	targets: RuntimeRequirementItem[];
	currentRequirementId: string;
	onReattach: (newRequirementId: string) => void;
}

export function ReattachRequirementPopover({
	targets,
	currentRequirementId,
	onReattach,
}: ReattachRequirementPopoverProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			inputRef.current?.focus();
		}
	}, [open]);

	const filtered = targets.filter(
		(item) => item.id !== currentRequirementId && item.title.toLowerCase().includes(query.trim().toLowerCase()),
	);

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setQuery("");
				}
			}}
		>
			<Popover.Trigger asChild>
				<Button variant="ghost" size="sm" icon={<Link2 size={14} />} aria-label="Re-attach to another requirement">
					Re-attach
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={4}
					className="z-50 w-72 rounded-lg border border-border bg-surface-1 p-2 shadow-xl"
				>
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search requirements…"
						className="mb-2 w-full rounded-md border border-border-bright bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
					/>
					<div className="max-h-60 overflow-y-auto">
						{filtered.length === 0 ? (
							<p className="px-2 py-3 text-center text-[12px] text-text-tertiary">No matching requirements.</p>
						) : (
							filtered.map((item) => (
								<button
									key={item.id}
									type="button"
									onClick={() => {
										onReattach(item.id);
										setOpen(false);
										setQuery("");
									}}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text-secondary outline-none",
										"hover:bg-surface-3 hover:text-text-primary",
									)}
								>
									<span className="min-w-0 flex-1 truncate">{item.title}</span>
								</button>
							))
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
