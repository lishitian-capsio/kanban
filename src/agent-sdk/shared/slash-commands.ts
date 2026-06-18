export interface KanbanBuiltinSlashCommandDefinition {
	name: string;
	description: string;
}

/**
 * Single source of truth for the builtin `/clear` command name. Both the
 * autocomplete list ({@link KANBAN_BUILTIN_SLASH_COMMANDS}) and the send-layer
 * parser ({@link isKanbanClearSlashCommand}) reference this constant so the
 * command surfaced in the composer is exactly the one the runtime intercepts.
 */
export const KANBAN_CLEAR_SLASH_COMMAND_NAME = "clear";

export const KANBAN_BUILTIN_SLASH_COMMANDS: readonly KanbanBuiltinSlashCommandDefinition[] = [
	{
		name: KANBAN_CLEAR_SLASH_COMMAND_NAME,
		description: "Start a fresh chat session and clear prior context.",
	},
];

function readLeadingSlashCommandName(text: string): string | null {
	const match = text.trim().match(/^\/([^\s]+)\s*$/);
	return match?.[1]?.toLowerCase() ?? null;
}

export function isKanbanClearSlashCommand(text: string): boolean {
	return readLeadingSlashCommandName(text) === KANBAN_CLEAR_SLASH_COMMAND_NAME;
}
