import { describe, expect, it, vi } from "vitest";

import {
	injectSessionPrompt,
	SESSION_PROMPT_NATIVE_FAILURE,
	SESSION_PROMPT_TERMINAL_SUBMIT_FAILURE,
	SESSION_PROMPT_TERMINAL_TYPE_FAILURE,
	type SessionPromptSenders,
} from "@/git-actions/inject-session-prompt";

function makeSenders(overrides?: Partial<SessionPromptSenders>): SessionPromptSenders {
	return {
		sendTaskChatMessage: vi.fn(async () => ({ ok: true })),
		sendTaskSessionInput: vi.fn(async () => ({ ok: true })),
		...overrides,
	};
}

describe("injectSessionPrompt", () => {
	it("routes native (pi) sessions through the chat-message sender in act mode", async () => {
		const senders = makeSenders();

		const result = await injectSessionPrompt({
			taskId: "task-1",
			prompt: "do the thing",
			agentId: "pi",
			senders,
		});

		expect(result).toEqual({ ok: true });
		expect(senders.sendTaskChatMessage).toHaveBeenCalledWith("task-1", "do the thing", { mode: "act" });
		expect(senders.sendTaskSessionInput).not.toHaveBeenCalled();
	});

	it("honors an explicit mode override for native sessions", async () => {
		const senders = makeSenders();

		await injectSessionPrompt({
			taskId: "task-1",
			prompt: "plan it",
			agentId: "pi",
			senders,
			mode: "plan",
		});

		expect(senders.sendTaskChatMessage).toHaveBeenCalledWith("task-1", "plan it", { mode: "plan" });
	});

	it("surfaces the chat sender's error message on native failure", async () => {
		const senders = makeSenders({
			sendTaskChatMessage: vi.fn(async () => ({ ok: false, message: "session dead" })),
		});

		const result = await injectSessionPrompt({
			taskId: "task-1",
			prompt: "do the thing",
			agentId: "pi",
			senders,
		});

		expect(result).toEqual({ ok: false, message: "session dead" });
	});

	it("falls back to a default message when native failure has no message", async () => {
		const senders = makeSenders({
			sendTaskChatMessage: vi.fn(async () => ({ ok: false })),
		});

		const result = await injectSessionPrompt({
			taskId: "task-1",
			prompt: "do the thing",
			agentId: "pi",
			senders,
		});

		expect(result).toEqual({ ok: false, message: SESSION_PROMPT_NATIVE_FAILURE });
	});

	it("pastes then submits a carriage return for CLI/terminal agents", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const senders = makeSenders({ sendTaskSessionInput });

		const result = await injectSessionPrompt({
			taskId: "task-2",
			prompt: "multi\nline",
			agentId: "claude",
			senders,
			submitDelayMs: 0,
		});

		expect(result).toEqual({ ok: true });
		expect(senders.sendTaskChatMessage).not.toHaveBeenCalled();
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(1, "task-2", "multi\nline", {
			appendNewline: false,
			mode: "paste",
		});
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(2, "task-2", "\r", { appendNewline: false });
	});

	it("stops and reports when the paste step fails for a CLI agent", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: false }));
		const senders = makeSenders({ sendTaskSessionInput });

		const result = await injectSessionPrompt({
			taskId: "task-2",
			prompt: "hello",
			agentId: "claude",
			senders,
			submitDelayMs: 0,
		});

		expect(result).toEqual({ ok: false, message: SESSION_PROMPT_TERMINAL_TYPE_FAILURE });
		expect(sendTaskSessionInput).toHaveBeenCalledTimes(1);
	});

	it("reports a submit failure for a CLI agent", async () => {
		const sendTaskSessionInput = vi
			.fn<SessionPromptSenders["sendTaskSessionInput"]>()
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false, message: "pty gone" });
		const senders = makeSenders({ sendTaskSessionInput });

		const result = await injectSessionPrompt({
			taskId: "task-2",
			prompt: "hello",
			agentId: "claude",
			senders,
			submitDelayMs: 0,
		});

		expect(result).toEqual({ ok: false, message: "pty gone" });
	});

	it("uses a default submit-failure message when none is provided", async () => {
		const sendTaskSessionInput = vi
			.fn<SessionPromptSenders["sendTaskSessionInput"]>()
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false });
		const senders = makeSenders({ sendTaskSessionInput });

		const result = await injectSessionPrompt({
			taskId: "task-2",
			prompt: "hello",
			agentId: "claude",
			senders,
			submitDelayMs: 0,
		});

		expect(result).toEqual({ ok: false, message: SESSION_PROMPT_TERMINAL_SUBMIT_FAILURE });
	});
});
