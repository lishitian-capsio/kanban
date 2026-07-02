import { afterEach, beforeEach, describe, expect, it } from "vitest";

// PtySession has a single backend: Bun's native Terminal API. When that API is
// unavailable (no `globalThis.Bun`, e.g. running under plain Node), spawning
// must fail loudly rather than silently doing nothing — there is no longer a
// node-pty fallback. This lives in its own file because PtySession memoizes the
// availability probe per module instance, and vitest isolates modules per file.

import { PtySession } from "../../../src/terminal/pty-session";

const originalBun = (globalThis as { Bun?: unknown }).Bun;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("PtySession without a Bun terminal backend", () => {
	beforeEach(() => {
		delete (globalThis as { Bun?: unknown }).Bun;
	});

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalBun === undefined) {
			delete (globalThis as { Bun?: unknown }).Bun;
		} else {
			(globalThis as { Bun?: unknown }).Bun = originalBun;
		}
	});

	it("throws when the Bun native Terminal API is unavailable", () => {
		expect(() =>
			PtySession.spawn({
				binary: "claude",
				args: [],
				cwd: "/tmp",
				cols: 120,
				rows: 40,
			}),
		).toThrow(/Bun/);
	});

	it("throws a Windows-specific error when neither bun-pty nor Bun native is available", () => {
		setPlatform("win32");
		expect(() =>
			PtySession.spawn({
				binary: "codex.exe",
				args: [],
				cwd: "C:/repo",
				cols: 120,
				rows: 40,
			}),
		).toThrow(/bun-pty/);
	});
});
