import { UserCog } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type GitIdentityDraft, useGitIdentityEditor } from "@/hooks/use-git-identity-editor";

/** Basic email shape check, kept in sync with the backend contract refinement. */
function isValidGitEmail(value: string): boolean {
	const trimmed = value.trim();
	return trimmed === "" || /^[^\s@]+@[^\s@]+$/.test(trimmed);
}

/**
 * The "Git identity" control in Settings → Project. Reads and edits the workspace
 * repo's real repo-local `git config user.name`/`user.email` — the author of every
 * commit this repo (and its task worktrees, which share `.git/config`) makes — via
 * `workspace.getGitUserIdentity` / `setGitUserIdentity`. Self-contained (owns its own
 * {@link useGitIdentityEditor}), mirroring {@link BoardBranchSetting}. Changing it
 * also moves the default owner stamped onto new tasks, since that default reads the
 * same git config.
 */
export function GitIdentitySetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const { identity, isLoading, isSaving, save } = useGitIdentityEditor(workspaceId);
	const [draft, setDraft] = useState<GitIdentityDraft | null>(null);

	const current: GitIdentityDraft = { name: identity?.name ?? "", email: identity?.email ?? "" };
	const value = draft ?? current;
	const trimmedName = value.name.trim();
	const trimmedEmail = value.email.trim();

	const emailValid = isValidGitEmail(value.email);
	const hasAtLeastOne = trimmedName.length > 0 || trimmedEmail.length > 0;
	const isDirty = value.name !== current.name || value.email !== current.email;
	const canSave = isDirty && hasAtLeastOne && emailValid && !isSaving;

	const update = (patch: Partial<GitIdentityDraft>) => {
		setDraft((previous) => ({ ...(previous ?? current), ...patch }));
	};

	const handleSave = async () => {
		if (!canSave) {
			return;
		}
		const result = await save({ name: trimmedName, email: trimmedEmail });
		if (result.ok) {
			setDraft(null);
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Git identity updated for this repository.",
				timeout: 4000,
			});
			return;
		}
		showAppToast({
			intent: "danger",
			icon: "error",
			message: result.error ?? "Could not update the git identity.",
			timeout: 6000,
		});
	};

	const inputClass =
		"h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60";

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<UserCog size={13} />
				Git identity
			</h6>
			{isLoading && identity === null ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : (
				<>
					<div className="grid grid-cols-2 gap-3">
						<div>
							<label htmlFor="git-identity-name" className="block text-[12px] text-text-secondary mb-1">
								Name
							</label>
							<input
								id="git-identity-name"
								value={value.name}
								onChange={(event) => update({ name: event.target.value })}
								placeholder="Ada Lovelace"
								spellCheck={false}
								disabled={isSaving}
								className={inputClass}
							/>
						</div>
						<div>
							<label htmlFor="git-identity-email" className="block text-[12px] text-text-secondary mb-1">
								Email
							</label>
							<input
								id="git-identity-email"
								value={value.email}
								onChange={(event) => update({ email: event.target.value })}
								placeholder="ada@example.com"
								spellCheck={false}
								disabled={isSaving}
								className={inputClass}
							/>
						</div>
					</div>
					{!emailValid ? (
						<p className="text-status-red text-[12px] mt-1.5 mb-0">Enter a valid email address.</p>
					) : isDirty && !hasAtLeastOne ? (
						<p className="text-status-red text-[12px] mt-1.5 mb-0">Provide a name or email.</p>
					) : null}
					<div className="flex items-center justify-between gap-2 mt-3">
						<p className="text-text-secondary text-[13px] m-0">
							Sets the real <span className="font-mono">git config</span> for this repository, so it authors all
							commits — task commits, board commits — and becomes the default owner of new tasks.
						</p>
						<Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave}>
							{isSaving ? (
								<>
									<Spinner size={12} />
									Saving…
								</>
							) : (
								"Save identity"
							)}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
