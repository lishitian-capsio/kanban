# Home Thread IM Channel Binding — UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional "绑定 IM(可选)" entry to the new-thread create dialog (platform → paste chatId → `thread.imChannel`), plus bind/unbind management on existing threads via the kebab — reusing T4's tRPC endpoints with zero backend change.

**Architecture:** Three small new components under `web-ui/src/components/im/` (a pure util, a display chip, a controlled picker) plus a bind/unbind dialog. The create dialog stores a local `imChannel` and passes it through `onCreate`; `use-home-threads.createThread` binds *after* a successful create (best-effort, non-fatal). Existing-thread management adds a kebab button opening the bind dialog wired to new hook mutations.

**Tech Stack:** React, TypeScript, Radix UI (`@radix-ui/react-select`, dialog/dropdown-menu wrappers), Tailwind design tokens, Lucide icons, Vitest (`createRoot`+`act`, no testing-library), tRPC proxy client.

## Global Constraints

- **Zero backend change.** Do NOT touch `src/im/`, `src/core/api-contract.ts`, or any tRPC router. Only consume the existing `runtime.bindHomeThreadImChannel` / `unbindHomeThreadImChannel`.
- **No new backend type export.** Derive the target type in web-ui: `ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"]`, `ImPlatform = ImChannelTarget["platform"]` (both reachable via `@/runtime/types` which re-exports `@runtime-contract`).
- **Design system:** dark theme only (no `dark:` prefix). Tokens: `bg-surface-{0..4}`, `text-text-{primary,secondary,tertiary}`, `border-border{,-bright,-focus}`, `rounded-{sm,md,lg}`, `accent`, `status-*`. Icons `size={12..16}`.
- **No live chat listing.** Interaction is paste-chatId + type inference only (T4 has no listChats/discovery API).
- **No `any`.** No inline/dynamic imports. Prefer SDK/contract types over local redefinitions.
- **Git:** per repo AGENTS.md, **never `git commit` unless the user asks.** Each task's final step **stages** changes (`git add`) as a reviewable checkpoint; hold the actual commit for the user.
- **Commands run from `web-ui/`:** tests `npx vitest run <path>`, types `npm run typecheck`.

---

### Task 1: `im-channel.ts` — platform labels + type inference (pure)

**Files:**
- Create: `web-ui/src/components/im/im-channel.ts`
- Test: `web-ui/src/components/im/im-channel.test.ts`

**Interfaces:**
- Consumes: `RuntimeHomeChatThreadBindImChannelRequest` from `@/runtime/types`.
- Produces:
  - `type ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"]` (`{ platform: "lark"|"dingtalk"; chatId: string }`)
  - `type ImPlatform = ImChannelTarget["platform"]`
  - `const IM_PLATFORM_LABELS: Record<ImPlatform, string>`
  - `const IM_PLATFORM_OPTIONS: { value: ImPlatform; label: string }[]`
  - `function inferLarkKindLabel(chatId: string): string`
  - `function describeImChannel(target: ImChannelTarget): { platformLabel: string; kindLabel: string }`

- [ ] **Step 1: Write the failing test**

Create `web-ui/src/components/im/im-channel.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
	describeImChannel,
	IM_PLATFORM_LABELS,
	IM_PLATFORM_OPTIONS,
	inferLarkKindLabel,
} from "@/components/im/im-channel";

describe("inferLarkKindLabel", () => {
	it("maps Lark id prefixes to a human kind label", () => {
		expect(inferLarkKindLabel("oc_123")).toBe("群聊");
		expect(inferLarkKindLabel("ou_123")).toBe("单聊");
		expect(inferLarkKindLabel("on_123")).toBe("union");
		expect(inferLarkKindLabel("someone@example.com")).toBe("邮箱");
		expect(inferLarkKindLabel("unprefixed")).toBe("群聊");
	});

	it("ignores surrounding whitespace", () => {
		expect(inferLarkKindLabel("  oc_123  ")).toBe("群聊");
	});
});

describe("IM_PLATFORM_LABELS / OPTIONS", () => {
	it("labels every platform in Chinese", () => {
		expect(IM_PLATFORM_LABELS.lark).toBe("飞书");
		expect(IM_PLATFORM_LABELS.dingtalk).toBe("钉钉");
	});

	it("derives options from the label map", () => {
		expect(IM_PLATFORM_OPTIONS).toEqual(
			expect.arrayContaining([
				{ value: "lark", label: "飞书" },
				{ value: "dingtalk", label: "钉钉" },
			]),
		);
	});
});

describe("describeImChannel", () => {
	it("describes a Lark group channel", () => {
		expect(describeImChannel({ platform: "lark", chatId: "oc_abc" })).toEqual({
			platformLabel: "飞书",
			kindLabel: "群聊",
		});
	});

	it("uses a generic kind for DingTalk (webhook robot, no chat kind)", () => {
		expect(describeImChannel({ platform: "dingtalk", chatId: "anything" })).toEqual({
			platformLabel: "钉钉",
			kindLabel: "群",
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run src/components/im/im-channel.test.ts`
Expected: FAIL — cannot resolve `@/components/im/im-channel`.

