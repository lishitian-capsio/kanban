import { describe, expect, it } from "vitest";

import type { RuntimeVaultOutgoingLink } from "@/runtime/types";

import { buildWikilinkResolver } from "./wikilink-resolution";

function link(overrides: Partial<RuntimeVaultOutgoingLink> & Pick<RuntimeVaultOutgoingLink, "target">): RuntimeVaultOutgoingLink {
	return {
		label: undefined,
		source: { kind: "body" },
		resolvedId: null,
		resolvedType: null,
		resolvedTitle: null,
		...overrides,
	};
}

describe("buildWikilinkResolver", () => {
	it("resolves a target to its document (case-insensitively)", () => {
		const resolve = buildWikilinkResolver([
			link({ target: "Acme Corp", resolvedId: "a", resolvedType: "customer", resolvedTitle: "Acme Corp" }),
		]);
		expect(resolve("acme corp")).toEqual({ id: "a", type: "customer", title: "Acme Corp" });
		expect(resolve("  Acme Corp  ")).toEqual({ id: "a", type: "customer", title: "Acme Corp" });
	});

	it("returns null for an unresolved target the engine saw but could not match", () => {
		const resolve = buildWikilinkResolver([link({ target: "Ghost" })]);
		expect(resolve("Ghost")).toBeNull();
	});

	it("returns null for a target the engine never reported", () => {
		const resolve = buildWikilinkResolver([]);
		expect(resolve("Anything")).toBeNull();
	});

	it("matches by the resolved title too, so a label alias resolves", () => {
		const resolve = buildWikilinkResolver([
			link({ target: "auth", resolvedId: "c", resolvedType: "requirement", resolvedTitle: "Login flow" }),
		]);
		expect(resolve("auth")).toEqual({ id: "c", type: "requirement", title: "Login flow" });
		expect(resolve("Login flow")).toEqual({ id: "c", type: "requirement", title: "Login flow" });
	});
});
