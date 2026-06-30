import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPathWithBinaryDir, isBinaryAvailableOnPath, resolveBinaryPathOnPath } from "../../../src/terminal/command-discovery";

describe("buildPathWithBinaryDir", () => {
	it("prepends the directory of an absolute binary path", () => {
		const result = buildPathWithBinaryDir("/home/dev/.local/bin/claude", `/usr/bin${delimiter}/bin`);
		expect(result).toBe(["/home/dev/.local/bin", "/usr/bin", "/bin"].join(delimiter));
	});

	it("returns the current PATH unchanged for a bare binary name", () => {
		const current = `/usr/bin${delimiter}/bin`;
		expect(buildPathWithBinaryDir("claude", current)).toBe(current);
	});

	it("does not duplicate a directory already present on PATH", () => {
		const current = `/home/dev/.local/bin${delimiter}/usr/bin`;
		expect(buildPathWithBinaryDir("/home/dev/.local/bin/claude", current)).toBe(current);
	});

	it("seeds PATH with the binary directory when PATH is empty", () => {
		expect(buildPathWithBinaryDir("/opt/tools/claude", undefined)).toBe("/opt/tools");
	});
});

describe("resolveBinaryPathOnPath", () => {
	it("resolves an accessible absolute path to itself", () => {
		// process.execPath is an absolute, executable binary on every platform.
		expect(resolveBinaryPathOnPath(process.execPath)).toBe(process.execPath);
	});

	it("returns null for an absolute path that does not exist", () => {
		expect(resolveBinaryPathOnPath("/definitely/not/here/kanban-nope")).toBeNull();
	});

	it("returns null for an empty binary name", () => {
		expect(resolveBinaryPathOnPath("   ")).toBeNull();
	});

	it("agrees with isBinaryAvailableOnPath", () => {
		expect(isBinaryAvailableOnPath(process.execPath)).toBe(true);
		expect(isBinaryAvailableOnPath("/definitely/not/here/kanban-nope")).toBe(false);
	});
});
