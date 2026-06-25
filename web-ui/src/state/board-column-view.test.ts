import { describe, expect, it } from "vitest";

import {
	applyColumnView,
	COLUMN_VIEW_UNASSIGNED,
	createDefaultColumnView,
	deriveColumnAgentOptions,
	deriveColumnOwnerOptions,
	filterColumnCards,
	getCardOwnerKey,
	isColumnViewActive,
	resolveColumnEmptyState,
	sortColumnCards,
} from "@/state/board-column-view";
import type { BoardCard } from "@/types";

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: overrides.id ?? "task-1",
		title: overrides.title ?? "Untitled",
		prompt: overrides.prompt ?? "Do the thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: overrides.createdAt ?? 1_000,
		updatedAt: overrides.updatedAt ?? 1_000,
		...overrides,
	};
}

describe("isColumnViewActive", () => {
	it("is inactive for the default view", () => {
		expect(isColumnViewActive(createDefaultColumnView())).toBe(false);
	});

	it("is active for any non-default field", () => {
		expect(isColumnViewActive({ ...createDefaultColumnView(), search: "x" })).toBe(true);
		expect(isColumnViewActive({ ...createDefaultColumnView(), search: "   " })).toBe(false);
		expect(isColumnViewActive({ ...createDefaultColumnView(), agentId: "claude" })).toBe(true);
		expect(isColumnViewActive({ ...createDefaultColumnView(), ownerKey: "a@b.co" })).toBe(true);
		expect(isColumnViewActive({ ...createDefaultColumnView(), sortKey: "title" })).toBe(true);
	});

	it("treats a descending rank sort as inactive (rank is always manual order)", () => {
		expect(isColumnViewActive({ ...createDefaultColumnView(), sortDirection: "desc" })).toBe(false);
	});
});

describe("filterColumnCards", () => {
	const cards = [
		createCard({ id: "a", title: "Fix login bug", prompt: "auth flow", agentId: "claude" }),
		createCard({ id: "b", title: "Add dashboard", prompt: "charts and LOGIN widgets", agentId: "codex" }),
		createCard({ id: "c", title: "Docs", prompt: "write README" }),
	];

	it("matches search against both title and prompt, case-insensitively", () => {
		const result = filterColumnCards(cards, { ...createDefaultColumnView(), search: "login" });
		expect(result.map((card) => card.id)).toEqual(["a", "b"]);
	});

	it("returns all cards for a blank search", () => {
		expect(filterColumnCards(cards, { ...createDefaultColumnView(), search: "  " })).toHaveLength(3);
	});

	it("filters by exact agent id", () => {
		const result = filterColumnCards(cards, { ...createDefaultColumnView(), agentId: "codex" });
		expect(result.map((card) => card.id)).toEqual(["b"]);
	});

	it("filters unassigned-agent cards via the sentinel", () => {
		const result = filterColumnCards(cards, { ...createDefaultColumnView(), agentId: COLUMN_VIEW_UNASSIGNED });
		expect(result.map((card) => card.id)).toEqual(["c"]);
	});

	it("filters by owner key and by no-owner sentinel", () => {
		const owned = [
			createCard({ id: "o1", owner: { name: "Ada", email: "ada@x.io" } }),
			createCard({ id: "o2", owner: { name: "", email: "" } }),
			createCard({ id: "o3" }),
		];
		expect(filterColumnCards(owned, { ...createDefaultColumnView(), ownerKey: "ada@x.io" }).map((c) => c.id)).toEqual(
			["o1"],
		);
		expect(
			filterColumnCards(owned, { ...createDefaultColumnView(), ownerKey: COLUMN_VIEW_UNASSIGNED }).map((c) => c.id),
		).toEqual(["o2", "o3"]);
	});

	it("combines search, agent and owner with AND semantics", () => {
		const data = [
			createCard({ id: "m", title: "match", prompt: "x", agentId: "claude", owner: { name: "Ada", email: "a@x" } }),
			createCard({ id: "n", title: "match", prompt: "x", agentId: "codex", owner: { name: "Ada", email: "a@x" } }),
		];
		const result = filterColumnCards(data, {
			...createDefaultColumnView(),
			search: "match",
			agentId: "claude",
			ownerKey: "a@x",
		});
		expect(result.map((card) => card.id)).toEqual(["m"]);
	});
});

