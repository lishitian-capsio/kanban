import type { RuntimeDbColumn, RuntimeDbColumnValue, RuntimeDbRow, RuntimeDbTable } from "@/runtime/types";

/** Extract a user-presentable message from a thrown error (TRPCClientError extends Error). */
export function dbErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return fallback;
}

/** The primary-key columns of a table, in declaration order. */
export function primaryKeyColumns(table: RuntimeDbTable): RuntimeDbColumn[] {
	return table.columns.filter((column) => column.isPrimaryKey);
}

/**
 * Build the row-identifying WHERE key from a table's primary key and a row's current values.
 * Returns null when the table has no primary key (editing/deleting is then unsupported) or when
 * a key value is NULL (a NULL key can't be matched by equality).
 */
export function buildRowKey(table: RuntimeDbTable, row: RuntimeDbRow): RuntimeDbColumnValue[] | null {
	const pk = primaryKeyColumns(table);
	if (pk.length === 0) {
		return null;
	}
	const key: RuntimeDbColumnValue[] = [];
	for (const column of pk) {
		const value = row[column.name];
		if (value === undefined || value === null) {
			return null;
		}
		key.push({ column: column.name, value });
	}
	return key;
}

/**
 * Build a row-identifying key from ALL of a table's columns and a row's current values — the
 * fallback used to edit/delete a row in a table WITHOUT a primary key. A NULL (or missing) cell is
 * preserved as `null` so the runtime renders `IS NULL` rather than `= NULL`. Because a full-row
 * match can still hit duplicate rows, the caller MUST send `requireSingleRow: true` so the write is
 * rolled back unless exactly one row is affected.
 */
export function buildFullRowKey(table: RuntimeDbTable, row: RuntimeDbRow): RuntimeDbColumnValue[] {
	return table.columns.map((column) => {
		const value = row[column.name];
		return { column: column.name, value: value === undefined ? null : value };
	});
}
