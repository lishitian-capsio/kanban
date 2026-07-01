import { describe, expect, it } from "vitest";
import { applySubagentLifecycle } from "../../src/agent-sdk/kanban/pi-subagent-adapter";
import { createDefaultSummary as makeSummary } from "../../src/agent-sdk/kanban/session-state";
import type { AgentEvent, AgentMessage } from "../../src/agent-sdk/types";

const CTX = { compositeId: "pi-sub#parent#sub1", label: "Investigate flaky test", modelId: "gpt-x" };

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function agentEnd(messages: AgentMessage[], usage?: { inputTokens: number; outputTokens: number; totalTokens: number }): AgentEvent {
	return {
		type: "agent_end",
		messages,
		telemetry: usage ? ({ usage } as any) : undefined,
	} as AgentEvent;
}

describe("applySubagentLifecycle", () => {
	it("creates a running record on first event", () => {
		const parent = makeSummary("__home_agent__:ws:pi");
		const next = applySubagentLifecycle(parent, "sub1", { type: "agent_start" }, CTX);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({
			subagentId: "sub1",
			parentTaskId: "__home_agent__:ws:pi",
			sessionId: CTX.compositeId,
			label: "Investigate flaky test",
			status: "running",
			modelId: "gpt-x",
		});
	});

	it("transitions to done on a clean agent_end and folds token usage", () => {
		const parent = makeSummary("__home_agent__:ws:pi");
		const started = applySubagentLifecycle(parent, "sub1", { type: "agent_start" }, CTX);
		const parentWithSub = { ...parent, subagents: started };
		const done = applySubagentLifecycle(
			parentWithSub,
			"sub1",
			agentEnd([assistantMessage("all fixed")], { inputTokens: 100, outputTokens: 40, totalTokens: 140 }),
			CTX,
		);
		expect(done).toHaveLength(1);
		expect(done[0].status).toBe("done");
		expect(done[0].usage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
	});

	it("transitions to failed when the agent_end carries an error", () => {
		const parent = makeSummary("__home_agent__:ws:pi");
		const errorMessage = { role: "assistant", content: [], errorMessage: "boom" } as unknown as AgentMessage;
		const next = applySubagentLifecycle(parent, "sub1", agentEnd([errorMessage]), CTX);
		expect(next[0].status).toBe("failed");
	});

	it("does not mutate the input array (immutability)", () => {
		const parent = makeSummary("__home_agent__:ws:pi");
		const first = applySubagentLifecycle(parent, "sub1", { type: "agent_start" }, CTX);
		const parentWithSub = { ...parent, subagents: first };
		const second = applySubagentLifecycle(parentWithSub, "sub2", { type: "agent_start" }, {
			...CTX,
			compositeId: "pi-sub#parent#sub2",
		});
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(2);
		expect(first).not.toBe(second);
	});
});
