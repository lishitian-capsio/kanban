/**
 * Task ids are already short (a few hex chars, e.g. `0a42e`), so the chip
 * normally shows the full id. This guards against an unexpectedly long id by
 * collapsing the tail to an ellipsis while keeping the leading characters that
 * make it recognizable. Visual width on narrow cards is handled separately by
 * CSS truncation — this is only a hard character cap on the displayed label.
 */
export const TASK_ID_CHIP_MAX_CHARS = 10;

export function formatTaskIdChipLabel(taskId: string, maxChars = TASK_ID_CHIP_MAX_CHARS): string {
	const trimmed = taskId.trim();
	if (maxChars < 1 || trimmed.length <= maxChars) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxChars - 1)}…`;
}
