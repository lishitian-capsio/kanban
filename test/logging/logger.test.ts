import { afterEach, describe, expect, it } from "vitest";
import { configureLogging, createLogger, resetLoggingForTest } from "../../src/logging/logger";
import type { LogRecord } from "../../src/logging/types";

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
	const records: LogRecord[] = [];
	configureLogging({ level, sink: (record) => records.push(record) });
	return records;
}

afterEach(() => {
	resetLoggingForTest();
});

describe("createLogger", () => {
	it("emits a record carrying the namespace, level and message", () => {
		const records = capture();
		createLogger("runtime").info("server started");
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			level: "info",
			namespace: "runtime",
			message: "server started",
		});
	});

	it("merges base fields with per-call fields, call fields winning", () => {
		const records = capture();
		const log = createLogger("session", { workspaceId: "w1", agentId: "pi" });
		log.warn("retrying", { agentId: "claude", taskId: "t7" });
		expect(records[0].fields).toEqual({ workspaceId: "w1", agentId: "claude", taskId: "t7" });
	});

	it("drops records below the active threshold", () => {
		const records = capture("warn");
		const log = createLogger("net");
		log.debug("noisy");
		log.info("chatty");
		log.warn("listen");
		log.error("oops");
		expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
	});

	it("child() layers additional base fields without mutating the parent", () => {
		const records = capture();
		const parent = createLogger("hub", { workspaceId: "w1" });
		const child = parent.child({ taskId: "t1" });
		child.info("child line");
		parent.info("parent line");
		expect(records[0].fields).toEqual({ workspaceId: "w1", taskId: "t1" });
		expect(records[1].fields).toEqual({ workspaceId: "w1" });
	});

	it("does not throw when a sink throws", () => {
		configureLogging({
			level: "info",
			sink: () => {
				throw new Error("sink exploded");
			},
		});
		expect(() => createLogger("x").info("safe")).not.toThrow();
	});
});
