import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ImCredentialService } from "../../../src/im/im-credential-service";
import { readPersistedImCredentials, writePersistedImCredentials } from "../../../src/im/im-credential-store";
import { createTempDir } from "../../utilities/temp-dir";

describe("ImCredentialService", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;
	let service: ImCredentialService;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "im-credentials.json");
		service = new ImCredentialService({ resolvePath: () => file });
	});
	afterEach(() => cleanup());

	it("reports every platform as unconfigured when nothing is stored", async () => {
		const status = await service.getStatus();
		expect(status).toEqual([
			{ platform: "lark", configured: false, hasBotToken: false, hasWebhookUrl: false, hasWebhookSecret: false },
			{ platform: "dingtalk", configured: false, hasBotToken: false, hasWebhookUrl: false, hasWebhookSecret: false },
		]);
	});

	it("stores a platform credential and reports presence booleans (never the secret)", async () => {
		const status = await service.setCredential("lark", { botToken: "app_id:app_secret" });
		const lark = status.find((s) => s.platform === "lark");
		expect(lark).toEqual({
			platform: "lark",
			configured: true,
			hasBotToken: true,
			hasWebhookUrl: false,
			hasWebhookSecret: false,
		});
		// The secret is on disk but never in the status payload.
		expect(JSON.stringify(status)).not.toContain("app_secret");
		const persisted = await readPersistedImCredentials(file);
		expect(persisted?.lark?.botToken).toBe("app_id:app_secret");
	});

	it("trims field whitespace and drops empty fields before persisting", async () => {
		await service.setCredential("dingtalk", {
			webhookUrl: "  https://oapi.dingtalk.com/robot/send?access_token=x  ",
			webhookSecret: "   ",
		});
		const persisted = await readPersistedImCredentials(file);
		expect(persisted?.dingtalk?.webhookUrl).toBe("https://oapi.dingtalk.com/robot/send?access_token=x");
		expect(persisted?.dingtalk?.webhookSecret).toBeUndefined();
	});

	it("rejects an all-empty credential (needs a token or webhook)", async () => {
		await expect(service.setCredential("lark", { botToken: "   " })).rejects.toThrow();
	});

	it("setting one platform leaves the other intact", async () => {
		await service.setCredential("lark", { botToken: "lark-token" });
		await service.setCredential("dingtalk", { webhookUrl: "https://example.com/hook" });
		const persisted = await readPersistedImCredentials(file);
		expect(persisted?.lark?.botToken).toBe("lark-token");
		expect(persisted?.dingtalk?.webhookUrl).toBe("https://example.com/hook");
	});

	it("clears a single platform and keeps the others; removes the file when the last is cleared", async () => {
		await service.setCredential("lark", { botToken: "lark-token" });
		await service.setCredential("dingtalk", { webhookUrl: "https://example.com/hook" });

		const afterFirstClear = await service.clearCredential("lark");
		expect(afterFirstClear.find((s) => s.platform === "lark")?.configured).toBe(false);
		expect(afterFirstClear.find((s) => s.platform === "dingtalk")?.configured).toBe(true);
		expect((await readPersistedImCredentials(file))?.dingtalk).toBeDefined();

		const afterLastClear = await service.clearCredential("dingtalk");
		expect(afterLastClear.every((s) => !s.configured)).toBe(true);
		expect(await readPersistedImCredentials(file)).toBeNull();
	});

	it("clearing an unconfigured platform is a no-op that preserves others", async () => {
		await writePersistedImCredentials(file, { lark: { botToken: "lark-token" } });
		const status = await service.clearCredential("dingtalk");
		expect(status.find((s) => s.platform === "lark")?.configured).toBe(true);
		expect((await readPersistedImCredentials(file))?.lark?.botToken).toBe("lark-token");
	});
});