- [ ] **Step 3: Write minimal implementation**

Create `web-ui/src/components/im/im-channel.ts`:

```ts
import type { RuntimeHomeChatThreadBindImChannelRequest } from "@/runtime/types";

/**
 * The platform-agnostic IM binding descriptor from the backend (T4). Derived from the
 * bind-request contract so web-ui never redefines the shape — `api-contract` imports
 * `imChannelTargetSchema` but does not re-export the type, so this projection is the
 * canonical web-ui alias.
 */
export type ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"];
export type ImPlatform = ImChannelTarget["platform"];

/** Chinese display labels. `Record<ImPlatform, …>` forces compile-time coverage of every platform. */
export const IM_PLATFORM_LABELS: Record<ImPlatform, string> = {
	lark: "飞书",
	dingtalk: "钉钉",
};

export interface ImPlatformOption {
	value: ImPlatform;
	label: string;
}

export const IM_PLATFORM_OPTIONS: ImPlatformOption[] = (
	Object.entries(IM_PLATFORM_LABELS) as [ImPlatform, string][]
).map(([value, label]) => ({ value, label }));

/**
 * Mirrors the backend `inferLarkReceiveIdType` (src/im/lark/lark-message-format.ts) as a
 * presentation label. Kept in web-ui deliberately — a ~5-line display mapping, not shared logic.
 */
export function inferLarkKindLabel(chatId: string): string {
	const id = chatId.trim();
	if (id.startsWith("oc_")) return "群聊";
	if (id.startsWith("ou_")) return "单聊";
	if (id.startsWith("on_")) return "union";
	if (id.includes("@")) return "邮箱";
	return "群聊";
}

export function describeImChannel(target: ImChannelTarget): { platformLabel: string; kindLabel: string } {
	const platformLabel = IM_PLATFORM_LABELS[target.platform] ?? target.platform;
	// DingTalk delivery is a webhook robot bound to one conversation — no chat-kind concept.
	const kindLabel = target.platform === "lark" ? inferLarkKindLabel(target.chatId) : "群";
	return { platformLabel, kindLabel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run src/components/im/im-channel.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `cd web-ui && npm run typecheck`
Expected: no errors. (Confirms `RuntimeHomeChatThreadBindImChannelRequest` resolves and the platform union is exactly `lark|dingtalk`.)

- [ ] **Step 6: Stage**

```bash
git add web-ui/src/components/im/im-channel.ts web-ui/src/components/im/im-channel.test.ts
```

---

### Task 2: `im-channel-chip.tsx` — bound-channel display chip

**Files:**
- Create: `web-ui/src/components/im/im-channel-chip.tsx`
- Test: `web-ui/src/components/im/im-channel-chip.test.tsx`

**Interfaces:**
- Consumes: `describeImChannel`, `ImChannelTarget` from Task 1.
- Produces: `function ImChannelChip(props: { channel: ImChannelTarget; onUnbind?: () => void; className?: string }): React.ReactElement`
  - When `onUnbind` is provided, renders a remove button with `aria-label={`解绑 ${platformLabel} · ${kindLabel}`}`.

- [ ] **Step 1: Write the failing test**

Create `web-ui/src/components/im/im-channel-chip.test.tsx`:

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelChip } from "@/components/im/im-channel-chip";

describe("ImChannelChip", () => {
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

	it("shows the platform, kind, and chat id", () => {
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc123" }} />);
		});
		expect(container.textContent).toContain("飞书");
		expect(container.textContent).toContain("群聊");
		expect(container.textContent).toContain("oc_abc123");
	});

	it("renders no unbind button without onUnbind", () => {
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc" }} />);
		});
		expect(container.querySelector("button")).toBeNull();
	});

	it("calls onUnbind when the remove button is clicked", () => {
		const onUnbind = vi.fn();
		act(() => {
			root.render(<ImChannelChip channel={{ platform: "lark", chatId: "oc_abc" }} onUnbind={onUnbind} />);
		});
		const button = container.querySelector('button[aria-label="解绑 飞书 · 群聊"]');
		expect(button).not.toBeNull();
		act(() => {
			button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onUnbind).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run src/components/im/im-channel-chip.test.tsx`
Expected: FAIL — cannot resolve `@/components/im/im-channel-chip`.

- [ ] **Step 3: Write minimal implementation**

