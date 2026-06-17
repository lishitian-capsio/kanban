import { describe, expect, it } from "vitest";

import type { BoardCard, BoardData } from "@/types";
import {
	collectBoardOwnerOptions,
	filterBoardByOwner,
	getTaskOwnerKey,
	getTaskOwnerLabel,
	UNASSIGNED_OWNER_KEY,
} from "@/utils/task-owner";

function card(id: string, owner?: BoardCard["owner"]): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...(owner ? { owner } : {}),
	};
}

function board(...cards: BoardCard[]): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("getTaskOwnerKey", () => {
	it("returns the unassigned sentinel for a missing or blank owner", () => {
		expect(getTaskOwnerKey(undefined)).toBe(UNASSIGNED_OWNER_KEY);
		expect(getTaskOwnerKey({ name: "  ", email: " " })).toBe(UNASSIGNED_OWNER_KEY);
	});

	it("distinguishes different identities", () => {
		const ada = getTaskOwnerKey({ name: "Ada", email: "ada@example.com" });
		const grace = getTaskOwnerKey({ name: "Grace", email: "grace@example.com" });
		expect(ada).not.toBe(grace);
		expect(getTaskOwnerKey({ name: "Ada", email: "ada@example.com" })).toBe(ada);
	});
});

describe("getTaskOwnerLabel", () => {
	it("prefers the name, falls back to the email", () => {
		expect(getTaskOwnerLabel({ name: "Ada", email: "ada@example.com" })).toBe("Ada");
		expect(getTaskOwnerLabel({ name: "", email: "ada@example.com" })).toBe("ada@example.com");
		expect(getTaskOwnerLabel(undefined)).toBe("");
	});
});

describe("collectBoardOwnerOptions", () => {
	it("lists distinct owners sorted by label with Unassigned last", () => {
		const data = board(
			card("a", { name: "Grace", email: "grace@example.com" }),
			card("b", { name: "Ada", email: "ada@example.com" }),
			card("c", { name: "Ada", email: "ada@example.com" }),
			card("d"),
		);
		const options = collectBoardOwnerOptions(data);
		expect(options.map((option) => option.label)).toEqual(["Ada", "Grace", "Unassigned"]);
	});

	it("omits Unassigned when every task has an owner", () => {
		const data = board(card("a", { name: "Ada", email: "ada@example.com" }));
		expect(collectBoardOwnerOptions(data).map((option) => option.label)).toEqual(["Ada"]);
	});
});

describe("filterBoardByOwner", () => {
	it("returns the board unchanged when no filter is set", () => {
		const data = board(card("a", { name: "Ada", email: "ada@example.com" }));
		expect(filterBoardByOwner(data, null)).toBe(data);
	});

	it("keeps only cards matching the owner key", () => {
		const data = board(
			card("a", { name: "Ada", email: "ada@example.com" }),
			card("b", { name: "Grace", email: "grace@example.com" }),
			card("c"),
		);
		const filtered = filterBoardByOwner(data, getTaskOwnerKey({ name: "Ada", email: "ada@example.com" }));
		expect(filtered.columns[0]?.cards.map((c) => c.id)).toEqual(["a"]);
	});

	it("keeps only unassigned cards when filtering by the unassigned key", () => {
		const data = board(card("a", { name: "Ada", email: "ada@example.com" }), card("c"));
		const filtered = filterBoardByOwner(data, UNASSIGNED_OWNER_KEY);
		expect(filtered.columns[0]?.cards.map((c) => c.id)).toEqual(["c"]);
	});
});
