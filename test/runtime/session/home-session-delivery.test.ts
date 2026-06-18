import { describe, expect, it, vi } from "vitest";

import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { deliverPromptToHomeSession, type HomeSessionDeliveryDeps } from "../../../src/session/home-session-delivery";

function makeDeps(overrides: { piLive?: boolean; terminalLive?: boolean }): {
	deps: HomeSessionDeliveryDeps;
	sendTaskSessionInput: ReturnType<typeof vi.fn>;
	writeInput: ReturnType<typeof vi.fn>;
	launch: ReturnType<typeof vi.fn>;
} {
	const sendTaskSessionInput = vi.fn(async () => null);
	const writeInput = vi.fn(() => null);
	const launch = vi.fn(async () => undefined);
	const deps: HomeSessionDeliveryDeps = {
		piService: {
			hasActiveAgentSession: () => overrides.piLive ?? false,
			sendTaskSessionInput,
		},
		terminalManager: {
			isSessionLive: () => overrides.terminalLive ?? false,
			writeInput,
		},
		launch,
	};
	return { deps, sendTaskSessionInput, writeInput, launch };
}

const piSession = createHomeAgentSessionId("ws1", "pi", "t1");
const claudeSession = createHomeAgentSessionId("ws1", "claude", "t1");

describe("deliverPromptToHomeSession", () => {
	it("enqueues into a live pi session", async () => {
		const { deps, sendTaskSessionInput, launch } = makeDeps({ piLive: true });
		await deliverPromptToHomeSession(deps, piSession, "hi");
		expect(sendTaskSessionInput).toHaveBeenCalledWith(piSession, "hi");
		expect(launch).not.toHaveBeenCalled();
	});

	it("launches a dead pi session", async () => {
		const { deps, sendTaskSessionInput, launch } = makeDeps({ piLive: false });
		await deliverPromptToHomeSession(deps, piSession, "hi");
		expect(sendTaskSessionInput).not.toHaveBeenCalled();
		expect(launch).toHaveBeenCalledWith(piSession, "hi");
	});

	it("writes into a live terminal session with a trailing CR", async () => {
		const { deps, writeInput, launch } = makeDeps({ terminalLive: true });
		await deliverPromptToHomeSession(deps, claudeSession, "hi");
		expect(writeInput).toHaveBeenCalledTimes(1);
		const [taskId, data] = writeInput.mock.calls[0];
		expect(taskId).toBe(claudeSession);
		expect((data as Buffer).toString("utf8")).toBe("hi\r");
		expect(launch).not.toHaveBeenCalled();
	});

	it("relaunches a dead terminal session", async () => {
		const { deps, writeInput, launch } = makeDeps({ terminalLive: false });
		await deliverPromptToHomeSession(deps, claudeSession, "hi");
		expect(writeInput).not.toHaveBeenCalled();
		expect(launch).toHaveBeenCalledWith(claudeSession, "hi");
	});
});
