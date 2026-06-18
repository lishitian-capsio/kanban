import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VaultModeSelect } from "./vault-mode-select";

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function optionButtons(): HTMLButtonElement[] {
	return Array.from(container.querySelectorAll<HTMLButtonElement>("button[role='radio']"));
}

function buttonFor(label: string): HTMLButtonElement {
	const found = optionButtons().find((button) => button.textContent?.trim() === label);
	if (!found) {
		throw new Error(`No option button labelled "${label}"`);
	}
	return found;
}

describe("VaultModeSelect", () => {
	it("renders all four tiers and marks the current one selected", () => {
		act(() => {
			root.render(<VaultModeSelect mode="on-demand" onChange={vi.fn()} />);
		});

		const labels = optionButtons().map((button) => button.textContent?.trim());
		expect(labels).toEqual(["Off", "CLI only", "On demand", "Managed"]);
		expect(buttonFor("On demand").getAttribute("aria-checked")).toBe("true");
		expect(buttonFor("Off").getAttribute("aria-checked")).toBe("false");
	});

	it("reports the chosen tier through onChange", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<VaultModeSelect mode="off" onChange={onChange} />);
		});

		act(() => buttonFor("Managed").click());
		expect(onChange).toHaveBeenCalledWith("managed");

		act(() => buttonFor("CLI only").click());
		expect(onChange).toHaveBeenCalledWith("cli-only");
	});

	it("does not fire onChange while disabled", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<VaultModeSelect mode="off" disabled onChange={onChange} />);
		});

		expect(buttonFor("Managed").disabled).toBe(true);
		act(() => buttonFor("Managed").click());
		expect(onChange).not.toHaveBeenCalled();
	});

	it("describes the currently selected tier", () => {
		act(() => {
			root.render(<VaultModeSelect mode="off" onChange={vi.fn()} />);
		});
		expect(container.textContent).toContain("No vault guidance");

		act(() => {
			root.render(<VaultModeSelect mode="managed" onChange={vi.fn()} />);
		});
		expect(container.textContent).toContain("proactively");
	});
});
