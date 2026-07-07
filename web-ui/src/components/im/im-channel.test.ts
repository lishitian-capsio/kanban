import { describe, expect, it } from "vitest";

import {
	describeImChannel,
	IM_PLATFORM_LABELS,
	IM_PLATFORM_OPTIONS,
	imChannelDisplayLabel,
	inferLarkKindLabel,
} from "@/components/im/im-channel";

describe("inferLarkKindLabel", () => {
	it("maps Lark id prefixes to a human kind label", () => {
		expect(inferLarkKindLabel("oc_123")).toBe("群聊");
		expect(inferLarkKindLabel("ou_123")).toBe("单聊");
		expect(inferLarkKindLabel("on_123")).toBe("union");
		expect(inferLarkKindLabel("someone@example.com")).toBe("邮箱");
		expect(inferLarkKindLabel("unprefixed")).toBe("群聊");
	});

	it("ignores surrounding whitespace", () => {
		expect(inferLarkKindLabel("  oc_123  ")).toBe("群聊");
	});
});

describe("IM_PLATFORM_LABELS / OPTIONS", () => {
	it("labels every platform in Chinese", () => {
		expect(IM_PLATFORM_LABELS.lark).toBe("飞书");
		expect(IM_PLATFORM_LABELS.dingtalk).toBe("钉钉");
	});

	it("derives options from the label map", () => {
		expect(IM_PLATFORM_OPTIONS).toEqual(
			expect.arrayContaining([
				{ value: "lark", label: "飞书" },
				{ value: "dingtalk", label: "钉钉" },
			]),
		);
	});
});

describe("imChannelDisplayLabel", () => {
	it("prefers a non-empty display name", () => {
		expect(imChannelDisplayLabel("oc_abc", "Technology.Result")).toBe("Technology.Result");
	});

	it("falls back to the chat id when the name is empty, whitespace, null, or undefined", () => {
		expect(imChannelDisplayLabel("oc_abc", "")).toBe("oc_abc");
		expect(imChannelDisplayLabel("oc_abc", "   ")).toBe("oc_abc");
		expect(imChannelDisplayLabel("oc_abc", null)).toBe("oc_abc");
		expect(imChannelDisplayLabel("oc_abc")).toBe("oc_abc");
	});

	it("trims the display name", () => {
		expect(imChannelDisplayLabel("oc_abc", "  团队群  ")).toBe("团队群");
	});
});

describe("describeImChannel", () => {
	it("describes a Lark group channel", () => {
		expect(describeImChannel({ platform: "lark", chatId: "oc_abc" })).toEqual({
			platformLabel: "飞书",
			kindLabel: "群聊",
		});
	});

	it("uses a generic kind for DingTalk (webhook robot, no chat kind)", () => {
		expect(describeImChannel({ platform: "dingtalk", chatId: "anything" })).toEqual({
			platformLabel: "钉钉",
			kindLabel: "群",
		});
	});
});
