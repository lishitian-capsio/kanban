/**
 * Rich human renderers for the CLI result object (design doc §4.3, phase P5).
 *
 * Every command computes one result object; the machine channel serializes it to the
 * envelope (`cli-envelope.ts`) and the human channel renders it here. These functions are
 * **pure** (string in, string out — no I/O, no `process.*`) so they are unit-tested
 * directly over the same result objects the `--json` envelope carries, which is what keeps
 * the two channels from drifting.
 *
 *   - `list`-shaped data (a recognized collection array) → an aligned borderless table with
 *     a colored header and a trailing summary footer (`12 tasks · 3 in_progress · 2 review`),
 *     wide cells truncated (full values via `--json` or `show`).
 *   - everything else → a key/value summary block with a green ✓ status line and the
 *     affected id highlighted.
 *   - failures → a red `✗ <message>`, the dim stable `(code: …)`, and an actionable hint.
 *
 * Color always routes through {@link paint} (the single source of color truth), so a
 * `useColor:false` render is byte-for-byte plain text.
 */

import Table from "cli-table3";
import stringWidth from "string-width";
import { paint } from "./cli-output";

export interface HumanRenderOptions {
	useColor: boolean;
}

/**
 * Keys, in priority order, that mark the primary collection of a list result. Only these
 * trigger table rendering — incidental arrays on a record (e.g. a service's `hints`) do
 * not — so the list-vs-record branch is content-driven, not coupled to command ids.
 */
const COLLECTION_KEYS = [
	"tasks",
	"connections",
	"tables",
	"columns",
	"files",
	"documents",
	"types",
	"rows",
	"items",
] as const;

/** Fields a list row may carry that are worth a per-value breakdown in the summary footer. */
const GROUP_FIELDS = ["column", "status", "state"] as const;

/** Canonical board-column ordering for the summary breakdown; unknown values sort after, alphabetically. */
const COLUMN_ORDER = ["backlog", "in_progress", "review", "done", "trash"];

const BORDERLESS_CHARS = {
	top: "",
	"top-mid": "",
	"top-left": "",
	"top-right": "",
	bottom: "",
	"bottom-mid": "",
	"bottom-left": "",
	"bottom-right": "",
	left: "",
	"left-mid": "",
	mid: "",
	"mid-mid": "",
	right: "",
	"right-mid": "",
	middle: "  ",
} as const;

type RowRecord = Record<string, unknown>;

interface ColumnSpec {
	header: string;
	get: (row: RowRecord) => unknown;
	/** Cap the column to this display width (truncating with `…`); omit for auto width. */
	maxWidth?: number;
}

/** Curated column sets for the high-traffic lists; everything else derives columns generically. */
const CURATED_COLUMNS: Record<string, ColumnSpec[]> = {
	"task.list": [
		{ header: "ID", get: (row) => row.id },
		{ header: "COLUMN", get: (row) => row.column },
		{ header: "SESSION", get: (row) => sessionState(row.session) },
		{ header: "AGENT", get: (row) => row.agentId ?? sessionAgent(row.session) ?? "—" },
		{ header: "TITLE", get: (row) => row.title ?? row.prompt ?? "", maxWidth: 50 },
	],
};

function sessionState(session: unknown): string {
	if (session && typeof session === "object" && "state" in session) {
		const state = (session as { state?: unknown }).state;
		return typeof state === "string" ? state : "—";
	}
	return "—";
}

function sessionAgent(session: unknown): string | undefined {
	if (session && typeof session === "object" && "agentId" in session) {
		const agent = (session as { agentId?: unknown }).agentId;
		return typeof agent === "string" ? agent : undefined;
	}
	return undefined;
}

