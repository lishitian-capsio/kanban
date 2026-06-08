import { isKanbanProviderAuthenticated } from "@/runtime/native-agent";
import type { RuntimeAgentId, RuntimeKanbanProviderSettings } from "@/runtime/types";

export function isSelectedAgentAuthenticated(
	selectedAgentId: RuntimeAgentId | null | undefined,
	kanbanProviderSettings: RuntimeKanbanProviderSettings | null | undefined,
): boolean {
	if (selectedAgentId !== "pi") {
		return true;
	}
	return isKanbanProviderAuthenticated(kanbanProviderSettings);
}

export function shouldShowStartupOnboardingDialog(input: { hasShownOnboardingDialog: boolean }): boolean {
	if (!input.hasShownOnboardingDialog) {
		return true;
	}
	return false;
}
