import { describe, expect, it, vi } from "vitest";

import {
	buildAttachmentMentionText,
	collectFilesFromDataTransfer,
	handleTerminalPasteEvent,
	processTerminalAttachments,
	type TerminalAttachmentUploadResult,
} from "./terminal-attachment-drop";

function fakeFile(name: string): File {
	// The orchestrator never reads bytes (upload is injected), so a minimal stub
	// with a `name` is enough.
	return { name } as unknown as File;
}

function fakeDataTransfer(options: {
	items?: Array<{ kind: string; file: File | null }>;
	files?: File[];
}): DataTransfer {
	const items = options.items ?? [];
	return {
		items: {
			length: items.length,
			...items.reduce<Record<number, { kind: string; getAsFile: () => File | null }>>((acc, entry, index) => {
				acc[index] = { kind: entry.kind, getAsFile: () => entry.file };
				return acc;
			}, {}),
		},
		files: options.files ?? [],
	} as unknown as DataTransfer;
}

describe("collectFilesFromDataTransfer", () => {
	it("returns [] for a null transfer", () => {
		expect(collectFilesFromDataTransfer(null)).toEqual([]);
	});

	it("collects file items (any type, not just images)", () => {
		const png = fakeFile("a.png");
		const pdf = fakeFile("b.pdf");
		const files = collectFilesFromDataTransfer(
			fakeDataTransfer({
				items: [
					{ kind: "file", file: png },
					{ kind: "string", file: null },
					{ kind: "file", file: pdf },
				],
			}),
		);
		expect(files).toEqual([png, pdf]);
	});

	it("falls back to files when items are empty (drop case)", () => {
		const doc = fakeFile("c.txt");
		const files = collectFilesFromDataTransfer(fakeDataTransfer({ items: [], files: [doc] }));
		expect(files).toEqual([doc]);
	});
});

describe("handleTerminalPasteEvent", () => {
	function fakePasteEvent(dataTransfer: DataTransfer | null): {
		event: Parameters<typeof handleTerminalPasteEvent>[0];
		calls: { preventDefault: number; stopImmediatePropagation: number };
	} {
		const calls = { preventDefault: 0, stopImmediatePropagation: 0 };
		return {
			calls,
			event: {
				clipboardData: dataTransfer,
				preventDefault: () => {
					calls.preventDefault += 1;
				},
				stopImmediatePropagation: () => {
					calls.stopImmediatePropagation += 1;
				},
			},
		};
	}

	it("intercepts a clipboard paste containing a file and blocks xterm", () => {
		const pdf = fakeFile("report.pdf");
		const onFiles = vi.fn();
		const { event, calls } = fakePasteEvent(fakeDataTransfer({ items: [{ kind: "file", file: pdf }] }));

		const intercepted = handleTerminalPasteEvent(event, onFiles);

		expect(intercepted).toBe(true);
		expect(calls.preventDefault).toBe(1);
		expect(calls.stopImmediatePropagation).toBe(1);
		expect(onFiles).toHaveBeenCalledWith([pdf]);
	});

	it("intercepts a pasted clipboard image (kind=file, image/*)", () => {
		const image = fakeFile("image.png");
		const onFiles = vi.fn();
		// A clipboard image arrives via items (kind=file); files is usually empty.
		const { event, calls } = fakePasteEvent(fakeDataTransfer({ items: [{ kind: "file", file: image }], files: [] }));

		const intercepted = handleTerminalPasteEvent(event, onFiles);

		expect(intercepted).toBe(true);
		expect(onFiles).toHaveBeenCalledWith([image]);
		expect(calls.preventDefault).toBe(1);
	});

	it("passes a pure-text paste through to xterm (no interception)", () => {
		const onFiles = vi.fn();
		const { event, calls } = fakePasteEvent(fakeDataTransfer({ items: [{ kind: "string", file: null }] }));

		const intercepted = handleTerminalPasteEvent(event, onFiles);

		expect(intercepted).toBe(false);
		expect(onFiles).not.toHaveBeenCalled();
		expect(calls.preventDefault).toBe(0);
		expect(calls.stopImmediatePropagation).toBe(0);
	});

	it("passes through when there is no clipboard data", () => {
		const onFiles = vi.fn();
		const { event, calls } = fakePasteEvent(null);

		const intercepted = handleTerminalPasteEvent(event, onFiles);

		expect(intercepted).toBe(false);
		expect(onFiles).not.toHaveBeenCalled();
		expect(calls.preventDefault).toBe(0);
	});
});

