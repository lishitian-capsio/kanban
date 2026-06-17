import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VaultManagedToggle } from "./vault-managed-toggle";

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

describe("VaultManagedToggle", () => {
	it("reflects the off state and toggles on when clicked", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<VaultManagedToggle managed={false} onChange={onChange} />);
		});

		const toggle = container.querySelector("button[role='switch']");
		expect(toggle).not.toBeNull();
		expect(toggle?.getAttribute("aria-checked")).toBe("false");

		act(() => (toggle as HTMLButtonElement).click());
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("reflects the on state and toggles off when clicked", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<VaultManagedToggle managed={true} onChange={onChange} />);
		});

		const toggle = container.querySelector("button[role='switch']");
		expect(toggle?.getAttribute("aria-checked")).toBe("true");

		act(() => (toggle as HTMLButtonElement).click());
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it("does not fire onChange while disabled", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<VaultManagedToggle managed={false} disabled onChange={onChange} />);
		});

		const toggle = container.querySelector("button[role='switch']");
		expect((toggle as HTMLButtonElement).disabled).toBe(true);
		act(() => (toggle as HTMLButtonElement).click());
		expect(onChange).not.toHaveBeenCalled();
	});
});
