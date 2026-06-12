import * as RadixDialog from "@radix-ui/react-dialog";
import type React from "react";
import { useEffect, useRef } from "react";

/**
 * Shared chrome for the vault search surfaces (full-text panel + quick-open palette):
 * a top-anchored modal with a single search input and a scrollable results region.
 * Each surface owns its own data + result rendering; this only provides the dialog,
 * the input, focus, and auto-scrolling the highlighted row into view.
 *
 * The highlighted row must carry `data-search-selected="true"`; whenever `scrollKey`
 * changes (i.e. the selection moves) that row is scrolled into view.
 */
export function SearchOverlay({
	open,
	onOpenChange,
	query,
	onQueryChange,
	onKeyDown,
	placeholder,
	icon,
	scrollKey,
	children,
	footer,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	query: string;
	onQueryChange: (query: string) => void;
	onKeyDown: (event: React.KeyboardEvent) => void;
	placeholder: string;
	icon: React.ReactNode;
	scrollKey: string | number;
	children: React.ReactNode;
	footer?: React.ReactNode;
}): React.ReactElement {
	const bodyRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			inputRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const selected = bodyRef.current?.querySelector<HTMLElement>("[data-search-selected='true']");
		selected?.scrollIntoView({ block: "nearest" });
	}, [open, scrollKey]);

	return (
		<RadixDialog.Root open={open} onOpenChange={onOpenChange}>
			<RadixDialog.Portal>
				<RadixDialog.Overlay
					className="fixed inset-0 z-50 bg-black/60"
					style={{ animation: "kb-overlay-show 150ms ease" }}
				/>
				<RadixDialog.Content
					aria-describedby={undefined}
					className="fixed left-1/2 top-[12vh] z-50 flex w-[90vw] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-1 shadow-2xl focus:outline-none"
				>
					<RadixDialog.Title className="sr-only">Search the vault</RadixDialog.Title>
					<div className="flex items-center gap-2.5 border-b border-border px-3">
						<span className="shrink-0 text-text-tertiary">{icon}</span>
						<input
							ref={inputRef}
							value={query}
							onChange={(event) => onQueryChange(event.target.value)}
							onKeyDown={onKeyDown}
							placeholder={placeholder}
							className="h-12 flex-1 bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
							spellCheck={false}
							autoComplete="off"
						/>
					</div>
					<div ref={bodyRef} className="max-h-[52vh] overflow-y-auto p-1.5">
						{children}
					</div>
					{footer ? (
						<div className="border-t border-border px-3 py-1.5 text-[11px] text-text-tertiary">{footer}</div>
					) : null}
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}
