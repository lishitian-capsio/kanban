import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	disablePersistedPasscode,
	getPasscodeFilePath,
	isPersistedPasscodeDisabled,
	readPersistedPasscode,
	readPersistedPasscodeRecord,
	resolveAndPersistPasscode,
	writePersistedPasscode,
} from "../../../src/security/passcode-store";
import { createTempDir } from "../../utilities/temp-dir";

describe("passcode-store path resolution", () => {
	const original = process.env.KANBAN_PASSCODE_FILE;
	afterEach(() => {
		if (original === undefined) delete process.env.KANBAN_PASSCODE_FILE;
		else process.env.KANBAN_PASSCODE_FILE = original;
	});

	it("honors the KANBAN_PASSCODE_FILE override", () => {
		process.env.KANBAN_PASSCODE_FILE = "/custom/passcode.json";
		expect(getPasscodeFilePath()).toBe("/custom/passcode.json");
	});

	it("defaults to the machine-home settings dir", () => {
		delete process.env.KANBAN_PASSCODE_FILE;
		const path = getPasscodeFilePath();
		expect(path.endsWith(join(".kanban", "settings", "passcode.json"))).toBe(true);
	});
});

describe("passcode-store persistence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "passcode.json");
	});
	afterEach(() => cleanup());

	it("round-trips a written passcode", async () => {
		await writePersistedPasscode(file, "ABCdef23");
		expect(await readPersistedPasscode(file)).toBe("ABCdef23");
	});

	it("returns null when the file is missing", async () => {
		expect(await readPersistedPasscode(join(dir, "nope.json"))).toBeNull();
	});

	it("returns null for a torn/invalid file instead of throwing", async () => {
		const torn = join(dir, "torn.json");
		await writeFile(torn, "{ not json", "utf8");
		expect(await readPersistedPasscode(torn)).toBeNull();
	});
});

describe("passcode-store disable state (P4)", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "passcode.json");
	});
	afterEach(() => cleanup());

	it("persists a disable and reports it via readPersistedPasscodeRecord", async () => {
		await disablePersistedPasscode(file);
		expect(await readPersistedPasscodeRecord(file)).toEqual({ value: null, disabled: true });
		expect(await isPersistedPasscodeDisabled(file)).toBe(true);
		// A disabled record exposes no secret value.
		expect(await readPersistedPasscode(file)).toBeNull();
	});

	it("writing a value clears a prior disable (re-enables)", async () => {
		await disablePersistedPasscode(file);
		await writePersistedPasscode(file, "REENAB12");
		expect(await isPersistedPasscodeDisabled(file)).toBe(false);
		expect(await readPersistedPasscode(file)).toBe("REENAB12");
	});

	it("resolveAndPersistPasscode with an explicit value re-enables a disabled store", async () => {
		await disablePersistedPasscode(file);
		const result = await resolveAndPersistPasscode({ explicit: "EXPLICIT1", filePath: file });
		expect(result).toEqual({ value: "EXPLICIT1", source: "explicit" });
		expect(await isPersistedPasscodeDisabled(file)).toBe(false);
	});

	it("reports not-disabled for a missing file", async () => {
		expect(await isPersistedPasscodeDisabled(join(dir, "nope.json"))).toBe(false);
		expect(await readPersistedPasscodeRecord(join(dir, "nope.json"))).toEqual({ value: null, disabled: false });
	});
});

describe("resolveAndPersistPasscode precedence", () => {
	let dir: string;
	let cleanup: () => void;
	let file: string;

	beforeEach(() => {
		const tmp = createTempDir();
		dir = tmp.path;
		cleanup = tmp.cleanup;
		file = join(dir, "settings", "passcode.json");
	});
	afterEach(() => cleanup());

	it("persists an explicit passcode and reports the explicit source", async () => {
		const result = await resolveAndPersistPasscode({ explicit: "EXPLICIT1", filePath: file });
		expect(result).toEqual({ value: "EXPLICIT1", source: "explicit" });
		expect(await readPersistedPasscode(file)).toBe("EXPLICIT1");
	});

	it("generates and persists when neither explicit nor a persisted file exists", async () => {
		const result = await resolveAndPersistPasscode({
			explicit: null,
			filePath: file,
			generate: () => "GENERATED1",
		});
		expect(result).toEqual({ value: "GENERATED1", source: "generated" });
		expect(await readPersistedPasscode(file)).toBe("GENERATED1");
	});

	it("reuses the persisted passcode across restarts", async () => {
		await writePersistedPasscode(file, "REUSED12");
		const result = await resolveAndPersistPasscode({
			explicit: null,
			filePath: file,
			generate: () => "SHOULD_NOT_RUN",
		});
		expect(result).toEqual({ value: "REUSED12", source: "persisted" });
		expect(await readPersistedPasscode(file)).toBe("REUSED12");
	});

	it("lets an explicit passcode override a persisted one", async () => {
		await writePersistedPasscode(file, "OLDVALUE");
		const result = await resolveAndPersistPasscode({ explicit: "NEWVALUE", filePath: file });
		expect(result).toEqual({ value: "NEWVALUE", source: "explicit" });
		expect(await readPersistedPasscode(file)).toBe("NEWVALUE");
	});

	it("writes the secret with owner-only permissions", async () => {
		await resolveAndPersistPasscode({ explicit: "SECRET12", filePath: file });
		const { mode } = await import("node:fs/promises").then((m) => m.stat(file));
		// Low 9 permission bits: owner rw only (0o600).
		expect(mode & 0o777).toBe(0o600);
	});

	it("does not leave the raw value in the persisted JSON structure beyond `value`", async () => {
		await resolveAndPersistPasscode({ explicit: "SECRET12", filePath: file });
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(parsed.value).toBe("SECRET12");
		expect(typeof parsed.issuedAt).toBe("number");
	});
});
