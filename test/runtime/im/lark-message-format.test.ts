import { describe, expect, it } from "vitest";

import { LarkCredentialFormatError } from "../../../src/im/lark/errors";
import {
	buildLarkInteractiveCardContent,
	buildLarkTextMessageContent,
	inferLarkReceiveIdType,
	parseLarkBotCredential,
} from "../../../src/im/lark/lark-message-format";

describe("parseLarkBotCredential", () => {
	it("splits app_id:app_secret on the first colon", () => {
		expect(parseLarkBotCredential("cli_app123:secretABC")).toEqual({ appId: "cli_app123", appSecret: "secretABC" });
	});

	it("keeps colons inside the secret intact (splits on FIRST colon only)", () => {
		expect(parseLarkBotCredential("cli_app:a:b:c")).toEqual({ appId: "cli_app", appSecret: "a:b:c" });
	});

	it("trims surrounding whitespace on both halves", () => {
		expect(parseLarkBotCredential(" cli_app : secret ")).toEqual({ appId: "cli_app", appSecret: "secret" });
	});

	it.each(["no-colon", ":secretonly", "appidonly:", " : ", ""])(
		"throws LarkCredentialFormatError for malformed %j",
		(value) => {
			expect(() => parseLarkBotCredential(value)).toThrow(LarkCredentialFormatError);
		},
	);
});

describe("inferLarkReceiveIdType", () => {
	it.each([
		["oc_group123", "chat_id"],
		["ou_user456", "open_id"],
		["on_union789", "union_id"],
		["alice@example.com", "email"],
		["something-unknown", "chat_id"],
	] as const)("maps %s → %s", (chatId, expected) => {
		expect(inferLarkReceiveIdType(chatId)).toBe(expected);
	});
});

describe("buildLarkTextMessageContent", () => {
	it("returns a JSON string with the text field", () => {
		expect(buildLarkTextMessageContent("hello 世界")).toBe(JSON.stringify({ text: "hello 世界" }));
	});
});

describe("buildLarkInteractiveCardContent", () => {
	it("emits a header only when a title is present", () => {
		const withTitle = JSON.parse(buildLarkInteractiveCardContent({ title: "Build", text: "done" }));
		expect(withTitle.header.title.content).toBe("Build");

		const withoutTitle = JSON.parse(buildLarkInteractiveCardContent({ text: "done" }));
		expect(withoutTitle.header).toBeUndefined();
	});

	it("renders body text as a lark_md div", () => {
		const card = JSON.parse(buildLarkInteractiveCardContent({ text: "**bold**" }));
		expect(card.elements[0]).toEqual({ tag: "div", text: { tag: "lark_md", content: "**bold**" } });
	});

	it("emits an action block with a button per card button, and none when empty", () => {
		const withButtons = JSON.parse(
			buildLarkInteractiveCardContent({
				text: "pick one",
				buttons: [{ text: "Open PR", url: "https://example.com/pr/1" }],
			}),
		);
		const action = withButtons.elements.find((e: { tag: string }) => e.tag === "action");
		expect(action.actions).toEqual([
			{ tag: "button", text: { tag: "plain_text", content: "Open PR" }, url: "https://example.com/pr/1", type: "default" },
		]);

		const noButtons = JSON.parse(buildLarkInteractiveCardContent({ text: "no actions" }));
		expect(noButtons.elements.some((e: { tag: string }) => e.tag === "action")).toBe(false);
	});
});
