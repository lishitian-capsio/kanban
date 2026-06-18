import { describe, expect, it } from "vitest";

import {
	isKanbanClearSlashCommand,
	KANBAN_BUILTIN_SLASH_COMMANDS,
	KANBAN_CLEAR_SLASH_COMMAND_NAME,
} from "../../src/agent-sdk/shared/slash-commands";

describe("kanban builtin slash commands", () => {
	it("exposes the clear command with a description for autocomplete", () => {
		const clear = KANBAN_BUILTIN_SLASH_COMMANDS.find((command) => command.name === KANBAN_CLEAR_SLASH_COMMAND_NAME);
		expect(clear).toBeDefined();
		expect(clear?.description.length ?? 0).toBeGreaterThan(0);
	});

	it("recognizes the same name from the single-source constant", () => {
		// The parser and the listed command must agree on the name so the
		// autocompleted command is the one the send layer actually intercepts.
		expect(isKanbanClearSlashCommand(`/${KANBAN_CLEAR_SLASH_COMMAND_NAME}`)).toBe(true);
		expect(isKanbanClearSlashCommand(`  /${KANBAN_CLEAR_SLASH_COMMAND_NAME}  `)).toBe(true);
	});

	it("does not match unrelated text", () => {
		expect(isKanbanClearSlashCommand("/cleared please")).toBe(false);
		expect(isKanbanClearSlashCommand("hello")).toBe(false);
	});
});
