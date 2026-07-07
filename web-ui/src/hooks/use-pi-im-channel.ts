// Owns the IM-channel binding for the workspace's single embedded Pi conversation
// (decision X1, requirement ac99c). Pi is not a home thread, so its binding is a
// doc-level field reached through the dedicated `runtime.{get,bind,unbind}PiImChannel`
// endpoints rather than the thread `imChannel` endpoints. This is the Pi analogue of the
// per-thread binding actions in `use-home-threads`, kept self-contained so it can live in
// the `PiConversationSurface` leaf without dragging in the whole thread registry.

import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import type { ImChannelTarget } from "@/components/im/im-channel";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export interface UsePiImChannelResult {
	/** The IM channel Pi is bound to for this workspace, or `null` when unbound. */
	imChannel: ImChannelTarget | null;
	isLoading: boolean;
	/** Re-fetch the current binding. */
	refresh: () => Promise<void>;
	/** Bind Pi to a channel (moving it off any thread that held it). Returns success. */
	bind: (channel: ImChannelTarget) => Promise<boolean>;
	/** Remove Pi's binding. Returns success. */
	unbind: () => Promise<boolean>;
}

export function usePiImChannel(workspaceId: string | null): UsePiImChannelResult {
	const [imChannel, setImChannel] = useState<ImChannelTarget | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	// Track which workspace the current binding belongs to so a workspace switch clears the
	// stale value immediately instead of flashing the previous workspace's binding.
	const loadedWorkspaceRef = useRef<string | null>(null);

	const load = useCallback(async (targetWorkspaceId: string) => {
		setIsLoading(true);
		try {
			const response = await getRuntimeTrpcClient(targetWorkspaceId).runtime.getPiImChannel.query();
			if (!response.ok) {
				throw new Error(response.error ?? "Could not load the Pi IM binding.");
			}
			loadedWorkspaceRef.current = targetWorkspaceId;
			setImChannel(response.imChannel);
		} catch (caught) {
			// Keep the last good value visible; a read failure should not clear the chip.
			notifyError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!workspaceId) {
			setImChannel(null);
			loadedWorkspaceRef.current = null;
			return;
		}
		if (loadedWorkspaceRef.current !== workspaceId) {
			setImChannel(null);
		}
		void load(workspaceId);
	}, [workspaceId, load]);

	const refresh = useCallback(async () => {
		if (workspaceId) {
			await load(workspaceId);
		}
	}, [workspaceId, load]);

	const bind = useCallback(
		async (channel: ImChannelTarget): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			try {
				const response = await getRuntimeTrpcClient(workspaceId).runtime.bindPiImChannel.mutate({ channel });
				if (!response.ok) {
					throw new Error(response.error ?? "Could not bind the Pi IM channel.");
				}
				setImChannel(response.imChannel);
				return true;
			} catch (caught) {
				notifyError(caught instanceof Error ? caught.message : String(caught));
				return false;
			}
		},
		[workspaceId],
	);

	const unbind = useCallback(async (): Promise<boolean> => {
		if (!workspaceId) {
			return false;
		}
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.unbindPiImChannel.mutate();
			if (!response.ok) {
				throw new Error(response.error ?? "Could not unbind the Pi IM channel.");
			}
			setImChannel(null);
			return true;
		} catch (caught) {
			notifyError(caught instanceof Error ? caught.message : String(caught));
			return false;
		}
	}, [workspaceId]);

	return { imChannel, isLoading, refresh, bind, unbind };
}
