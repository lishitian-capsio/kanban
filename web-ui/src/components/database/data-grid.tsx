import { ArrowDown, ArrowUp, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TableVirtuoso } from "react-virtuoso";

import { Spinner } from "@/components/ui/spinner";
import type { RuntimeDbFilter, RuntimeDbResultColumn, RuntimeDbRow, RuntimeDbSort } from "@/runtime/types";
import { ColumnFilterPopover } from "./column-filter-popover";

const COLUMN_WIDTH = 180;
const ACTIONS_WIDTH = 40;

interface EditingCell {
	rowIndex: number;
	column: string;
}

export interface DataGridProps {
	columns: RuntimeDbResultColumn[];
	rows: RuntimeDbRow[];
	primaryKeyColumns: Set<string>;
	editable: boolean;
	sort: RuntimeDbSort | null;
	filtersByColumn: Map<string, RuntimeDbFilter>;
	isLoadingMore: boolean;
	onToggleSort: (column: string) => void;
	onSetFilter: (column: string, filter: RuntimeDbFilter | null) => void;
	onCommitEdit: (rowIndex: number, column: string, value: string | null) => void;
	onDeleteRow: (rowIndex: number) => void;
	onLoadMore: () => void;
}

/**
 * Virtualized result grid (row virtualization via TableVirtuoso; off-screen cell paint culled via
 * `content-visibility` for wide tables). Sticky header carries sort + per-column filter; cells are
 * double-click editable when the connection allows writes and the table has a primary key.
 */
export function DataGrid({
	columns,
	rows,
	primaryKeyColumns,
	editable,
	sort,
	filtersByColumn,
	isLoadingMore,
	onToggleSort,
	onSetFilter,
	onCommitEdit,
	onDeleteRow,
	onLoadMore,
}: DataGridProps): React.ReactElement {
	const [editing, setEditing] = useState<EditingCell | null>(null);
	const [editValue, setEditValue] = useState("");

	const startEdit = useCallback((rowIndex: number, column: string, current: string | null) => {
		setEditing({ rowIndex, column });
		setEditValue(current ?? "");
	}, []);

	const commit = useCallback(
		(value: string | null) => {
			if (editing) {
				onCommitEdit(editing.rowIndex, editing.column, value);
			}
			setEditing(null);
		},
		[editing, onCommitEdit],
	);

	const totalWidth = columns.length * COLUMN_WIDTH + (editable ? ACTIONS_WIDTH : 0);

	return (
		<TableVirtuoso
			data={rows}
			endReached={onLoadMore}
			overscan={400}
			className="flex-1 min-h-0"
			components={{
				Table: ({ style, ...props }) => (
					<table
						{...props}
						className="border-collapse text-[12px] text-text-primary"
						style={{ ...style, width: totalWidth, tableLayout: "fixed" }}
					/>
				),
				TableRow: ({ style, ...props }) => (
					<tr {...props} style={style} className="border-b border-border hover:bg-surface-2/60 group" />
				),
				TableFoot: () =>
					isLoadingMore ? (
						<tfoot>
							<tr>
								<td colSpan={columns.length + (editable ? 1 : 0)} className="px-3 py-2">
									<span className="flex items-center gap-2 text-[12px] text-text-tertiary">
										<Spinner size={12} /> Loading more…
									</span>
								</td>
							</tr>
						</tfoot>
					) : null,
			}}
			fixedHeaderContent={() => (
				<tr>
					{columns.map((column) => {
						const isPk = primaryKeyColumns.has(column.name);
						const sortDir = sort?.column === column.name ? sort.direction : null;
						return (
							<th
								key={column.name}
								style={{ width: COLUMN_WIDTH }}
								className="border-b border-r border-border bg-surface-1 px-2 py-1.5 text-left align-middle"
							>
								<div className="flex items-center gap-1">
									{isPk ? <KeyRound size={11} className="text-status-gold shrink-0" /> : null}
									<button
										type="button"
										onClick={() => onToggleSort(column.name)}
										className="flex min-w-0 flex-1 items-center gap-1 text-text-primary hover:text-accent"
										title={column.dataType ?? undefined}
									>
										<span className="truncate font-semibold">{column.name}</span>
										{sortDir === "asc" ? <ArrowUp size={11} /> : null}
										{sortDir === "desc" ? <ArrowDown size={11} /> : null}
									</button>
									<ColumnFilterPopover
										column={column.name}
										filter={filtersByColumn.get(column.name) ?? null}
										onApply={(filter) => onSetFilter(column.name, filter)}
										onClear={() => onSetFilter(column.name, null)}
									/>
								</div>
							</th>
						);
					})}
					{editable ? (
						<th style={{ width: ACTIONS_WIDTH }} className="border-b border-border bg-surface-1" />
					) : null}
				</tr>
			)}
			itemContent={(index, row) => (
				<>
					{columns.map((column) => {
						const raw = row[column.name] ?? null;
						const isEditing = editing?.rowIndex === index && editing.column === column.name;
						return (
							<td
								key={column.name}
								style={{ width: COLUMN_WIDTH }}
								className="kb-db-cell border-r border-border px-2 py-1 align-middle"
								onDoubleClick={editable ? () => startEdit(index, column.name, raw) : undefined}
							>
								{isEditing ? (
									<CellEditor
										initialValue={editValue}
										onChangeValue={setEditValue}
										onCommit={commit}
										onCancel={() => setEditing(null)}
									/>
								) : raw === null ? (
									<span className="italic text-text-tertiary">NULL</span>
								) : (
									<span className="block truncate" title={raw}>
										{raw === "" ? <span className="text-text-tertiary">∅ empty</span> : raw}
									</span>
								)}
							</td>
						);
					})}
					{editable ? (
						<td className="border-border px-1 text-center align-middle">
							<button
								type="button"
								aria-label="Delete row"
								onClick={() => onDeleteRow(index)}
								className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary opacity-0 hover:bg-surface-3 hover:text-status-red group-hover:opacity-100"
							>
								<Trash2 size={13} />
							</button>
						</td>
					) : null}
				</>
			)}
		/>
	);
}

function CellEditor({
	initialValue,
	onChangeValue,
	onCommit,
	onCancel,
}: {
	initialValue: string;
	onChangeValue: (value: string) => void;
	onCommit: (value: string | null) => void;
	onCancel: () => void;
}): React.ReactElement {
	const inputRef = useRef<HTMLInputElement>(null);
	// Enter commits then unmounts the input, which fires onBlur — guard so we commit at most once.
	const doneRef = useRef(false);
	const commitOnce = useCallback(
		(value: string | null) => {
			if (doneRef.current) {
				return;
			}
			doneRef.current = true;
			onCommit(value);
		},
		[onCommit],
	);
	const cancelOnce = useCallback(() => {
		if (doneRef.current) {
			return;
		}
		doneRef.current = true;
		onCancel();
	}, [onCancel]);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	return (
		<div className="flex items-center gap-1">
			<input
				ref={inputRef}
				defaultValue={initialValue}
				onChange={(event) => onChangeValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						commitOnce((event.target as HTMLInputElement).value);
					} else if (event.key === "Escape") {
						cancelOnce();
					}
				}}
				onBlur={(event) => commitOnce(event.target.value)}
				className="h-6 w-full rounded border border-border-focus bg-surface-2 px-1 text-[12px] text-text-primary focus:outline-none"
			/>
			<button
				type="button"
				title="Set NULL"
				onMouseDown={(event) => {
					event.preventDefault();
					commitOnce(null);
				}}
				className="rounded px-1 text-[10px] text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
			>
				NULL
			</button>
		</div>
	);
}
