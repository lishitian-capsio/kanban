import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelPicker } from "@/components/im/im-channel-picker";
import type { RuntimeImChat } from "@/runtime/types";

// The picker owns the palette query — mock the hook so the test drives the list + addChat.
const addChatMock = vi.fn();
let mockChats: RuntimeImChat[] = [];
vi.mock("@/hooks/use-im-chats", () => ({
	useImChats: () => ({
		chats: mockChats,
		isLoading: false,
		error: null,
		refresh: vi.fn(async () => {}),
		addChat: addChatMock,
	}),
}));

function chat(overrides: Partial<RuntimeImChat> = {}): RuntimeImChat {
	return {
		platform: "lark",
		chatId: "oc_group1",
		displayName: "Group One",
		source: "manual",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ImChannelPicker", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockChats = [];
		addChatMock.mockReset();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("shows the unbound state and offers a manual-add fallback", () => {
		mockChats = [chat(), chat({ chatId: "cid_1", displayName: "DingGroup", platform: "dingtalk" })];
		act(() => {
			root.render(<ImChannelPicker value={null} onChange={() => {}} workspaceId="ws-1" />);
		});
		// Unbound → the select trigger reads "不绑定"; the manual-add escape hatch is present.
		expect(container.textContent).toContain("不绑定");
		expect(container.textContent).toContain("手动添加会话 ID");
	});

	it("adds a manual id via addChat and emits the resulting target", async () => {
		addChatMock.mockResolvedValue(chat({ chatId: "oc_new", displayName: "" }));
		const onChange = vi.fn();
		act(() => {
			root.render(<ImChannelPicker value={null} onChange={onChange} workspaceId="ws-1" />);
		});
		// Open the manual-add fallback.
		const addToggle = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("手动添加会话 ID"),
		);
		expect(addToggle).toBeTruthy();
		act(() => addToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

		const input = container.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		expect(input).not.toBeNull();
		act(() => setInputValue(input, "oc_new"));

		const addButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "添加");
		await act(async () => {
			addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});

		expect(addChatMock).toHaveBeenCalledWith({ platform: "lark", chatId: "oc_new" });
		expect(onChange).toHaveBeenLastCalledWith({ platform: "lark", chatId: "oc_new" });
	});

	it("does not emit when the manual add fails", async () => {
		addChatMock.mockResolvedValue(null);
		const onChange = vi.fn();
		act(() => {
			root.render(<ImChannelPicker value={null} onChange={onChange} workspaceId="ws-1" />);
		});
		const addToggle = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("手动添加会话 ID"),
		);
		act(() => addToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const input = container.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		act(() => setInputValue(input, "oc_bad"));
		const addButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "添加");
		await act(async () => {
			addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(addChatMock).toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});
});
