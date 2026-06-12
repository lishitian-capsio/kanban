import * as Popover from "@radix-ui/react-popover";
import { Fzf } from "fzf";
import { Building2, Check, ChevronDown, X } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";

import { cn } from "@/components/ui/cn";

import type { VaultDoc } from "../data/vault-doc-model";
import { customerRefLabel, customerRefValue, resolveCustomerRef } from "./customer-ref";

interface CustomerPickerProps {
	/** The stored `customer` frontmatter value (a `[[wikilink]]` or "" when unset). */
	value: string;
	customers: VaultDoc[];
	onChange: (refValue: string) => void;
	className?: string;
}

/**
 * Select the customer a requirement is anchored to. Lists `type:customer` docs
 * (fuzzy-filtered with fzf) and stores the choice as a `[[Customer Name]]`
 * wikilink. A ref that no longer resolves is still shown (its raw label) so a
 * renamed/missing customer is visible rather than silently dropped.
 */
export function CustomerPicker({ value, customers, onChange, className }: CustomerPickerProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	const selected = useMemo(() => resolveCustomerRef(value, customers), [value, customers]);
	const label = customerRefLabel(value);

	const finder = useMemo(() => new Fzf(customers, { selector: (customer) => customer.name }), [customers]);
	const results = useMemo(() => {
		if (!query.trim()) {
			return customers;
		}
		return finder.find(query).map((result) => result.item);
	}, [customers, finder, query]);

	function choose(customer: VaultDoc): void {
		onChange(customerRefValue(customer));
		setOpen(false);
		setQuery("");
	}

	function clear(): void {
		onChange("");
		setOpen(false);
		setQuery("");
	}

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
				<button
					type="button"
					aria-label="Customer"
					className={cn(
						"flex h-8 items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] outline-none hover:bg-surface-3 focus:border-border-focus",
						label ? "text-text-primary" : "text-text-tertiary",
						className,
					)}
				>
					<span className="truncate">{label || "No customer"}</span>
					<ChevronDown size={14} className="shrink-0 text-text-tertiary" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={4}
					className="z-50 w-64 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-xl"
				>
					<div className="border-b border-border p-2">
						{/* Radix Popover focuses the first tabbable element (this input) on open. */}
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search customers…"
							className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
						/>
					</div>
					<div className="max-h-64 overflow-y-auto p-1">
						{value ? (
							<button
								type="button"
								onClick={clear}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text-tertiary outline-none hover:bg-surface-3 hover:text-text-primary"
							>
								<X size={14} className="shrink-0" />
								Clear customer
							</button>
						) : null}
						{results.length === 0 ? (
							<div className="px-2 py-3 text-center text-[12px] text-text-tertiary">
								{customers.length === 0 ? "No customers yet. Create one in the Customers tab." : "No matches."}
							</div>
						) : (
							results.map((customer) => {
								const isSelected = selected?.id === customer.id;
								return (
									<button
										key={customer.id}
										type="button"
										onClick={() => choose(customer)}
										className={cn(
											"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-surface-3",
											isSelected ? "text-text-primary" : "text-text-secondary",
										)}
									>
										<Building2 size={14} className="shrink-0 text-text-tertiary" />
										<span className="min-w-0 flex-1 truncate">{customer.name || "Untitled"}</span>
										{isSelected ? <Check size={14} className="shrink-0 text-accent" /> : null}
									</button>
								);
							})
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
