import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChatListPanel } from "@/components/im/im-chat-list-panel";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeImChat } from "@/runtime/types";

// The panel owns the palette query — mock the hook so the test drives the list + mutations.
const addChatMock = vi.fn();
const removeChatMock = vi.fn();
let mockChats: RuntimeImChat[] = [];
vi.mock("@/hooks/use-im-chats", () => ({
	useImChats: () => ({
		chats: mockChats,
		isLoading: false,
		error: null,
		refresh: vi.fn(async () => {}),
		addChat: addChatMock,
		removeChat: removeChatMock,
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

function thread(overrides: Partial<HomeThread> = {}): HomeThread {
	return {
		id: "thread-1",
		agentId: "claude",
		name: "Thread 1",
		titleSource: "manual",
		createdAt: 1,
		updatedAt: 1,
		isDefault: false,
		...overrides,
	};
}

const AGENTS: RuntimeAgentDefinition[] = [
	{ id: "claude", label: "Claude" } as RuntimeAgentDefinition,
	{ id: "codex", label: "Codex" } as RuntimeAgentDefinition,
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function findButtonByAriaLabel(label: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label) as
		| HTMLButtonElement
		| undefined;
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as
		| HTMLButtonElement
		| undefined;
}

describe("ImChatListPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockChats = [];
		addChatMock.mockReset();
		removeChatMock.mockReset();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	function render(props: Partial<React.ComponentProps<typeof ImChatListPanel>> = {}) {
		act(() => {
			root.render(
				<ImChatListPanel
					workspaceId="ws-1"
					threads={props.threads ?? []}
					agents={AGENTS}
					onBindChannel={props.onBindChannel ?? vi.fn()}
					onUnbindChannel={props.onUnbindChannel ?? vi.fn()}
				/>,
			);
		});
	}

	it("shows an unbound chat with its name and platform label", () => {
		mockChats = [chat()];
		render({ threads: [] });
		expect(container.textContent).toContain("Group One");
		expect(container.textContent).toContain("飞书");
		expect(container.textContent).toContain("未绑定");
	});

	it("shows the bound thread for a bound chat", () => {
		mockChats = [chat()];
		render({ threads: [thread({ imChannel: { platform: "lark", chatId: "oc_group1" }, name: "Ops" })] });
		expect(container.textContent).toContain("已绑定 → Ops");
		expect(container.textContent).not.toContain("未绑定");
	});

	it("unbinds a bound chat via its bound thread id", () => {
		mockChats = [chat()];
		const onUnbindChannel = vi.fn();
		render({
			threads: [thread({ id: "t-ops", imChannel: { platform: "lark", chatId: "oc_group1" }, name: "Ops" })],
			onUnbindChannel,
		});
		act(() => findButtonByAriaLabel("解绑")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onUnbindChannel).toHaveBeenCalledWith("t-ops");
	});

	it("removes a chat from the palette", () => {
		mockChats = [chat({ chatId: "oc_x", displayName: "X" })];
		render({ threads: [] });
		act(() => findButtonByAriaLabel("移除")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(removeChatMock).toHaveBeenCalledWith("lark", "oc_x");
	});

	it("binds an unbound chat to a selected thread", async () => {
		mockChats = [chat()];
		const onBindChannel = vi.fn(async () => {});
		render({ threads: [thread({ id: "t-1", name: "Thread 1" })], onBindChannel });

		// Open the bind dialog.
		act(() => findButtonByAriaLabel("绑定到会话")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		// Pick the thread from the dialog list.
		const threadButton = Array.from(document.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Thread 1"),
		);
		act(() => threadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

		// Unbound → the confirm reads "绑定到此会话".
		const confirm = findButtonByText("绑定到此会话");
		expect(confirm).toBeTruthy();
		await act(async () => {
			confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onBindChannel).toHaveBeenCalledWith("t-1", { platform: "lark", chatId: "oc_group1" });
	});

	it("switches a bound chat to another thread with a confirmation warning", async () => {
		mockChats = [chat()];
		const onBindChannel = vi.fn(async () => {});
		render({
			threads: [
				thread({ id: "t-a", name: "Alpha", imChannel: { platform: "lark", chatId: "oc_group1" } }),
				thread({ id: "t-b", name: "Beta", agentId: "codex" }),
			],
			onBindChannel,
		});

		// The chat is bound to Alpha → the row action is the switch entrypoint.
		act(() => findButtonByAriaLabel("切换绑定的会话")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		// The dialog knows the current binding.
		expect(document.body.textContent).toContain("当前已绑定");

		// Select the OTHER thread → the action becomes a switch + shows the unbind warning.
		const betaButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Beta"));
		act(() => betaButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(document.body.textContent).toContain("将从会话『Alpha』解绑");

		const confirm = findButtonByText("切换到此会话");
		expect(confirm).toBeTruthy();
		await act(async () => {
			confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onBindChannel).toHaveBeenCalledWith("t-b", { platform: "lark", chatId: "oc_group1" });
	});

	it("adds a chat id to the palette via the inline add form", async () => {
		addChatMock.mockResolvedValue(chat({ chatId: "oc_new", displayName: "" }));
		render({ threads: [] });

		act(() => findButtonByText("添加会话 ID")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const input = document.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		act(() => {
			setter?.call(input, "oc_new");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			findButtonByText("添加")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(addChatMock).toHaveBeenCalledWith({ platform: "lark", chatId: "oc_new" });
	});
});
