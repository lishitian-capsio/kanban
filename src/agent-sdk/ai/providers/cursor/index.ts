/**
 * Cursor provider stub — types only.
 *
 * The full Cursor provider implementation is excluded from the embedded source.
 * This file provides the minimal type exports needed for compilation.
 */
import type { StreamOptions, CursorExecHandlers, CursorToolResultHandler } from "../../types";

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	conversationId?: string;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;
}
