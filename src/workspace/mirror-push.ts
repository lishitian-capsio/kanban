import type { RuntimeExtraPushRemote } from "../core/api-contract";
import { isLikelyGitRemoteUrl } from "./git-utils";

export interface MirrorPushResult {
	name: string;
	url: string;
	ok: boolean;
	error?: string;
}

export type MirrorPushOne = (
	remote: RuntimeExtraPushRemote,
	branch: string,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * Clean a raw list of extra push remotes coming from the settings UI: trim the
 * name and URL, drop entries with an empty name or a URL that does not look like
 * a git remote, and dedupe by URL (first occurrence wins). Pure and
 * side-effect-free so it can be unit-tested and reused at both the save and the
 * push paths.
 */
export function normalizeExtraPushRemotes(
	input: ReadonlyArray<{ name: string; url: string }>,
): RuntimeExtraPushRemote[] {
	const seen = new Set<string>();
	const out: RuntimeExtraPushRemote[] = [];
	for (const entry of input) {
		const name = entry.name.trim();
		const url = entry.url.trim();
		if (name === "" || !isLikelyGitRemoteUrl(url) || seen.has(url)) {
			continue;
		}
		seen.add(url);
		out.push({ name, url });
	}
	return out;
}

/**
 * Push `branch` to every configured mirror remote, in order, via the injected
 * `pushOne`. This is the mirror loop: a single remote that reports `ok: false`
 * or throws degrades to a failed {@link MirrorPushResult} for that remote only —
 * it never throws and never short-circuits the rest, so one unreachable mirror
 * can't block the others (or the primary push that already succeeded).
 */
export async function pushToMirrorRemotes(
	remotes: ReadonlyArray<RuntimeExtraPushRemote>,
	branch: string,
	pushOne: MirrorPushOne,
): Promise<MirrorPushResult[]> {
	const results: MirrorPushResult[] = [];
	for (const remote of remotes) {
		try {
			const outcome = await pushOne(remote, branch);
			results.push(
				outcome.ok
					? { name: remote.name, url: remote.url, ok: true }
					: { name: remote.name, url: remote.url, ok: false, error: outcome.error ?? "Push failed." },
			);
		} catch (error) {
			results.push({
				name: remote.name,
				url: remote.url,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

/**
 * Render a short, human-readable summary of mirror push results for the git-sync
 * `output` text. Returns an empty string when there were no mirror remotes so the
 * primary push output is unchanged when the feature is unused.
 */
export function formatMirrorPushOutput(results: ReadonlyArray<MirrorPushResult>): string {
	if (results.length === 0) {
		return "";
	}
	const succeeded = results.filter((result) => result.ok);
	const failed = results.filter((result) => !result.ok);
	const lines = [`Mirror push: ${succeeded.length}/${results.length} remote(s) succeeded.`];
	for (const result of succeeded) {
		lines.push(`  ✓ ${result.name} (${result.url})`);
	}
	for (const result of failed) {
		lines.push(`  ✗ ${result.name} (${result.url}): ${result.error ?? "Push failed."}`);
	}
	return lines.join("\n");
}
