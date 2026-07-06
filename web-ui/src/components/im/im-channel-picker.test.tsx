import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelPicker } from "@/components/im/im-channel-picker";

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ImChannelPicker", () => {
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

	it("emits a lark target (default platform) when a chatId is typed", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<ImChannelPicker value={null} onChange={onChange} />);
		});
		const input = container.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		expect(input).not.toBeNull();
		act(() => {
			setInputValue(input, "oc_group1");
		});
		expect(onChange).toHaveBeenLastCalledWith({ platform: "lark", chatId: "oc_group1" });
	});

	it("emits null when the chatId is cleared", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<ImChannelPicker value={{ platform: "lark", chatId: "oc_group1" }} onChange={onChange} />);
		});
		const input = container.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		act(() => {
			setInputValue(input, "   ");
		});
		expect(onChange).toHaveBeenLastCalledWith(null);
	});

	it("shows the inferred Lark kind for the typed chatId", () => {
		act(() => {
			root.render(<ImChannelPicker value={{ platform: "lark", chatId: "ou_person" }} onChange={() => {}} />);
		});
		expect(container.textContent).toContain("单聊");
	});
});
