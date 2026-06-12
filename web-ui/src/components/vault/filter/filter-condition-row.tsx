import { X } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeVaultFilterCondition, RuntimeVaultFilterOp, RuntimeVaultFrontmatterValue } from "@/runtime/types";

import type { VaultTypeView } from "../data/vault-type-registry";
import {
	availableFilterFields,
	findFilterField,
	isSetOp,
	isUnaryOp,
	OP_LABELS,
	operatorsForKind,
} from "./filter-fields";

function valueToInput(value: RuntimeVaultFrontmatterValue | undefined): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.join(", ");
	}
	return String(value);
}

function inputToValue(op: RuntimeVaultFilterOp, raw: string): RuntimeVaultFrontmatterValue {
	if (isSetOp(op)) {
		return raw
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
	}
	return raw;
}

const controlClass = "h-7 text-[12px]";

export function FilterConditionRow({
	view,
	condition,
	onChange,
	onRemove,
}: {
	view: VaultTypeView;
	condition: RuntimeVaultFilterCondition;
	onChange: (next: RuntimeVaultFilterCondition) => void;
	onRemove: () => void;
}): React.ReactElement {
	const fields = availableFilterFields(view);
	const field = findFilterField(view, condition.field) ?? fields[0];
	const ops = field ? operatorsForKind(field.kind) : [];

	function handleFieldChange(nextKey: string): void {
		const nextField = findFilterField(view, nextKey);
		const nextOps = nextField ? operatorsForKind(nextField.kind) : [];
		const nextOp = nextOps.includes(condition.op) ? condition.op : (nextOps[0] ?? "equals");
		onChange({ field: nextKey, op: nextOp, value: isUnaryOp(nextOp) ? undefined : "" });
	}

	function handleOpChange(nextOp: RuntimeVaultFilterOp): void {
		onChange({
			field: condition.field,
			op: nextOp,
			value: isUnaryOp(nextOp) ? undefined : (condition.value ?? ""),
		});
	}

	function handleValueChange(raw: string): void {
		onChange({ field: condition.field, op: condition.op, value: inputToValue(condition.op, raw) });
	}

	return (
		<div className="flex items-center gap-1.5">
			<NativeSelect
				size="sm"
				className={controlClass}
				value={condition.field}
				onChange={(event) => handleFieldChange(event.target.value)}
				aria-label="Filter field"
			>
				{fields.map((option) => (
					<option key={option.key} value={option.key}>
						{option.label}
					</option>
				))}
			</NativeSelect>

			<NativeSelect
				size="sm"
				className={controlClass}
				value={condition.op}
				onChange={(event) => handleOpChange(event.target.value as RuntimeVaultFilterOp)}
				aria-label="Filter operator"
			>
				{ops.map((op) => (
					<option key={op} value={op}>
						{OP_LABELS[op]}
					</option>
				))}
			</NativeSelect>

			<ConditionValueInput field={field} condition={condition} onChange={handleValueChange} />

			<button
				type="button"
				onClick={onRemove}
				aria-label="Remove condition"
				className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
			>
				<X size={13} />
			</button>
		</div>
	);
}

function ConditionValueInput({
	field,
	condition,
	onChange,
}: {
	field: ReturnType<typeof findFilterField>;
	condition: RuntimeVaultFilterCondition;
	onChange: (raw: string) => void;
}): React.ReactElement | null {
	if (isUnaryOp(condition.op)) {
		return null;
	}

	const inputClass = cn(
		"h-7 min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary",
		"focus:border-border-focus focus:outline-none placeholder:text-text-tertiary",
	);

	if (field?.kind === "date") {
		return (
			<input
				type="date"
				className={inputClass}
				value={valueToInput(condition.value)}
				onChange={(event) => onChange(event.target.value)}
				aria-label="Filter value"
			/>
		);
	}

	// Enum-backed single value: a select of the field's options.
	if (field?.options && !isSetOp(condition.op)) {
		return (
			<NativeSelect
				size="sm"
				className={cn(controlClass, "flex-1")}
				value={valueToInput(condition.value)}
				onChange={(event) => onChange(event.target.value)}
				aria-label="Filter value"
			>
				<option value="">—</option>
				{field.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</NativeSelect>
		);
	}

	return (
		<input
			type="text"
			className={inputClass}
			value={valueToInput(condition.value)}
			placeholder={isSetOp(condition.op) ? "value, value, …" : "value"}
			onChange={(event) => onChange(event.target.value)}
			aria-label="Filter value"
		/>
	);
}
