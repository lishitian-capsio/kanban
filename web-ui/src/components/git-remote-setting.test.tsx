import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitRemoteSetting } from "@/components/git-remote-setting";

const getRemoteQueryMock = vi.fn();
const setRemoteMutateMock = vi.fn();
const showAppToastMock = vi.fn();

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			getGitRemote: { query: () => getRemoteQueryMock() },
			setGitRemote: { mutate: (input: object) => setRemoteMutateMock(input) },
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

describe("GitRemoteSetting", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		getRemoteQueryMock.mockReset();
		setRemoteMutateMock.mockReset();
		showAppToastMock.mockReset();
		getRemoteQueryMock.mockResolvedValue({ url: "https://github.com/owner/repo.git" });
		setRemoteMutateMock.mockResolvedValue({ url: "git@github.com:owner/repo.git" });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	async function render() {
		act(() => {
			root.render(<GitRemoteSetting workspaceId="workspace-1" />);
		});
		await flush();
	}

	function urlInput(): HTMLInputElement {
		return container.querySelector("#git-remote-url") as HTMLInputElement;
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

	it("prefills the current origin url and keeps Save disabled until edited", async () => {
		await render();
		expect(urlInput().value).toBe("https://github.com/owner/repo.git");
		expect(saveButton().disabled).toBe(true);
	});

	it("shows an empty state and keeps Save disabled when no origin is configured", async () => {
		getRemoteQueryMock.mockResolvedValue({ url: null });
		await render();
		expect(urlInput().value).toBe("");
		expect(saveButton().disabled).toBe(true);
	});

	it("disables Save when the url is malformed", async () => {
		await render();
		setValue(urlInput(), "not a url");
		expect(saveButton().disabled).toBe(true);
		expect(container.textContent).toContain("Enter a valid git remote URL.");
	});

	it("writes the trimmed url and toasts on success", async () => {
		getRemoteQueryMock.mockResolvedValue({ url: null });
		await render();
		setValue(urlInput(), "  git@github.com:owner/repo.git  ");
		expect(saveButton().disabled).toBe(false);
		await act(async () => {
			saveButton().click();
		});
		await flush();
		expect(setRemoteMutateMock).toHaveBeenCalledWith({ url: "git@github.com:owner/repo.git" });
		expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ intent: "success" }));
	});
});
