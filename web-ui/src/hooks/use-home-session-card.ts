// Supplies one Home-tab session card with its live signals.
//
// A card needs the thread's latest conversational line, which lives in two
// half-complete places: the runtime broadcast store (only messages seen since
// the socket connected) and the persisted transcript (everything up to a
// one-shot fetch). This hook unions them — a single history fetch on
// mount/taskId-change plus a live subscription — and derives the preview.
//
// The live subscription is intentionally read INSIDE the leaf card (via this
// hook), so a streaming token for one thread re-renders only that card, never
// the whole launcher (see the granular-store rule in the runtime store).
import { useEffect, useMemo, useState } from "react";

import {
	deriveHomeSessionCardPreview,
	type HomeSessionCardMessagePreview,
	mergeHomeSessionCardMessages,
} from "@/components/home-agent/home-session-card-derive";
import { useTaskChatMessages } from "@/runtime/runtime-stream-store";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskChatMessage } from "@/runtime/types";

export interface UseHomeSessionCardResult {
	/** Newest user/assistant line for the card body, or null if none yet. */
	preview: HomeSessionCardMessagePreview | null;
	/** True until the one-shot history fetch settles (controls the skeleton). */
	isLoadingHistory: boolean;
}

export function useHomeSessionCard(currentProjectId: string | null, taskId: string | null): UseHomeSessionCardResult {
	const [history, setHistory] = useState<RuntimeTaskChatMessage[] | null>(null);
	const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(Boolean(currentProjectId && taskId));
	const liveMessages = useTaskChatMessages(taskId);

	useEffect(() => {
		if (!currentProjectId || !taskId) {
			setHistory(null);
			setIsLoadingHistory(false);
			return;
		}
		let cancelled = false;
		setIsLoadingHistory(true);
		void getRuntimeTrpcClient(currentProjectId)
			.runtime.getTaskChatMessages.query({ taskId })
			.then((payload) => {
				if (cancelled) {
					return;
				}
				setHistory(payload.ok ? payload.messages : []);
			})
			.catch(() => {
				if (!cancelled) {
					// A transcript that can't be read yet (session never started, transient
					// boot failure) is not an error for the card — it simply has no preview.
					setHistory([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingHistory(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [currentProjectId, taskId]);

	const preview = useMemo(
		() => deriveHomeSessionCardPreview(mergeHomeSessionCardMessages(history, liveMessages)),
		[history, liveMessages],
	);

	return { preview, isLoadingHistory };
}
