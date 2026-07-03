import { describe, expect, it, vi } from "vitest";

import {
	buildAttachmentMentionText,
	collectFilesFromDataTransfer,
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
