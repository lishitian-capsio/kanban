import { describe, expect, it } from "vitest";

import { ImCredentialUnavailableError } from "../../../src/im/errors";
import { LarkApiError, LarkCredentialFormatError } from "../../../src/im/lark/errors";
import { LarkImProvider, type LarkFetch } from "../../../src/im/lark/lark-provider";
import type { ImOutboundCredential } from "../../../src/im/types";

const BASE = "https://open.feishu.cn";
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`;

interface FakeCall {
	url: string;
	init: RequestInit;
}

/** A fake transport that records calls and returns canned JSON bodies routed by URL substring. */
function makeFakeFetch(routes: {
	token?: () => { status?: number; body: unknown };
	message?: () => { status?: number; body: unknown };
}): { fetchImpl: LarkFetch; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const fetchImpl: LarkFetch = async (url, init) => {
		calls.push({ url, init });
		const route = url.includes("/tenant_access_token/") ? routes.token : routes.message;
		if (!route) throw new Error(`unexpected fetch to ${url}`);
		const { status = 200, body } = route();
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	};
	return { fetchImpl, calls };
}

const okToken = () => ({ body: { code: 0, msg: "ok", tenant_access_token: "t-abc", expire: 7200 } });
const okMessage = () => ({ body: { code: 0, msg: "ok", data: { message_id: "om_123" } } });

function makeProvider(
	overrides: {
		credential?: ImOutboundCredential | null;
		fetchImpl?: LarkFetch;
		now?: () => number;
	} = {},
) {
	const credential = "credential" in overrides ? overrides.credential : { botToken: "cli_app:secret" };
	return new LarkImProvider({
		fetchImpl: overrides.fetchImpl,
		resolveCredential: async () => credential ?? null,
		now: overrides.now,
	});
}

describe("LarkImProvider.sendMessage", () => {
	it("mints a token then posts a text message and returns the message id", async () => {
		const { fetchImpl, calls } = makeFakeFetch({ token: okToken, message: okMessage });
		const result = await makeProvider({ fetchImpl }).sendMessage({ platform: "lark", chatId: "oc_group" }, { text: "hi" });

		expect(result).toEqual({ platform: "lark", chatId: "oc_group", messageId: "om_123" });

		expect(calls[0].url).toBe(TOKEN_URL);
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ app_id: "cli_app", app_secret: "secret" });

		expect(calls[1].url).toBe(`${BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`);
		expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer t-abc");
		expect(JSON.parse(String(calls[1].init.body))).toEqual({
			receive_id: "oc_group",
			msg_type: "text",
			content: JSON.stringify({ text: "hi" }),
		});
	});

	it("infers receive_id_type=open_id for a single-chat open id (ou_)", async () => {
		const { fetchImpl, calls } = makeFakeFetch({ token: okToken, message: okMessage });
		await makeProvider({ fetchImpl }).sendMessage({ platform: "lark", chatId: "ou_user" }, { text: "hi" });
		expect(calls[1].url).toBe(`${BASE}/open-apis/im/v1/messages?receive_id_type=open_id`);
	});

	it("returns a result without messageId when the API omits one (still succeeds)", async () => {
		const { fetchImpl } = makeFakeFetch({ token: okToken, message: () => ({ body: { code: 0, msg: "ok", data: {} } }) });
		const result = await makeProvider({ fetchImpl }).sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "hi" });
		expect(result).toEqual({ platform: "lark", chatId: "oc_g" });
	});
});

describe("LarkImProvider.sendCard", () => {
	it("posts an interactive card built from the neutral ImCard", async () => {
		const { fetchImpl, calls } = makeFakeFetch({ token: okToken, message: okMessage });
		await makeProvider({ fetchImpl }).sendCard(
			{ platform: "lark", chatId: "oc_g" },
			{ title: "Build", text: "done", buttons: [{ text: "Open", url: "https://x.test" }] },
		);
		const sent = JSON.parse(String(calls[1].init.body));
		expect(sent.msg_type).toBe("interactive");
		const card = JSON.parse(sent.content);
		expect(card.header.title.content).toBe("Build");
		expect(card.elements[0].text.content).toBe("done");
		expect(card.elements[1].actions[0].url).toBe("https://x.test");
	});
});

describe("LarkImProvider tenant token caching", () => {
	it("mints the token once across multiple sends while it is fresh", async () => {
		const { fetchImpl, calls } = makeFakeFetch({ token: okToken, message: okMessage });
		const provider = makeProvider({ fetchImpl, now: () => 1_000 });
		await provider.sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "a" });
		await provider.sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "b" });
		expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
	});

	it("re-mints the token after it expires (safety window applied)", async () => {
		const { fetchImpl, calls } = makeFakeFetch({ token: okToken, message: okMessage });
		let clock = 0;
		const provider = makeProvider({ fetchImpl, now: () => clock });
		await provider.sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "a" });
		clock = 7_200_000; // well past the 7200s ttl minus the 60s safety window
		await provider.sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "b" });
		expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
	});
});

describe("LarkImProvider failure modes (throw; the dispatch seam swallows)", () => {
	it("throws ImCredentialUnavailableError when no credential is configured", async () => {
		const { fetchImpl } = makeFakeFetch({ token: okToken, message: okMessage });
		await expect(
			makeProvider({ fetchImpl, credential: null }).sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "x" }),
		).rejects.toBeInstanceOf(ImCredentialUnavailableError);
	});

	it("throws ImCredentialUnavailableError for a webhook-only credential (no botToken)", async () => {
		const { fetchImpl } = makeFakeFetch({ token: okToken, message: okMessage });
		await expect(
			makeProvider({ fetchImpl, credential: { webhookUrl: "https://hook.test" } }).sendMessage(
				{ platform: "lark", chatId: "oc_g" },
				{ text: "x" },
			),
		).rejects.toBeInstanceOf(ImCredentialUnavailableError);
	});

	it("throws LarkCredentialFormatError when botToken is not app_id:app_secret", async () => {
		const { fetchImpl } = makeFakeFetch({ token: okToken, message: okMessage });
		await expect(
			makeProvider({ fetchImpl, credential: { botToken: "no-colon" } }).sendMessage(
				{ platform: "lark", chatId: "oc_g" },
				{ text: "x" },
			),
		).rejects.toBeInstanceOf(LarkCredentialFormatError);
	});

	it("throws LarkApiError on a non-zero business code from the message API", async () => {
		const { fetchImpl } = makeFakeFetch({
			token: okToken,
			message: () => ({ body: { code: 230001, msg: "bot not in chat" } }),
		});
		await expect(
			makeProvider({ fetchImpl }).sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "x" }),
		).rejects.toMatchObject({ constructor: LarkApiError, code: 230001 });
	});

	it("throws LarkApiError on a non-2xx HTTP status", async () => {
		const { fetchImpl } = makeFakeFetch({ token: () => ({ status: 500, body: {} }), message: okMessage });
		await expect(
			makeProvider({ fetchImpl }).sendMessage({ platform: "lark", chatId: "oc_g" }, { text: "x" }),
		).rejects.toMatchObject({ constructor: LarkApiError, code: 500 });
	});
});
