import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";
import { useWikilinkEditorCompletion, WIKILINK_SEARCH_DEBOUNCE_MS } from "./use-wikilink-editor-completion";

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
	vi.useFakeTimers();
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
	vi.useRealTimers();
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
	// Flush the debounced search so matches reflect the typed token.
	act(() => {
		vi.advanceTimersByTime(WIKILINK_SEARCH_DEBOUNCE_MS + 20);
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

	it("debounces the fuzzy search (matches only narrow after the delay)", () => {
		act(() => root.render(<Harness />));
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		// Type a narrowing query but do NOT advance the debounce timer yet.
		act(() => {
			nativeSetValue?.call(textarea, "See [[Ac");
			textarea.selectionStart = "See [[Ac".length;
			textarea.selectionEnd = "See [[Ac".length;
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		// Menu is open immediately, but ranking still reflects the pre-debounce
		// (empty) term: both linkable docs show before the timer fires.
		const beforeDelay = Array.from(container.querySelectorAll('[data-testid="menu"] button')).map(
			(b) => b.textContent,
		);
		expect(beforeDelay).toEqual(["Acme Corp", "Beta Industries"]);
		// Once the debounce fires, the query narrows the list.
		act(() => {
			vi.advanceTimersByTime(WIKILINK_SEARCH_DEBOUNCE_MS + 20);
		});
		const afterDelay = Array.from(container.querySelectorAll('[data-testid="menu"] button')).map(
			(b) => b.textContent,
		);
		expect(afterDelay).toEqual(["Acme Corp"]);
	});

	it("keeps a typed label when completing", () => {
		act(() => root.render(<Harness />));
		type("[[Ac|the client");
		const button = container.querySelector('button[data-id="a"]') as HTMLButtonElement;
		act(() => button.click());
		expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("[[Acme Corp|the client]]");
	});
});
