import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPathWithBinaryDir } from "../../../src/terminal/command-discovery";

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