Create `web-ui/src/components/im/im-channel-chip.tsx`:

```tsx
import { MessageCircle, X } from "lucide-react";
import type { ReactElement } from "react";

import { describeImChannel, type ImChannelTarget } from "@/components/im/im-channel";
import { cn } from "@/components/ui/cn";

interface ImChannelChipProps {
	channel: ImChannelTarget;
	onUnbind?: () => void;
	className?: string;
}

export function ImChannelChip({ channel, onUnbind, className }: ImChannelChipProps): ReactElement {
	const { platformLabel, kindLabel } = describeImChannel(channel);
	const label = `${platformLabel} · ${kindLabel}`;
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-secondary",
				className,
			)}
		>
			<MessageCircle size={13} className="shrink-0 text-text-tertiary" />
			<span className="shrink-0">{label}</span>
			<span className="max-w-[160px] truncate font-mono text-text-tertiary" title={channel.chatId}>
				{channel.chatId}
			</span>
			{onUnbind ? (
				<button
					type="button"
					onClick={onUnbind}
					aria-label={`解绑 ${label}`}
					className="shrink-0 cursor-pointer text-text-tertiary transition-colors hover:text-text-primary"
				>
					<X size={12} />
				</button>
			) : null}
		</span>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run src/components/im/im-channel-chip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add web-ui/src/components/im/im-channel-chip.tsx web-ui/src/components/im/im-channel-chip.test.tsx
```

---

### Task 3: `im-channel-picker.tsx` — platform select + chatId input (controlled)

**Files:**
- Create: `web-ui/src/components/im/im-channel-picker.tsx`
- Test: `web-ui/src/components/im/im-channel-picker.test.tsx`

**Interfaces:**
- Consumes: `IM_PLATFORM_OPTIONS`, `inferLarkKindLabel`, `ImChannelTarget`, `ImPlatform` from Task 1.
- Produces: `function ImChannelPicker(props: { value: ImChannelTarget | null; onChange: (value: ImChannelTarget | null) => void; disabled?: boolean }): React.ReactElement`
  - chatId input has `aria-label="IM chat ID"`.
  - Emits `{ platform, chatId }` (trimmed) when chatId is non-empty; emits `null` when empty.
  - Platform selection persists locally even when chatId is empty.

- [ ] **Step 1: Write the failing test**

