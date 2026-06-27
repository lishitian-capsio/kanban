import { AlertTriangle, ExternalLink, KeyRound, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useGiteeAuth } from "@/hooks/use-gitee-auth";

/**
 * Settings → Project "Gitee git auth" control. Manages the Kanban-hosted Gitee Personal Access
 * Token (PAT) used to authenticate HTTPS pushes (board sync, task PRs) to gitee.com. Reads/drives
 * the machine-global `gitee` tRPC router via {@link useGiteeAuth}: shows who is signed in, accepts
 * a pasted PAT (+ optional username), and signs out. Gitee has no OAuth device flow (cf0d6), so —
 * unlike {@link GithubAuthSetting} — this is a paste-token card, not a device-flow card. The PAT
 * is never exposed back; only the secret-free status crosses the wire.
 */
const inputClass =
	"h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60";

const GITEE_PAT_DOCS_URL = "https://gitee.com/profile/personal_access_tokens";

export function GiteeAuthSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const { status, statusLoading, statusError, isSaving, isLoggingOut, saveToken, logout, refreshStatus } =
		useGiteeAuth(workspaceId);

	const [token, setToken] = useState("");
	const [username, setUsername] = useState("");

	const firstLoad = statusLoading && status === null;
	const unreachable = statusError !== null && status === null;
	const authenticated = status?.authenticated ?? false;

	const handleSave = async () => {
		const ok = await saveToken({ token, username });
		if (ok) {
			setToken("");
			setUsername("");
		}
	};

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<KeyRound size={13} />
				Gitee git auth
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
						loggingOut={isLoggingOut}
						onLogout={() => void logout()}
					/>

					<div className="mt-3 rounded-md border border-border-bright bg-surface-1 p-3">
						<label htmlFor="gitee-pat" className="block text-[12px] text-text-secondary mb-1">
							{authenticated ? "Replace token" : "Personal access token"}
						</label>
						<input
							id="gitee-pat"
							type="password"
							value={token}
							onChange={(event) => setToken(event.target.value)}
							placeholder="Paste your Gitee PAT"
							spellCheck={false}
							autoComplete="off"
							disabled={isSaving}
							className={inputClass}
						/>
						<label htmlFor="gitee-username" className="block text-[12px] text-text-secondary mb-1 mt-2.5">
							Username <span className="text-text-tertiary">(recommended)</span>
						</label>
						<input
							id="gitee-username"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							placeholder="Your gitee.com username"
							spellCheck={false}
							autoComplete="off"
							disabled={isSaving}
							className={inputClass}
						/>
						<div className="mt-3 flex items-center justify-between gap-2">
							<a
								href={GITEE_PAT_DOCS_URL}
								target="_blank"
								rel="noreferrer noopener"
								className="inline-flex items-center gap-1 text-text-secondary text-[12px] hover:text-text-primary"
							>
								Generate a token on Gitee
								<ExternalLink size={12} />
							</a>
							<Button
								variant="primary"
								size="sm"
								icon={isSaving ? <Spinner size={12} /> : <KeyRound size={14} />}
								onClick={() => void handleSave()}
								disabled={isSaving || token.trim() === ""}
							>
								{isSaving ? "Saving…" : authenticated ? "Update token" : "Save token"}
							</Button>
						</div>
					</div>

					<p className="text-text-secondary text-[12px] mt-3 mb-0">
						Authenticates HTTPS pushes to <span className="font-mono">gitee.com</span> (board sync, task PRs). The
						token is stored locally on this machine and never committed. SSH and non-Gitee remotes are unaffected.
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
				<p className="text-text-primary text-[13px] m-0">Couldn't reach the Gitee auth service.</p>
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
	status: { authenticated: boolean; login: string | null; username: string | null } | null;
	degraded: boolean;
	loggingOut: boolean;
	onLogout: () => void;
}

function AuthStatusRow({ status, degraded, loggingOut, onLogout }: AuthStatusRowProps): React.ReactElement {
	const authenticated = status?.authenticated ?? false;
	const account = status?.login ?? status?.username ?? null;

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex min-w-0 items-center gap-2.5">
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
					<KeyRound size={16} />
				</div>
				<div className="min-w-0">
					{authenticated ? (
						<>
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium text-text-primary">
									{account ?? "Signed in"}
								</span>
								<span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-green/10 text-status-green">
									Signed in
								</span>
							</div>
							<p className="text-text-secondary text-[11px] mt-0.5 mb-0 truncate">
								Token stored locally on this machine.
							</p>
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
								Paste a Gitee token to push to private Gitee repositories over HTTPS.
							</p>
						</>
					)}
				</div>
			</div>

			{authenticated ? (
				<div className="shrink-0">
					<Button
						variant="ghost"
						size="sm"
						icon={loggingOut ? <Spinner size={12} /> : <LogOut size={13} />}
						onClick={onLogout}
						disabled={loggingOut}
					>
						Sign out
					</Button>
				</div>
			) : null}
		</div>
	);
}
