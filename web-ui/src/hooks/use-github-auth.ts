// Orchestrates the Kanban-hosted GitHub git OAuth device flow for the Settings UI.
//
// The backend `github` tRPC router exposes a secret-free surface: `status` (who is
// signed in, token expiry), `beginLogin` (device-flow handshake → user code +
// verification URL), `pendingLogin` (the in-flight login to resume), `pollLogin` (one
// poll of the server-held login), `cancelLogin`, and `logout`. The OAuth token AND the
// device code never cross the wire. This hook owns the device-flow state machine and the
// polling lifecycle so the view component can stay presentational.
//
// **Refresh/disconnect resilience:** the device-flow pending state (device code, interval,
// expiry) is owned by the backend, not this component. On mount the hook queries
// `pendingLogin` and, if a non-expired login is in flight, resumes polling automatically.
// This is what stops the "GitHub says connected, Kanban says signed out" dead-end: a page
// refresh or a brief tRPC/ws disconnect used to discard the only copy of the device code
// and silently abandon the flow.
import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	beginGithubLogin,
	cancelGithubLogin,
	fetchGithubAuthStatus,
	fetchGithubPendingLogin,
	logoutGithub,
	pollGithubLogin,
} from "@/runtime/runtime-config-query";
import type { RuntimeGithubAuthStatus } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { createLogger } from "@/utils/logger";
import { useInterval } from "@/utils/react-use";

const log = createLogger("github-auth");

/** GitHub's device flow recommends a minimum poll interval; never poll faster than this. */
const MIN_POLL_INTERVAL_SECONDS = 5;

/**
 * How many *consecutive* failed polls to tolerate before surfacing an error. A single
 * blip (transient network hiccup, a momentary proxy stall) should not abort a flow that
 * is otherwise healthy, but a sustained failure must become visible — silently retrying
 * forever is the bug this guards against (the UI would spin on "Checking authorization…"
 * indefinitely, indistinguishable from a still-pending authorization).
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** What the user needs in order to complete the device flow in their browser. */
export interface GithubLoginPrompt {
	userCode: string;
	verificationUri: string;
	/** Epoch ms when the device/user code pair expires. */
	expiresAt: number;
}

export type GithubAuthFlow =
	| { kind: "idle" }
	/** `beginLogin` is in flight. */
	| { kind: "starting" }
	/** Showing the code; polling the backend until the user authorizes in the browser. */
	| { kind: "awaiting"; prompt: GithubLoginPrompt }
	/** The device flow failed or the code expired; carries a user-facing message. */
	| { kind: "error"; message: string };

export interface UseGithubAuthResult {
	/** Latest known auth status, or null before the first load completes. */
	status: RuntimeGithubAuthStatus | null;
	statusLoading: boolean;
	/** Set when the status query cannot reach the runtime (degraded / unreachable). */
	statusError: Error | null;
	flow: GithubAuthFlow;
	/** True while a single poll request is in flight (for a subtle spinner). */
	isPolling: boolean;
	isLoggingOut: boolean;
	login: () => Promise<void>;
	cancelLogin: () => void;
	logout: () => Promise<void>;
	refreshStatus: () => Promise<void>;
}

function toMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return fallback;
}

