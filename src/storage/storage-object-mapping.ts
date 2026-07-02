// src/storage/storage-object-mapping.ts
import type { S3ListObjectsResponse } from "bun";

export interface StorageEntry {
	key: string;
	name: string;
	kind: "prefix" | "object";
	size?: number;
	lastModified?: string;
	etag?: string;
}

/**
 * Extension allowlist that overrides mime-db (fixes `.ts` → `video/mp2t`).
 * Keep in sync with workspace-fs-api.ts TEXT_EXTENSIONS.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonc",
	"json5",
	"css",
	"scss",
	"sass",
	"less",
	"html",
	"htm",
	"xml",
	"svg",
	"vue",
	"svelte",
	"astro",
	"md",
	"markdown",
	"mdx",
	"txt",
	"text",
	"log",
	"csv",
	"tsv",
	"rst",
	"adoc",
	"yml",
	"yaml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"properties",
	"editorconfig",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"cmd",
	"py",
	"pyi",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"kts",
	"c",
	"h",
	"cpp",
	"cc",
	"cxx",
	"hpp",
	"hh",
	"cs",
	"php",
	"lua",
	"sql",
	"graphql",
	"gql",
	"r",
	"swift",
	"m",
	"mm",
	"pl",
	"pm",
	"dart",
	"ex",
	"exs",
	"erl",
	"hs",
	"clj",
	"cljs",
	"scala",
	"groovy",
	"tf",
	"hcl",
	"proto",
	"prisma",
	"gradle",
	"cmake",
	"make",
	"mk",
	"patch",
	"diff",
	"lock",
	"gitignore",
	"gitattributes",
	"dockerignore",
	"npmrc",
	"nvmrc",
	"browserslistrc",
	"prettierrc",
	"eslintrc",
	"babelrc",
]);

/** Last non-empty `/`-delimited segment; tolerates a single trailing slash (prefix keys). */
export function basename(key: string): string {
	const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function extensionOf(key: string): string {
	const name = basename(key);
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isTextKey(key: string): boolean {
	return TEXT_EXTENSIONS.has(extensionOf(key));
}

/**
 * Decide binary-ness: a NUL byte in the head is always binary; otherwise a text-ish content-type
 * OR a known text extension ⇒ text. Mirrors the fs sniffing contract.
 */
export function classifyContent(bytes: Uint8Array, contentType: string, key: string): { binary: boolean } {
	const head = bytes.subarray(0, 8192);
	for (const b of head) {
		if (b === 0) {
			return { binary: true };
		}
	}
	const type = contentType.toLowerCase();
	const looksTextByType = type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("javascript");
	return { binary: !(looksTextByType || isTextKey(key)) };
}

/** Convert a Bun `list()` response (delimiter "/") into ordered entries: folders first, then objects. */
export function mapListResponse(
	prefix: string,
	res: S3ListObjectsResponse,
): { entries: StorageEntry[]; isTruncated: boolean; nextContinuationToken?: string } {
	const prefixes: StorageEntry[] = (res.commonPrefixes ?? []).map((cp) => ({
		key: cp.prefix,
		name: basename(cp.prefix),
		kind: "prefix" as const,
	}));
	const objects: StorageEntry[] = (res.contents ?? [])
		// S3 returns a zero-byte placeholder object for the folder itself; drop it.
		.filter((c) => c.key !== prefix)
		.map((c) => ({
			key: c.key,
			name: basename(c.key),
			kind: "object" as const,
			size: c.size,
			lastModified: c.lastModified,
			etag: c.eTag,
		}));
	return {
		entries: [...prefixes, ...objects],
		isTruncated: res.isTruncated === true,
		nextContinuationToken: res.nextContinuationToken,
	};
}
