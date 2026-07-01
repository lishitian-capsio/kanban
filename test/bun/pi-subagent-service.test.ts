import { describe, expect, it } from "bun:test";

import type {
	CreatePiAgentRuntimeOptions,
	PiAgentRuntime,
	PiSubagentEventInfo,
} from "../../src/agent-sdk/kanban/pi-agent-runtime";
import { createPiSubagentSessionId } from "../../src/agent-sdk/kanban/pi-subagent-session-id";
import { InMemoryPiTaskSessionService } from "../../src/agent-sdk/kanban/pi-task-session-service";
import type { AgentEvent, AgentMessage } from "../../src/agent-sdk/types";

/**
 * The pi task session service can't be imported under vitest (agent-sdk touches Bun.env at
 * import), so the subagent wiring is covered here with Bun's runner. We inject a fake agent
 * runtime that hands us its `onSubagentEvent` callback, then drive a subagent's event stream
 * directly — no real Agent / LLM.
 */
function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

interface Captured {
	onSubagentEvent: NonNullable<CreatePiAgentRuntimeOptions["onSubagentEvent"]>;
}

function makeServiceWithFakeRuntime(): { service: InMemoryPiTaskSessionService; captured: Captured } {
	const captured = {} as Captured;
	const fakeRuntime: PiAgentRuntime = {
		async startSession() {
			return {
				agent: {} as never,
				taskId: "unused",
				providerId: "openai",
				modelId: "m",
				mode: "act",
				childAgents: new Map(),
				spawnContext: {} as never,
				dispose: async () => {},
			};
		},
		async sendInput() {},
		async stopSession() {},
		async abortSession() {},
		async clearSessions() {},
		getSession() {
			return null;
		},
		async dispose() {},
		subscribeToEvents() {
			return () => {};
		},
	};
	const service = new InMemoryPiTaskSessionService({
		createAgentRuntime: (options: CreatePiAgentRuntimeOptions) => {
			captured.onSubagentEvent = options.onSubagentEvent!;
			return fakeRuntime;
		},
	});
	return { service, captured };
}

describe("pi task session service — subagents", () => {
	const PARENT = "__home_agent__:ws:pi";
	const SUBAGENT_ID = "sub1";
	const COMPOSITE = createPiSubagentSessionId(PARENT, SUBAGENT_ID);

	function info(): PiSubagentEventInfo {
		return { parentTaskId: PARENT, subagentId: SUBAGENT_ID, compositeId: COMPOSITE, label: "Deep dive", modelId: "m" };
	}

	it("projects subagents onto the parent summary WITHOUT creating a phantom top-level session", async () => {
		const { service, captured } = makeServiceWithFakeRuntime();
		await service.startTaskSession({ taskId: PARENT, cwd: "/tmp", prompt: "do it" });

		captured.onSubagentEvent(info(), { type: "agent_start" } as AgentEvent);
		captured.onSubagentEvent(info(), { type: "agent_end", messages: [assistantMessage("done")] } as AgentEvent);

		// The subagent is NOT its own session — listSummaries has only the parent.
		const summaries = service.listSummaries();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.taskId).toBe(PARENT);
		// It IS projected onto the parent's subagents[].
		expect(summaries[0]?.subagents).toHaveLength(1);
		expect(summaries[0]?.subagents?.[0]).toMatchObject({
			subagentId: SUBAGENT_ID,
			sessionId: COMPOSITE,
			label: "Deep dive",
			status: "done",
		});
		// getSummary for the composite id returns null (no top-level summary).
		expect(service.getSummary(COMPOSITE)).toBeNull();

		await service.dispose();
	});

	it("exposes the subagent transcript via the composite session id", async () => {
		const { service, captured } = makeServiceWithFakeRuntime();
		await service.startTaskSession({ taskId: PARENT, cwd: "/tmp", prompt: "do it" });

		captured.onSubagentEvent(info(), { type: "agent_start" } as AgentEvent);
		captured.onSubagentEvent(info(), { type: "agent_end", messages: [assistantMessage("subagent result")] } as AgentEvent);

		const messages = await service.loadTaskSessionMessages(COMPOSITE);
		expect(messages.some((m) => m.role === "assistant" && m.content.includes("subagent result"))).toBe(true);

		await service.dispose();
	});
});