export function useGithubAuth(workspaceId: string | null): UseGithubAuthResult {
	const queryFn = useCallback(() => fetchGithubAuthStatus(workspaceId), [workspaceId]);
	const statusQuery = useTrpcQuery<RuntimeGithubAuthStatus>({
		enabled: true,
		queryFn,
		// Keep the last good status visible if a later refresh hits a transient failure,
		// rather than blanking the panel.
		retainDataOnError: true,
	});

	const [flow, setFlow] = useState<GithubAuthFlow>({ kind: "idle" });
	const [pollDelayMs, setPollDelayMs] = useState(MIN_POLL_INTERVAL_SECONDS * 1000);
	const [isPolling, setIsPolling] = useState(false);
	const [isLoggingOut, setIsLoggingOut] = useState(false);

	// A monotonic "flow generation": every state-machine transition (start, cancel, resume,
	// terminal) bumps it. A poll request captures the generation at dispatch and drops its
	// result if the generation changed while it was in flight (cancel/restart raced the
	// request). It replaces the old device-code-identity guard now that the device code lives
	// server-side.
	const generationRef = useRef(0);
	// Client-side expiry guard (the backend also enforces expiry) so a dead code stops polling
	// without a pointless round-trip.
	const expiresAtRef = useRef<number>(0);
	const pollInFlightRef = useRef(false);
	const pollFailuresRef = useRef(0);
	// Mirror of the current flow kind, read by the resume effect without depending on `flow`.
	const flowKindRef = useRef<GithubAuthFlow["kind"]>("idle");
	useEffect(() => {
		flowKindRef.current = flow.kind;
	}, [flow.kind]);

	const setDataRef = useRef(statusQuery.setData);
	setDataRef.current = statusQuery.setData;

	// Enter the awaiting state for a prompt, starting a fresh poll generation.
	const enterAwaiting = useCallback((prompt: GithubLoginPrompt, intervalSeconds: number) => {
		generationRef.current += 1;
		pollFailuresRef.current = 0;
		expiresAtRef.current = prompt.expiresAt;
		setPollDelayMs(Math.max(intervalSeconds, MIN_POLL_INTERVAL_SECONDS) * 1000);
		setFlow({ kind: "awaiting", prompt });
	}, []);

	const login = useCallback(async () => {
		generationRef.current += 1; // invalidate any in-flight poll from a prior flow
		setFlow({ kind: "starting" });
		try {
			const prompt = await beginGithubLogin(workspaceId);
			enterAwaiting(
				{ userCode: prompt.userCode, verificationUri: prompt.verificationUri, expiresAt: prompt.expiresAt },
				prompt.intervalSeconds,
			);
		} catch (error) {
			log.warn("github.beginLogin failed", { error });
			generationRef.current += 1;
			setFlow({ kind: "error", message: toMessage(error, "Could not reach GitHub to start sign-in.") });
		}
	}, [workspaceId, enterAwaiting]);

	const cancelLogin = useCallback(() => {
		generationRef.current += 1;
		pollFailuresRef.current = 0;
		setFlow({ kind: "idle" });
		// Best-effort: clear the server-held pending login so it can't be resumed later.
		void cancelGithubLogin(workspaceId).catch((error) => log.warn("github.cancelLogin failed", { error }));
	}, [workspaceId]);

	const pollTick = useCallback(async () => {
		if (pollInFlightRef.current) {
			return;
		}
		if (Date.now() > expiresAtRef.current) {
			generationRef.current += 1;
			setFlow({ kind: "error", message: "The sign-in code expired. Start again to get a new code." });
			return;
		}
		const generation = generationRef.current;
		pollInFlightRef.current = true;
		setIsPolling(true);
		try {
			const result = await pollGithubLogin(workspaceId);
			// A cancel / restart happened while this request was in flight — drop the result.
			if (generationRef.current !== generation) {
				return;
			}
			// The backend answered (pending/complete/error/idle all count) — clear the streak.
			pollFailuresRef.current = 0;
			if (result.state === "complete") {
				generationRef.current += 1;
				setDataRef.current(result.status);
				setFlow({ kind: "idle" });
				showAppToast({
					intent: "success",
					icon: "tick",
					message: result.status.login
						? `Signed in to GitHub as @${result.status.login}.`
						: "Signed in to GitHub.",
					timeout: 4000,
				});
			} else if (result.state === "error") {
				generationRef.current += 1;
				setFlow({ kind: "error", message: result.message });
			} else if (result.state === "idle") {
				// The server has no pending login (completed/cancelled elsewhere) — reset quietly.
				generationRef.current += 1;
				setFlow({ kind: "idle" });
			}
			// "pending" → keep polling on the next tick.
		} catch (error) {
			// A cancel / restart happened while this request was in flight — drop the failure
			// so it can't taint a freshly started (or cancelled) flow.
			if (generationRef.current !== generation) {
				return;
			}
			pollFailuresRef.current += 1;
			if (pollFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
				// Sustained failure: stop the silent retry and make it visible so the user can
				// act (check network/proxy, retry) instead of watching an endless spinner.
				log.warn("github.pollLogin failed repeatedly; surfacing error", {
					error,
					failures: pollFailuresRef.current,
				});
				generationRef.current += 1;
				pollFailuresRef.current = 0;
				setFlow({
					kind: "error",
					message: toMessage(
						error,
						"Lost contact with GitHub while waiting for authorization. Check your network or proxy and try again.",
					),
				});
			} else {
				// A transient blip should not abort an otherwise healthy flow — let the next
				// tick retry while the code is still valid.
				log.warn("github.pollLogin failed; will retry", { error, failures: pollFailuresRef.current });
			}
		} finally {
			pollInFlightRef.current = false;
			setIsPolling(false);
		}
	}, [workspaceId]);

	useInterval(
		() => {
			void pollTick();
		},
		flow.kind === "awaiting" ? pollDelayMs : null,
	);

	// Resume an in-flight login started before a refresh / brief disconnect. The backend owns
	// the device code, so the only thing lost on reload is this component's view of the flow —
	// re-fetch it and pick polling back up so an authorization that lands in this window still
	// completes. Only resumes from idle: never clobber a flow the user just (re)started.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const { pending } = await fetchGithubPendingLogin(workspaceId);
				if (cancelled || !pending || flowKindRef.current !== "idle") {
					return;
				}
				enterAwaiting(
					{
						userCode: pending.userCode,
						verificationUri: pending.verificationUri,
						expiresAt: pending.expiresAt,
					},
					pending.intervalSeconds,
				);
			} catch (error) {
				log.warn("github.pendingLogin resume check failed", { error });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId, enterAwaiting]);

	const logout = useCallback(async () => {
		setIsLoggingOut(true);
		try {
			const response = await logoutGithub(workspaceId);
			setDataRef.current(response.status);
			setFlow({ kind: "idle" });
			showAppToast({ intent: "success", icon: "tick", message: "Signed out of GitHub.", timeout: 4000 });
		} catch (error) {
			log.warn("github.logout failed", { error });
			showAppToast({
				intent: "danger",
				icon: "error",
				message: toMessage(error, "Could not sign out of GitHub."),
				timeout: 6000,
			});
		} finally {
			setIsLoggingOut(false);
		}
	}, [workspaceId]);

	const refetchRef = useRef(statusQuery.refetch);
	refetchRef.current = statusQuery.refetch;
	const refreshStatus = useCallback(async () => {
		await refetchRef.current();
	}, []);

	// Drop any in-flight poll's state update if the component unmounts mid-flow.
	useEffect(
		() => () => {
			generationRef.current += 1;
		},
		[],
	);

	return {
		status: statusQuery.data,
		statusLoading: statusQuery.isLoading,
		statusError: statusQuery.isError ? statusQuery.error : null,
		flow,
		isPolling,
		isLoggingOut,
		login,
		cancelLogin,
		logout,
		refreshStatus,
	};
}
