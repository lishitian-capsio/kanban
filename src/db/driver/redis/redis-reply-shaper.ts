import type { FieldInfo } from "../../types";

/** Commands whose flat/paired reply is (field, value). */
const HASH_PAIR_COMMANDS = new Set(["HGETALL"]);
/** Commands whose flat/paired reply is (member, score) when WITHSCORES was requested. */
const MEMBER_SCORE_COMMANDS = new Set(["ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZPOPMIN", "ZPOPMAX"]);

function fields(names: string[]): FieldInfo[] {
	return names.map((name) => ({ name }));
}

function cell(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	return JSON.stringify(value);
}

function isEvenPairArray(reply: unknown[]): boolean {
	return reply.length % 2 === 0 && reply.every((v) => typeof v === "string" || typeof v === "number");
}

/**
 * Normalize a heterogeneous Redis reply into rows/fields for the table view, keyed on the
 * command where a paired reply is meaningful (HGETALL fields, ZRANGE WITHSCORES scores) and
 * falling back to a generic scalar/array/object shape otherwise.
 */
export function shapeRedisReply(
	command: string,
	reply: unknown,
): { rows: Array<Record<string, unknown>>; fields: FieldInfo[] } {
	const cmd = command.toUpperCase();

	if (reply === null || reply === undefined) {
		return { rows: [], fields: fields(["value"]) };
	}

	// Object map (RESP3 HGETALL, XINFO, etc.) → field/value rows.
	if (typeof reply === "object" && !Array.isArray(reply)) {
		const rows = Object.entries(reply as Record<string, unknown>).map(([field, value]) => ({
			field,
			value: cell(value),
		}));
		return { rows, fields: fields(["field", "value"]) };
	}

	if (Array.isArray(reply)) {
		if (HASH_PAIR_COMMANDS.has(cmd) && isEvenPairArray(reply)) {
			const rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < reply.length; i += 2) {
				rows.push({ field: cell(reply[i]), value: cell(reply[i + 1]) });
			}
			return { rows, fields: fields(["field", "value"]) };
		}
		if (MEMBER_SCORE_COMMANDS.has(cmd) && isEvenPairArray(reply) && reply.length >= 2) {
			const rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < reply.length; i += 2) {
				rows.push({ member: cell(reply[i]), score: cell(reply[i + 1]) });
			}
			return { rows, fields: fields(["member", "score"]) };
		}
		const rows = reply.map((value, index) => ({ index, value: cell(value) }));
		return { rows, fields: fields(["index", "value"]) };
	}

	// Scalar.
	return { rows: [{ value: cell(reply) }], fields: fields(["value"]) };
}
