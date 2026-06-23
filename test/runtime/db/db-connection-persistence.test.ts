import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getDbCredentialsPath,
	loadDbCredential,
	mutateDbCredential,
} from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

describe("db credential persistence (workspace-state seam)", () => {
	let dir: string;
	let cleanup: () => void;
	let originalEnv: string | undefined;

	beforeEach(() => {
		const { path, cleanup: c } = createTempDir();
		dir = path;
		cleanup = c;
		originalEnv = process.env.KANBAN_DB_CREDENTIALS_PATH;
		process.env.KANBAN_DB_CREDENTIALS_PATH = join(dir, "db-credentials.json");
	});

	afterEach(() => {
		cleanup();
		if (originalEnv === undefined) {
			delete process.env.KANBAN_DB_CREDENTIALS_PATH;
		} else {
			process.env.KANBAN_DB_CREDENTIALS_PATH = originalEnv;
		}
	});

	it("resolves the overridden credentials path from the env var", () => {
		const expected = join(dir, "db-credentials.json");
		expect(getDbCredentialsPath()).toBe(expected);
	});

	it("round-trips a credential via mutate + load", async () => {
		await mutateDbCredential("conn-1", () => ({ password: "secret123" }));
		const loaded = await loadDbCredential("conn-1");
		expect(loaded?.password).toBe("secret123");
	});

	it("deletes a credential when the mutator returns undefined", async () => {
		await mutateDbCredential("conn-1", () => ({ password: "secret123" }));
		await mutateDbCredential("conn-1", () => undefined);
		const loaded = await loadDbCredential("conn-1");
		expect(loaded).toBeUndefined();
	});

	it("credential stored under uppercase key is retrievable via lowercase lookup (case-insensitive)", async () => {
		await mutateDbCredential("C1", () => ({ password: "secret-c1" }));
		const loaded = await loadDbCredential("c1");
		expect(loaded?.password).toBe("secret-c1");
	});
});
