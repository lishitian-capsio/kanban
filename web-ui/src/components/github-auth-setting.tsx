import { AlertTriangle, Check, Copy, ExternalLink, Github, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useGithubAuth } from "@/hooks/use-github-auth";
import { useCopyToClipboard } from "@/utils/react-use";

/**
 * Settings → Project "GitHub git auth" control. Manages the Kanban-hosted GitHub git
 * OAuth used to authenticate HTTPS pushes (board sync, task PRs). Reads/drives the
 * machine-global `github` tRPC router via {@link useGithubAuth}: shows who is signed in,
 * runs the device flow (user code + verification URL, polled to completion), and signs
 * out. The OAuth token is never exposed here — only the secret-free status crosses the
 * wire. Mirrors {@link GitRemoteSetting}: a self-contained card that owns its own hook.
 */
export function GithubAuthSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const {
		status,
		statusLoading,
		statusError,
		flow,
		isPolling,
		isLoggingOut,
		login,
		cancelLogin,
		logout,
		refreshStatus,
	} = useGithubAuth(workspaceId);

	const firstLoad = statusLoading && status === null;
	const unreachable = statusError !== null && status === null;

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<Github size={13} />
				GitHub git auth
			</h6>

			{firstLoad ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : unreachable ? (
				<UnreachableState onRetry={() => void refreshStatus()} loading={statusLoading} />
			) : (
				<>
					<AuthStatusRow
						status={status}
						degraded={statusError !== null}
						busy={flow.kind === "starting" || isLoggingOut}
						onLogin={() => void login()}
						onLogout={() => void logout()}
						loggingOut={isLoggingOut}
						starting={flow.kind === "starting"}
					/>

					{flow.kind === "awaiting" ? (
						<DeviceFlowPrompt
							userCode={flow.prompt.userCode}
							verificationUri={flow.prompt.verificationUri}
							expiresAt={flow.prompt.expiresAt}
							polling={isPolling}
							onCancel={cancelLogin}
						/>
					) : null}

					{flow.kind === "error" ? (
						<div className="mt-3 flex items-start gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-2.5">
							<AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-red" />
							<div className="min-w-0 flex-1">
								<p className="text-text-primary text-[13px] m-0">{flow.message}</p>
								<Button variant="ghost" size="sm" className="mt-1.5" onClick={() => void login()}>
									Try again
								</Button>
							</div>
						</div>
					) : null}

					<p className="text-text-secondary text-[12px] mt-3 mb-0">
						Authenticates HTTPS pushes to <span className="font-mono">github.com</span> (board sync, task PRs).
						The token is stored locally on this machine and never committed. SSH and non-GitHub remotes are
						unaffected.
					</p>
				</>
			)}
		</div>
	);
}

function UnreachableState({ onRetry, loading }: { onRetry: () => void; loading: boolean }): React.ReactElement {
	return (
		<div className="flex items-start gap-2 rounded-md border border-status-orange/30 bg-status-orange/5 p-2.5">
			<AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-orange" />
			<div className="min-w-0 flex-1">
				<p className="text-text-primary text-[13px] m-0">Couldn't reach the GitHub auth service.</p>
				<p className="text-text-secondary text-[12px] mt-0.5 mb-0">
					The runtime may be offline or restarting. Git pushes use your last saved credentials.
				</p>
				<Button
					variant="ghost"
					size="sm"
					className="mt-1.5"
					icon={loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
					onClick={onRetry}
					disabled={loading}
				>
					Retry
				</Button>
			</div>
		</div>
	);
}

interface AuthStatusRowProps {
	status: { authenticated: boolean; login: string | null; scope: string | null; expiresAt: number | null } | null;
	degraded: boolean;
	busy: boolean;
	starting: boolean;
	loggingOut: boolean;
	onLogin: () => void;
	onLogout: () => void;
}

function AuthStatusRow({
	status,
	degraded,
	busy,
	starting,
	loggingOut,
	onLogin,
	onLogout,
}: AuthStatusRowProps): React.ReactElement {
	const authenticated = status?.authenticated ?? false;

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex min-w-0 items-center gap-2.5">
				{authenticated && status?.login ? (
					<GithubAvatar login={status.login} />
				) : (
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
						<Github size={16} />
					</div>
				)}
				<div className="min-w-0">
					{authenticated ? (
						<>
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium text-text-primary">
									{status?.login ? `@${status.login}` : "Signed in"}
								</span>
								<span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-green/10 text-status-green">
									Signed in
								</span>
							</div>
							<TokenExpiryNote expiresAt={status?.expiresAt ?? null} scope={status?.scope ?? null} />
							{degraded ? (
								<p className="text-status-orange text-[11px] mt-0.5 mb-0">
									Couldn't refresh status — showing last known.
								</p>
							) : null}
						</>
					) : (
						<>
							<span className="text-[13px] font-medium text-text-primary">Not signed in</span>
							<p className="text-text-secondary text-[11px] mt-0.5 mb-0">
								Sign in to push to private GitHub repositories over HTTPS.
							</p>
						</>
					)}
				</div>
			</div>

			<div className="shrink-0">
				{authenticated ? (
					<Button
						variant="ghost"
						size="sm"
						icon={loggingOut ? <Spinner size={12} /> : <LogOut size={13} />}
						onClick={onLogout}
						disabled={loggingOut}
					>
						Sign out
					</Button>
				) : (
					<Button
						variant="primary"
						size="sm"
						icon={starting ? <Spinner size={12} /> : <Github size={14} />}
						onClick={onLogin}
						disabled={busy}
					>
						{starting ? "Starting…" : "Sign in"}
					</Button>
				)}
			</div>
		</div>
	);
}

