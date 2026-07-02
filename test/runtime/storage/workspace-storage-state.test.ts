import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStorageCredentialsPath, loadStorageCredential, mutateStorageCredential } from "../../../src/state/workspace-state";

let dir: string;
let prev: string | undefined;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "kanban-storage-creds-"));
	prev = process.env.KANBAN_STORAGE_CREDENTIALS_PATH;
	process.env.KANBAN_STORAGE_CREDENTIALS_PATH = join(dir, "storage-credentials.json");
});
afterEach(async () => {
	if (prev === undefined) delete process.env.KANBAN_STORAGE_CREDENTIALS_PATH;
	else process.env.KANBAN_STORAGE_CREDENTIALS_PATH = prev;
	await rm(dir, { recursive: true, force: true });
});

describe("storage credential machine-home store", () => {
	it("honors the path override", () => {
		expect(getStorageCredentialsPath()).toBe(join(dir, "storage-credentials.json"));
	});
	it("sets then clears a credential", async () => {
		await mutateStorageCredential("r2", () => ({ accessKeyId: "AK", secretAccessKey: "SK" }));
		expect((await loadStorageCredential("R2"))?.accessKeyId).toBe("AK");
		await mutateStorageCredential("r2", () => undefined);
		expect(await loadStorageCredential("r2")).toBeUndefined();
	});
	it("writes the credentials file with 0600 mode", async () => {
		await mutateStorageCredential("r2", () => ({ accessKeyId: "AK" }));
		const { mode } = await stat(getStorageCredentialsPath());
		expect(mode & 0o777).toBe(0o600);
	});
});