describe("sortColumnCards", () => {
	const cards = [
		createCard({ id: "a", title: "Banana", createdAt: 30, updatedAt: 5 }),
		createCard({ id: "b", title: "apple", createdAt: 10, updatedAt: 15 }),
		createCard({ id: "c", title: "Cherry", createdAt: 20, updatedAt: 25 }),
	];

	it("preserves original order for rank sort regardless of direction", () => {
		expect(sortColumnCards(cards, { ...createDefaultColumnView() }).map((c) => c.id)).toEqual(["a", "b", "c"]);
		expect(sortColumnCards(cards, { ...createDefaultColumnView(), sortDirection: "desc" }).map((c) => c.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("does not mutate the input array", () => {
		const input = [...cards];
		sortColumnCards(input, { ...createDefaultColumnView(), sortKey: "createdAt" });
		expect(input.map((c) => c.id)).toEqual(["a", "b", "c"]);
	});

	it("sorts by createdAt ascending and descending", () => {
		expect(sortColumnCards(cards, { ...createDefaultColumnView(), sortKey: "createdAt" }).map((c) => c.id)).toEqual([
			"b",
			"c",
			"a",
		]);
		expect(
			sortColumnCards(cards, { ...createDefaultColumnView(), sortKey: "createdAt", sortDirection: "desc" }).map(
				(c) => c.id,
			),
		).toEqual(["a", "c", "b"]);
	});

	it("sorts by updatedAt", () => {
		expect(sortColumnCards(cards, { ...createDefaultColumnView(), sortKey: "updatedAt" }).map((c) => c.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("sorts by title case-insensitively", () => {
		expect(sortColumnCards(cards, { ...createDefaultColumnView(), sortKey: "title" }).map((c) => c.id)).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	it("keeps equal keys stable across directions", () => {
		const tied = [
			createCard({ id: "x", createdAt: 1 }),
			createCard({ id: "y", createdAt: 1 }),
			createCard({ id: "z", createdAt: 1 }),
		];
		expect(
			sortColumnCards(tied, { ...createDefaultColumnView(), sortKey: "createdAt", sortDirection: "desc" }).map(
				(c) => c.id,
			),
		).toEqual(["x", "y", "z"]);
	});
});

describe("applyColumnView", () => {
	it("filters before sorting", () => {
		const cards = [
			createCard({ id: "a", title: "keep zeta", createdAt: 3 }),
			createCard({ id: "b", title: "drop", createdAt: 1 }),
			createCard({ id: "c", title: "keep alpha", createdAt: 2 }),
		];
		const result = applyColumnView(cards, { ...createDefaultColumnView(), search: "keep", sortKey: "title" });
		expect(result.map((c) => c.id)).toEqual(["c", "a"]);
	});
});

describe("deriveColumnAgentOptions", () => {
	it("counts distinct agents, sorts by label, and appends an unassigned option", () => {
		const cards = [
			createCard({ id: "a", agentId: "codex" }),
			createCard({ id: "b", agentId: "claude" }),
			createCard({ id: "c", agentId: "claude" }),
			createCard({ id: "d" }),
		];
		const options = deriveColumnAgentOptions(cards, (id) => id.toUpperCase());
		expect(options).toEqual([
			{ value: "claude", label: "CLAUDE", count: 2 },
			{ value: "codex", label: "CODEX", count: 1 },
			{ value: COLUMN_VIEW_UNASSIGNED, label: "Default agent", count: 1 },
		]);
	});

	it("omits the unassigned option when every card has an agent", () => {
		const options = deriveColumnAgentOptions([createCard({ agentId: "claude" })], (id) => id);
		expect(options.some((option) => option.value === COLUMN_VIEW_UNASSIGNED)).toBe(false);
	});
});

describe("deriveColumnOwnerOptions", () => {
	it("groups by owner key, labels by name, and appends a no-owner option", () => {
		const cards = [
			createCard({ id: "a", owner: { name: "Ada", email: "ada@x.io" } }),
			createCard({ id: "b", owner: { name: "Ada", email: "ada@x.io" } }),
			createCard({ id: "c" }),
		];
		const options = deriveColumnOwnerOptions(cards);
		expect(options).toEqual([
			{ value: "ada@x.io", label: "Ada", count: 2 },
			{ value: COLUMN_VIEW_UNASSIGNED, label: "No owner", count: 1 },
		]);
	});
});

describe("getCardOwnerKey", () => {
	it("prefers email, falls back to name, else null", () => {
		expect(getCardOwnerKey(createCard({ owner: { name: "Ada", email: "ada@x.io" } }))).toBe("ada@x.io");
		expect(getCardOwnerKey(createCard({ owner: { name: "Ada", email: "  " } }))).toBe("Ada");
		expect(getCardOwnerKey(createCard({ owner: { name: "", email: "" } }))).toBeNull();
		expect(getCardOwnerKey(createCard())).toBeNull();
	});
});

describe("resolveColumnEmptyState", () => {
	it("is none when cards are showing", () => {
		expect(resolveColumnEmptyState(5, 3, true)).toBe("none");
	});

	it("is empty when the column has no cards at all", () => {
		expect(resolveColumnEmptyState(0, 0, false)).toBe("empty");
	});

	it("is no-matches when an active view hides every card", () => {
		expect(resolveColumnEmptyState(4, 0, true)).toBe("no-matches");
	});

	it("is empty when no view is active but nothing shows", () => {
		expect(resolveColumnEmptyState(4, 0, false)).toBe("empty");
	});
});
