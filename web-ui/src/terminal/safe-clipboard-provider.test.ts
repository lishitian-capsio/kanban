import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ClipboardWriteFailureReason, createSafeClipboardProvider } from "@/terminal/safe-clipboard-provider";

const SYSTEM = "c" as ClipboardSelectionType;
const PRIMARY = "p" as ClipboardSelectionType;

function setClipboard(value: unknown): void {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value,
		configurable: true,
		writable: true,
	});
}

function mockExecCommand(result: boolean): ReturnType<typeof vi.fn> {
	const execCommand = vi.fn(() => result);
	Object.defineProperty(globalThis.document, "execCommand", {
		value: execCommand,
		configurable: true,
		writable: true,
	});
	return execCommand;
}

describe("createSafeClipboardProvider", () => {
	afterEach(() => {
		setClipboard(undefined);
		vi.restoreAllMocks();
	});

	it("delegates writeText to navigator.clipboard when it succeeds (no fallback, no failure)", async () => {
		const writeText = vi.fn(async () => {});
		setClipboard({ writeText });
		const execCommand = mockExecCommand(true);
		const onWriteFailure = vi.fn();
		const provider = createSafeClipboardProvider({ onWriteFailure });

		await provider.writeText(SYSTEM, "copied");

		expect(writeText).toHaveBeenCalledWith("copied");
		expect(execCommand).not.toHaveBeenCalled();
		expect(onWriteFailure).not.toHaveBeenCalled();
	});

	it("falls back to execCommand when the async API is unavailable", async () => {
		setClipboard(undefined);
		const execCommand = mockExecCommand(true);
		const onWriteFailure = vi.fn();
		const provider = createSafeClipboardProvider({ onWriteFailure });

		await provider.writeText(SYSTEM, "via-fallback");

		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(onWriteFailure).not.toHaveBeenCalled();
	});

	it("falls back to execCommand when the async write rejects", async () => {
		const writeText = vi.fn(async () => {
			throw new Error("denied");
		});
		setClipboard({ writeText });
		const execCommand = mockExecCommand(true);
		const onWriteFailure = vi.fn();
		const provider = createSafeClipboardProvider({ onWriteFailure });

		await provider.writeText(SYSTEM, "copied");

		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(onWriteFailure).not.toHaveBeenCalled();
	});

	it("reports 'insecure-context' when the API is absent and the fallback fails", async () => {
		setClipboard(undefined);
		mockExecCommand(false);
		const reasons: ClipboardWriteFailureReason[] = [];
		const provider = createSafeClipboardProvider({ onWriteFailure: (reason) => reasons.push(reason) });

		await provider.writeText(SYSTEM, "copied");

		expect(reasons).toEqual(["insecure-context"]);
	});

	it("reports 'blocked' when the async write rejects and the fallback fails", async () => {
		const writeText = vi.fn(async () => {
			throw new Error("NotAllowedError");
		});
		setClipboard({ writeText });
		mockExecCommand(false);
		const reasons: ClipboardWriteFailureReason[] = [];
		const provider = createSafeClipboardProvider({ onWriteFailure: (reason) => reasons.push(reason) });

		await provider.writeText(SYSTEM, "copied");

		expect(reasons).toEqual(["blocked"]);
	});

	it("does not throw when no onWriteFailure handler is provided and every path fails", async () => {
		setClipboard(undefined);
		mockExecCommand(false);
		const provider = createSafeClipboardProvider();

		await expect(Promise.resolve(provider.writeText(SYSTEM, "hello"))).resolves.toBeUndefined();
	});

	it("ignores the primary selection (matches the default browser provider)", async () => {
		const writeText = vi.fn(async () => {});
		setClipboard({ writeText });
		const execCommand = mockExecCommand(true);
		const onWriteFailure = vi.fn();
		const provider = createSafeClipboardProvider({ onWriteFailure });

		await provider.writeText(PRIMARY, "ignored");

		expect(writeText).not.toHaveBeenCalled();
		expect(execCommand).not.toHaveBeenCalled();
		expect(onWriteFailure).not.toHaveBeenCalled();
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
