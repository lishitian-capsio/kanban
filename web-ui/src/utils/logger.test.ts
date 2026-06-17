import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureBrowserLogging, createLogger } from "@/utils/logger";

describe("browser createLogger", () => {
	beforeEach(() => {
		vi.spyOn(console, "debug").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		configureBrowserLogging({ level: "debug" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		configureBrowserLogging({ level: "info" });
	});

	it("prefixes the namespace and routes each level to the matching console method", () => {
		const log = createLogger("settings");
		log.info("loaded config");
		expect(console.info).toHaveBeenCalledWith("[settings] loaded config");

		log.warn("retrying");
		expect(console.warn).toHaveBeenCalledWith("[settings] retrying");

		log.error("failed");
		expect(console.error).toHaveBeenCalledWith("[settings] failed");
	});

	it("passes structured fields as a trailing argument", () => {
		createLogger("models").warn("load failed", { providerId: "openai" });
		expect(console.warn).toHaveBeenCalledWith("[models] load failed", { providerId: "openai" });
	});

	it("merges base fields with per-call fields", () => {
		createLogger("net", { scope: "global" }).warn("oops", { attempt: 2 });
		expect(console.warn).toHaveBeenCalledWith("[net] oops", { scope: "global", attempt: 2 });
	});

	it("drops records below the active threshold", () => {
		configureBrowserLogging({ level: "warn" });
		const log = createLogger("net");
		log.info("chatty");
		log.warn("listen");
		expect(console.info).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith("[net] listen");
	});
});
