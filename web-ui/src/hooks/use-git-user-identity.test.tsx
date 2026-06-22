import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseGitUserIdentityResult, useGitUserIdentity } from "@/hooks/use-git-user-identity";
import {
	dispatchRuntimeStreamAction,
	resetRuntimeStreamStoreForTest,
	useRuntimeBoardSyncStatus,
} from "@/runtime/runtime-stream-store";
import type { RuntimeBoardSyncStatus } from "@/runtime/types";

const getIdentityQueryMock = vi.fn();
const boardSyncStatus: RuntimeBoardSyncStatus = {
	state: "synced",
	decoupled: true,
	branch: "kanban/board",
	hasRemote: true,
	aheadCount: 0,
	behindCount: 0,
	autoSyncPaused: false,
	lastError: null,
	worktreePath: "/tmp/board",
};

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string) => ({
		workspace: {
			getGitUserIdentity: { query: () => getIdentityQueryMock(workspaceId) },
		},
	}),
}));

function flush() {
	return act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function HookHarness({
	workspaceId,
	renderTick,
	onSnapshot,
}: {
	workspaceId: string | null;
	renderTick: number;
	onSnapshot: (snapshot: UseGitUserIdentityResult) => void;
}): null {
	useRuntimeBoardSyncStatus();
	const snapshot = useGitUserIdentity(workspaceId);

	useEffect(() => {
		onSnapshot(snapshot);
	}, [onSnapshot, renderTick, snapshot]);

	return null;
}

describe("useGitUserIdentity", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		resetRuntimeStreamStoreForTest();
		getIdentityQueryMock.mockReset();
		getIdentityQueryMock.mockResolvedValue({ identity: { name: "Ada Lovelace", email: "ada@example.com" } });
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		resetRuntimeStreamStoreForTest();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("does not refetch the same workspace after query state updates or parent rerenders", async () => {
		const snapshots: UseGitUserIdentityResult[] = [];

		act(() => {
			root.render(
				<HookHarness
					workspaceId="workspace-1"
					renderTick={0}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
		});
		await flush();
		await flush();

		expect(getIdentityQueryMock).toHaveBeenCalledTimes(1);
		expect(getIdentityQueryMock).toHaveBeenLastCalledWith("workspace-1");
		expect(snapshots.at(-1)?.identity).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });

		act(() => {
			root.render(
				<HookHarness
					workspaceId="workspace-1"
					renderTick={1}
					onSnapshot={(snapshot) => snapshots.push(snapshot)}
				/>,
			);
		});
		await flush();

		expect(getIdentityQueryMock).toHaveBeenCalledTimes(1);
	});

	it("does not refetch when a colocated runtime stream subscription updates", async () => {
		act(() => {
			root.render(<HookHarness workspaceId="workspace-1" renderTick={0} onSnapshot={() => {}} />);
		});
		await flush();

		act(() => {
			dispatchRuntimeStreamAction({
				type: "board_sync_status_updated",
				payload: { type: "board_sync_status_updated", workspaceId: "workspace-1", status: boardSyncStatus },
			});
		});
		await flush();

		expect(getIdentityQueryMock).toHaveBeenCalledTimes(1);
	});

	it("fetches again when the workspace changes", async () => {
		act(() => {
			root.render(<HookHarness workspaceId="workspace-1" renderTick={0} onSnapshot={() => {}} />);
		});
		await flush();

		act(() => {
			root.render(<HookHarness workspaceId="workspace-2" renderTick={1} onSnapshot={() => {}} />);
		});
		await flush();

		expect(getIdentityQueryMock).toHaveBeenCalledTimes(2);
		expect(getIdentityQueryMock).toHaveBeenNthCalledWith(1, "workspace-1");
		expect(getIdentityQueryMock).toHaveBeenNthCalledWith(2, "workspace-2");
	});

	it("stays idle without a workspace", async () => {
		act(() => {
			root.render(<HookHarness workspaceId={null} renderTick={0} onSnapshot={() => {}} />);
		});
		await flush();

		expect(getIdentityQueryMock).not.toHaveBeenCalled();
	});
});
