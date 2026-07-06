/**
 * DingTalk outbound {@link ImProvider} — delivers plain-text messages and interactive cards to a
 * bound DingTalk channel under the robot's identity.
 *
 * Delivery mechanism: the DingTalk **custom robot ("自定义机器人") webhook**. It is the only
 * outbound path expressible with the foundation's per-platform credential shape (a `webhookUrl` +
 * optional signing `webhookSecret`, or a bare robot `botToken`), and the credential-schema comment
 * pairs `webhookSecret` with DingTalk by name. The robot's webhook pins its group, so multi-group
 * targeting is done by swapping the `access_token` ({@link ImChannelTarget.chatId}) on a shared
 * endpoint. (DingTalk 1:1 "单聊" and true per-conversation routing require the enterprise-bot API
 * with appKey/appSecret/robotCode — richer credentials the current store does not model — and is a
 * deliberate later extension, not this adapter.)
 *
 * Credentials are self-resolved from the machine-local 0600 store (never passed through the
 * interface), mirroring the git credential injectors. This adapter is a **throwing leaf**: it
 * throws on any failure (unconfigured credential, network error, non-zero DingTalk errcode) to stay
 * honest to `Promise<ImSendResult>`. The "发送失败只记日志不抛,不拖垮 runtime" guarantee lives in the
 * generic egress {@link ../im-dispatch} (`sendImText`/`sendImCard`), which catches + logs + returns
 * null — mirroring the throwing-leaf + catching-egress git-injector idiom.
 */
import { ImCredentialUnavailableError, ImSendFailedError } from "../errors";
import { resolveImCredential } from "../im-credential-store";
import { registerImProvider } from "../im-provider-registry";
import type { ImProvider } from "../im-provider";
import type { ImCard, ImChannelTarget, ImOutboundCredential, ImSendResult, ImTextMessage } from "../types";
import {
	buildDingtalkCardPayload,
	buildDingtalkTextPayload,
	type DingtalkOutboundPayload,
	resolveDingtalkWebhookUrl,
	signDingtalkWebhookUrl,
} from "./dingtalk-message";
import { createDefaultDingtalkTransport, type DingtalkTransport } from "./dingtalk-transport";

export interface DingtalkProviderDeps {
	/** Self-resolve the DingTalk outbound credential (default: the machine-local 0600 store). */
	resolveCredential?: () => Promise<ImOutboundCredential | null>;
	/** HTTP seam (default: proxy-aware global `fetch`). Injected as a fake in tests. */
	transport?: DingtalkTransport;
	/** Clock for webhook signing (default: `Date.now`). Injected for deterministic tests. */
	now?: () => number;
}

export class DingtalkImProvider implements ImProvider {
	readonly platform = "dingtalk" as const;

	private readonly resolveCredential: () => Promise<ImOutboundCredential | null>;
	private readonly transport: DingtalkTransport;
	private readonly now: () => number;

	constructor(deps: DingtalkProviderDeps = {}) {
		this.resolveCredential = deps.resolveCredential ?? (() => resolveImCredential("dingtalk"));
		this.transport = deps.transport ?? createDefaultDingtalkTransport();
		this.now = deps.now ?? Date.now;
	}

	sendMessage(target: ImChannelTarget, message: ImTextMessage): Promise<ImSendResult> {
		return this.deliver(target, buildDingtalkTextPayload(message.text));
	}

	sendCard(target: ImChannelTarget, card: ImCard): Promise<ImSendResult> {
		return this.deliver(target, buildDingtalkCardPayload(card));
	}

	/**
	 * Resolve credential + URL, sign if needed, post, and validate the DingTalk response. Throws
	 * {@link ImCredentialUnavailableError} when unconfigured, propagates a transport/network error,
	 * and throws {@link ImSendFailedError} on a non-zero DingTalk `errcode`. The webhook returns no
	 * message id, so a successful {@link ImSendResult} carries only `platform` + `chatId`.
	 */
	private async deliver(target: ImChannelTarget, payload: DingtalkOutboundPayload): Promise<ImSendResult> {
		const credential = await this.resolveCredential();
		if (!credential) {
			throw new ImCredentialUnavailableError(this.platform);
		}

		let url = resolveDingtalkWebhookUrl(credential, target.chatId);
		if (credential.webhookSecret) {
			url = signDingtalkWebhookUrl(url, credential.webhookSecret, this.now());
		}

		const response = await this.transport.post(url, payload);
		if (response.errcode !== undefined && response.errcode !== 0) {
			throw new ImSendFailedError(this.platform, response.errcode, response.errmsg);
		}
		return { platform: this.platform, chatId: target.chatId };
	}
}

/** Construct the default (production) DingTalk adapter and register it under the `dingtalk` id. */
export function registerDingtalkImProvider(): DingtalkImProvider {
	const provider = new DingtalkImProvider();
	registerImProvider(provider);
	return provider;
}
