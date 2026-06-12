import { Link2, Plus } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";

import type { WikilinkResolution } from "./wikilink-resolution";

interface WikilinkChipProps {
	/** Decoded link target (what was written inside `[[ ]]`). */
	target: string;
	/** The resolved document, or null when the engine could not match the target. */
	resolution: WikilinkResolution | null;
	onOpen?: (resolution: WikilinkResolution) => void;
	onCreate?: (target: string) => void;
	/** Visible label (the `[[target|label]]` label, defaulting to the target). */
	children: React.ReactNode;
}

/**
 * Inline rendering of a body `[[wikilink]]`. A resolved link is an accent chip
 * that opens its document; an unresolved link is a dashed "to create" chip that
 * (when a handler is supplied) creates the missing document on click. With no
 * create handler, an unresolved link is shown inert so dangling links stay
 * visible without being actionable.
 */
export function WikilinkChip({ target, resolution, onOpen, onCreate, children }: WikilinkChipProps): React.ReactElement {
	const base =
		"inline-flex items-center gap-0.5 rounded px-1 py-0 align-baseline text-[0.95em] font-medium leading-tight";

	if (resolution) {
		return (
			<button
				type="button"
				data-resolved="true"
				aria-label={`Open ${resolution.title}`}
				onClick={() => onOpen?.(resolution)}
				className={cn(base, "bg-accent/10 text-accent hover:bg-accent/20")}
			>
				<Link2 size={12} className="shrink-0 opacity-70" />
				{children}
			</button>
		);
	}

	if (onCreate) {
		return (
			<button
				type="button"
				data-resolved="false"
				aria-label={`Create ${target}`}
				title={`Create “${target}”`}
				onClick={() => onCreate(target)}
				className={cn(
					base,
					"border border-dashed border-border-bright text-text-tertiary hover:border-accent hover:text-accent",
				)}
			>
				<Plus size={12} className="shrink-0 opacity-70" />
				{children}
			</button>
		);
	}

	return (
		<span
			data-resolved="false"
			title={`“${target}” has no matching document yet`}
			className={cn(base, "border border-dashed border-border-bright text-text-tertiary")}
		>
			{children}
		</span>
	);
}
