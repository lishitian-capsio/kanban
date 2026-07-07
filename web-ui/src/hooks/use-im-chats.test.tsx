import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UseImChatsResult, useImChats } from "@/hooks/use-im-chats";
import type { RuntimeImChat } from "@/runtime/types";

const listQuery = vi.fn();
const addMutate = vi.fn();

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			listImChats: { query: listQuery },
			addImChat: { mutate: addMutate },
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: vi.fn(),
}));

function chat(overrides: Partial<RuntimeImChat> = {}): RuntimeImChat {
	return {
		platform: "lark",
		chatId: "oc_1",
		displayName: "One",
		source: "manual",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Render the hook into a probe component so we can read its latest result.
function renderHook(workspaceId: string | null): { root: Root; latest: () => UseImChatsResult } {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let current: UseImChatsResult | null = null;
	function Probe({ ws }: { ws: string | null }) {
		current = useImChats(ws);
		return null;
	}
	act(() => root.render(<Probe ws={workspaceId} />));
	return {
		root,
		latest: () => {
			if (!current) {
				throw new Error("hook not rendered");
			}
			return current;
		},
	};
}

describe("useImChats", () => {
	beforeEach(() => {
		listQuery.mockReset();
		addMutate.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("loads the palette for the workspace", async () => {
		listQuery.mockResolvedValue({ ok: true, chats: [chat()] });
		const { root, latest } = renderHook("ws-1");
		await act(async () => {
			await flush();
		});
		expect(listQuery).toHaveBeenCalled();
		expect(latest().chats).toEqual([chat()]);
		act(() => root.unmount());
	});

	it("upserts a manually added chat to the front and dedupes by identity", async () => {
		listQuery.mockResolvedValue({ ok: true, chats: [chat({ chatId: "oc_old" })] });
		addMutate.mockResolvedValue({ ok: true, chat: chat({ chatId: "oc_new", displayName: "New" }) });
		const { root, latest } = renderHook("ws-1");
		await act(async () => {
			await flush();
		});

		await act(async () => {
			await latest().addChat({ platform: "lark", chatId: "oc_new" });
			await flush();
		});

		expect(addMutate).toHaveBeenCalledWith({ platform: "lark", chatId: "oc_new" });
		expect(latest().chats.map((c) => c.chatId)).toEqual(["oc_new", "oc_old"]);
		act(() => root.unmount());
	});

	it("surfaces a list error without clobbering an empty palette", async () => {
		listQuery.mockResolvedValue({ ok: false, chats: [], error: "boom" });
		const { root, latest } = renderHook("ws-1");
		await act(async () => {
			await flush();
		});
		expect(latest().error).toBe("boom");
		expect(latest().chats).toEqual([]);
		act(() => root.unmount());
	});
});
