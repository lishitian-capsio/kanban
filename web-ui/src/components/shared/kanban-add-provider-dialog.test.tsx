import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanAddProviderDialog } from "@/components/shared/kanban-add-provider-dialog";

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

/** Find a button whose text content contains the given substring (e.g. protocol toggles with a label + description). */
function findButtonContainingText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("KanbanAddProviderDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function fillRequiredFields(overrides: { baseUrl?: string } = {}): Promise<void> {
		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as HTMLInputElement;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as HTMLInputElement;
		const baseUrlInput = inputs.find(
			(input) => input.placeholder === "https://api.openai.com/v1",
		) as HTMLInputElement;
		const modelInput = inputs.find(
			(input) => input.placeholder === "Type a model ID and press Enter",
		) as HTMLInputElement;
		await act(async () => {
			setInputValue(providerIdInput, "my-provider");
			setInputValue(providerNameInput, "My Provider");
			setInputValue(baseUrlInput, overrides.baseUrl ?? "http://localhost:8000/v1");
			setInputValue(modelInput, "qwen2.5-coder:32b");
		});
	}

	it("shows an inline error and blocks save for an invalid base URL", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={onSubmit}
				/>,
			);
		});

		await fillRequiredFields({ baseUrl: "not a url" });

		expect(document.body.textContent).toContain("Enter a valid http(s) URL.");
		const saveButton = findButtonByText(document.body, "Add provider");
		expect(saveButton?.disabled).toBe(true);
	});

	it("shows an inline error and blocks save for an out-of-range timeout", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={onSubmit}
				/>,
			);
		});

		await fillRequiredFields();

		const timeoutInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "30000",
		) as HTMLInputElement;
		await act(async () => {
			setInputValue(timeoutInput, "5");
		});

		expect(document.body.textContent).toMatch(/Timeout must be between/);
		expect(findButtonByText(document.body, "Add provider")?.disabled).toBe(true);
	});

	it("shows an inline error and blocks save for an invalid custom header name", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={onSubmit}
				/>,
			);
		});

		await fillRequiredFields();

		const addHeaderButton = findButtonByText(document.body, "Add");
		await act(async () => {
			addHeaderButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			addHeaderButton?.click();
		});
		const headerKeyInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "Header name",
		) as HTMLInputElement;
		await act(async () => {
			setInputValue(headerKeyInput, "Bad Header");
		});

		expect(document.body.textContent).toMatch(/Invalid header name/);
		expect(findButtonByText(document.body, "Add provider")?.disabled).toBe(true);
	});

	it("enables save when the user types a model without pressing Enter", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={onSubmit}
				/>,
			);
		});

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as
			| HTMLInputElement
			| undefined;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.openai.com/v1") as
			| HTMLInputElement
			| undefined;
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter") as
			| HTMLInputElement
			| undefined;
		const saveButton = findButtonByText(document.body, "Add provider");

		expect(providerIdInput).toBeDefined();
		expect(providerNameInput).toBeDefined();
		expect(baseUrlInput).toBeDefined();
		expect(modelInput).toBeDefined();
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);

		await act(async () => {
			if (!providerIdInput || !providerNameInput || !baseUrlInput || !modelInput) {
				return;
			}
			setInputValue(providerIdInput, "my-provider");
			setInputValue(providerNameInput, "My Provider");
			setInputValue(baseUrlInput, "http://localhost:8000/v1");
			setInputValue(modelInput, "qwen2.5-coder:32b");
		});

		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		// The endpoint is carried only on `protocols[]` (single source of truth) —
		// the legacy scalar `baseUrl` is no longer part of the write payload.
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "my-provider",
				name: "My Provider",
				protocols: [{ protocol: "openai", baseUrl: "http://localhost:8000/v1" }],
				models: ["qwen2.5-coder:32b"],
				defaultModelId: "qwen2.5-coder:32b",
			}),
		);
		const submitted = (onSubmit.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
		expect(submitted).not.toHaveProperty("baseUrl");
	});

	it("keeps the header key input focused while typing", async () => {
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={async () => ({ ok: true })}
				/>,
			);
		});

		const addHeaderButton = findButtonByText(document.body, "Add");
		expect(addHeaderButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			addHeaderButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			addHeaderButton?.click();
		});

		const headerKeyInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "Header name",
		) as HTMLInputElement | undefined;
		expect(headerKeyInput).toBeDefined();

		headerKeyInput?.focus();

		await act(async () => {
			if (!headerKeyInput) {
				return;
			}
			setInputValue(headerKeyInput, "Authorization");
		});

		expect(document.activeElement).toBe(headerKeyInput);
		expect(headerKeyInput?.value).toBe("Authorization");
	});

	it("hides Anthropic settings until the Anthropic protocol is enabled, then submits the chosen apiKeyField", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={onSubmit}
				/>,
			);
		});

		// Default protocol is OpenAI → no Anthropic settings section.
		expect(findButtonContainingText(document.body, "x-api-key")).toBeNull();

		// Enable the Anthropic protocol.
		const anthropicProtocolButton = findButtonContainingText(document.body, "Anthropic-compatible");
		expect(anthropicProtocolButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			anthropicProtocolButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			anthropicProtocolButton?.click();
		});

		// The Anthropic settings section now exposes both key-header options,
		// defaulting to auth_token.
		const authTokenOption = findButtonContainingText(document.body, "Authorization (Bearer)");
		const apiKeyOption = findButtonContainingText(document.body, "x-api-key");
		expect(authTokenOption?.getAttribute("aria-checked")).toBe("true");
		expect(apiKeyOption?.getAttribute("aria-checked")).toBe("false");

		await act(async () => {
			apiKeyOption?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			apiKeyOption?.click();
		});
		expect(apiKeyOption?.getAttribute("aria-checked")).toBe("true");

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as
			| HTMLInputElement
			| undefined;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.anthropic.com") as
			| HTMLInputElement
			| undefined;
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter") as
			| HTMLInputElement
			| undefined;

		await act(async () => {
			if (!providerIdInput || !providerNameInput || !baseUrlInput || !modelInput) {
				return;
			}
			setInputValue(providerIdInput, "my-relay");
			setInputValue(providerNameInput, "My Relay");
			setInputValue(baseUrlInput, "https://relay.example.com");
			setInputValue(modelInput, "claude-sonnet-4-6");
		});

		const saveButton = findButtonByText(document.body, "Add provider");
		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "my-relay",
				anthropic: { apiKeyField: "api_key" },
			}),
		);
	});

	it("constrains the protocol options to the selected agent's compatibility (anthropic-only)", async () => {
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					agentId="claude"
					onSubmit={async () => ({ ok: true })}
				/>,
			);
		});

		// claude → ["anthropic"]: a single compatible protocol locks the choice,
		// so neither chooser button is rendered.
		expect(findButtonContainingText(document.body, "Anthropic-compatible")).toBeNull();
		expect(findButtonContainingText(document.body, "OpenAI-compatible")).toBeNull();

		// The base URL field reflects the locked anthropic protocol.
		const baseUrlInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "https://api.anthropic.com",
		) as HTMLInputElement | undefined;
		expect(baseUrlInput).toBeDefined();
	});

	it("constrains the protocol options to the selected agent's compatibility (openai-only)", async () => {
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					agentId="codex"
					onSubmit={async () => ({ ok: true })}
				/>,
			);
		});

		// codex → ["openai"]: a single compatible protocol locks the choice, so
		// neither chooser button is rendered.
		expect(findButtonContainingText(document.body, "OpenAI-compatible")).toBeNull();
		expect(findButtonContainingText(document.body, "Anthropic-compatible")).toBeNull();

		// The base URL field reflects the locked openai protocol.
		const baseUrlInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "https://api.openai.com/v1",
		) as HTMLInputElement | undefined;
		expect(baseUrlInput).toBeDefined();
	});

	it("submits the agent-compatible protocol for the selected agent", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					agentId="claude"
					onSubmit={onSubmit}
				/>,
			);
		});

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as
			| HTMLInputElement
			| undefined;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.anthropic.com") as
			| HTMLInputElement
			| undefined;
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter") as
			| HTMLInputElement
			| undefined;

		await act(async () => {
			if (!providerIdInput || !providerNameInput || !baseUrlInput || !modelInput) {
				return;
			}
			setInputValue(providerIdInput, "my-anthropic");
			setInputValue(providerNameInput, "My Anthropic");
			setInputValue(baseUrlInput, "https://relay.example.com");
			setInputValue(modelInput, "claude-opus-4");
		});

		const saveButton = findButtonByText(document.body, "Add provider");
		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				protocols: [{ protocol: "anthropic", baseUrl: "https://relay.example.com" }],
			}),
		);
	});

	it("hides the protocol/base-URL inputs and shows a capability note for a vendor agent (gemini)", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					agentId="gemini"
					onSubmit={onSubmit}
				/>,
			);
		});

		// gemini is a vendor agent: no generic protocol/base-URL selection, just a note.
		expect(findButtonContainingText(document.body, "OpenAI-compatible")).toBeNull();
		expect(findButtonContainingText(document.body, "Anthropic-compatible")).toBeNull();
		expect(document.body.querySelector('[data-testid="vendor-capability-note"]')?.textContent).toMatch(/Gemini/);
		// No base-URL input is rendered.
		const inputs = Array.from(document.body.querySelectorAll("input"));
		expect(inputs.find((input) => input.placeholder?.includes("api.openai.com"))).toBeUndefined();
		// Gemini still surfaces an API key field (identified by its reveal toggle).
		expect(document.body.querySelector('[aria-label="Show API key"]')).toBeInstanceOf(HTMLButtonElement);

		// Submitting requires only id + name + a model — and never sends protocols/baseUrl.
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as HTMLInputElement;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as HTMLInputElement;
		const modelInput = inputs.find(
			(input) => input.placeholder === "Type a model ID and press Enter",
		) as HTMLInputElement;
		await act(async () => {
			setInputValue(providerIdInput, "google");
			setInputValue(providerNameInput, "Google");
			setInputValue(modelInput, "gemini-2.5-pro");
		});
		const saveButton = findButtonByText(document.body, "Add provider");
		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const geminiCalls = onSubmit.mock.calls as unknown as Array<[{ protocols?: unknown; models: string[] }]>;
		const payload = geminiCalls[0]?.[0];
		expect(payload?.protocols).toBeUndefined();
		expect(payload?.models).toContain("gemini-2.5-pro");
	});

	it("hides the API key field for kiro (official login) and submits with a model only", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));
		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					agentId="kiro"
					onSubmit={onSubmit}
				/>,
			);
		});

		expect(document.body.querySelector('[data-testid="vendor-capability-note"]')?.textContent).toMatch(/Kiro/);
		// Kiro v1: no API key field (no reveal toggle), no protocol/base-URL inputs.
		expect(document.body.querySelector('[aria-label="Show API key"]')).toBeNull();
		expect(findButtonContainingText(document.body, "OpenAI-compatible")).toBeNull();

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as HTMLInputElement;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as HTMLInputElement;
		const modelInput = inputs.find(
			(input) => input.placeholder === "Type a model ID and press Enter",
		) as HTMLInputElement;
		await act(async () => {
			setInputValue(providerIdInput, "kiro");
			setInputValue(providerNameInput, "Kiro");
			setInputValue(modelInput, "kiro-default");
		});
		const saveButton = findButtonByText(document.body, "Add provider");
		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const kiroCalls = onSubmit.mock.calls as unknown as Array<[{ protocols?: unknown; apiKey?: unknown }]>;
		const payload = kiroCalls[0]?.[0];
		expect(payload?.protocols).toBeUndefined();
	});

	it("updates capability toggle state and submits the selected capabilities", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<KanbanAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={onSubmit}
				/>,
			);
		});

		const visionButton = findButtonByText(document.body, "vision");
		const streamingButton = findButtonByText(document.body, "streaming");
		expect(visionButton?.getAttribute("aria-pressed")).toBe("false");
		expect(streamingButton?.getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			visionButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			visionButton?.click();
			streamingButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			streamingButton?.click();
		});

		expect(visionButton?.getAttribute("aria-pressed")).toBe("true");
		expect(streamingButton?.getAttribute("aria-pressed")).toBe("false");

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as
			| HTMLInputElement
			| undefined;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.openai.com/v1") as
			| HTMLInputElement
			| undefined;
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter") as
			| HTMLInputElement
			| undefined;
		const saveButton = findButtonByText(document.body, "Add provider");

		await act(async () => {
			if (!providerIdInput || !providerNameInput || !baseUrlInput || !modelInput) {
				return;
			}
			setInputValue(providerIdInput, "my-provider");
			setInputValue(providerNameInput, "My Provider");
			setInputValue(baseUrlInput, "http://localhost:8000/v1");
			setInputValue(modelInput, "qwen2.5-coder:32b");
		});

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilities: ["tools", "vision"],
			}),
		);
	});
});
