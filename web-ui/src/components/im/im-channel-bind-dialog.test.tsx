import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelBindDialog } from "@/components/im/im-channel-bind-dialog";
import type { HomeThread } from "@/hooks/use-home-threads";

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeThread(overrides: Partial<HomeThread> = {}): HomeThread {
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ImChannelBindDialog", () => {
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

	it("binds a new channel from an unbound thread", async () => {
		const onBind = vi.fn(async () => {});
		await act(async () => {
			root.render(
				<ImChannelBindDialog thread={makeThread()} onOpenChange={() => {}} onBind={onBind} onUnbind={vi.fn()} />,
			);
			await flush();
		});
		const input = document.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		await act(async () => {
			setInputValue(input, "oc_new");
			await flush();
		});
		const bindButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "绑定",
		);
		expect(bindButton).toBeTruthy();
		await act(async () => {
			bindButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onBind).toHaveBeenCalledWith("thread-1", { platform: "lark", chatId: "oc_new" });
	});

	it("shows the current binding and unbinds it", async () => {
		const onUnbind = vi.fn(async () => {});
		await act(async () => {
			root.render(
				<ImChannelBindDialog
					thread={makeThread({ imChannel: { platform: "lark", chatId: "oc_existing" } })}
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
		expect(onUnbind).toHaveBeenCalledWith("thread-1");
	});
});
