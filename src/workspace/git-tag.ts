import type { RuntimeGitTagMutationResponse } from "../core/api-contract";
import { runGit } from "./git-utils";

/**
 * Local git tag management. Both operations run entirely against the local repo
 * via `runGit`; nothing is pushed here. Annotated tags created with a `vX.Y.Z`
 * name reach the remote only through the existing unified push
 * (`git push --follow-tags`), never a dedicated tag-push endpoint.
 *
 * Names are validated with `git check-ref-format` and an explicit leading-dash
 * guard (a `-`-prefixed name would otherwise be parsed as a `git tag` flag), so
 * a caller can never smuggle in extra arguments — `runGit` already passes argv
 * as an array (no shell), so there is no shell-injection surface.
 */

function rejectsAsArgument(value: string): boolean {
	// A leading dash would be parsed by git as an option, not a positional. This
	// is not caught by `check-ref-format` (`refs/tags/-x` is a valid ref name).
	return value.startsWith("-");
}

async function isValidTagName(cwd: string, name: string): Promise<boolean> {
	if (rejectsAsArgument(name)) {
		return false;
	}
	const result = await runGit(cwd, ["check-ref-format", `refs/tags/${name}`]);
	return result.ok;
}

export async function createGitTag(options: {
	cwd: string;
	name: string;
	commitish?: string | null;
	message?: string | null;
}): Promise<RuntimeGitTagMutationResponse> {
	const name = options.name.trim();
	if (!name) {
		return { ok: false, name, error: "Tag name cannot be empty." };
	}
	if (!(await isValidTagName(options.cwd, name))) {
		return { ok: false, name, error: `Invalid tag name: ${name}` };
	}

	const commitish = options.commitish?.trim() || null;
	if (commitish) {
		if (rejectsAsArgument(commitish)) {
			return { ok: false, name, error: `Invalid target: ${commitish}` };
		}
		const exists = await runGit(options.cwd, ["rev-parse", "--verify", "--quiet", `${commitish}^{commit}`]);
		if (!exists.ok) {
			return { ok: false, name, error: `Target commit not found: ${commitish}` };
		}
	}

	const message = options.message?.trim() || null;
	const args = ["tag"];
	if (message) {
		args.push("-a", "-m", message);
	}
	args.push(name);
	if (commitish) {
		args.push(commitish);
	}

	const result = await runGit(options.cwd, args);
	if (!result.ok) {
		return { ok: false, name, error: result.error ?? "Failed to create tag." };
	}
	return { ok: true, name };
}

export async function deleteGitTag(options: { cwd: string; name: string }): Promise<RuntimeGitTagMutationResponse> {
	const name = options.name.trim();
	if (!name) {
		return { ok: false, name, error: "Tag name cannot be empty." };
	}
	if (rejectsAsArgument(name)) {
		return { ok: false, name, error: `Invalid tag name: ${name}` };
	}

	const result = await runGit(options.cwd, ["tag", "-d", name]);
	if (!result.ok) {
		return { ok: false, name, error: result.error ?? "Failed to delete tag." };
	}
	return { ok: true, name };
}
