/**
 * Pure, framework-free field validation for the add/edit provider dialog.
 *
 * The dialog persists a provider config that is only exercised at *runtime*
 * (when an agent actually calls the endpoint). Without field-level checks a
 * malformed base URL, a bogus HTTP header, or an out-of-range timeout sails
 * through the form and only surfaces as a confusing failure mid-session. These
 * helpers catch those mistakes at edit time and feed inline error messages.
 */

/** Inclusive lower bound for the request timeout (1 second). */
export const MIN_TIMEOUT_MS = 1_000;
/** Inclusive upper bound for the request timeout (1 hour). */
export const MAX_TIMEOUT_MS = 3_600_000;

export interface ProviderHeaderInput {
	id: string;
	key: string;
	value: string;
}

export interface ProviderFormValidationInput {
	baseUrl: string;
	apiKey: string;
	modelsSourceUrl: string;
	/** Raw text from the timeout input (may be empty). */
	timeoutMs: string;
	/** The effective model list (manual entries plus any pending draft). */
	models: string[];
	defaultModelId: string;
	headers: ProviderHeaderInput[];
}

export interface ProviderHeaderError {
	key?: string;
	value?: string;
}

export interface ProviderFormFieldErrors {
	baseUrl?: string;
	apiKey?: string;
	modelsSourceUrl?: string;
	timeoutMs?: string;
	defaultModelId?: string;
	/** Header errors keyed by the header entry id. */
	headers: Record<string, ProviderHeaderError>;
	/** True when any field carries an error that should block submission. */
	hasBlockingErrors: boolean;
}

/** Accept only absolute http(s) URLs (the only protocols an SDK endpoint uses). */
export function isValidHttpUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * RFC 7230 header field-name: a non-empty "token" of visible ASCII excluding
 * separators. This is what every HTTP stack accepts as a header name.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(value: string): boolean {
	return HEADER_NAME_PATTERN.test(value);
}

/**
 * Header field-value: reject control characters (incl. CR/LF, which enable
 * header injection) while allowing horizontal tab (0x09) and visible text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to reject them.
const HEADER_VALUE_FORBIDDEN = /[\u0000-\u0008\u000A-\u001F\u007F]/;

export function isValidHeaderValue(value: string): boolean {
	return !HEADER_VALUE_FORBIDDEN.test(value);
}

function validateTimeout(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed)) {
		return "Timeout must be a whole number of milliseconds.";
	}
	if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
		return `Timeout must be between ${MIN_TIMEOUT_MS.toLocaleString()} and ${MAX_TIMEOUT_MS.toLocaleString()} ms.`;
	}
	return undefined;
}

function validateApiKey(raw: string): string | undefined {
	if (raw.length === 0) {
		return undefined;
	}
	if (/\s/.test(raw)) {
		return "API key must not contain spaces or line breaks.";
	}
	return undefined;
}

function validateHeader(entry: ProviderHeaderInput): ProviderHeaderError | undefined {
	const key = entry.key.trim();
	const value = entry.value.trim();
	// A fully empty row is dropped on submit — nothing to validate.
	if (key.length === 0 && value.length === 0) {
		return undefined;
	}
	const error: ProviderHeaderError = {};
	if (key.length === 0) {
		error.key = "Header name is required.";
	} else if (!isValidHeaderName(key)) {
		error.key = "Invalid header name (letters, digits, and !#$%&'*+-.^_`|~ only).";
	}
	if (value.length > 0 && !isValidHeaderValue(value)) {
		error.value = "Header value must not contain control characters.";
	}
	return error.key || error.value ? error : undefined;
}

export function validateProviderForm(input: ProviderFormValidationInput): ProviderFormFieldErrors {
	const baseUrlTrimmed = input.baseUrl.trim();
	const baseUrl =
		baseUrlTrimmed.length > 0 && !isValidHttpUrl(baseUrlTrimmed) ? "Enter a valid http(s) URL." : undefined;

	const modelsSourceUrlTrimmed = input.modelsSourceUrl.trim();
	const modelsSourceUrl =
		modelsSourceUrlTrimmed.length > 0 && !isValidHttpUrl(modelsSourceUrlTrimmed)
			? "Enter a valid http(s) URL."
			: undefined;

	const apiKey = validateApiKey(input.apiKey);
	const timeoutMs = validateTimeout(input.timeoutMs);

	const defaultModelId =
		input.defaultModelId.trim().length > 0 && !input.models.includes(input.defaultModelId.trim())
			? "Default model must be one of the listed models."
			: undefined;

	const headers: Record<string, ProviderHeaderError> = {};
	for (const entry of input.headers) {
		const headerError = validateHeader(entry);
		if (headerError) {
			headers[entry.id] = headerError;
		}
	}

	const hasBlockingErrors =
		Boolean(baseUrl || modelsSourceUrl || apiKey || timeoutMs || defaultModelId) || Object.keys(headers).length > 0;

	return { baseUrl, apiKey, modelsSourceUrl, timeoutMs, defaultModelId, headers, hasBlockingErrors };
}
