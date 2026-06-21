import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitIdentitySetting } from "@/components/git-identity-setting";

const getIdentityQueryMock = vi.fn();
const setIdentityMutateMock = vi.fn();
const showAppToastMock = vi.fn();

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			getGitUserIdentity: { query: () => getIdentityQueryMock() },
			setGitUserIdentity: { mutate: (input: object) => setIdentityMutateMock(input) },
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: (props: object) => showAppToastMock(props),
}));

function flush() {
	return act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("GitIdentitySetting", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		getIdentityQueryMock.mockReset();
		setIdentityMutateMock.mockReset();
		showAppToastMock.mockReset();
		getIdentityQueryMock.mockResolvedValue({ identity: { name: "Ada Lovelace", email: "ada@example.com" } });
		setIdentityMutateMock.mockResolvedValue({ identity: { name: "Grace Hopper", email: "grace@example.com" } });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	async function render() {
		act(() => {
			root.render(<GitIdentitySetting workspaceId="workspace-1" />);
		});
		await flush();
	}

	function nameInput(): HTMLInputElement {
		return container.querySelector("#git-identity-name") as HTMLInputElement;
	}
	function emailInput(): HTMLInputElement {
		return container.querySelector("#git-identity-email") as HTMLInputElement;
	}
	function saveButton(): HTMLButtonElement {
		return Array.from(container.querySelectorAll("button")).find((b) =>
			(b.textContent ?? "").includes("Save"),
		) as HTMLButtonElement;
	}
	function setValue(input: HTMLInputElement, value: string) {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		act(() => {
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("prefills the current git identity and keeps Save disabled until edited", async () => {
		await render();
		expect(nameInput().value).toBe("Ada Lovelace");
		expect(emailInput().value).toBe("ada@example.com");
		expect(saveButton().disabled).toBe(true);
	});

	it("disables Save when the email is malformed", async () => {
		await render();
		setValue(emailInput(), "not-an-email");
		expect(saveButton().disabled).toBe(true);
		expect(container.textContent).toContain("Enter a valid email address.");
	});

	it("writes the trimmed identity and toasts on success", async () => {
		await render();
		setValue(nameInput(), "  Grace Hopper  ");
		setValue(emailInput(), "grace@example.com");
		expect(saveButton().disabled).toBe(false);
		await act(async () => {
			saveButton().click();
		});
		await flush();
		expect(setIdentityMutateMock).toHaveBeenCalledWith({ name: "Grace Hopper", email: "grace@example.com" });
		expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ intent: "success" }));
	});
});
