import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeDbColumnValue, RuntimeDbPreviewWriteRequest, RuntimeDbTable } from "@/runtime/types";
import { SqlPreview } from "./sql-preview";

interface FieldState {
	value: string;
	isNull: boolean;
}

export interface InsertRowDialogProps {
	open: boolean;
	workspaceId: string;
	connId: string;
	table: RuntimeDbTable;
	isSaving: boolean;
	onClose: () => void;
	onInsert: (values: RuntimeDbColumnValue[]) => Promise<void>;
}

/**
 * Insert a new row. Each column is optional in the form: a blank, non-NULL field is omitted so the
 * database applies its own DEFAULT; a NULL toggle sends an explicit SQL NULL.
 */
export function InsertRowDialog({
	open,
	workspaceId,
	connId,
	table,
	isSaving,
	onClose,
	onInsert,
}: InsertRowDialogProps): React.ReactElement {
	const [fields, setFields] = useState<Record<string, FieldState>>({});
	const [renderedKey, setRenderedKey] = useState(table.name);
	if (renderedKey !== table.name) {
		setRenderedKey(table.name);
		setFields({});
	}

	const setField = (column: string, patch: Partial<FieldState>) =>
		setFields((prev) => ({ ...prev, [column]: { value: prev[column]?.value ?? "", isNull: prev[column]?.isNull ?? false, ...patch } }));

	const values = useMemo<RuntimeDbColumnValue[]>(() => {
		const result: RuntimeDbColumnValue[] = [];
		for (const column of table.columns) {
			const field = fields[column.name];
			if (!field) {
				continue;
			}
			if (field.isNull) {
				result.push({ column: column.name, value: null });
			} else if (field.value !== "") {
				result.push({ column: column.name, value: field.value });
			}
		}
		return result;
	}, [fields, table.columns]);

	const handleInsert = async () => {
		if (values.length === 0) {
			showAppToast({ intent: "warning", message: "Enter at least one column value." });
			return;
		}
		await onInsert(values);
	};

	const preview = useMemo<RuntimeDbPreviewWriteRequest | null>(
		() => (values.length === 0 ? null : { connId, schema: table.schema, table: table.name, op: "insert", values }),
		[values, connId, table.schema, table.name],
	);

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
			<DialogHeader title={`Insert into ${table.name}`} icon={<Plus size={16} />} />
			<DialogBody className="space-y-2">
				{table.columns.map((column) => {
					const field = fields[column.name] ?? { value: "", isNull: false };
					return (
						<div key={column.name} className="flex items-center gap-2">
							<div className="w-40 shrink-0 truncate text-right">
								<span className="text-[12px] text-text-primary">{column.name}</span>
								<span className="ml-1 text-[10px] text-text-tertiary">{column.dataType}</span>
							</div>
							<input
								className={cn(
									"h-7 flex-1 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary focus:border-border-focus focus:outline-none",
									field.isNull && "opacity-40",
								)}
								value={field.isNull ? "" : field.value}
								disabled={field.isNull}
								placeholder={column.defaultValue != null ? `DEFAULT ${column.defaultValue}` : "DEFAULT"}
								onChange={(event) => setField(column.name, { value: event.target.value })}
							/>
							<label
								htmlFor={`db-insert-null-${column.name}`}
								className="flex items-center gap-1 cursor-pointer select-none"
							>
								<Checkbox.Root
									id={`db-insert-null-${column.name}`}
									checked={field.isNull}
									disabled={!column.nullable}
									onCheckedChange={(checked) => setField(column.name, { isNull: checked === true })}
									className={cn(
										"flex h-4 w-4 items-center justify-center rounded border border-border-bright bg-surface-2 disabled:opacity-30",
										"data-[state=checked]:bg-accent data-[state=checked]:border-accent",
									)}
								>
									<Checkbox.Indicator>
										<Check size={11} className="text-white" />
									</Checkbox.Indicator>
								</Checkbox.Root>
								<span className="text-[11px] text-text-tertiary">NULL</span>
							</label>
						</div>
					);
				})}
				{preview ? (
					<div className="pt-1">
						<SqlPreview workspaceId={workspaceId} request={preview} />
					</div>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={isSaving}
					icon={isSaving ? <Spinner size={14} /> : undefined}
					onClick={() => void handleInsert()}
				>
					Insert
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
