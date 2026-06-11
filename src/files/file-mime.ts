import mime from "mime";

import type { RuntimeFileCategory } from "../core/api-contract";

const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Resolve the mime type for a stored file. An explicit, non-empty `override`
 * (e.g. supplied by an uploader that already knows the content type) wins;
 * otherwise the type is derived from the file name's extension. Falls back to
 * `application/octet-stream` when nothing matches.
 */
export function detectMimeType(name: string, override?: string | null): string {
	const trimmedOverride = override?.trim();
	if (trimmedOverride) {
		return trimmedOverride;
	}
	return mime.getType(name) ?? DEFAULT_MIME_TYPE;
}

// Application mime subtypes that are really text under the hood. Kept small and
// explicit rather than guessing from "+xml"/"+json" suffixes.
const TEXT_LIKE_APPLICATION_SUBTYPES = new Set([
	"json",
	"xml",
	"javascript",
	"ecmascript",
	"x-yaml",
	"yaml",
	"x-sh",
	"x-shellscript",
	"sql",
	"graphql",
]);

const DOCUMENT_APPLICATION_SUBTYPES = new Set([
	"pdf",
	"msword",
	"rtf",
	"epub+zip",
	"vnd.ms-excel",
	"vnd.ms-powerpoint",
	"vnd.oasis.opendocument.text",
	"vnd.oasis.opendocument.spreadsheet",
	"vnd.oasis.opendocument.presentation",
]);

const ARCHIVE_APPLICATION_SUBTYPES = new Set([
	"zip",
	"gzip",
	"x-tar",
	"x-gzip",
	"x-bzip2",
	"x-7z-compressed",
	"x-rar-compressed",
	"vnd.rar",
	"x-xz",
	"x-zip-compressed",
]);

/**
 * Map a mime type to the coarse {@link RuntimeFileCategory} bucket used for
 * grouping and filtering. Top-level types (image/audio/video/text) map
 * directly; the open-ended `application/*` space is classified by subtype.
 */
export function classifyFileCategory(mimeType: string): RuntimeFileCategory {
	const normalized = mimeType.trim().toLowerCase();
	const [type, rawSubtype = ""] = normalized.split("/", 2);
	const subtype = rawSubtype.split(";", 1)[0]?.trim() ?? "";

	switch (type) {
		case "image":
			return "image";
		case "audio":
			return "audio";
		case "video":
			return "video";
		case "text":
			return "text";
		case "application": {
			if (DOCUMENT_APPLICATION_SUBTYPES.has(subtype) || subtype.startsWith("vnd.openxmlformats-officedocument")) {
				return "document";
			}
			if (ARCHIVE_APPLICATION_SUBTYPES.has(subtype)) {
				return "archive";
			}
			if (TEXT_LIKE_APPLICATION_SUBTYPES.has(subtype) || subtype.endsWith("+xml") || subtype.endsWith("+json")) {
				return "text";
			}
			return "other";
		}
		default:
			return "other";
	}
}
