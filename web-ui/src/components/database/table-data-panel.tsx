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
import type {
	RuntimeDbColumnValue,
	RuntimeDbConnection,
	RuntimeDbFilter,
	RuntimeDbPreviewWriteRequest,
	RuntimeDbSort,
	RuntimeDbTable,
} from "@/runtime/types";
import { DataGrid } from "./data-grid";
import { buildFullRowKey, buildRowKey, dbErrorMessage, primaryKeyColumns } from "./db-utils";
import { InsertRowDialog } from "./insert-row-dialog";
import { SqlPreview } from "./sql-preview";
import { useDbRowMutations } from "./use-db-row-mutations";
import { useDbTableData } from "./use-db-table-data";

export interface TableDataPanelProps {
	workspaceId: string;
	connection: RuntimeDbConnection;
	table: RuntimeDbTable;
}

interface PendingEdit {
	rowIndex: number;
	column: string;
	value: string | null;
}

/** The main browse/edit surface for one selected table. Keyed per-table so state resets on switch. */
export function TableDataPanel({ workspaceId, connection, table }: TableDataPanelProps): React.ReactElement {
	const [sort, setSort] = useState<RuntimeDbSort | null>(null);
	const [filtersByColumn, setFiltersByColumn] = useState<Map<string, RuntimeDbFilter>>(new Map());
	const [insertOpen, setInsertOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<number | null>(null);
	const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

	const pkColumns = useMemo(() => primaryKeyColumns(table), [table]);
	const pkColumnNames = useMemo(() => new Set(pkColumns.map((c) => c.name)), [pkColumns]);
	const hasPrimaryKey = pkColumns.length > 0;
	// Writes need an allow-writes connection and a real table (not a view). A missing primary key no
	// longer disables editing — keyless rows are matched on all columns and guarded to a single row.
	const editable = connection.allowWrites && table.kind === "table";

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

	/** Apply an UPDATE for one cell and reflect it locally; shared by the PK and keyless paths. */
	const applyUpdate = useCallback(
		async (rowIndex: number, column: string, value: string | null, where: RuntimeDbColumnValue[], requireSingleRow: boolean) => {
			const row = rows[rowIndex];
			if (!row) {
				return;
			}
			try {
				await mutations.updateRow({ schema: table.schema, table: table.name, assignments: [{ column, value }], where, requireSingleRow });
				updateRowLocal(rowIndex, { ...row, [column]: value });
			} catch (error) {
				showAppToast({ intent: "danger", message: dbErrorMessage(error, "Update failed.") });
				reload();
			}
		},
		[rows, table, mutations, updateRowLocal, reload],
	);

	const handleCommitEdit = useCallback(
		async (rowIndex: number, column: string, value: string | null) => {
			const row = rows[rowIndex];
			if (!row || row[column] === value) {
				return;
			}
			if (hasPrimaryKey) {
				const where = buildRowKey(table, row);
				if (!where) {
					showAppToast({ intent: "danger", message: "Cannot edit: primary key value is NULL." });
					return;
				}
				await applyUpdate(rowIndex, column, value, where, false);
				return;
			}
			// Keyless table: confirm with a SQL preview before applying the guarded, full-row-match edit.
			setPendingEdit({ rowIndex, column, value });
		},
		[rows, table, hasPrimaryKey, applyUpdate],
	);

	const handleConfirmEdit = useCallback(async () => {
		if (!pendingEdit) {
			return;
		}
		const { rowIndex, column, value } = pendingEdit;
		const row = rows[rowIndex];
		setPendingEdit(null);
		if (!row) {
			return;
		}
		await applyUpdate(rowIndex, column, value, buildFullRowKey(table, row), true);
	}, [pendingEdit, rows, table, applyUpdate]);

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
		const where = hasPrimaryKey ? buildRowKey(table, row) : buildFullRowKey(table, row);
		if (!where) {
			showAppToast({ intent: "danger", message: "Cannot delete: primary key value is NULL." });
			return;
		}
		try {
			await mutations.deleteRow({ schema: table.schema, table: table.name, where, requireSingleRow: !hasPrimaryKey });
			removeRowLocal(index);
			showAppToast({ intent: "success", message: "Row deleted." });
		} catch (error) {
			showAppToast({ intent: "danger", message: dbErrorMessage(error, "Delete failed.") });
			reload();
		}
	}, [pendingDelete, rows, table, hasPrimaryKey, mutations, removeRowLocal, reload]);

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

	const deletePreview = useMemo<RuntimeDbPreviewWriteRequest | null>(() => {
		if (pendingDelete === null) {
			return null;
		}
		const row = rows[pendingDelete];
		if (!row) {
			return null;
		}
		const where = hasPrimaryKey ? buildRowKey(table, row) : buildFullRowKey(table, row);
		if (!where) {
			return null;
		}
		return { connId: connection.connId, schema: table.schema, table: table.name, op: "delete", where };
	}, [pendingDelete, rows, table, hasPrimaryKey, connection.connId]);

	const editPreview = useMemo<RuntimeDbPreviewWriteRequest | null>(() => {
		if (!pendingEdit) {
			return null;
		}
		const row = rows[pendingEdit.rowIndex];
		if (!row) {
			return null;
		}
		return {
			connId: connection.connId,
			schema: table.schema,
			table: table.name,
			op: "update",
			assignments: [{ column: pendingEdit.column, value: pendingEdit.value }],
			where: buildFullRowKey(table, row),
		};
	}, [pendingEdit, rows, table, connection.connId]);

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
					<span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] text-status-orange">
						no primary key — edits matched on all columns
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
					workspaceId={workspaceId}
					connId={connection.connId}
					table={table}
					isSaving={mutations.isMutating}
					onClose={() => setInsertOpen(false)}
					onInsert={handleInsert}
				/>
			) : null}

			<AlertDialog open={pendingEdit !== null} onOpenChange={(next) => (next ? undefined : setPendingEdit(null))}>
				<AlertDialogHeader>
					<AlertDialogTitle>Apply this edit?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						<strong>{table.name}</strong> has no primary key, so this row is matched on all of its column values. The
						change is applied only if it matches exactly one row — otherwise it is rolled back.
					</AlertDialogDescription>
					<div className="mt-3">
						<SqlPreview workspaceId={workspaceId} request={editPreview} />
					</div>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setPendingEdit(null)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<Button variant="primary" disabled={mutations.isMutating} onClick={() => void handleConfirmEdit()}>
						Apply edit
					</Button>
				</AlertDialogFooter>
			</AlertDialog>

			<AlertDialog open={pendingDelete !== null} onOpenChange={(next) => (next ? undefined : setPendingDelete(null))}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete this row?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This permanently deletes the row from <strong>{table.name}</strong>
						{hasPrimaryKey
							? " using its primary key."
							: ". This table has no primary key, so the row is matched on all of its columns and the delete is rolled back unless it matches exactly one row."}{" "}
						This cannot be undone.
					</AlertDialogDescription>
					<div className="mt-3">
						<SqlPreview workspaceId={workspaceId} request={deletePreview} />
					</div>
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