function GithubAvatar({ login }: { login: string }): React.ReactElement {
	const [failed, setFailed] = useState(false);
	if (failed) {
		return (
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
				<Github size={16} />
			</div>
		);
	}
	return (
		// GitHub serves public avatars at github.com/<login>.png with no auth; degrade to
		// the generic icon if it can't load (offline / LAN).
		<img
			src={`https://github.com/${encodeURIComponent(login)}.png?size=64`}
			alt=""
			width={32}
			height={32}
			className="h-8 w-8 shrink-0 rounded-full bg-surface-2 object-cover"
			onError={() => setFailed(true)}
		/>
	);
}

function TokenExpiryNote({ expiresAt, scope }: { expiresAt: number | null; scope: string | null }): React.ReactElement {
	const scopeNote = scope && scope.trim() !== "" ? scope : null;

	if (expiresAt === null) {
		return (
			<p className="text-text-secondary text-[11px] mt-0.5 mb-0 truncate">
				Token doesn't expire{scopeNote ? ` · ${scopeNote}` : ""}
			</p>
		);
	}

	const remainingMs = expiresAt - Date.now();
	if (remainingMs <= 0) {
		return <p className="text-status-red text-[11px] mt-0.5 mb-0">Token expired — sign in again to refresh it.</p>;
	}

	return (
		<p className="text-text-secondary text-[11px] mt-0.5 mb-0 truncate">
			Token expires {formatRelativeFuture(remainingMs)}
			{scopeNote ? ` · ${scopeNote}` : ""}
		</p>
	);
}

interface DeviceFlowPromptProps {
	userCode: string;
	verificationUri: string;
	expiresAt: number;
	polling: boolean;
	onCancel: () => void;
}

function DeviceFlowPrompt({
	userCode,
	verificationUri,
	expiresAt,
	polling,
	onCancel,
}: DeviceFlowPromptProps): React.ReactElement {
	const [, copy] = useCopyToClipboard();
	const [copied, setCopied] = useState(false);

	const handleCopy = () => {
		copy(userCode);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	};

	const remainingMs = expiresAt - Date.now();

	return (
		<div className="mt-3 rounded-md border border-border-bright bg-surface-1 p-3">
			<p className="text-text-primary text-[13px] m-0 mb-2">
				<span className="font-semibold">1.</span> Copy this code, then <span className="font-semibold">2.</span>{" "}
				open GitHub and paste it to authorize.
			</p>

			<div className="flex items-center gap-2">
				<code className="select-all rounded-md border border-border bg-surface-2 px-3 py-1.5 font-mono text-[16px] tracking-[0.25em] text-text-primary">
					{userCode}
				</code>
				<Tooltip content={copied ? "Copied!" : "Copy code"}>
					<Button
						variant="ghost"
						size="sm"
						icon={copied ? <Check size={14} className="text-status-green" /> : <Copy size={14} />}
						onClick={handleCopy}
						aria-label="Copy code"
					/>
				</Tooltip>
				<a href={verificationUri} target="_blank" rel="noreferrer noopener" className="ml-auto">
					<Button variant="primary" size="sm" icon={<ExternalLink size={14} />}>
						Open GitHub
					</Button>
				</a>
			</div>

			<div className="mt-3 flex items-center justify-between gap-2">
				<span className="flex items-center gap-2 text-text-secondary text-[12px]">
					<Spinner size={12} />
					{polling ? "Checking authorization…" : "Waiting for you to authorize…"}
				</span>
				<div className="flex items-center gap-2">
					{remainingMs > 0 ? (
						<span className="text-text-tertiary text-[11px]">
							Code valid for {formatRelativeFuture(remainingMs)}
						</span>
					) : null}
					<Button variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
				</div>
			</div>
		</div>
	);
}

function formatRelativeFuture(ms: number): string {
	const totalMinutes = Math.round(ms / 60_000);
	if (totalMinutes < 1) {
		return "less than a minute";
	}
	if (totalMinutes === 1) {
		return "about a minute";
	}
	return `about ${totalMinutes} minutes`;
}