Create `web-ui/src/components/im/im-channel-picker.test.tsx`:

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelPicker } from "@/components/im/im-channel-picker";

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ImChannelPicker", () => {
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

	it("emits a lark target (default platform) when a chatId is typed", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<ImChannelPicker value={null} onChange={onChange} />);
		});
		const input = container.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		expect(input).not.toBeNull();
		act(() => {
			setInputValue(input, "oc_group1");
		});
		expect(onChange).toHaveBeenLastCalledWith({ platform: "lark", chatId: "oc_group1" });
	});

	it("emits null when the chatId is cleared", () => {
		const onChange = vi.fn();
		act(() => {
			root.render(<ImChannelPicker value={{ platform: "lark", chatId: "oc_group1" }} onChange={onChange} />);
		});
		const input = container.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		act(() => {
			setInputValue(input, "   ");
		});
		expect(onChange).toHaveBeenLastCalledWith(null);
	});

	it("shows the inferred Lark kind for the typed chatId", () => {
		act(() => {
			root.render(<ImChannelPicker value={{ platform: "lark", chatId: "ou_person" }} onChange={() => {}} />);
		});
		expect(container.textContent).toContain("单聊");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run src/components/im/im-channel-picker.test.tsx`
Expected: FAIL — cannot resolve `@/components/im/im-channel-picker`.

- [ ] **Step 3: Write minimal implementation**

Create `web-ui/src/components/im/im-channel-picker.tsx`:

```tsx
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import {
	IM_PLATFORM_OPTIONS,
	type ImChannelTarget,
	type ImPlatform,
	inferLarkKindLabel,
} from "@/components/im/im-channel";
import { cn } from "@/components/ui/cn";

interface ImChannelPickerProps {
	value: ImChannelTarget | null;
	onChange: (value: ImChannelTarget | null) => void;
	disabled?: boolean;
}

export function ImChannelPicker({ value, onChange, disabled }: ImChannelPickerProps): ReactElement {
	// Platform is held locally so a selection survives an empty chatId (when the emitted
	// value is null). Re-seed only when the controlled value's primitives actually change —
	// keying the effect on primitives (not the object) means typing never resets local state.
	const [platform, setPlatform] = useState<ImPlatform>(value?.platform ?? "lark");
	const [chatId, setChatId] = useState<string>(value?.chatId ?? "");

	useEffect(() => {
		setPlatform(value?.platform ?? "lark");
		setChatId(value?.chatId ?? "");
	}, [value?.platform, value?.chatId]);

	const emit = (nextPlatform: ImPlatform, nextChatId: string) => {
		const trimmed = nextChatId.trim();
		onChange(trimmed ? { platform: nextPlatform, chatId: trimmed } : null);
	};

	const handlePlatform = (next: string) => {
		const nextPlatform = next as ImPlatform;
		setPlatform(nextPlatform);
		emit(nextPlatform, chatId);
	};

	const handleChatId = (raw: string) => {
		setChatId(raw);
		emit(platform, raw);
	};

	const handleClear = () => {
		setChatId("");
		onChange(null);
	};

	const trimmedChatId = chatId.trim();
	const kindHint = platform === "lark" && trimmedChatId ? inferLarkKindLabel(trimmedChatId) : null;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<RadixSelect.Root value={platform} onValueChange={handlePlatform} disabled={disabled}>
					<RadixSelect.Trigger
						aria-label="IM platform"
						className="flex h-8 w-28 shrink-0 items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 focus:border-border-focus disabled:opacity-50"
					>
						<RadixSelect.Value />
						<RadixSelect.Icon>
							<ChevronDown size={14} className="text-text-tertiary" />
						</RadixSelect.Icon>
					</RadixSelect.Trigger>
					<RadixSelect.Portal>
						<RadixSelect.Content
							className="z-50 overflow-hidden rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
							position="popper"
							sideOffset={4}
							align="start"
						>
							<RadixSelect.Viewport>
								{IM_PLATFORM_OPTIONS.map((option) => (
									<RadixSelect.Item
										key={option.value}
										value={option.value}
										className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
									>
										<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
										<RadixSelect.ItemIndicator className="ml-auto">
											<Check size={14} className="text-accent" />
										</RadixSelect.ItemIndicator>
									</RadixSelect.Item>
								))}
							</RadixSelect.Viewport>
						</RadixSelect.Content>
					</RadixSelect.Portal>
				</RadixSelect.Root>

				<div className="relative flex-1">
					<input
						type="text"
						aria-label="IM chat ID"
						value={chatId}
						disabled={disabled}
						onChange={(event) => handleChatId(event.target.value)}
						placeholder="粘贴群 / 单聊 ID，如 oc_…"
						className="h-8 w-full rounded-md border border-border-bright bg-surface-2 px-2.5 pr-7 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus disabled:opacity-50"
					/>
					{trimmedChatId ? (
						<button
							type="button"
							onClick={handleClear}
							disabled={disabled}
							aria-label="清除 IM chat ID"
							className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-text-tertiary hover:text-text-primary"
						>
							<X size={13} />
						</button>
					) : null}
				</div>
			</div>

			<p className="text-[11px] text-text-tertiary">
				{kindHint ? (
					<>
						识别为:<span className="text-text-secondary">{kindHint}</span>
					</>
				) : (
					"飞书群设置 → 更多 → 复制群 ID。留空表示不绑定。"
				)}
			</p>
		</div>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run src/components/im/im-channel-picker.test.tsx`
Expected: PASS (tests drive the chatId input directly and never open the Radix Select portal).

- [ ] **Step 5: Stage**

```bash
git add web-ui/src/components/im/im-channel-picker.tsx web-ui/src/components/im/im-channel-picker.test.tsx
```

---

### Task 4: `im-channel-bind-dialog.tsx` — existing-thread bind/unbind dialog

**Files:**
- Create: `web-ui/src/components/im/im-channel-bind-dialog.tsx`
- Test: `web-ui/src/components/im/im-channel-bind-dialog.test.tsx`

**Interfaces:**
- Consumes: `ImChannelPicker` (Task 3), `ImChannelChip` (Task 2), `ImChannelTarget` (Task 1), `HomeThread` from `@/hooks/use-home-threads`, `Dialog`/`DialogHeader`/`DialogBody`/`DialogFooter` from `@/components/ui/dialog`, `Button` from `@/components/ui/button`.
- Produces: `function ImChannelBindDialog(props: { thread: HomeThread | null; onOpenChange: (open: boolean) => void; onBind: (threadId: string, channel: ImChannelTarget) => void | Promise<void>; onUnbind: (threadId: string) => void | Promise<void> }): React.ReactElement`
  - Open iff `thread !== null` (mirrors `HomeThreadRenameDialog`).
  - Bind button label: `更新绑定` when already bound, else `绑定`; disabled unless the draft differs from the current binding.

- [ ] **Step 1: Write the failing test**

Create `web-ui/src/components/im/im-channel-bind-dialog.test.tsx`:

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImChannelBindDialog } from "@/components/im/im-channel-bind-dialog";
import type { HomeThread } from "@/hooks/use-home-threads";

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeThread(overrides: Partial<HomeThread> = {}): HomeThread {
	return {
		id: "thread-1",
		agentId: "claude",
		name: "Thread 1",
		titleSource: "manual",
		createdAt: 1,
		updatedAt: 1,
		isDefault: false,
		...overrides,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ImChannelBindDialog", () => {
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

	it("binds a new channel from an unbound thread", async () => {
		const onBind = vi.fn(async () => {});
		await act(async () => {
			root.render(
				<ImChannelBindDialog thread={makeThread()} onOpenChange={() => {}} onBind={onBind} onUnbind={vi.fn()} />,
			);
			await flush();
		});
		const input = document.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		await act(async () => {
			setInputValue(input, "oc_new");
			await flush();
		});
		const bindButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "绑定",
		);
		expect(bindButton).toBeTruthy();
		await act(async () => {
			bindButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onBind).toHaveBeenCalledWith("thread-1", { platform: "lark", chatId: "oc_new" });
	});

	it("shows the current binding and unbinds it", async () => {
		const onUnbind = vi.fn(async () => {});
		await act(async () => {
			root.render(
				<ImChannelBindDialog
					thread={makeThread({ imChannel: { platform: "lark", chatId: "oc_existing" } })}
					onOpenChange={() => {}}
					onBind={vi.fn()}
					onUnbind={onUnbind}
				/>,
			);
			await flush();
		});
		expect(document.body.textContent).toContain("oc_existing");
		const unbindButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "解绑",
		);
		expect(unbindButton).toBeTruthy();
		await act(async () => {
			unbindButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(onUnbind).toHaveBeenCalledWith("thread-1");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run src/components/im/im-channel-bind-dialog.test.tsx`
Expected: FAIL — cannot resolve `@/components/im/im-channel-bind-dialog`.

- [ ] **Step 3: Write minimal implementation**

Create `web-ui/src/components/im/im-channel-bind-dialog.tsx`:

```tsx
import { type ReactElement, useEffect, useState } from "react";

import type { ImChannelTarget } from "@/components/im/im-channel";
import { ImChannelChip } from "@/components/im/im-channel-chip";
import { ImChannelPicker } from "@/components/im/im-channel-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { HomeThread } from "@/hooks/use-home-threads";

interface ImChannelBindDialogProps {
	thread: HomeThread | null;
	onOpenChange: (open: boolean) => void;
	onBind: (threadId: string, channel: ImChannelTarget) => void | Promise<void>;
	onUnbind: (threadId: string) => void | Promise<void>;
}

function sameChannel(a: ImChannelTarget | null, b: ImChannelTarget | null): boolean {
	if (!a || !b) return a === b;
	return a.platform === b.platform && a.chatId === b.chatId;
}

export function ImChannelBindDialog({ thread, onOpenChange, onBind, onUnbind }: ImChannelBindDialogProps): ReactElement {
	const current = thread?.imChannel ?? null;
	const [draft, setDraft] = useState<ImChannelTarget | null>(current);
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		if (thread) {
			setDraft(thread.imChannel ?? null);
			setIsSubmitting(false);
		}
	}, [thread]);

	const changed = Boolean(draft) && !sameChannel(draft, current);

	const handleBind = async () => {
		if (!thread || !draft || !changed || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onBind(thread.id, draft);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleUnbind = async () => {
		if (!thread || !current || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onUnbind(thread.id);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={thread !== null} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title="绑定 IM 频道" />
			<DialogBody className="flex flex-col gap-4">
				{current ? (
					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">已绑定</span>
						<div className="flex items-center gap-2">
							<ImChannelChip channel={current} />
							<Button variant="ghost" size="sm" disabled={isSubmitting} onClick={() => void handleUnbind()}>
								解绑
							</Button>
						</div>
					</div>
				) : null}
				<div className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">{current ? "重新绑定" : "选择平台与频道"}</span>
					<ImChannelPicker value={draft} onChange={setDraft} disabled={isSubmitting} />
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					取消
				</Button>
				<Button variant="primary" size="sm" disabled={!changed || isSubmitting} onClick={() => void handleBind()}>
					{current ? "更新绑定" : "绑定"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run src/components/im/im-channel-bind-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Stage**

```bash
git add web-ui/src/components/im/im-channel-bind-dialog.tsx web-ui/src/components/im/im-channel-bind-dialog.test.tsx
```

---

### Task 5: `use-home-threads.ts` — bind-after-create + bind/unbind mutations

**Files:**
- Modify: `web-ui/src/hooks/use-home-threads.ts`

**Interfaces:**
- Consumes: existing `runtime.createHomeThread`; new `runtime.bindHomeThreadImChannel` / `runtime.unbindHomeThreadImChannel` (T4). `ImChannelTarget` type via the contract projection `RuntimeHomeChatThreadBindImChannelRequest["channel"]` (imported type-only from `@/runtime/types` — the hook does NOT import from `@/components/im` to keep the layer direction clean).
- Produces (added to `UseHomeThreadsResult`):
  - `createThread` input extended with `imChannel?: ImChannelTarget | null`
  - `bindThreadImChannel: (threadId: string, channel: ImChannelTarget) => Promise<void>`
  - `unbindThreadImChannel: (threadId: string) => Promise<void>`

- [ ] **Step 1: Add the type import and extend `UseHomeThreadsResult`**

In `web-ui/src/hooks/use-home-threads.ts`, extend the existing type import line:

```ts
import type {
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadBindImChannelRequest,
} from "@/runtime/types";
```

Add near the top (after imports), a local alias:

```ts
type ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"];
```

In `UseHomeThreadsResult`, change the `createThread` signature to add `imChannel` and add two methods. Replace the existing `createThread` field:

```ts
	createThread: (input: {
		description?: string;
		name?: string;
		agentId: RuntimeAgentId;
		images?: TaskImage[];
		/** Optional IM channel to bind to the new thread (best-effort, after create). */
		imChannel?: ImChannelTarget | null;
	}) => Promise<string | null>;
```

Add after `closeThread` in the interface:

```ts
	/** Bind an IM channel to an existing thread (no-op for the synthetic default). */
	bindThreadImChannel: (threadId: string, channel: ImChannelTarget) => Promise<void>;
	/** Remove a thread's IM channel binding. */
	unbindThreadImChannel: (threadId: string) => Promise<void>;
```

- [ ] **Step 2: Extend `createThread` to bind after create**

In the `createThread` `useCallback`, extend the destructured input to include `imChannel` and change the success branch to bind before inserting. Replace the destructuring signature:

```ts
		async ({
			threadId,
			description,
			name,
			agentId,
			images,
			imChannel,
		}: {
			threadId?: string;
			description?: string;
			name?: string;
			agentId: RuntimeAgentId;
			images?: TaskImage[];
			imChannel?: ImChannelTarget | null;
		}): Promise<string | null> => {
```

Replace the block from `const created = response.thread;` through the `setRegistryThreadsByWorkspace(...)` insert with:

```ts
				const created = response.thread;
				let finalThread = created;
				// Best-effort bind AFTER create — keeps T4's createHomeThread contract untouched.
				// A bind failure never fails the create: the thread exists (rebind via kebab).
				if (imChannel) {
					const bindResponse = await getRuntimeTrpcClient(currentProjectId).runtime.bindHomeThreadImChannel.mutate(
						{ id: created.id, channel: imChannel },
					);
					if (bindResponse.ok && bindResponse.thread) {
						finalThread = bindResponse.thread;
					} else {
						notifyError(bindResponse.error ?? "Could not bind IM channel.");
					}
				}
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: [...(current[currentProjectId] ?? []), finalThread],
				}));
				setActiveThreadIdByWorkspace((current) => ({ ...current, [currentProjectId]: finalThread.id }));
				return finalThread.id;
```

- [ ] **Step 3: Add `bindThreadImChannel` / `unbindThreadImChannel` callbacks**

Add after the `closeThread` `useCallback` (before the `fullscreenTabs` const):

```ts
	const bindThreadImChannel = useCallback(
		async (threadId: string, channel: ImChannelTarget) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.bindHomeThreadImChannel.mutate({
					id: threadId,
					channel,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not bind IM channel.");
				}
				const bound = response.thread;
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: (current[currentProjectId] ?? []).map((thread) =>
						thread.id === bound.id ? bound : thread,
					),
				}));
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);

	const unbindThreadImChannel = useCallback(
		async (threadId: string) => {
			if (!currentProjectId || threadId === DEFAULT_HOME_THREAD_ID) {
				return;
			}
			try {
				const response = await getRuntimeTrpcClient(currentProjectId).runtime.unbindHomeThreadImChannel.mutate({
					id: threadId,
				});
				if (!response.ok || !response.thread) {
					throw new Error(response.error ?? "Could not unbind IM channel.");
				}
				const unbound = response.thread;
				setRegistryThreadsByWorkspace((current) => ({
					...current,
					[currentProjectId]: (current[currentProjectId] ?? []).map((thread) =>
						thread.id === unbound.id ? unbound : thread,
					),
				}));
			} catch (error) {
				notifyError(error instanceof Error ? error.message : String(error));
			}
		},
		[currentProjectId],
	);
