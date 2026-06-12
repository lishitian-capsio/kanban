import type { Paragraph, Root } from "mdast";
import { describe, expect, it } from "vitest";

import { parseWikilinkHref, remarkWikilink, WIKILINK_SCHEME } from "./remark-wikilink";

function paragraph(text: string): Root {
	return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
}

function runPlugin(tree: Root): Root {
	remarkWikilink()(tree);
	return tree;
}

describe("remarkWikilink", () => {
	it("rewrites a bare wikilink into a link node carrying the target", () => {
		const tree = runPlugin(paragraph("See [[Acme Corp]] now"));
		const children = (tree.children[0] as Paragraph).children;
		expect(children).toHaveLength(3);
		expect(children[0]).toMatchObject({ type: "text", value: "See " });
		expect(children[2]).toMatchObject({ type: "text", value: " now" });
		const link = children[1]!;
		expect(link.type).toBe("link");
		expect(link).toMatchObject({ url: `${WIKILINK_SCHEME}Acme%20Corp` });
		// The visible text defaults to the target.
		expect((link as { children: { value: string }[] }).children[0]).toMatchObject({ value: "Acme Corp" });
	});

	it("uses the label as the visible text but keeps the target in the url", () => {
		const tree = runPlugin(paragraph("[[Acme Corp|the cli]]"));
		const link = (tree.children[0] as Paragraph).children[0]! as unknown as {
			url: string;
			children: { value: string }[];
		};
		expect(link.url).toBe(`${WIKILINK_SCHEME}Acme%20Corp`);
		expect(link.children[0]!.value).toBe("the cli");
	});

	it("leaves text without wikilinks untouched", () => {
		const tree = runPlugin(paragraph("just [single] brackets"));
		expect((tree.children[0] as Paragraph).children).toEqual([{ type: "text", value: "just [single] brackets" }]);
	});

	it("rewrites several links in one paragraph", () => {
		const tree = runPlugin(paragraph("[[A]] and [[B]]"));
		const links = (tree.children[0] as Paragraph).children.filter((node) => node.type === "link");
		expect(links).toHaveLength(2);
	});
});

describe("parseWikilinkHref", () => {
	it("decodes the target from a wikilink href", () => {
		expect(parseWikilinkHref(`${WIKILINK_SCHEME}Acme%20Corp`)).toBe("Acme Corp");
	});

	it("returns null for ordinary links", () => {
		expect(parseWikilinkHref("https://example.com")).toBeNull();
		expect(parseWikilinkHref(undefined)).toBeNull();
	});
});
