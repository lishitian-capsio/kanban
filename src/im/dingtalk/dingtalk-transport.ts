/**
 * Network seam for the DingTalk adapter. Isolating the single HTTP POST behind an interface keeps
 * the provider unit-testable with a fake transport (no real network in tests) and keeps all the
 * fetch/JSON plumbing in one small place.
 */

/** The relevant fields of a DingTalk robot-send response (`{ errcode, errmsg }`; 0 = success). */
export interface DingtalkApiResponse {
	errcode?: number;
	errmsg?: string;
}

/** Posts a JSON payload to a DingTalk robot webhook and returns the parsed response. */
export interface DingtalkTransport {
	post(url: string, body: unknown): Promise<DingtalkApiResponse>;
}

/**
 * Default transport using the runtime's global `fetch`. `fetch` is the proxy-aware, monkey-patched
 * global installed at startup (`config/proxy-fetch.ts`), so outbound goes through the configured
 * proxy for free. Throws on a non-2xx HTTP status; the caller (provider) swallows + logs.
 */
export function createDefaultDingtalkTransport(): DingtalkTransport {
	return {
		async post(url: string, body: unknown): Promise<DingtalkApiResponse> {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				throw new Error(`DingTalk webhook returned HTTP ${response.status}`);
			}
			return (await response.json()) as DingtalkApiResponse;
		},
	};
}
