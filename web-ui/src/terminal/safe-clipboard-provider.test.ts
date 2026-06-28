import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSafeClipboardProvider } from "@/terminal/safe-clipboard-provider";

const SYSTEM = "c" as ClipboardSelectionType;
const PRIMARY = "p" as ClipboardSelectionType;

function setClipboard(value: unknown): void {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value,
		configurable: true,
		writable: true,
	});
}

describe("createSafeClipboardProvider", () => {
	afterEach(() => {
		setClipboard(undefined);
	});

	it("does not throw and resolves when navigator.clipboard is unavailable", async () => {
		setClipboard(undefined);
		const provider = createSafeClipboardProvider();

		await expect(Promise.resolve(provider.writeText(SYSTEM, "hello"))).resolves.toBeUndefined();
	});

	it("delegates writeText to navigator.clipboard when it is available", async () => {
		const writeText = vi.fn(async () => {});
		setClipboard({ writeText });
		const provider = createSafeClipboardProvider();

		await provider.writeText(SYSTEM, "copied");

		expect(writeText).toHaveBeenCalledWith("copied");
	});

	it("swallows a rejected clipboard write instead of propagating it", async () => {
		const writeText = vi.fn(async () => {
			throw new Error("denied");
		});
		setClipboard({ writeText });
		const provider = createSafeClipboardProvider();

		await expect(Promise.resolve(provider.writeText(SYSTEM, "copied"))).resolves.toBeUndefined();
	});

	it("ignores the primary selection (matches the default browser provider)", async () => {
		const writeText = vi.fn(async () => {});
		setClipboard({ writeText });
		const provider = createSafeClipboardProvider();

		await provider.writeText(PRIMARY, "ignored");

		expect(writeText).not.toHaveBeenCalled();
	});

	it("returns an empty string from readText when navigator.clipboard is unavailable", async () => {
		setClipboard(undefined);
		const provider = createSafeClipboardProvider();

		await expect(Promise.resolve(provider.readText(SYSTEM))).resolves.toBe("");
	});

	it("delegates readText to navigator.clipboard when it is available", async () => {
		const readText = vi.fn(async () => "pasted");
		setClipboard({ readText });
		const provider = createSafeClipboardProvider();

		await expect(Promise.resolve(provider.readText(SYSTEM))).resolves.toBe("pasted");
	});
});
