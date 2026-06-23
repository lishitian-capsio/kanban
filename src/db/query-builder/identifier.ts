import type { DatabaseEngine } from "../types";

/**
 * Quote a SQL identifier (table / column / schema) for the target engine. This is the
 * ONLY place identifiers are interpolated into SQL text — values always travel as bound
 * parameters, never concatenated. Embedded quote characters are doubled so an identifier
 * can never break out of its quoting.
 */
export function quoteIdentifier(engine: DatabaseEngine, name: string): string {
	if (engine === "mysql") {
		return `\`${name.replace(/`/g, "``")}\``;
	}
	return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a table name, qualifying it with its schema when one is present (sqlite has none). */
export function quoteQualifiedTable(engine: DatabaseEngine, schema: string, table: string): string {
	const quotedTable = quoteIdentifier(engine, table);
	if (!schema.trim()) {
		return quotedTable;
	}
	return `${quoteIdentifier(engine, schema)}.${quotedTable}`;
}

/**
 * Mints bind-parameter placeholders in the dialect of the target engine: `$1, $2, …` for
 * postgres (1-based positional) and `?` for mysql / sqlite. Use one factory per statement so
 * the positional indices line up with the params array passed to the driver.
 */
export function createPlaceholderFactory(engine: DatabaseEngine): () => string {
	let index = 0;
	return () => {
		index += 1;
		return engine === "postgres" ? `$${index}` : "?";
	};
}
