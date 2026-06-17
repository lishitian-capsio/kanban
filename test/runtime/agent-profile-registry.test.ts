import { describe, expect, it } from "vitest";

import type { RuntimeAgentProfileRecord, RuntimeAgentProfilesData } from "../../src/core/api-contract";
import {
	createAgentProfile,
	deleteAgentProfile,
	getSelectedAgentProfile,
	listAgentProfiles,
	selectAgentProfile,
	updateAgentProfile,
} from "../../src/state/agent-profile-registry";

function record(
	overrides: Partial<RuntimeAgentProfileRecord> & Pick<RuntimeAgentProfileRecord, "id" | "name">,
): RuntimeAgentProfileRecord {
	return {
		agentId: "pi",
		providerId: null,
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

function seed(): RuntimeAgentProfilesData {
	return {
		profiles: [
			record({ id: "p1", name: "Sonnet", agentId: "pi", providerId: "anthropic", modelId: "claude-sonnet-4" }),
			record({ id: "p2", name: "Local", agentId: "pi", providerId: "ollama" }),
			record({ id: "p3", name: "Claude default", agentId: "claude" }),
		],
		selectedByAgent: { pi: "p1" },
	};
}

describe("agent profile registry", () => {
	describe("listAgentProfiles", () => {
		it("returns all profiles sorted by name (case-insensitive) when no agent filter", () => {
			expect(listAgentProfiles(seed()).map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
		});

		it("filters by agentId", () => {
			expect(listAgentProfiles(seed(), "pi").map((p) => p.id)).toEqual(["p2", "p1"]);
			expect(listAgentProfiles(seed(), "claude").map((p) => p.id)).toEqual(["p3"]);
		});

		it("does not mutate the source data", () => {
			const data = seed();
			listAgentProfiles(data);
			expect(data.profiles.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
		});
	});

	describe("createAgentProfile", () => {
		it("appends a new profile", () => {
			const next = createAgentProfile(
				seed(),
				record({ id: "p4", name: "GPT", agentId: "pi", providerId: "openai" }),
			);
			expect(next.profiles.map((p) => p.id)).toContain("p4");
			expect(next.profiles).toHaveLength(4);
		});

		it("does not mutate the source data", () => {
			const data = seed();
			createAgentProfile(data, record({ id: "p4", name: "GPT", agentId: "pi" }));
			expect(data.profiles).toHaveLength(3);
		});

		it("throws when the id already exists", () => {
			expect(() => createAgentProfile(seed(), record({ id: "p1", name: "Other", agentId: "pi" }))).toThrow(
				/already exists/i,
			);
		});

		it("throws when the name collides within the same agent (case-insensitive, trimmed)", () => {
			expect(() => createAgentProfile(seed(), record({ id: "p9", name: "  sonnet ", agentId: "pi" }))).toThrow(
				/name/i,
			);
		});

		it("allows the same name across different agents", () => {
			const next = createAgentProfile(seed(), record({ id: "p9", name: "Sonnet", agentId: "claude" }));
			expect(next.profiles).toHaveLength(4);
		});
	});

	describe("updateAgentProfile", () => {
		it("patches mutable fields", () => {
			const next = updateAgentProfile(seed(), "p2", { modelId: "qwen2.5", reasoningEffort: "high" });
			const updated = next.profiles.find((p) => p.id === "p2");
			expect(updated?.modelId).toBe("qwen2.5");
			expect(updated?.reasoningEffort).toBe("high");
			expect(updated?.providerId).toBe("ollama");
		});

		it("throws when the profile does not exist", () => {
			expect(() => updateAgentProfile(seed(), "missing", { name: "x" })).toThrow(/not found/i);
		});

		it("throws when renaming to a name used by another profile of the same agent", () => {
			expect(() => updateAgentProfile(seed(), "p2", { name: "Sonnet" })).toThrow(/name/i);
		});

		it("allows renaming a profile to its own current name", () => {
			const next = updateAgentProfile(seed(), "p1", { name: "Sonnet" });
			expect(next.profiles.find((p) => p.id === "p1")?.name).toBe("Sonnet");
		});
	});

	describe("deleteAgentProfile", () => {
		it("removes the profile and returns the removed entry", () => {
			const { next, removed } = deleteAgentProfile(seed(), "p2");
			expect(next.profiles.map((p) => p.id)).toEqual(["p1", "p3"]);
			expect(removed.id).toBe("p2");
		});

		it("clears the agent selection when the selected profile is deleted", () => {
			const { next } = deleteAgentProfile(seed(), "p1");
			expect(next.selectedByAgent.pi).toBeUndefined();
		});

		it("leaves the selection intact when a non-selected profile is deleted", () => {
			const { next } = deleteAgentProfile(seed(), "p2");
			expect(next.selectedByAgent.pi).toBe("p1");
		});

		it("throws when the profile does not exist", () => {
			expect(() => deleteAgentProfile(seed(), "missing")).toThrow(/not found/i);
		});
	});

	describe("selectAgentProfile", () => {
		it("sets the selected profile for an agent", () => {
			const next = selectAgentProfile(seed(), "pi", "p2");
			expect(next.selectedByAgent.pi).toBe("p2");
		});

		it("clears the selection when profileId is null", () => {
			const next = selectAgentProfile(seed(), "pi", null);
			expect(next.selectedByAgent.pi).toBeUndefined();
		});

		it("throws when the profile does not exist", () => {
			expect(() => selectAgentProfile(seed(), "pi", "missing")).toThrow(/not found/i);
		});

		it("throws when the profile belongs to a different agent", () => {
			expect(() => selectAgentProfile(seed(), "pi", "p3")).toThrow(/agent/i);
		});
	});

	describe("getSelectedAgentProfile", () => {
		it("returns the selected profile record", () => {
			expect(getSelectedAgentProfile(seed(), "pi")?.id).toBe("p1");
		});

		it("returns null when nothing is selected", () => {
			expect(getSelectedAgentProfile(seed(), "claude")).toBeNull();
		});

		it("returns null when the selected id no longer resolves", () => {
			const data: RuntimeAgentProfilesData = { profiles: [], selectedByAgent: { pi: "ghost" } };
			expect(getSelectedAgentProfile(data, "pi")).toBeNull();
		});
	});
});
