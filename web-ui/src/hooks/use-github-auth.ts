// Orchestrates the Kanban-hosted GitHub git OAuth device flow for the Settings UI.
//
// The backend `github` tRPC router exposes a secret-free surface: `status` (who is
// signed in, token expiry), `beginLogin` (device-flow handshake → user code +
// verification URL), `pollLogin` (one poll per call), and `logout`. The OAuth token
// itself never crosses the wire. This hook owns the device-flow state machine and the
// polling lifecycle so the view component can stay presentational.
import { useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { beginGithubLogin, fetchGithubAuthStatus, logoutGithub, pollGithubLogin } from "@/runtime/runtime-config-query";
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

	// Refs keep the poll tick stable so changing it never resets the interval, and let
	// us detect cancellation of an in-flight poll.
	const deviceCodeRef = useRef<string | null>(null);
	const expiresAtRef = useRef<number>(0);
	const pollInFlightRef = useRef(false);
	const pollFailuresRef = useRef(0);

	const setDataRef = useRef(statusQuery.setData);
	setDataRef.current = statusQuery.setData;

	const login = useCallback(async () => {
		setFlow({ kind: "starting" });
		try {
			const grant = await beginGithubLogin(workspaceId);
			deviceCodeRef.current = grant.deviceCode;
			pollFailuresRef.current = 0;
			expiresAtRef.current = Date.now() + grant.expiresInSeconds * 1000;
			setPollDelayMs(Math.max(grant.intervalSeconds, MIN_POLL_INTERVAL_SECONDS) * 1000);
			setFlow({
				kind: "awaiting",
				prompt: {
					userCode: grant.userCode,
					verificationUri: grant.verificationUri,
					expiresAt: expiresAtRef.current,
				},
			});
		} catch (error) {
			log.warn("github.beginLogin failed", { error });
			deviceCodeRef.current = null;
			setFlow({ kind: "error", message: toMessage(error, "Could not reach GitHub to start sign-in.") });
		}
	}, [workspaceId]);

	const cancelLogin = useCallback(() => {
		deviceCodeRef.current = null;
		pollFailuresRef.current = 0;
		setFlow({ kind: "idle" });
	}, []);

	const pollTick = useCallback(async () => {
		const deviceCode = deviceCodeRef.current;
		if (deviceCode === null || pollInFlightRef.current) {
			return;
		}
		if (Date.now() > expiresAtRef.current) {
			deviceCodeRef.current = null;
			setFlow({ kind: "error", message: "The sign-in code expired. Start again to get a new code." });
			return;
		}
		pollInFlightRef.current = true;
		setIsPolling(true);
		try {
			const result = await pollGithubLogin(workspaceId, deviceCode);
			// A cancel / restart happened while this request was in flight — drop the result.
			if (deviceCodeRef.current !== deviceCode) {
				return;
			}
			// The backend answered (pending/complete/error all count) — clear the failure streak.
			pollFailuresRef.current = 0;
			if (result.state === "complete") {
				deviceCodeRef.current = null;
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
				deviceCodeRef.current = null;
				setFlow({ kind: "error", message: result.message });
			}
			// "pending" → keep polling on the next tick.
		} catch (error) {
			// A cancel / restart happened while this request was in flight — drop the failure
			// so it can't taint a freshly started (or cancelled) flow.
			if (deviceCodeRef.current !== deviceCode) {
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
				deviceCodeRef.current = null;
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

	// Stop polling if the component unmounts mid-flow.
	useEffect(
		() => () => {
			deviceCodeRef.current = null;
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
