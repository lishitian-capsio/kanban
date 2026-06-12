// Managed-provider OAuth sign-in panel for Kanban's native agent (pi).
// Shows sign-in status, account id/expiry, the device-code flow for
// remote/headless sessions, and the sign-in button. Self-gates: renders
// nothing unless the configured provider is a managed OAuth provider.
// Reused by both KanbanSetupSection (onboarding carousel) and the Settings
// dialog's slim Account section.
import { Check, Copy } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { UseRuntimeSettingsKanbanControllerResult } from "@/hooks/use-runtime-settings-kanban-controller";
import { useCopyToClipboard } from "@/utils/react-use";

function formatExpiry(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return trimmed;
	}

	if (!Number.isNaN(Number(value))) {
		const ms = Number(trimmed) * 1000;
		const date = new Date(ms);
		if (!Number.isNaN(date.getTime())) {
			return date.toLocaleString();
		}
		return trimmed;
	}

	const parsed = new Date(trimmed);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toLocaleString();
	}

	return trimmed;
}

export function KanbanOauthSignInPanel({
	controller,
	controlsDisabled,
	onError,
	onSaved,
}: {
	controller: UseRuntimeSettingsKanbanControllerResult;
	controlsDisabled: boolean;
	onError?: (message: string | null) => void;
	onSaved?: () => void;
}): ReactElement | null {
	const [isDeviceCodeCopied, setIsDeviceCodeCopied] = useState(false);
	const deviceCodeCopiedResetTimerRef = useRef<number | null>(null);
	const [copiedDeviceCodeState, copyDeviceCode] = useCopyToClipboard();

	useEffect(() => {
		return () => {
			if (deviceCodeCopiedResetTimerRef.current !== null) {
				window.clearTimeout(deviceCodeCopiedResetTimerRef.current);
				deviceCodeCopiedResetTimerRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		setIsDeviceCodeCopied(false);
	}, [controller.deviceAuthInfo?.userCode]);

	useEffect(() => {
		if (!copiedDeviceCodeState.value || copiedDeviceCodeState.value !== controller.deviceAuthInfo?.userCode) {
			return;
		}
		if (copiedDeviceCodeState.error) {
			onError?.("Could not copy code automatically. Please copy it manually.");
			setIsDeviceCodeCopied(false);
			return;
		}
		onError?.(null);
		setIsDeviceCodeCopied(true);
		if (deviceCodeCopiedResetTimerRef.current !== null) {
			window.clearTimeout(deviceCodeCopiedResetTimerRef.current);
		}
		deviceCodeCopiedResetTimerRef.current = window.setTimeout(() => {
			setIsDeviceCodeCopied(false);
			deviceCodeCopiedResetTimerRef.current = null;
		}, 2000);
	}, [copiedDeviceCodeState, controller.deviceAuthInfo?.userCode, onError]);

	const handleOauthLogin = () => {
		void (async () => {
			onError?.(null);
			const result = await controller.runOauthLogin();
			if (!result.ok) {
				onError?.(result.message ?? "OAuth login failed.");
				return;
			}
			onSaved?.();
		})();
	};

	const handleCopyDeviceCode = (code: string) => {
		setIsDeviceCodeCopied(false);
		onError?.(null);
		copyDeviceCode(code);
	};

	if (!controller.isOauthProviderSelected) {
		return null;
	}

	return (
		<>
			<p className="text-text-secondary text-[12px] mt-1 mb-0">
				Status: {controller.oauthConfigured ? "Signed in" : "Not signed in"}
			</p>
			{controller.oauthAccountId ? (
				<p className="text-text-secondary text-[12px] mt-1 mb-0">
					Account ID: <span className="text-text-primary">{controller.oauthAccountId}</span>
				</p>
			) : null}
			{controller.oauthExpiresAt ? (
				<p className="text-text-secondary text-[12px] mt-1 mb-0">
					Expiry: <span className="text-text-primary">{formatExpiry(controller.oauthExpiresAt)}</span>
				</p>
			) : null}
			{controller.isRunningOauthLogin && controller.deviceAuthInfo ? (
				<div className="mt-2 rounded-md border border-border bg-surface-2 p-3">
					<p className="text-text-secondary text-[13px] font-medium mt-0 mb-2">Sign in to Kanban</p>
					<ol className="list-decimal pl-4 text-[12px] text-text-primary m-0">
						<li>
							Go to this URL:{" "}
							<a
								href={controller.deviceAuthInfo.verificationUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="break-all text-accent underline"
							>
								{controller.deviceAuthInfo.verificationUrl}
							</a>
						</li>
						<li className="mt-2">
							Enter this code:
							<div className="mt-1 flex items-center gap-2">
								<p className="text-text-primary text-[18px] font-mono font-bold tracking-wider m-0">
									{controller.deviceAuthInfo.userCode}
								</p>
								<Button
									variant="ghost"
									size="sm"
									icon={isDeviceCodeCopied ? <Check size={14} /> : <Copy size={14} />}
									onClick={() => {
										const userCode = controller.deviceAuthInfo?.userCode;
										if (!userCode) {
											return;
										}
										handleCopyDeviceCode(userCode);
									}}
									disabled={controlsDisabled || !controller.deviceAuthInfo}
								>
									{isDeviceCodeCopied ? "Copied" : "Copy"}
								</Button>
							</div>
						</li>
					</ol>
				</div>
			) : null}
			<div className="mt-2">
				<Button
					variant="default"
					size="sm"
					disabled={controlsDisabled || controller.isRunningOauthLogin}
					onClick={handleOauthLogin}
				>
					{controller.isRunningOauthLogin
						? controller.deviceAuthInfo
							? "Waiting for confirmation..."
							: "Signing in..."
						: controller.oauthConfigured
							? `Sign in again with ${controller.managedOauthProvider ?? "OAuth"}`
							: `Sign in with ${controller.managedOauthProvider ?? "OAuth"}`}
				</Button>
			</div>
		</>
	);
}
