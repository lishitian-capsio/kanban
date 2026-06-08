export interface KanbanBuiltinSlashCommandDefinition {
	name: string;
	description: string;
}

export const KANBAN_BUILTIN_SLASH_COMMANDS: readonly KanbanBuiltinSlashCommandDefinition[] = [
	{
		name: "clear",
		description: "Start a fresh chat session and clear prior context.",
	},
];

function readLeadingSlashCommandName(text: string): string | null {
	const match = text.trim().match(/^\/([^\s]+)\s*$/);
	return match?.[1]?.toLowerCase() ?? null;
}

export function isKanbanClearSlashCommand(text: string): boolean {
	return readLeadingSlashCommandName(text) === "clear";
}
