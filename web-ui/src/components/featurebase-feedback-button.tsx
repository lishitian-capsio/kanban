import { Button } from "@/components/ui/button";
import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";
import { isKanbanOauthAuthenticated, isNativeAgentSelected } from "@/runtime/native-agent";
import type { RuntimeAgentId, RuntimeKanbanProviderSettings } from "@/runtime/types";

interface FeaturebaseFeedbackVisibilityInput {
	selectedAgentId?: RuntimeAgentId | null;
	kanbanProviderSettings?: RuntimeKanbanProviderSettings | null;
	featurebaseFeedbackState?: FeaturebaseFeedbackState;
}

export function canShowFeaturebaseFeedbackButton({
	selectedAgentId,
	kanbanProviderSettings,
	featurebaseFeedbackState,
}: FeaturebaseFeedbackVisibilityInput): boolean {
	const isKanbanAgent = isNativeAgentSelected(selectedAgentId);
	const isAuthenticated = isKanbanOauthAuthenticated(kanbanProviderSettings);
	return isKanbanAgent && isAuthenticated && featurebaseFeedbackState !== undefined;
}

interface FeaturebaseFeedbackButtonProps extends FeaturebaseFeedbackVisibilityInput {
	size?: "sm" | "md";
	variant?: "default" | "primary" | "danger" | "ghost";
	className?: string;
	onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export function FeaturebaseFeedbackButton({
	selectedAgentId,
	kanbanProviderSettings,
	featurebaseFeedbackState,
	size = "sm",
	variant = "default",
	className,
	onClick,
}: FeaturebaseFeedbackButtonProps): React.ReactElement | null {
	if (
		!canShowFeaturebaseFeedbackButton({
			selectedAgentId,
			kanbanProviderSettings,
			featurebaseFeedbackState,
		})
	) {
		return null;
	}

	const isOpening = featurebaseFeedbackState?.authState === "loading";

	return (
		<Button size={size} variant={variant} className={className} onClick={onClick} disabled={isOpening}>
			{isOpening ? "Opening..." : "Send feedback"}
		</Button>
	);
}
