import { Plus } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeVaultFilterGroup, RuntimeVaultFilterNode } from "@/runtime/types";

import type { VaultTypeView } from "../data/vault-type-registry";
import { FilterConditionRow } from "./filter-condition-row";
import { availableFilterFields } from "./filter-fields";
import {
	type Combinator,
	groupChildren,
	groupCombinator,
	isFilterGroup,
	newCondition,
	withChildren,
} from "./filter-tree";

/**
 * Form-driven builder for the recursive vault filter expression: an `all` (AND) /
 * `any` (OR) group whose children are leaf conditions or nested groups. Mirrors
 * tolaria's FilterBuilder — each level toggles its combinator and adds/removes
 * conditions or sub-groups; edits bubble up via `onChange` replacing the node.
 */
export function FilterBuilder({
	view,
	group,
	onChange,
}: {
	view: VaultTypeView;
	group: RuntimeVaultFilterGroup;
	onChange: (next: RuntimeVaultFilterGroup) => void;
}): React.ReactElement {
	return <FilterGroupView view={view} group={group} onChange={onChange} depth={0} />;
}

function CombinatorToggle({
	combinator,
	onChange,
}: {
	combinator: Combinator;
	onChange: (next: Combinator) => void;
}): React.ReactElement {
	return (
		<div className="flex items-center rounded-md border border-border bg-surface-2 p-0.5 text-[11px]">
			{(["all", "any"] as const).map((option) => (
				<button
					key={option}
					type="button"
					onClick={() => onChange(option)}
					className={cn(
						"rounded px-2 py-0.5 font-medium text-text-secondary hover:text-text-primary",
						combinator === option && "bg-surface-3 text-text-primary",
					)}
				>
					{option === "all" ? "All" : "Any"}
				</button>
			))}
		</div>
	);
}

function FilterGroupView({
	view,
	group,
	onChange,
	depth,
}: {
	view: VaultTypeView;
	group: RuntimeVaultFilterGroup;
	onChange: (next: RuntimeVaultFilterGroup) => void;
	depth: number;
}): React.ReactElement {
	const combinator = groupCombinator(group);
	const children = groupChildren(group);
	const firstFieldKey = availableFilterFields(view)[0]?.key ?? "type";

	function replaceChildren(next: RuntimeVaultFilterNode[]): void {
		onChange(withChildren(combinator, next));
	}

	function updateChild(index: number, next: RuntimeVaultFilterNode): void {
		replaceChildren(children.map((child, i) => (i === index ? next : child)));
	}

	function removeChild(index: number): void {
		replaceChildren(children.filter((_, i) => i !== index));
	}

	return (
		<div className={cn("flex flex-col gap-2", depth > 0 && "rounded-md border border-border bg-surface-1 p-2")}>
			<div className="flex items-center gap-2 text-[11px] text-text-tertiary">
				<CombinatorToggle combinator={combinator} onChange={(next) => onChange(withChildren(next, children))} />
				<span>of the following</span>
			</div>

			{children.length === 0 ? (
				<p className="px-0.5 text-[12px] text-text-tertiary">No conditions — showing everything.</p>
			) : (
				<div className="flex flex-col gap-2">
					{children.map((child, index) =>
						isFilterGroup(child) ? (
							<FilterGroupView
								key={index}
								view={view}
								group={child}
								onChange={(next) => updateChild(index, next)}
								depth={depth + 1}
							/>
						) : (
							<FilterConditionRow
								key={index}
								view={view}
								condition={child}
								onChange={(next) => updateChild(index, next)}
								onRemove={() => removeChild(index)}
							/>
						),
					)}
				</div>
			)}

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => replaceChildren([...children, newCondition(firstFieldKey)])}
					className="inline-flex items-center gap-1 text-[12px] text-accent hover:text-accent-hover"
				>
					<Plus size={12} /> Condition
				</button>
				{depth < 2 ? (
					<button
						type="button"
						onClick={() => replaceChildren([...children, { all: [] }])}
						className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
					>
						<Plus size={12} /> Group
					</button>
				) : null}
			</div>
		</div>
	);
}
