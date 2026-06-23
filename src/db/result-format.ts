/**
 * Format a raw driver cell value into a display string (or null) for the wire. The data browser
 * renders text and edits as text, so every non-null value is reduced to a string here:
 * Dates become ISO strings, binary becomes base64, structured values become JSON. Edits travel
 * back as strings and are bound as parameters, so the database applies its own coercion.
 */
export function formatDbCell(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Buffer.isBuffer(value)) {
		return value.toString("base64");
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value).toString("base64");
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Format an entire row keyed by column name into display strings. */
export function formatDbRow(row: Record<string, unknown>): Record<string, string | null> {
	const result: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(row)) {
		result[key] = formatDbCell(value);
	}
	return result;
}
