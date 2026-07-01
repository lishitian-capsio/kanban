import type { Extension } from "@codemirror/state";

/**
 * How the right-hand viewer should render a given file. Decided from the file
 * name + the backend's authoritative `binary` flag (see `workspaceFs.readFile`).
 */
export type FsViewerKind = "markdown" | "code" | "image" | "audio" | "video" | "binary";

// A thunk that dynamically imports and constructs a CodeMirror language extension.
// Kept as a lazy import so a syntax package only enters the bundle when a file of
// that language is actually opened (mirrors the `CodeEditorLazy` shell — see
// design §5.2 and the `web-ui-perf-round2` modulepreload caveat).
export type LanguageLoader = () => Promise<Extension>;

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

// Extension → media mime, used only to build a `data:` URL for inline preview.
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
	svg: "image/svg+xml",
};
const AUDIO_MIME: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	aac: "audio/aac",
	opus: "audio/opus",
};
const VIDEO_MIME: Record<string, string> = {
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	ogv: "video/ogg",
	mkv: "video/x-matroska",
};

/**
 * Decide the viewer for a file. Markdown wins (rendered via the shared vault
 * preview); otherwise the backend `binary` flag splits code vs. media/binary,
 * and the extension narrows media into image/audio/video for inline preview.
 */
export function resolveViewerKind(name: string, binary: boolean): FsViewerKind {
	const ext = extensionOf(name);
	if (MARKDOWN_EXTENSIONS.has(ext)) {
		return "markdown";
	}
	if (!binary) {
		return "code";
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return "image";
	}
	if (AUDIO_EXTENSIONS.has(ext)) {
		return "audio";
	}
	if (VIDEO_EXTENSIONS.has(ext)) {
		return "video";
	}
	return "binary";
}

/** Best-effort media mime for building a `data:` preview URL. */
export function resolveMediaMime(name: string): string | null {
	const ext = extensionOf(name);
	return IMAGE_MIME[ext] ?? AUDIO_MIME[ext] ?? VIDEO_MIME[ext] ?? null;
}

// One loader per extension. Reuses a handful of language packages; the JS pack
// covers TS/JSX via options. Unmapped text files render as plain text (no loader).
const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
	ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
	mts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	cts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	js: async () => (await import("@codemirror/lang-javascript")).javascript(),
	jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	mjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
	cjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
	json: async () => (await import("@codemirror/lang-json")).json(),
	jsonc: async () => (await import("@codemirror/lang-json")).json(),
	json5: async () => (await import("@codemirror/lang-json")).json(),
	py: async () => (await import("@codemirror/lang-python")).python(),
	pyi: async () => (await import("@codemirror/lang-python")).python(),
	css: async () => (await import("@codemirror/lang-css")).css(),
	scss: async () => (await import("@codemirror/lang-css")).css(),
	less: async () => (await import("@codemirror/lang-css")).css(),
	html: async () => (await import("@codemirror/lang-html")).html(),
	htm: async () => (await import("@codemirror/lang-html")).html(),
	vue: async () => (await import("@codemirror/lang-html")).html(),
	svelte: async () => (await import("@codemirror/lang-html")).html(),
	rs: async () => (await import("@codemirror/lang-rust")).rust(),
	sql: async () => (await import("@codemirror/lang-sql")).sql(),
	yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	xml: async () => (await import("@codemirror/lang-xml")).xml(),
	svg: async () => (await import("@codemirror/lang-xml")).xml(),
	c: async () => (await import("@codemirror/lang-cpp")).cpp(),
	h: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cc: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cxx: async () => (await import("@codemirror/lang-cpp")).cpp(),
	hpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	hh: async () => (await import("@codemirror/lang-cpp")).cpp(),
	java: async () => (await import("@codemirror/lang-java")).java(),
	kt: async () => (await import("@codemirror/lang-java")).java(),
	php: async () => (await import("@codemirror/lang-php")).php(),
	go: async () => (await import("@codemirror/lang-go")).go(),
};

/** The CodeMirror language loader for a file name, or null for plain text. */
export function getLanguageLoader(name: string): LanguageLoader | null {
	return LANGUAGE_LOADERS[extensionOf(name)] ?? null;
}
