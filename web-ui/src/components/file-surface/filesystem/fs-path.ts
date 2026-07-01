// Pure helpers for repo-relative POSIX paths ("" denotes the repo root). Kept
// separate from Node's `path` (browser bundle) and shared by the tree + explorer.

/** Last path segment: "a/b/c.ts" → "c.ts"; "" → "". */
export function posixBaseName(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** Parent directory: "a/b/c.ts" → "a/b"; "a" → ""; "" → "". */
export function posixDirName(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? "" : trimmed.slice(0, slash);
}

/** Join a parent dir with a child name ("" parent → the bare name). */
export function posixJoin(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

/** True when `path` is `ancestor` itself or nested inside it. */
export function isPathInside(ancestor: string, path: string): boolean {
	return path === ancestor || path.startsWith(`${ancestor}/`);
}
