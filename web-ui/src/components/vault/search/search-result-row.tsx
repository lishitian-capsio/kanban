import type React from "react";

import { cn } from "@/components/ui/cn";

/**
 * One row in a vault search surface. Highlighted rows expose
 * `data-search-selected` so {@link SearchOverlay} can scroll them into view, and
 * pointer movement (not enter) drives hover-selection so keyboard scrolling does
 * not fight the mouse.
 */
export function SearchResultRow({
	icon,
	title,
	subtitle,
	badge,
	selected,
	onSelect,
	onHover,
}: {
	icon: React.ReactNode;
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	badge?: React.ReactNode;
	selected: boolean;
	onSelect: () => void;
	onHover: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			data-search-selected={selected}
			onClick={onSelect}
			onMouseMove={onHover}
			className={cn(
				"flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
				selected ? "bg-surface-3" : "hover:bg-surface-2",
			)}
		>
			<span className="shrink-0 text-text-tertiary">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] text-text-primary">{title}</span>
				{subtitle ? <span className="mt-0.5 block truncate text-[12px] text-text-tertiary">{subtitle}</span> : null}
			</span>
			{badge ? <span className="shrink-0 text-[11px] text-text-tertiary">{badge}</span> : null}
		</button>
	);
}
