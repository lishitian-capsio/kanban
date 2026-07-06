import { describe, expect, it } from "vitest";

import { collectNonImageFilesFromDataTransfer } from "./task-image-input-utils";

function fakeFile(name: string, type: string): File {
	return { name, type } as unknown as File;
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

describe("collectNonImageFilesFromDataTransfer", () => {
	it("keeps non-image files and drops accepted image files", () => {
		const png = fakeFile("shot.png", "image/png");
		const pdf = fakeFile("spec.pdf", "application/pdf");
		const txt = fakeFile("notes.txt", "text/plain");

		const result = collectNonImageFilesFromDataTransfer(
			fakeDataTransfer({
				items: [
					{ kind: "file", file: png },
					{ kind: "file", file: pdf },
					{ kind: "file", file: txt },
				],
			}),
		);

		expect(result.map((file) => file.name)).toEqual(["spec.pdf", "notes.txt"]);
	});

	it("ignores non-file items (e.g. dragged text/selection)", () => {
		const pdf = fakeFile("spec.pdf", "application/pdf");
		const result = collectNonImageFilesFromDataTransfer(
			fakeDataTransfer({
				items: [
					{ kind: "string", file: null },
					{ kind: "file", file: pdf },
				],
			}),
		);
		expect(result.map((file) => file.name)).toEqual(["spec.pdf"]);
	});

	it("falls back to `files` when `items` yields nothing", () => {
		const pdf = fakeFile("spec.pdf", "application/pdf");
		const png = fakeFile("shot.png", "image/png");
		const result = collectNonImageFilesFromDataTransfer(fakeDataTransfer({ files: [pdf, png] }));
		expect(result.map((file) => file.name)).toEqual(["spec.pdf"]);
	});

	it("returns [] when only image files are present", () => {
		const png = fakeFile("shot.png", "image/png");
		const result = collectNonImageFilesFromDataTransfer(
			fakeDataTransfer({ items: [{ kind: "file", file: png }] }),
		);
		expect(result).toEqual([]);
	});
});
