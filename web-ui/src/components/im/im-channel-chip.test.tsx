import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelChip } from "@/components/im/im-channel-chip";

describe("ImChannelChip", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("shows the platform, kind, and chat id", () => {
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc123" }} />);
		});
		expect(container.textContent).toContain("飞书");
		expect(container.textContent).toContain("群聊");
		expect(container.textContent).toContain("oc_abc123");
	});

	it("prefers a display name and keeps the chat id as a hover title", () => {
		act(() => {
			root.render(
				<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc123" }} displayName="Technology.Result" />,
			);
		});
		expect(container.textContent).toContain("Technology.Result");
		expect(container.textContent).not.toContain("oc_abc123");
		expect(container.querySelector('[title="oc_abc123"]')).not.toBeNull();
	});

	it("falls back to the chat id when the display name is blank", () => {
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc123" }} displayName="   " />);
		});
		expect(container.textContent).toContain("oc_abc123");
	});

	it("renders no unbind button without onUnbind", () => {
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc" }} />);
		});
		expect(container.querySelector("button")).toBeNull();
	});

	it("calls onUnbind when the remove button is clicked", () => {
		const onUnbind = vi.fn();
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc" }} onUnbind={onUnbind} />);
		});
		const button = container.querySelector('button[aria-label="解绑 飞书 · 群聊"]');
		expect(button).not.toBeNull();
		act(() => {
			button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onUnbind).toHaveBeenCalledTimes(1);
	});
});
