import { describe, expect, it } from "vitest";

import { FILE_RECENTS_LIMIT, type FileRecent, normalizeRecents, pushRecent } from "./use-file-recents";

const recent = (id: string, title = `Title ${id}`): FileRecent => ({ id, title });

describe("normalizeRecents", () => {
	it("keeps a clean list, de-duplicated by id and capped", () => {
		expect(normalizeRecents([recent("a"), recent("b"), recent("a"), recent("c")])).toEqual([
			recent("a"),
			recent("b"),
			recent("c"),
		]);
	});

	it("drops malformed entries and non-array input", () => {
		expect(normalizeRecents([recent("a"), 1, { id: "" }, null, { title: "no id" }, recent("b")])).toEqual([
			recent("a"),
			recent("b"),
		]);
		expect(normalizeRecents("nope")).toEqual([]);
		expect(normalizeRecents(undefined)).toEqual([]);
	});

	it("defaults a missing title to an empty string", () => {
		expect(normalizeRecents([{ id: "a" }])).toEqual([{ id: "a", title: "" }]);
	});

	it("caps the list at the limit", () => {
		const many = Array.from({ length: FILE_RECENTS_LIMIT + 5 }, (_, i) => recent(`id-${i}`));
		expect(normalizeRecents(many)).toHaveLength(FILE_RECENTS_LIMIT);
	});
});

describe("pushRecent", () => {
	it("moves a file to the front, most-recent-first", () => {
		expect(pushRecent([recent("a"), recent("b"), recent("c")], recent("c"))).toEqual([
			recent("c"),
			recent("a"),
			recent("b"),
		]);
		expect(pushRecent([recent("a"), recent("b")], recent("z"))).toEqual([recent("z"), recent("a"), recent("b")]);
	});

	it("caps the result at the limit", () => {
		const existing = Array.from({ length: FILE_RECENTS_LIMIT }, (_, i) => recent(`id-${i}`));
		const result = pushRecent(existing, recent("newest"));
		expect(result).toHaveLength(FILE_RECENTS_LIMIT);
		expect(result[0]).toEqual(recent("newest"));
	});
});