```

- [ ] **Step 4: Export the new callbacks**

In the hook's returned object, add after `closeThread,`:

```ts
		bindThreadImChannel,
		unbindThreadImChannel,
```

- [ ] **Step 5: Typecheck**

Run: `cd web-ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the existing hook/consumer tests to catch regressions**

Run: `cd web-ui && npx vitest run src/hooks/use-home-agent-session.test.tsx`
Expected: PASS (no behavior change to existing paths).

- [ ] **Step 7: Stage**

```bash
git add web-ui/src/hooks/use-home-threads.ts
```

---

### Task 6: Create dialog — add "绑定 IM(可选)" section + pass through `onCreate`

**Files:**
- Modify: `web-ui/src/components/home-agent/home-thread-create-dialog.tsx`
- Test: `web-ui/src/components/home-agent/home-thread-create-dialog.test.tsx` (extend)

**Interfaces:**
- Consumes: `ImChannelPicker` (Task 3), `ImChannelTarget` (Task 1).
- Produces: `onCreate` input extended with `imChannel?: ImChannelTarget | null` (consumed by Task 5's `createThread`, wired via Task 7).

- [ ] **Step 1: Write the failing test (extend the existing describe block)**

Add this `it` inside the existing `describe("HomeThreadCreateDialog", …)` in `home-thread-create-dialog.test.tsx`:

```tsx
	it("passes the bound IM channel through onCreate", async () => {
		const onCreate = vi.fn(async () => {});
		await render({ onCreate });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			setControlledValue(textarea, "Ship it");
			await flush();
		});

		// Type an IM chat id into the (default lark) picker.
		const imInput = document.querySelector('input[aria-label="IM chat ID"]') as HTMLInputElement;
		expect(imInput).not.toBeNull();
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(imInput, "oc_team");
			imInput.dispatchEvent(new Event("input", { bubbles: true }));
			await flush();
		});

		const createButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Create",
		);
		await act(async () => {
			createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});

		expect(onCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				description: "Ship it",
				imChannel: { platform: "lark", chatId: "oc_team" },
			}),
		);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run src/components/home-agent/home-thread-create-dialog.test.tsx -t "passes the bound IM channel"`
Expected: FAIL — no `input[aria-label="IM chat ID"]` in the dialog yet.

- [ ] **Step 3: Add imports, state, section, and pass-through**

In `home-thread-create-dialog.tsx`:

3a. Add imports (top, with the other `@/components` imports):

```tsx
import { ImChannelPicker } from "@/components/im/im-channel-picker";
import type { ImChannelTarget } from "@/components/im/im-channel";
```

3b. Extend the `onCreate` prop type — add the `imChannel` field to the `onCreate` input object type:

```tsx
		agentId: RuntimeAgentId;
		images?: TaskImage[];
		/** Optional IM channel bound to the new thread (best-effort, bound after create). */
		imChannel?: ImChannelTarget | null;
	}) => void | Promise<unknown>;
```

3c. Add state alongside the others (after the `threadId` state):

```tsx
	const [imChannel, setImChannel] = useState<ImChannelTarget | null>(null);
```

3d. Reset it in the open effect — add inside the `if (open) { … }` block:

```tsx
			setImChannel(null);
```

3e. Pass it through in `handleSubmit`'s `onCreate` call — add to the object:

```tsx
				await onCreate({
					threadId,
					description: trimmedDescription,
					agentId,
					images: images.length > 0 ? images : undefined,
					imChannel: imChannel ?? undefined,
				});
```

3f. Add the section in `DialogBody`, immediately after the closing `</div>` of the Agent section (before `</DialogBody>`):

```tsx
					<div className="flex flex-col gap-2">
						<span className="text-[12px] font-medium text-text-secondary">绑定 IM(可选)</span>
						<ImChannelPicker value={imChannel} onChange={setImChannel} disabled={isSubmitting} />
					</div>
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `cd web-ui && npx vitest run src/components/home-agent/home-thread-create-dialog.test.tsx`
Expected: PASS (new test + all pre-existing tests in the file).

- [ ] **Step 5: Typecheck**

Run: `cd web-ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Stage**

```bash
git add web-ui/src/components/home-agent/home-thread-create-dialog.tsx web-ui/src/components/home-agent/home-thread-create-dialog.test.tsx
```

---

### Task 7: Wire the kebab bind entry (panel → thread bar → bind dialog)

**Files:**
- Modify: `web-ui/src/components/home-agent/home-sidebar-agent-panel.tsx` (pass the two new hook methods to `HomeThreadBar`)
- Modify: `web-ui/src/components/home-agent/home-thread-bar.tsx` (new props, kebab button, mount `ImChannelBindDialog`)

**Interfaces:**
- Consumes: `homeThreads.bindThreadImChannel` / `homeThreads.unbindThreadImChannel` (Task 5); `ImChannelBindDialog` (Task 4); `HomeThread.imChannel` (already on the type).
- Produces: no downstream consumers (UI leaf).

- [ ] **Step 1: Pass the hook methods from the panel**

In `home-sidebar-agent-panel.tsx`, in the `<HomeThreadBar … />` element (currently ends after `onCloseThread={homeThreads.closeThread}`), add:

```tsx
				onBindThreadImChannel={homeThreads.bindThreadImChannel}
				onUnbindThreadImChannel={homeThreads.unbindThreadImChannel}
```

- [ ] **Step 2: Add props + state + dialog mount to `HomeThreadBar`**

In `home-thread-bar.tsx`:

2a. Add imports (with the other component imports). Merge `Radio` into the existing `lucide-react` import line rather than adding a duplicate:

```tsx
import { Radio } from "lucide-react";
import { ImChannelBindDialog } from "@/components/im/im-channel-bind-dialog";
import type { ImChannelTarget } from "@/components/im/im-channel";
```

2b. Extend the props interface — add two callback props next to `onRenameThread` / `onCloseThread` (top-level type import used; inline `import(...)` in a type position is banned by the repo TS rules):

```tsx
	onBindThreadImChannel: (threadId: string, channel: ImChannelTarget) => void | Promise<void>;
	onUnbindThreadImChannel: (threadId: string) => void | Promise<void>;
```

Destructure them in the component's props alongside `onRenameThread` / `onCloseThread`.

2c. Add state next to the existing `renameTarget` / `closeTarget` state:

```tsx
	const [imChannelTarget, setImChannelTarget] = useState<HomeThread | null>(null);
```

2d. Add a bind button in the per-thread action `<span>` (the one holding the Rename/Close buttons), placed **before** the Rename button. Use accent color when already bound to signal state:

```tsx
						<button
							type="button"
							aria-label="绑定 IM"
							className={cn(
								"cursor-pointer rounded-sm p-1 hover:bg-surface-4 hover:text-text-primary",
								thread.imChannel ? "text-accent" : "text-text-tertiary",
							)}
							onClick={(event) => {
								event.stopPropagation();
								setMenuOpen(false);
								setImChannelTarget(thread);
							}}
						>
							<Radio size={12} />
						</button>
```

2e. Mount the dialog next to the existing `HomeThreadRenameDialog` / `HomeThreadCloseDialog` mounts:

```tsx
			<ImChannelBindDialog
				thread={imChannelTarget}
				onOpenChange={(open) => {
					if (!open) {
						setImChannelTarget(null);
					}
				}}
				onBind={onBindThreadImChannel}
				onUnbind={onUnbindThreadImChannel}
			/>
```

> The `ImChannelBindDialog` reads the live binding from `imChannelTarget.imChannel`. After a bind/unbind, `use-home-threads` updates `registryThreadsByWorkspace`, so the next open reflects the change. (The dialog closes on success via `onOpenChange(false)`.)

- [ ] **Step 3: Typecheck**

Run: `cd web-ui && npm run typecheck`
Expected: no errors. (If `home-sidebar-agent-panel.tsx` had a stricter `HomeThreadBar` prop type elsewhere, ensure the two new props are non-optional and supplied.)

- [ ] **Step 4: Full web-ui test + build sanity**

Run: `cd web-ui && npx vitest run src/components/im src/components/home-agent/home-thread-create-dialog.test.tsx`
Expected: PASS.

Run: `cd web-ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification checklist (record results)**

Start the app and verify:
1. New-thread dialog shows "绑定 IM(可选)" with a platform select (飞书/钉钉) + chat-id input; typing `oc_…` shows "识别为:群聊".
2. Creating a thread with a chat id → thread appears; its kebab bind icon is accent-colored.
3. Kebab "绑定 IM" on an existing thread → dialog shows current binding + 解绑, and re-bind updates it.
4. Unbind → icon returns to muted; dialog reopened shows unbound picker.

- [ ] **Step 6: Stage**

```bash
git add web-ui/src/components/home-agent/home-sidebar-agent-panel.tsx web-ui/src/components/home-agent/home-thread-bar.tsx
```

---

## Notes for the executor

- **Root project instructions (AGENTS.md) govern.** Do not commit; leave staged changes for the user to review and commit.
- If `HomeThreadBar`'s prop type lives in a separate `interface` above the component, add the two new props there (not just to the destructure).
- The Radix `Select` in the picker uses a portal; the unit tests deliberately drive only the chat-id `input`, never the Select dropdown (jsdom + pointer capture is flaky). Platform-switch behavior is covered by typecheck + manual verification.
- Keep the hook free of any `@/components/im` import — it uses the contract type projection directly to preserve the hook→contract (not hook→component) dependency direction.
