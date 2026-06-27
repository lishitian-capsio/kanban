// Pure, side-effect-free derivations over the persisted STT config: the secret-free
// status crossing the wire, and the merge applied on save. Kept free of I/O so they
// can be unit-tested, and so the tRPC layer and the service share one source of truth.

import type { RuntimeSttSaveRequest, RuntimeSttStatus } from "../core/api-contract";
import { maskApiKey } from "../core/api-key-mask";
import { DEFAULT_STT_MODEL, normalizeSttBaseUrl } from "./stt-transcribe";
import type { PersistedSttConfig } from "./stt-types";

/**
 * Project the persisted config to its secret-free status. The API key never crosses
 * the wire — only a masked preview and a `hasApiKey` flag.
 */
export function deriveSttStatus(config: PersistedSttConfig | null): RuntimeSttStatus {
	if (!config) {
		return {
			configured: false,
			baseUrl: null,
			model: null,
			language: null,
			hasApiKey: false,
			apiKeyPreview: null,
		};
	}
	const hasApiKey = typeof config.apiKey === "string" && config.apiKey.length > 0;
	return {
		configured: config.baseUrl.length > 0 && config.model.length > 0,
		baseUrl: config.baseUrl,
		model: config.model,
		language: config.language ?? null,
		hasApiKey,
		apiKeyPreview: hasApiKey ? maskApiKey(config.apiKey as string) : null,
	};
}

/**
 * Merge a save request onto the existing config:
 * - `baseUrl` is required and normalized.
 * - `model` falls back to the existing value, then {@link DEFAULT_STT_MODEL}.
 * - `apiKey`/`language`: `undefined` keeps the existing value; an empty string clears it.
 */
export function mergeSttConfigForSave(
	existing: PersistedSttConfig | null,
	request: RuntimeSttSaveRequest,
): PersistedSttConfig {
	const model = (request.model ?? existing?.model ?? DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL;

	const apiKey =
		request.apiKey === undefined
			? existing?.apiKey
			: request.apiKey.trim().length > 0
				? request.apiKey.trim()
				: undefined;

	const language =
		request.language === undefined
			? existing?.language
			: request.language.trim().length > 0
				? request.language.trim()
				: undefined;

	const next: PersistedSttConfig = {
		baseUrl: normalizeSttBaseUrl(request.baseUrl),
		model,
	};
	if (apiKey) {
		next.apiKey = apiKey;
	}
	if (language) {
		next.language = language;
	}
	return next;
}
