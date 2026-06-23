import { Eye, Lock, Plus, RefreshCw, Table2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeDbColumnValue, RuntimeDbConnection, RuntimeDbFilter, RuntimeDbSort, RuntimeDbTable } from "@/runtime/types";
import { DataGrid } from "./data-grid";
import { buildRowKey, dbErrorMessage, primaryKeyColumns } from "./db-utils";
import { InsertRowDialog } from "./insert-row-dialog";
import { useDbRowMutations } from "./use-db-row-mutations";
import { useDbTableData } from "./use-db-table-data";

export interface TableDataPanelProps {
	workspaceId: string;
	connection: RuntimeDbConnection;
	table: RuntimeDbTable;
}

/** The main browse/edit surface for one selected table. Keyed per-table so state resets on switch. */
export function TableDataPanel({ workspaceId, connection, table }: TableDataPanelProps): React.ReactElement {
	const [sort, setSort] = useState<RuntimeDbSort | null>(null);
	const [filtersByColumn, setFiltersByColumn] = useState<Map<string, RuntimeDbFilter>>(new Map());
	const [insertOpen, setInsertOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<number | null>(null);

	const pkColumns = useMemo(() => primaryKeyColumns(table), [table]);
	const pkColumnNames = useMemo(() => new Set(pkColumns.map((c) => c.name)), [pkColumns]);
	const hasPrimaryKey = pkColumns.length > 0;
	const editable = connection.allowWrites && hasPrimaryKey && table.kind === "table";

	const sortArray = useMemo(() => (sort ? [sort] : []), [sort]);
	const filterArray = useMemo(() => [...filtersByColumn.values()], [filtersByColumn]);

	const target = useMemo(
		() => ({ connId: connection.connId, schema: table.schema, table: table.name }),
		[connection.connId, table.schema, table.name],
	);
	const data = useDbTableData(workspaceId, target, sortArray, filterArray);
	const mutations = useDbRowMutations(workspaceId, connection.connId);

	const handleToggleSort = useCallback((column: string) => {
		setSort((current) => {
			if (current?.column !== column) {
				return { column, direction: "asc" };
			}
			return current.direction === "asc" ? { column, direction: "desc" } : null;
		});
	}, []);

	const handleSetFilter = useCallback((column: string, filter: RuntimeDbFilter | null) => {
		setFiltersByColumn((prev) => {
			const next = new Map(prev);
			if (filter) {
				next.set(column, filter);
			} else {
				next.delete(column);
			}
			return next;
		});
	}, []);

	const { rows, updateRowLocal, removeRowLocal, reload } = data;

	const handleCommitEdit = useCallback(
		async (rowIndex: number, column: string, value: string | null) => {
			const row = rows[rowIndex];
			if (!row || row[column] === value) {
				return;
			}
			const where = buildRowKey(table, row);
			if (!where) {
				showAppToast({ intent: "danger", message: "Cannot edit: table has no primary key." });
				return;
			}
			try {
				await mutations.updateRow({ schema: table.schema, table: table.name, assignments: [{ column, value }], where });
				updateRowLocal(rowIndex, { ...row, [column]: value });
			} catch (error) {
				showAppToast({ intent: "danger", message: dbErrorMessage(error, "Update failed.") });
				reload();
			}
		},
		[rows, table, mutations, updateRowLocal, reload],
	);

	const handleConfirmDelete = useCallback(async () => {
		if (pendingDelete === null) {
			return;
		}
		const index = pendingDelete;
		const row = rows[index];
		setPendingDelete(null);
		if (!row) {
			return;
		}
		const where = buildRowKey(table, row);
		if (!where) {
			showAppToast({ intent: "danger", message: "Cannot delete: table has no primary key." });
			return;
		}
		try {
			await mutations.deleteRow({ schema: table.schema, table: table.name, where });
			removeRowLocal(index);
			showAppToast({ intent: "success", message: "Row deleted." });
		} catch (error) {
			showAppToast({ intent: "danger", message: dbErrorMessage(error, "Delete failed.") });
			reload();
		}
	}, [pendingDelete, rows, table, mutations, removeRowLocal, reload]);

	const handleInsert = useCallback(
		async (values: RuntimeDbColumnValue[]) => {
			try {
				await mutations.insertRow({ schema: table.schema, table: table.name, values });
				setInsertOpen(false);
				showAppToast({ intent: "success", message: "Row inserted." });
				reload();
			} catch (error) {
				showAppToast({ intent: "danger", message: dbErrorMessage(error, "Insert failed.") });
			}
		},
		[mutations, table, reload],
	);

	return (
		<div className="flex flex-1 flex-col min-h-0 bg-surface-0">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
				{table.kind === "view" ? (
					<Eye size={15} className="text-status-purple" />
				) : (
					<Table2 size={15} className="text-status-blue" />
				)}
				<span className="text-[13px] font-semibold text-text-primary">
					{table.schema ? `${table.schema}.${table.name}` : table.name}
				</span>
				{!connection.allowWrites || table.kind === "view" ? (
					<span className="flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-tertiary">
						<Lock size={10} /> read-only
					</span>
				) : !hasPrimaryKey ? (
					<span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-tertiary">
						no primary key — read-only
					</span>
				) : null}
				<div className="ml-auto flex items-center gap-2">
					{data.truncated.byRows || data.truncated.byBytes ? (
						<span className="text-[11px] text-status-orange">Results truncated</span>
					) : null}
					<span className="text-[11px] text-text-tertiary">{data.rows.length} rows loaded</span>
					{editable ? (
						<Button variant="default" size="sm" icon={<Plus size={14} />} onClick={() => setInsertOpen(true)}>
							Add row
						</Button>
					) : null}
					<Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={reload} title="Refresh" />
				</div>
			</div>

			{filterArray.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 shrink-0">
					{filterArray.map((filter) => (
						<span
							key={filter.column}
							className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary"
						>
							{filter.column} {filter.op}
							{filter.value != null ? ` ${filter.value}` : ""}
							<button
								type="button"
								aria-label={`Clear filter on ${filter.column}`}
								onClick={() => handleSetFilter(filter.column, null)}
								className="text-text-tertiary hover:text-text-primary"
							>
								<X size={11} />
							</button>
						</span>
					))}
				</div>
			) : null}

			{data.isLoading ? (
				<div className="flex flex-1 items-center justify-center text-[13px] text-text-tertiary">
					<Spinner size={16} className="mr-2" /> Loading rows…
				</div>
			) : data.errorMessage ? (
				<div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-status-red">
					{data.errorMessage}
				</div>
			) : data.columns.length === 0 ? (
				<div className="flex flex-1 items-center justify-center text-[13px] text-text-tertiary">No rows.</div>
			) : (
				<DataGrid
					columns={data.columns}
					rows={data.rows}
					primaryKeyColumns={pkColumnNames}
					editable={editable}
					sort={sort}
					filtersByColumn={filtersByColumn}
					isLoadingMore={data.isLoadingMore}
					onToggleSort={handleToggleSort}
					onSetFilter={handleSetFilter}
					onCommitEdit={(rowIndex, column, value) => void handleCommitEdit(rowIndex, column, value)}
					onDeleteRow={(rowIndex) => setPendingDelete(rowIndex)}
					onLoadMore={data.loadMore}
				/>
			)}

			{insertOpen ? (
				<InsertRowDialog
					open={insertOpen}
					table={table}
					isSaving={mutations.isMutating}
					onClose={() => setInsertOpen(false)}
					onInsert={handleInsert}
				/>
			) : null}

			<AlertDialog open={pendingDelete !== null} onOpenChange={(next) => (next ? undefined : setPendingDelete(null))}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete this row?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This permanently deletes the row from <strong>{table.name}</strong> using its primary key. This cannot be
						undone.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setPendingDelete(null)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<Button variant="danger" disabled={mutations.isMutating} onClick={() => void handleConfirmDelete()}>
						Delete row
					</Button>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
