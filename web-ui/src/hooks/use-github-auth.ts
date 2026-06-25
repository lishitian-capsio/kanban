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

	const setDataRef = useRef(statusQuery.setData);
	setDataRef.current = statusQuery.setData;

	const login = useCallback(async () => {
		setFlow({ kind: "starting" });
		try {
			const grant = await beginGithubLogin(workspaceId);
			deviceCodeRef.current = grant.deviceCode;
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
			// A transient network blip during a poll should not abort the whole flow —
			// log it and let the next tick retry while the code is still valid.
			log.warn("github.pollLogin failed", { error });
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
