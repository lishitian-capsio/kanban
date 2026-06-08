import { describe, expect, it } from "vitest";

import { isSelectedAgentAuthenticated, shouldShowStartupOnboardingDialog } from "@/runtime/onboarding";

describe("runtime onboarding helpers", () => {
	it("treats non-pi selections as authenticated", () => {
		expect(isSelectedAgentAuthenticated("claude", null)).toBe(true);
		expect(isSelectedAgentAuthenticated("codex", null)).toBe(true);
	});

	it("checks pi authentication from provider settings", () => {
		expect(
			isSelectedAgentAuthenticated("pi", {
				providerId: null,
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: false,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(false);
		expect(
			isSelectedAgentAuthenticated("pi", {
				providerId: "anthropic",
				modelId: "claude-3-7-sonnet",
				baseUrl: null,
				apiKeyConfigured: true,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			}),
		).toBe(true);
	});

	it("shows startup onboarding at least once for configured users", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: false,
			}),
		).toBe(true);
	});

	it("does not reopen startup onboarding after it has been shown", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
			}),
		).toBe(false);
	});
});
