import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearPersistedImCredentials,
	getImCredentialsFilePath,
	readPersistedImCredentials,
	resolveImCredential,
	statImCredentialsMtimeMs,
	writePersistedImCredentials,
} from "../../../src/im/im-credential-store";
import { createTempDir } from "../../utilities/temp-dir";

describe("im-credential-store path resolution", () => {
	const original = process.env.KANBAN_IM_CREDENTIALS_FILE;
	afterEach(() => {
		if (original === undefined) delete process.env.KANBAN_IM_CREDENTIALS_FILE;
		else process.env.KANBAN_IM_CREDENTIALS_FILE = original;
	});

	it("honors the KANBAN_IM_CREDENTIALS_FILE override", () => {
		process.env.KANBAN_IM_CREDENTIALS_FILE = "/custom/im-credentials.json";
		expect(getImCredentialsFilePath()).toBe("/custom/im-credentials.json");
	});

	it("defaults to the machine-home settings dir", () => {
		delete process.env.KANBAN_IM_CREDENTIALS_FILE;
		expect(getImCredentialsFilePath().endsWith(join(".kanban", "settings", "im-credentials.json"))).toBe(true);
	});
});

describe("im-credential-store persistence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "im-credentials.json");
	});
	afterEach(() => cleanup());

	it("round-trips per-platform outbound credentials keyed by platform id", async () => {
		await writePersistedImCredentials(file, {
			lark: { botToken: "lark-bot-token" },
			dingtalk: { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=x", webhookSecret: "s" },
		});
		const read = await readPersistedImCredentials(file);
		expect(read).toMatchObject({
			lark: { botToken: "lark-bot-token" },
			dingtalk: { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=x", webhookSecret: "s" },
		});
	});

	it("writes the secret file with owner-only (0o600) permissions", async () => {
		await writePersistedImCredentials(file, { lark: { botToken: "t" } });
		const { mode } = await stat(file);
		expect(mode & 0o777).toBe(0o600);
	});

	it("returns null for a missing file", async () => {
		expect(await readPersistedImCredentials(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for a torn/invalid file instead of throwing", async () => {
		const torn = join(dir, "torn.json");
		await writeFile(torn, "{ not json", "utf8");
		expect(await readPersistedImCredentials(torn)).toBeNull();
	});

	it("returns null when a credential sets neither botToken nor webhookUrl", async () => {
		const bad = join(dir, "bad.json");
		await writeFile(bad, JSON.stringify({ lark: { webhookSecret: "only-secret" } }), "utf8");
		expect(await readPersistedImCredentials(bad)).toBeNull();
	});

	it("resolveImCredential returns the requested platform's credential, or null when absent", async () => {
		await writePersistedImCredentials(file, { lark: { botToken: "lark-bot-token" } });
		expect(await resolveImCredential("lark", file)).toEqual({ botToken: "lark-bot-token" });
		expect(await resolveImCredential("dingtalk", file)).toBeNull();
	});

	it("resolveImCredential returns null when the file is absent", async () => {
		expect(await resolveImCredential("lark", join(dir, "nope.json"))).toBeNull();
	});

	it("clearPersistedImCredentials removes the file and is idempotent", async () => {
		await writePersistedImCredentials(file, { lark: { botToken: "t" } });
		await clearPersistedImCredentials(file);
		expect(await readPersistedImCredentials(file)).toBeNull();
		await expect(clearPersistedImCredentials(file)).resolves.toBeUndefined();
	});

	it("statImCredentialsMtimeMs returns a number when present and null when absent", async () => {
		expect(await statImCredentialsMtimeMs(file)).toBeNull();
		await writePersistedImCredentials(file, { lark: { botToken: "t" } });
		expect(typeof (await statImCredentialsMtimeMs(file))).toBe("number");
	});
});
