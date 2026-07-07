import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelBindDialog } from "@/components/im/im-channel-bind-dialog";
import type { RuntimeImChat } from "@/runtime/types";

// The picker inside the dialog owns the palette query — mock it so no network is touched and
// the test can drive a manual add (which upserts + selects a draft binding).
const addChatMock = vi.fn();
let chatsMock: RuntimeImChat[] = [];
vi.mock("@/hooks/use-im-chats", () => ({
	useImChats: () => ({
		chats: chatsMock,
		isLoading: false,
		error: null,
		refresh: vi.fn(async () => {}),
		addChat: addChatMock,
	}),
}));

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ImChannelBindDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		addChatMock.mockReset();
		chatsMock = [];
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("binds a new channel picked via manual add from an unbound thread", async () => {
		addChatMock.mockResolvedValue({
			platform: "lark",
			chatId: "oc_new",
			displayName: "",
			source: "manual",
			createdAt: 1,
			updatedAt: 1,
		});
		const onBind = vi.fn(async () => {});
		await act(async () => {
			root.render(
				<ImChannelBindDialog
					open
					current={null}
					workspaceId="ws-1"
					onOpenChange={() => {}}
					onBind={onBind}
					onUnbind={vi.fn()}
				/>,
			);
			await flush();
		});

		// Open the picker's manual-add fallback and register a new id.
		const addToggle = Array.from(document.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("手动添加会话 ID"),
		);
		await act(async () => {
			addToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		const input = document.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		await act(async () => {
			setInputValue(input, "oc_new");
			await flush();
		});
		const addButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "添加");
		await act(async () => {
			addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});

		// Now the dialog's bind button commits the selected draft.
		const bindButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "绑定",
		);
		expect(bindButton).toBeTruthy();
		await act(async () => {
			bindButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onBind).toHaveBeenCalledWith({ platform: "lark", chatId: "oc_new" });
	});

	it("shows the current binding and unbinds it", async () => {
		const onUnbind = vi.fn(async () => {});
		await act(async () => {
			root.render(
				<ImChannelBindDialog
					open
					current={{ platform: "lark", chatId: "oc_existing" }}
					workspaceId="ws-1"
					onOpenChange={() => {}}
					onBind={vi.fn()}
					onUnbind={onUnbind}
				/>,
			);
			await flush();
		});
		expect(document.body.textContent).toContain("oc_existing");
		const unbindButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "解绑",
		);
		expect(unbindButton).toBeTruthy();
		await act(async () => {
			unbindButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onUnbind).toHaveBeenCalledWith();
	});

	it("shows the resolved display name for the bound channel when the palette knows it", async () => {
		chatsMock = [
			{
				platform: "lark",
				chatId: "oc_existing",
				displayName: "Technology.Result",
				source: "inbound",
				createdAt: 1,
				updatedAt: 1,
			},
		];
		await act(async () => {
			root.render(
				<ImChannelBindDialog
					open
					current={{ platform: "lark", chatId: "oc_existing" }}
					workspaceId="ws-1"
					onOpenChange={() => {}}
					onBind={vi.fn()}
					onUnbind={vi.fn()}
				/>,
			);
			await flush();
		});
		expect(document.body.textContent).toContain("Technology.Result");
		// The raw id is available as a hover title, not as visible text.
		expect(document.querySelector('[title="oc_existing"]')).not.toBeNull();
	});
});
