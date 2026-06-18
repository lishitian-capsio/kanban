import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DroidByokProjection } from "../../../src/agent-sdk/kanban/droid-byok";

// Mock the projector so the adapter test controls the resolved provider without
// touching the machine-home store (whose path is frozen at module load). The real
// `mergeDroidCustomModels` is kept so the merge/compose behavior is exercised.
const byokMocks = vi.hoisted(() => ({ resolveDroidByokProjection: vi.fn() }));
vi.mock("../../../src/agent-sdk/kanban/droid-byok", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/agent-sdk/kanban/droid-byok")>();
	return { ...actual, resolveDroidByokProjection: byokMocks.resolveDroidByokProjection };
});

import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

const originalHome = process.env.HOME;
let tempHome: string | null = null;

function readSettings(args: string[]): {
	autonomyMode?: string;
	hooks?: Record<string, unknown>;
	customModels?: Array<{ model: string; provider: string; baseUrl: string; apiKey: string; displayName?: string }>;
} {
	const idx = args.indexOf("--settings");
	expect(idx).toBeGreaterThanOrEqual(0);
	const path = args[idx + 1];
	expect(path).toBeDefined();
	return JSON.parse(readFileSync(path ?? "", "utf8"));
}

const PROJECTION: DroidByokProjection = {
	model: "claude-sonnet-4-5",
	env: { KANBAN_DROID_BYOK_API_KEY: "sk-secret-123" },
	customModel: {
		model: "claude-sonnet-4-5",
		displayName: "my-relay",
		baseUrl: "https://relay.example.com",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} is Droid's apiKey env-interpolation syntax, not a template.
		apiKey: "${KANBAN_DROID_BYOK_API_KEY}",
		provider: "anthropic",
	},
};

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-droid-byok-"));
	process.env.HOME = tempHome;
	byokMocks.resolveDroidByokProjection.mockReset();
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
});

describe("Droid adapter BYOK projection", () => {
	it("writes the projected customModel, selects it with --model, and injects the key env", async () => {
		byokMocks.resolveDroidByokProjection.mockReturnValue(PROJECTION);

		const launch = await prepareAgentLaunch({
			taskId: "task-byok",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			providerId: "my-relay",
		});

		const settings = readSettings(launch.args);
		expect(settings.customModels).toEqual([PROJECTION.customModel]);

		const modelIdx = launch.args.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(launch.args[modelIdx + 1]).toBe("claude-sonnet-4-5");

		// The real secret is injected as a per-spawn env var, behind the ${...} ref.
		expect(launch.env.KANBAN_DROID_BYOK_API_KEY).toBe("sk-secret-123");
	});

	it("composes BYOK with the existing autonomy + hooks settings generation", async () => {
		byokMocks.resolveDroidByokProjection.mockReturnValue(PROJECTION);

		const launch = await prepareAgentLaunch({
			taskId: "task-byok",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
			providerId: "my-relay",
		});

		const settings = readSettings(launch.args);
		// All three coexist — BYOK does not clobber the adapter's own settings.
		expect(settings.autonomyMode).toBe("auto-high");
		expect(settings.hooks?.Stop).toBeDefined();
		expect(settings.customModels).toEqual([PROJECTION.customModel]);
	});

	it("does not write customModels or --model when there is no BYOK provider (official login)", async () => {
		byokMocks.resolveDroidByokProjection.mockReturnValue(null);

		const launch = await prepareAgentLaunch({
			taskId: "task-official",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settings = readSettings(launch.args);
		expect(settings.customModels).toBeUndefined();
		expect(launch.args).not.toContain("--model");
	});

	it("respects a user-provided --model and does not override it", async () => {
		byokMocks.resolveDroidByokProjection.mockReturnValue(PROJECTION);

		const launch = await prepareAgentLaunch({
			taskId: "task-byok",
			agentId: "droid",
			binary: "droid",
			args: ["--model", "user-chosen-model"],
			cwd: "/tmp",
			prompt: "",
			providerId: "my-relay",
		});

		const modelValues = launch.args.filter((_, i) => launch.args[i - 1] === "--model");
		expect(modelValues).toEqual(["user-chosen-model"]);
	});

	it("propagates a projection error (incompatible/misconfigured provider) as a clear failure", async () => {
		byokMocks.resolveDroidByokProjection.mockImplementation(() => {
			throw new Error("Droid BYOK provider is missing a base URL.");
		});

		await expect(
			prepareAgentLaunch({
				taskId: "task-bad",
				agentId: "droid",
				binary: "droid",
				args: [],
				cwd: "/tmp",
				prompt: "",
				providerId: "broken",
			}),
		).rejects.toThrow(/missing a base URL/);
	});
});