// Verifies the actual bug fix: a CAPTURE-phase listener on the container must run
// before — and be able to block — xterm's bubble-phase paste handler registered on
// a descendant textarea (which calls stopPropagation and swallows the event). Uses
// real jsdom DOM dispatch so it proves the event-ordering guarantee, not a mock.
describe("capture-phase paste interception (jsdom)", () => {
	function pasteEventWith(dataTransfer: DataTransfer | null): Event {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: dataTransfer, configurable: true });
		return event;
	}

	function buildTerminalDom(): { container: HTMLDivElement; textarea: HTMLTextAreaElement; cleanup: () => void } {
		const container = document.createElement("div");
		// Mirror xterm's structure: textarea nested a couple levels under the container.
		const element = document.createElement("div");
		const textarea = document.createElement("textarea");
		element.appendChild(textarea);
		container.appendChild(element);
		document.body.appendChild(container);
		return { container, textarea, cleanup: () => container.remove() };
	}

	it("intercepts a file paste before xterm's handler and prevents the default", () => {
		const { container, textarea, cleanup } = buildTerminalDom();
		const onFiles = vi.fn();
		let xtermHandled = false;
		// xterm: bubble-phase listener on the textarea that stops propagation.
		textarea.addEventListener("paste", (event) => {
			xtermHandled = true;
			event.stopPropagation();
		});
		// Our fix: capture-phase listener on the container.
		container.addEventListener(
			"paste",
			(event) => {
				handleTerminalPasteEvent(event as unknown as Parameters<typeof handleTerminalPasteEvent>[0], onFiles);
			},
			{ capture: true },
		);

		const png = fakeFile("shot.png");
		const event = pasteEventWith(fakeDataTransfer({ items: [{ kind: "file", file: png }] }));
		textarea.dispatchEvent(event);

		expect(onFiles).toHaveBeenCalledWith([png]);
		expect(xtermHandled).toBe(false); // blocked before reaching xterm
		expect(event.defaultPrevented).toBe(true);
		cleanup();
	});

	it("lets a plain-text paste fall through to xterm untouched", () => {
		const { container, textarea, cleanup } = buildTerminalDom();
		const onFiles = vi.fn();
		let xtermHandled = false;
		textarea.addEventListener("paste", () => {
			xtermHandled = true;
		});
		container.addEventListener(
			"paste",
			(event) => {
				handleTerminalPasteEvent(event as unknown as Parameters<typeof handleTerminalPasteEvent>[0], onFiles);
			},
			{ capture: true },
		);

		const event = pasteEventWith(fakeDataTransfer({ items: [{ kind: "string", file: null }] }));
		textarea.dispatchEvent(event);

		expect(onFiles).not.toHaveBeenCalled();
		expect(xtermHandled).toBe(true); // xterm still pastes the text
		expect(event.defaultPrevented).toBe(false);
		cleanup();
	});
});

describe("buildAttachmentMentionText", () => {
	it("builds an @path mention with a trailing space", () => {
		expect(buildAttachmentMentionText("/repo/.kanban/attachments/abc.png")).toBe(
			"@/repo/.kanban/attachments/abc.png ",
		);
	});

	it("quotes a path containing spaces", () => {
		expect(buildAttachmentMentionText("/repo/my dir/abc.png")).toBe('@"/repo/my dir/abc.png" ');
	});
});

describe("processTerminalAttachments", () => {
	it("injects an @path mention for each successful upload, in order", async () => {
		const inject = vi.fn();
		const onError = vi.fn();
		const upload = vi.fn(
			async (file: File): Promise<TerminalAttachmentUploadResult> => ({
				ok: true,
				path: `/wt/.kanban/attachments/${file.name}`,
			}),
		);

		const result = await processTerminalAttachments({
			files: [fakeFile("1.png"), fakeFile("2.png")],
			upload,
			inject,
			onError,
		});

		expect(result).toEqual({ injected: 2, failed: 0 });
		expect(inject.mock.calls.map((call) => call[0])).toEqual([
			"@/wt/.kanban/attachments/1.png ",
			"@/wt/.kanban/attachments/2.png ",
		]);
		expect(onError).not.toHaveBeenCalled();
	});

	it("reports a failed upload and injects nothing for it (rollback)", async () => {
		const inject = vi.fn();
		const onError = vi.fn();

		const result = await processTerminalAttachments({
			files: [fakeFile("bad.png")],
			upload: async () => ({ ok: false, error: "too big" }),
			inject,
			onError,
		});

		expect(result).toEqual({ injected: 0, failed: 1 });
		expect(inject).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith("too big");
	});

	it("treats a thrown upload as a failure", async () => {
		const inject = vi.fn();
		const onError = vi.fn();

		const result = await processTerminalAttachments({
			files: [fakeFile("boom.png")],
			upload: async () => {
				throw new Error("network down");
			},
			inject,
			onError,
		});

		expect(result).toEqual({ injected: 0, failed: 1 });
		expect(inject).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith("network down");
	});

	it("handles a mix of success and failure independently", async () => {
		const inject = vi.fn();
		const onError = vi.fn();

		const result = await processTerminalAttachments({
			files: [fakeFile("ok.png"), fakeFile("no.png")],
			upload: async (file) =>
				file.name === "ok.png" ? { ok: true, path: "/wt/ok.png" } : { ok: false, error: "denied" },
			inject,
			onError,
		});

		expect(result).toEqual({ injected: 1, failed: 1 });
		expect(inject).toHaveBeenCalledTimes(1);
		expect(inject).toHaveBeenCalledWith("@/wt/ok.png ");
		expect(onError).toHaveBeenCalledWith("denied");
	});
});
