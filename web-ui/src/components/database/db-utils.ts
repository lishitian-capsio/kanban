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