function isScalar(value: unknown): boolean {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Singularize a (typically already-plural) collection noun for the `1 <noun>` case. */
function singularize(noun: string): string {
	if (noun.endsWith("ies")) {
		return `${noun.slice(0, -3)}y`;
	}
	if (noun.endsWith("s")) {
		return noun.slice(0, -1);
	}
	return noun;
}

function canonicalOrder(value: string): number {
	const index = COLUMN_ORDER.indexOf(value);
	return index === -1 ? COLUMN_ORDER.length : index;
}

/**
 * Build the trailing summary footer for a list (e.g. `12 tasks · 3 in_progress · 2 review`).
 * Appends a per-value breakdown only when every row shares a recognized group field.
 */
export function summarizeCollection(collectionKey: string, rows: RowRecord[]): string {
	const count = rows.length;
	const noun = count === 1 ? singularize(collectionKey) : collectionKey;
	const base = `${count} ${noun}`;
	if (count === 0) {
		return base;
	}
	const groupField = GROUP_FIELDS.find((field) => rows.every((row) => typeof row?.[field] === "string"));
	if (!groupField) {
		return base;
	}
	const counts = new Map<string, number>();
	for (const row of rows) {
		const value = row[groupField] as string;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	const breakdown = [...counts.keys()]
		.sort((left, right) => canonicalOrder(left) - canonicalOrder(right) || left.localeCompare(right))
		.map((value) => `${counts.get(value)} ${value}`);
	return [base, ...breakdown].join(" · ");
}

function findPrimaryCollection(data: RowRecord): { key: string; rows: unknown[] } | null {
	for (const key of COLLECTION_KEYS) {
		const value = data[key];
		if (Array.isArray(value)) {
			return { key, rows: value };
		}
	}
	return null;
}

function columnsFor(commandId: string, rows: unknown[]): ColumnSpec[] {
	const curated = CURATED_COLUMNS[commandId];
	if (curated) {
		return curated;
	}
	const first = rows[0];
	if (first === null || typeof first !== "object" || Array.isArray(first)) {
		return [{ header: "VALUE", get: (row) => row as unknown }];
	}
	return Object.keys(first as RowRecord)
		.filter((key) => isScalar((first as RowRecord)[key]))
		.slice(0, 8)
		.map((key) => ({ header: key.toUpperCase(), get: (row) => (row as RowRecord)[key], maxWidth: 40 }));
}

function stringifyCell(value: unknown): string {
	if (value === null || value === undefined) {
		return "—";
	}
	if (Array.isArray(value)) {
		return `[${value.length}]`;
	}
	if (typeof value === "object") {
		return "{…}";
	}
	return String(value);
}

/** Render the aligned borderless table; the header is cyan, wide columns truncate with `…`. */
function buildTable(columns: ColumnSpec[], rows: unknown[], useColor: boolean): string {
	const head = columns.map((column) => paint(column.header, "cyan", useColor));
	const cells = rows.map((row) => columns.map((column) => stringifyCell(column.get(row as RowRecord))));
	const colWidths = columns.map((column, index) => {
		if (!column.maxWidth) {
			return null;
		}
		const natural = Math.max(stringWidth(head[index]), ...cells.map((row) => stringWidth(row[index])));
		return natural > column.maxWidth ? column.maxWidth : null;
	});
	const hasFixedWidth = colWidths.some((width) => width !== null);
	const table = new Table({
		head,
		chars: { ...BORDERLESS_CHARS },
		style: { head: [], border: [], "padding-left": 0, "padding-right": 0 },
		...(hasFixedWidth ? { colWidths, truncate: "…", wordWrap: false } : {}),
	});
	for (const row of cells) {
		table.push(row);
	}
	// cli-table3 right-pads every row to the column width; trim the trailing run so the
	// output has no ragged whitespace (and tests can assert exact lines).
	return table
		.toString()
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.join("\n");
}

/** Dim one-line context of the scalar top-level fields that are not the collection itself. */
function contextLine(data: RowRecord, collectionKey: string, useColor: boolean): string | null {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (key === collectionKey || key === "count" || value === null || value === undefined) {
			continue;
		}
		if (isScalar(value)) {
			parts.push(`${key}: ${String(value)}`);
		}
	}
	if (parts.length === 0) {
		return null;
	}
	return paint(parts.join(" · "), "dim", useColor);
}

/** Render a list result: optional context line → table → dim summary footer (design doc §4.3). */
export function renderListResult(commandId: string, data: RowRecord, options: HumanRenderOptions): string {
	const collection = findPrimaryCollection(data);
	if (!collection) {
		return renderRecordResult(commandId, data, options);
	}
	const { key, rows } = collection;
	const lines: string[] = [];
	const context = contextLine(data, key, options.useColor);
	if (context) {
		lines.push(context);
	}
	if (rows.length === 0) {
		lines.push(paint(`No ${key} found.`, "dim", options.useColor));
		return lines.join("\n");
	}
	lines.push(buildTable(columnsFor(commandId, rows), rows, options.useColor));
	lines.push(paint(summarizeCollection(key, rows as RowRecord[]), "dim", options.useColor));
	return lines.join("\n");
}

const VERB_PAST: Record<string, string> = {
	create: "created",
	update: "updated",
	delete: "deleted",
	start: "started",
	done: "moved to done",
	trash: "moved to done",
	link: "linked",
	unlink: "unlinked",
	add: "added",
	remove: "removed",
	install: "installed",
	set: "set",
	disable: "disabled",
};

/** A friendly success label for the ✓ status line, e.g. `task.create` → `Task created`. */
function successLabel(commandId: string): string {
	const segments = commandId.split(".");
	const noun = segments[0] ?? commandId;
	const verb = segments.at(-1) ?? "";
	const nounLabel = noun.charAt(0).toUpperCase() + noun.slice(1);
	const past = VERB_PAST[verb];
	if (past) {
		return `${nounLabel} ${past}`;
	}
	if (verb === "show" || verb === "list") {
		return nounLabel;
	}
	return commandId;
}

function appendKeyValue(lines: string[], key: string, value: unknown, useColor: boolean, depth: number): void {
	const indent = "  ".repeat(depth);
	if (depth === 1 && key === "id" && typeof value === "string") {
		// Highlight the affected id (green + bold) so it stands out in the summary block.
		lines.push(
			`${indent}${paint("id", "dim", useColor)}: ${paint(paint(value, "green", useColor), "bold", useColor)}`,
		);
		return;
	}
	if (Array.isArray(value)) {
		lines.push(`${indent}${paint(key, "dim", useColor)}: [${value.length} item${value.length === 1 ? "" : "s"}]`);
		return;
	}
	if (value !== null && typeof value === "object" && depth < 2) {
		lines.push(`${indent}${paint(key, "dim", useColor)}:`);
		for (const [nestedKey, nestedValue] of Object.entries(value)) {
			appendKeyValue(lines, nestedKey, nestedValue, useColor, depth + 1);
		}
		return;
	}
	lines.push(`${indent}${paint(key, "dim", useColor)}: ${String(value)}`);
}

/** Render a single-record result (show/create/update/…): a ✓ status line + a key/value block. */
export function renderRecordResult(commandId: string, data: RowRecord, options: HumanRenderOptions): string {
	const lines: string[] = [];
	const tick = paint("✓", "green", options.useColor);
	lines.push(`${tick} ${paint(successLabel(commandId), "bold", options.useColor)}`);
	for (const [key, value] of Object.entries(data)) {
		appendKeyValue(lines, key, value, options.useColor, 1);
	}
	return lines.join("\n");
}

/** Branch a successful result to the list or record renderer based on its content (§4.3). */
export function renderHumanSuccess(commandId: string, data: RowRecord, options: HumanRenderOptions): string {
	return findPrimaryCollection(data)
		? renderListResult(commandId, data, options)
		: renderRecordResult(commandId, data, options);
}

/** Actionable, one-line recovery hints keyed by the stable `error.code` (design doc §6.3). */
const ERROR_HINTS: Partial<Record<string, string>> = {
	runtime_unreachable: "Is the Kanban runtime running? Start it with `kanban` and check `kanban remote status`.",
	workspace_not_found: "Run inside a Kanban repo, or pass --project-path <repo>.",
	task_not_found: "List valid ids with `kanban task list`.",
	file_not_found: "List valid ids with `kanban file list`.",
	document_not_found: "List valid ids with `kanban vault doc list`.",
	connection_not_found: "List valid ids with `kanban db connection list`.",
	write_not_allowed: "This connection is read-only. Re-add it with --allow-writes to permit writes.",
	database_access_disabled:
		"Agent database access is disabled for this workspace. Enable it in the Vault settings popover (Agent database access).",
	passcode_not_set: "Set one with `kanban remote passcode set <value>`.",
	dependency_cycle: "Remove the conflicting link with `kanban task unlink <dependency-id>`.",
	service_unsupported_platform: "Managed services are not supported on this platform.",
};

/** The hint for a structured error code, or `undefined` when none applies (§4.3 / §6.3). */
export function hintForErrorCode(code: string): string | undefined {
	return ERROR_HINTS[code];
}

export interface HumanErrorInputs {
	command: string;
	message: string;
	code?: string;
	useColor: boolean;
}

/**
 * Render a failure: a red `✗ <message>`, the dim stable `(code: …)` so the machine-stable
 * classification is still visible to a human, and an actionable hint when one applies (§4.3).
 */
export function renderHumanError(inputs: HumanErrorInputs): string {
	const lines: string[] = [];
	lines.push(`${paint("✗", "red", inputs.useColor)} ${inputs.message}`);
	if (inputs.code) {
		lines.push(paint(`  (code: ${inputs.code})`, "dim", inputs.useColor));
		const hint = hintForErrorCode(inputs.code);
		if (hint) {
			lines.push(paint(`  ${hint}`, "yellow", inputs.useColor));
		}
	}
	return lines.join("\n");
}
