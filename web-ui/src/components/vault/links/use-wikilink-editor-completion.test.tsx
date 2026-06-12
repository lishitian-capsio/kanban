import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";
import { useWikilinkEditorCompletion } from "./use-wikilink-editor-completion";

function doc(id: string, name: string, type = "customer"): VaultDoc {
	return { id, type, name, frontmatter: {}, body: "", relativePath: `docs/${id}.md`, createdAt: 0, updatedAt: 0 };
}

const CANDIDATES = [doc("a", "Acme Corp"), doc("b", "Beta Industries"), doc("self", "Current Doc", "requirement")];

function Harness(): React.ReactElement {
	const [value, setValue] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	const completion = useWikilinkEditorCompletion({
		value,
		onChange: setValue,
		candidates: CANDIDATES,
		currentDocId: "self",
		getTextarea: () => ref.current,
	});
	return (
		<div>
			<textarea
				ref={ref}
				value={value}
				onChange={(event) => {
					setValue(event.target.value);
					completion.syncCaret();
				}}
				onKeyUp={() => completion.syncCaret()}
				onKeyDown={completion.handleKeyDown}
			/>
			{completion.open ? (
				<ul data-testid="menu">
					{completion.items.map((item) => (
						<li key={item.id}>
							<button type="button" data-id={item.id} onClick={() => completion.selectItem(item)}>
								{item.label}
							</button>
						</li>
					))}
					{completion.items.length === 0 ? <li data-testid="empty">{completion.emptyMessage}</li> : null}
				</ul>
			) : null}
		</div>
	);
}

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

const nativeSetValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

function type(text: string, caret = text.length): void {
	const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
	act(() => {
		nativeSetValue?.call(textarea, text);
		textarea.selectionStart = caret;
		textarea.selectionEnd = caret;
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("useWikilinkEditorCompletion", () => {
	it("stays closed until a [[ token is opened", () => {
		act(() => root.render(<Harness />));
		expect(container.querySelector('[data-testid="menu"]')).toBeNull();
		type("no links here");
		expect(container.querySelector('[data-testid="menu"]')).toBeNull();
	});

	it("opens and fuzzy-matches candidates when typing inside [[", () => {
		act(() => root.render(<Harness />));
		type("See [[Ac");
		const labels = Array.from(container.querySelectorAll('[data-testid="menu"] button')).map((b) => b.textContent);
		expect(labels).toEqual(["Acme Corp"]);
	});

	it("excludes the current document from candidates", () => {
		act(() => root.render(<Harness />));
		type("[[Current");
		expect(container.querySelector('[data-testid="empty"]')).not.toBeNull();
	});

	it("inserts the chosen candidate as a closed wikilink", () => {
		act(() => root.render(<Harness />));
		type("See [[Ac");
		const button = container.querySelector('[data-testid="menu"] button[data-id="a"]') as HTMLButtonElement;
		act(() => button.click());
		expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("See [[Acme Corp]]");
		// Menu closes once the link is completed.
		expect(container.querySelector('[data-testid="menu"]')).toBeNull();
	});

	it("keeps a typed label when completing", () => {
		act(() => root.render(<Harness />));
		type("[[Ac|the client");
		const button = container.querySelector('button[data-id="a"]') as HTMLButtonElement;
		act(() => button.click());
		expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("[[Acme Corp|the client]]");
	});
});
