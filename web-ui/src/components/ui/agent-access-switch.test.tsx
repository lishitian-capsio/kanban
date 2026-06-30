import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentAccessSwitch } from "./agent-access-switch";

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

function switchControl(): HTMLButtonElement {
	const found = container.querySelector<HTMLButtonElement>("button[role='switch']");
	if (!found) {
		throw new Error("No switch control rendered");
	}
	return found;
}

describe("AgentAccessSwitch", () => {
	it("reflects the checked state and renders the label + description", () => {
		act(() => {
			root.render(
				<AgentAccessSwitch
					icon={null}
					label="Allow agents to do the thing"
					description="The thing is allowed."
					checked={true}
					onCheckedChange={vi.fn()}
				/>,
			);
		});

		expect(switchControl().getAttribute("data-state")).toBe("checked");
		expect(container.textContent).toContain("Allow agents to do the thing");
		expect(container.textContent).toContain("The thing is allowed.");
	});

	it("reports the toggled value through onCheckedChange", () => {
		const onCheckedChange = vi.fn();
		act(() => {
			root.render(
				<AgentAccessSwitch
					icon={null}
					label="label"
					description="desc"
					checked={false}
					onCheckedChange={onCheckedChange}
				/>,
			);
		});

		act(() => switchControl().click());
		expect(onCheckedChange).toHaveBeenCalledWith(true);
	});

	it("does not fire onCheckedChange while disabled", () => {
		const onCheckedChange = vi.fn();
		act(() => {
			root.render(
				<AgentAccessSwitch
					icon={null}
					label="label"
					description="desc"
					checked={false}
					disabled
					onCheckedChange={onCheckedChange}
				/>,
			);
		});

		expect(switchControl().disabled).toBe(true);
		act(() => switchControl().click());
		expect(onCheckedChange).not.toHaveBeenCalled();
	});
});
