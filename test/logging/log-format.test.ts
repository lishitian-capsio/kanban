import { describe, expect, it } from "vitest";
import { formatRecord, resolveLogFormat } from "../../src/logging/log-format";
import type { LogRecord } from "../../src/logging/types";

const baseRecord: LogRecord = {
	level: "info",
	namespace: "proxy-fetch",
	message: "installed interceptor",
	fields: {},
};

const meta = { timestamp: "2026-06-17T09:00:00.000Z", pid: 4242 };

describe("resolveLogFormat", () => {
	it("defaults to pretty on a TTY", () => {
		expect(resolveLogFormat({}, true)).toBe("pretty");
	});

	it("defaults to json when stdout is not a TTY", () => {
		expect(resolveLogFormat({}, false)).toBe("json");
	});

	it("honors an explicit KANBAN_LOG_FORMAT over TTY detection", () => {
		expect(resolveLogFormat({ KANBAN_LOG_FORMAT: "json" }, true)).toBe("json");
		expect(resolveLogFormat({ KANBAN_LOG_FORMAT: "pretty" }, false)).toBe("pretty");
	});

	it("ignores an unrecognized KANBAN_LOG_FORMAT", () => {
		expect(resolveLogFormat({ KANBAN_LOG_FORMAT: "xml" }, true)).toBe("pretty");
	});
});

describe("formatRecord json", () => {
	it("emits one parseable line with the standard envelope and fields", () => {
		const line = formatRecord(
			{ ...baseRecord, fields: { taskId: "t1", workspaceId: "w9" } },
			meta,
			"json",
		);
		expect(line).not.toContain("\n");
		expect(JSON.parse(line)).toEqual({
			timestamp: meta.timestamp,
			level: "info",
			pid: 4242,
			namespace: "proxy-fetch",
			message: "installed interceptor",
			taskId: "t1",
			workspaceId: "w9",
		});
	});

	it("unwraps Error fields into name/message/stack instead of {}", () => {
		const err = new Error("boom");
		const parsed = JSON.parse(formatRecord({ ...baseRecord, fields: { error: err } }, meta, "json"));
		expect(parsed.error.name).toBe("Error");
		expect(parsed.error.message).toBe("boom");
		expect(typeof parsed.error.stack).toBe("string");
	});
});

describe("formatRecord pretty", () => {
	it("includes a short timestamp, padded level, namespace and message", () => {
		const line = formatRecord(baseRecord, meta, "pretty");
		expect(line).toContain("09:00:00.000");
		expect(line).toContain("INFO");
		expect(line).toContain("[proxy-fetch]");
		expect(line).toContain("installed interceptor");
	});

	it("renders structured fields inline", () => {
		const line = formatRecord({ ...baseRecord, fields: { taskId: "t1" } }, meta, "pretty");
		expect(line).toContain("taskId");
		expect(line).toContain("t1");
	});

	it("omits the field segment when there are no fields", () => {
		const line = formatRecord(baseRecord, meta, "pretty");
		expect(line.trimEnd().endsWith("installed interceptor")).toBe(true);
	});
});
