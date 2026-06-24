import { describe, expect, it } from "vitest";
import { paint, startCliSpinner } from "../src/cli-output";

/** A minimal non-TTY writable stand-in capturing what the spinner falls back to printing. */
function fakeStream(): { stream: NodeJS.WriteStream; written: () => string } {
	let buffer = "";
	const stream = {
		isTTY: false,
		write(chunk: string | Uint8Array): boolean {
			buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			return true;
		},
	} as unknown as NodeJS.WriteStream;
	return { stream, written: () => buffer };
}

describe("paint", () => {
	it("wraps text in an ANSI escape only when color is enabled", () => {
		expect(paint("hi", "green", false)).toBe("hi");
		expect(paint("hi", "green", true)).toContain("hi");
		expect(paint("hi", "green", true)).not.toBe("hi");
	});
});

describe("startCliSpinner (non-TTY fallback)", () => {
	it("prints the in-progress text and a terminal success line without a spinner", () => {
		const { stream, written } = fakeStream();
		const spinner = startCliSpinner("Working…", stream);
		spinner.succeed("Done");
		expect(written()).toContain("Working…");
		expect(written()).toContain("Done");
	});

	it("prints the failure line on fail", () => {
		const { stream, written } = fakeStream();
		const spinner = startCliSpinner("Working…", stream);
		spinner.fail("Boom");
		expect(written()).toContain("Boom");
	});
});
