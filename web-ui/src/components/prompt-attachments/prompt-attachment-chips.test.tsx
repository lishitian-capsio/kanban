import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptAttachmentChips } from "@/components/prompt-attachments/prompt-attachment-chips";
import type { PromptAttachment } from "@/components/prompt-attachments/use-prompt-file-attachments";

const attachments: PromptAttachment[] = [
	{ id: "1", name: "report.pdf", path: "/repo/.kanban/attachments/t/report-1.pdf", mentionText: "@/x " },
	{ id: "2", name: "spec.md", path: "/repo/.kanban/attachments/t/spec-2.md", mentionText: "@/y " },
];

describe("PromptAttachmentChips", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("renders a chip per attachment showing the original filename", () => {
		act(() => {
			root.render(<PromptAttachmentChips attachments={attachments} onRemove={() => {}} />);
		});
		expect(container.textContent).toContain("report.pdf");
		expect(container.textContent).toContain("spec.md");
	});

	it("renders nothing when there are no attachments", () => {
		act(() => {
			root.render(<PromptAttachmentChips attachments={[]} onRemove={() => {}} />);
		});
		expect(container.querySelector("button")).toBeNull();
	});

	it("calls onRemove with the attachment id when its remove button is clicked", () => {
		const onRemove = vi.fn();
		act(() => {
			root.render(<PromptAttachmentChips attachments={attachments} onRemove={onRemove} />);
		});
		const removeButton = container.querySelector('button[aria-label="Remove report.pdf"]');
		expect(removeButton).not.toBeNull();
		act(() => {
			removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onRemove).toHaveBeenCalledWith("1");
	});
});
