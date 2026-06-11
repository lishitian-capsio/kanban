# Unified File-Library Attachments (pi + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let both the pi agent and CLI/terminal agents (claude/codex/…) reference files from the repo-scoped Files library via a single `attachments[]` message/request field — pi inlines images as base64 and references documents by path; CLI injects `@<path>` references — replacing the tmpdir image materialization with stable committed Files-library paths.

**Architecture:** Add a reference-based `attachments[]` field (Files-library `fileId` + metadata) to the session/message wire contract *alongside* the existing inline-base64 `images[]` (decided: additive coexistence — `images[]` stays for board-card drag/drop). A single store-driven resolver (`src/files/attachment-resolver.ts`) turns `attachments[]` into resolved records; two thin, pure formatters consume it — `pi-user-content.ts` (base64 image blocks + doc-path notes) and the refactored `task-attachment-prompt.ts` (`@<path>` text injection shared by CLI kickoff and runtime input). pi-agent-runtime and TerminalSessionManager each get an injectable `FileLibraryStore` factory (default `new FileLibraryStore(cwd)`), rooted at the session's `cwd` (the worktree, where committed `.kanban/files/` paths are valid).

**Tech Stack:** TypeScript, Zod (wire contract in `src/core/api-contract.ts`), Vitest (`bun vitest run`), the existing `FileLibraryStore` (`src/files/file-library-store.ts`).

---

## File Structure

**New files:**
- `src/files/attachment-resolver.ts` — pure, store-driven. Resolves `RuntimeTaskAttachment[]` → `ResolvedAttachment[]` (path always; base64 for image-category on demand). Vitest-testable with a real `FileLibraryStore` in a tmp repo.
- `src/agent-sdk/kanban/pi-user-content.ts` — pure. Builds pi's user-message content parts (text + doc-path notes + base64 image blocks) from `(text, images[], ResolvedAttachment[])`. **No `../agent` import** so it is importable under Vitest (the Agent SDK touches `Bun.env` at import and cannot load under Vitest).
- `test/runtime/files/attachment-resolver.test.ts`
- `test/runtime/agent-sdk/pi-user-content.test.ts`

**Renamed/refactored:**
- `src/terminal/task-image-prompt.ts` → `src/terminal/task-attachment-prompt.ts` — generalized: shared `@<path>` builder + a `prepareTaskPrompt` that materializes legacy inline `images[]` to tmpdir (kept for board-card back-compat) and appends already-resolved Files-library attachment paths.
- `test/runtime/terminal/task-attachment-prompt.test.ts` (new; replaces any prompt-format assertions).

**Modified:**
- `src/core/api-contract.ts` — `runtimeTaskAttachmentSchema` + `attachments?` on chat-message / start / input / chat-send schemas.
- `src/core/api-validation.ts` — accept `attachments` in the relevant parse validators.
- `src/session/session-message.ts` — thread `attachments` through create/clone helpers.
- `src/agent-sdk/kanban/pi-agent-runtime.ts` — inject store factory, thread `attachments`, resolve + use `pi-user-content`.
- `src/agent-sdk/kanban/pi-task-session-service.ts` — thread `attachments` through start/sendInput + persist on the transcript message.
- `src/terminal/agent-session-adapters.ts` — `prepareAgentLaunch` accepts pre-resolved attachment paths.
- `src/terminal/session-manager.ts` — inject store factory, store `cwd` per entry, thread `attachments` into kickoff, add async `writeTaskInput`.
- `src/trpc/runtime-api.ts` — forward `attachments` through `startTaskSession`, `sendTaskSessionInput`, `sendTaskChatMessage`.

**Explicitly OUT of scope (later tasks):** board-card persistence of attachments (`runtimeBoardCardSchema` / `task-board-mutations.ts`), the web-ui file-picker UI to *produce* attachments, removing `images[]`, and wiring `supportsAttachments` model-capability gating.

---

## Conventions for every task

- Run a single test file with: `bun vitest run <path>`.
- Run the fast suite with: `bun vitest run test/runtime test/utilities`.
- No `any` (the existing `source: any` in `buildUserMessage` is being removed — do not introduce new ones).
- Follow AGENTS.md: NEVER commit unless the user asks. Commit steps below stage files but the executor should only run them if the user has authorized commits; otherwise leave changes staged/unstaged and move on.
- The real pi runtime (`pi-agent-runtime.ts` / `pi-task-session-service.ts`) **cannot be imported under Vitest** — its threading is covered by the pure unit tests (Tasks 3–4) plus a `bun -e` smoke check (Task 5, Step 6) and the mocked `runtime-api` test (Task 8).

---

### Task 1: Contract — `runtimeTaskAttachmentSchema` + `attachments[]` fields

**Files:**
- Modify: `src/core/api-contract.ts` (insert after line 268, the `RuntimeFileItem` type; add field on schemas at ~1159, ~1193, ~1208, ~1240)
- Modify: `src/core/api-validation.ts:221-288`
- Test: `test/runtime/trpc/api-validation-attachments.test.ts` (new) — if a more natural existing api-validation test file exists, add there instead.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/trpc/api-validation-attachments.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
	parseTaskChatSendRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
} from "../../../src/core/api-validation";

const attachment = {
	fileId: "file-1",
	name: "diagram.png",
	mime: "image/png",
	category: "image" as const,
};

describe("attachment-aware request validators", () => {
	it("accepts attachments on the session input request", () => {
		const parsed = parseTaskSessionInputRequest({
			taskId: "task-1",
			text: "look at this",
			attachments: [attachment],
		});
		expect(parsed.attachments).toEqual([attachment]);
	});

	it("accepts attachments on the start request", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "task-1",
			prompt: "go",
			baseRef: "main",
			attachments: [attachment],
		});
		expect(parsed.attachments).toEqual([attachment]);
	});

	it("treats attachments-only chat sends as valid (no text, no images)", () => {
		const parsed = parseTaskChatSendRequest({
			taskId: "task-1",
			text: "",
			attachments: [attachment],
		});
		expect(parsed.attachments).toEqual([attachment]);
		expect(parsed.text).toBe("");
	});

	it("rejects an empty chat send with neither text, images, nor attachments", () => {
		expect(() => parseTaskChatSendRequest({ taskId: "task-1", text: "" })).toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/trpc/api-validation-attachments.test.ts`
Expected: FAIL (`attachments` stripped by schema / `parsed.attachments` undefined; attachments-only chat send throws).

- [ ] **Step 3: Add the attachment schema and fields**

In `src/core/api-contract.ts`, immediately after line 268 (`export type RuntimeFileItem = z.infer<typeof runtimeFileItemSchema>;`) insert:

```typescript
/**
 * A reference to a file in the repo-scoped Files library, carried on chat
 * messages and session input. The `fileId` is resolved against the library at
 * send time; `name`/`mime`/`category` are a metadata copy so the transcript and
 * the `task_chat_message` broadcast can render the attachment without a store
 * lookup and survive the underlying file later being renamed or removed.
 */
export const runtimeTaskAttachmentSchema = z.object({
	fileId: z.string(),
	name: z.string(),
	mime: z.string(),
	category: runtimeFileCategorySchema,
});
export type RuntimeTaskAttachment = z.infer<typeof runtimeTaskAttachmentSchema>;
```

Add `attachments: z.array(runtimeTaskAttachmentSchema).optional(),` to each of these object schemas:
- `runtimeTaskSessionStartRequestSchema` (after line 1159, next to `images`)
- `runtimeTaskSessionInputRequestSchema` (after line 1193, next to `appendNewline`)
- `runtimeTaskChatMessageSchema` (after line 1208, next to `images`)
- `runtimeTaskChatSendRequestSchema` (after line 1240, next to `images`)

- [ ] **Step 4: Update the chat-send validator to treat attachments as content**

In `src/core/api-validation.ts`, change `parseTaskChatSendRequest` (lines 272-288) so attachments count as content:

```typescript
export function parseTaskChatSendRequest(value: unknown): RuntimeTaskChatSendRequest {
	const parsed = parseWithSchema(runtimeTaskChatSendRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	const text = parsed.text.trim();
	const hasImages = Boolean(parsed.images && parsed.images.length > 0);
	const hasAttachments = Boolean(parsed.attachments && parsed.attachments.length > 0);
	if (!text && !hasImages && !hasAttachments) {
		throw new Error("Task chat text, images, or attachments are required.");
	}
	return {
		...parsed,
		taskId,
		text,
	};
}
```

`parseTaskSessionStartRequest` and `parseTaskSessionInputRequest` already spread `...parsed`, so the new optional `attachments` flows through with no change.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/trpc/api-validation-attachments.test.ts`
Expected: PASS

- [ ] **Step 6: Guard against contract drift**

Run: `bun vitest run test/runtime test/utilities`
Expected: PASS (no existing test asserted these schemas reject extra keys).

- [ ] **Step 7: Commit**

```bash
git add src/core/api-contract.ts src/core/api-validation.ts test/runtime/trpc/api-validation-attachments.test.ts
git commit -m "feat(contract): add Files-library attachments[] to session/message schemas"
```

---

### Task 2: SessionMessage — thread `attachments` through helpers

**Files:**
- Modify: `src/session/session-message.ts:23-57`
- Test: `test/runtime/session/session-message-attachments.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/runtime/session/session-message-attachments.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { RuntimeTaskAttachment } from "../../../src/core/api-contract";
import { cloneSessionMessage, createSessionMessage } from "../../../src/session/session-message";

const attachment: RuntimeTaskAttachment = {
	fileId: "file-1",
	name: "spec.pdf",
	mime: "application/pdf",
	category: "document",
};

describe("session message attachments", () => {
	it("stores attachments on the created message", () => {
		const message = createSessionMessage("task-1", "user", "see attached", undefined, [attachment]);
		expect(message.attachments).toEqual([attachment]);
	});

	it("omits attachments when none are provided", () => {
		const message = createSessionMessage("task-1", "user", "hi");
		expect(message.attachments).toBeUndefined();
	});

	it("deep-clones attachments", () => {
		const message = createSessionMessage("task-1", "user", "x", undefined, [attachment]);
		const clone = cloneSessionMessage(message);
		expect(clone.attachments).toEqual([attachment]);
		expect(clone.attachments?.[0]).not.toBe(message.attachments?.[0]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/session/session-message-attachments.test.ts`
Expected: FAIL (`createSessionMessage` has no 5th param; `message.attachments` undefined).

- [ ] **Step 3: Thread attachments through the helpers**

In `src/session/session-message.ts`:

Update the import on line 13:
```typescript
import type { RuntimeTaskAttachment, RuntimeTaskChatMessage, RuntimeTaskImage } from "../core/api-contract";
```

Replace `createSessionMessage` (lines 23-36):
```typescript
export function createSessionMessage(
	taskId: string,
	role: SessionMessageRole,
	content: string,
	images?: RuntimeTaskImage[],
	attachments?: RuntimeTaskAttachment[],
): SessionMessage {
	return {
		id: `${taskId}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
		role,
		content,
		images: images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined,
		attachments:
			attachments && attachments.length > 0 ? attachments.map((attachment) => ({ ...attachment })) : undefined,
		createdAt: now(),
	};
}
```

Replace `createSessionMessageWithMeta` (lines 38-49):
```typescript
export function createSessionMessageWithMeta(
	taskId: string,
	role: SessionMessageRole,
	content: string,
	meta: SessionMessage["meta"],
	images?: RuntimeTaskImage[],
	attachments?: RuntimeTaskAttachment[],
): SessionMessage {
	return {
		...createSessionMessage(taskId, role, content, images, attachments),
		meta,
	};
}
```

Replace `cloneSessionMessage` (lines 51-57):
```typescript
export function cloneSessionMessage(message: SessionMessage): SessionMessage {
	return {
		...message,
		images: message.images ? message.images.map((image) => ({ ...image })) : message.images,
		attachments: message.attachments
			? message.attachments.map((attachment) => ({ ...attachment }))
			: message.attachments,
		meta: message.meta ? { ...message.meta } : message.meta,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/session/session-message-attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/session-message.ts test/runtime/session/session-message-attachments.test.ts
git commit -m "feat(session): thread attachments through session-message helpers"
```

---

### Task 3: Attachment resolver

**Files:**
- Create: `src/files/attachment-resolver.ts`
- Test: `test/runtime/files/attachment-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/runtime/files/attachment-resolver.test.ts`:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeTaskAttachment } from "../../../src/core/api-contract";
import { resolveTaskAttachments } from "../../../src/files/attachment-resolver";
import { FileLibraryStore } from "../../../src/files/file-library-store";

let repoPath: string;
let store: FileLibraryStore;

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-attach-"));
	store = new FileLibraryStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

function attachmentFor(fileId: string, category: RuntimeTaskAttachment["category"]): RuntimeTaskAttachment {
	return { fileId, name: "ignored.bin", mime: "x", category };
}

describe("resolveTaskAttachments", () => {
	it("returns [] for undefined/empty input", async () => {
		expect(await resolveTaskAttachments(store, undefined)).toEqual([]);
		expect(await resolveTaskAttachments(store, [])).toEqual([]);
	});

	it("resolves a repo-relative path for every attachment", async () => {
		const doc = await store.add({ name: "spec.md", bytes: Buffer.from("# hi") });
		const [resolved] = await resolveTaskAttachments(store, [attachmentFor(doc.id, "document")]);
		expect(resolved.relativePath).toBe(`.kanban/files/blobs/${doc.id}/spec.md`);
		expect(resolved.absolutePath).toContain(repoPath);
		expect(resolved.name).toBe("spec.md");
		expect(resolved.imageData).toBeNull();
	});

	it("inlines base64 for image-category attachments only when includeImageBytes is set", async () => {
		const png = await store.add({ name: "p.png", bytes: Buffer.from([1, 2, 3]), mime: "image/png" });
		const att = attachmentFor(png.id, "image");

		const withoutBytes = await resolveTaskAttachments(store, [att]);
		expect(withoutBytes[0]?.imageData).toBeNull();

		const withBytes = await resolveTaskAttachments(store, [att], { includeImageBytes: true });
		expect(withBytes[0]?.imageData).toBe(Buffer.from([1, 2, 3]).toString("base64"));
		expect(withBytes[0]?.mimeType).toBe("image/png");
	});

	it("skips attachments whose file is missing from the library", async () => {
		const resolved = await resolveTaskAttachments(store, [attachmentFor("does-not-exist", "image")]);
		expect(resolved).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/files/attachment-resolver.test.ts`
Expected: FAIL (module `attachment-resolver` does not exist).

- [ ] **Step 3: Implement the resolver**

Create `src/files/attachment-resolver.ts`:

```typescript
import type { RuntimeFileCategory, RuntimeTaskAttachment } from "../core/api-contract";
import { FileLibraryStore } from "./file-library-store";

/** An attachment resolved against the Files library at send time. */
export interface ResolvedAttachment {
	fileId: string;
	/** Authoritative file name from the library manifest. */
	name: string;
	mimeType: string;
	category: RuntimeFileCategory;
	absolutePath: string;
	/** Repo-relative path, stable across worktree checkouts (files are committed). */
	relativePath: string;
	/**
	 * Base64-encoded bytes, populated only when {@link ResolveAttachmentOptions.includeImageBytes}
	 * is set and the file is image-category. Used for inline agent vision; `null` otherwise.
	 */
	imageData: string | null;
}

export interface ResolveAttachmentOptions {
	/** Read image-category bytes for inline base64 vision content (pi). CLI agents leave this off. */
	includeImageBytes?: boolean;
}

export type FileLibraryFactory = (repoPath: string) => FileLibraryStore;

/** Default factory: a fresh store rooted at the given repo/worktree path. */
export const defaultFileLibraryFactory: FileLibraryFactory = (repoPath) => new FileLibraryStore(repoPath);

/**
 * Resolve Files-library references into path (always) and, for images, optional
 * inline base64. Missing files are skipped, so a stale reference degrades to "no
 * attachment" rather than throwing.
 */
export async function resolveTaskAttachments(
	store: FileLibraryStore,
	attachments: RuntimeTaskAttachment[] | undefined,
	options: ResolveAttachmentOptions = {},
): Promise<ResolvedAttachment[]> {
	if (!attachments || attachments.length === 0) {
		return [];
	}
	const resolved: ResolvedAttachment[] = [];
	for (const attachment of attachments) {
		const path = await store.getPath(attachment.fileId);
		if (!path) {
			continue;
		}
		let imageData: string | null = null;
		if (options.includeImageBytes && path.item.category === "image") {
			const bytes = await store.getBytes(attachment.fileId);
			imageData = bytes?.data ?? null;
		}
		resolved.push({
			fileId: attachment.fileId,
			name: path.item.name,
			mimeType: path.item.mime,
			category: path.item.category,
			absolutePath: path.absolutePath,
			relativePath: path.relativePath,
			imageData,
		});
	}
	return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/files/attachment-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/files/attachment-resolver.ts test/runtime/files/attachment-resolver.test.ts
git commit -m "feat(files): add store-driven attachment resolver"
```

---

### Task 4: pi user-content builder (pure)

**Files:**
- Create: `src/agent-sdk/kanban/pi-user-content.ts`
- Test: `test/runtime/agent-sdk/pi-user-content.test.ts`

> The content shape mirrors the current `buildUserMessage` image block exactly
> (`{ type: "image", source: { type: "base64", media_type, data } }`) so the
> Anthropic wire layer keeps working unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/agent-sdk/pi-user-content.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { RuntimeTaskImage } from "../../../src/core/api-contract";
import type { ResolvedAttachment } from "../../../src/files/attachment-resolver";
import { buildPiUserContent } from "../../../src/agent-sdk/kanban/pi-user-content";

const image: RuntimeTaskImage = { id: "i1", data: "QUJD", mimeType: "image/png", name: "a.png" };

function resolved(partial: Partial<ResolvedAttachment>): ResolvedAttachment {
	return {
		fileId: "f1",
		name: "spec.md",
		mimeType: "text/markdown",
		category: "document",
		absolutePath: "/repo/.kanban/files/blobs/f1/spec.md",
		relativePath: ".kanban/files/blobs/f1/spec.md",
		imageData: null,
		...partial,
	};
}

describe("buildPiUserContent", () => {
	it("returns a single text part when there is nothing attached", () => {
		expect(buildPiUserContent("hello", undefined, undefined)).toEqual([{ type: "text", text: "hello" }]);
	});

	it("inlines legacy images[] as base64 image blocks after the text", () => {
		const parts = buildPiUserContent("look", [image], undefined);
		expect(parts[0]).toEqual({ type: "text", text: "look" });
		expect(parts[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "QUJD" },
		});
	});

	it("inlines image-category attachments and lists document attachments as paths", () => {
		const doc = resolved({ relativePath: ".kanban/files/blobs/f1/spec.md", name: "spec.md" });
		const pic = resolved({
			fileId: "f2",
			category: "image",
			mimeType: "image/png",
			name: "shot.png",
			imageData: "WFla",
		});
		const parts = buildPiUserContent("review", undefined, [doc, pic]);
		expect(parts[0]).toEqual({
			type: "text",
			text: "review\n\nAttached files:\n- .kanban/files/blobs/f1/spec.md (spec.md)",
		});
		expect(parts).toContainEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "WFla" },
		});
	});

	it("skips images with blank data or mime", () => {
		const parts = buildPiUserContent("x", [{ id: "i", data: "  ", mimeType: "image/png" }], undefined);
		expect(parts).toEqual([{ type: "text", text: "x" }]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/agent-sdk/pi-user-content.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the pure content builder**

Create `src/agent-sdk/kanban/pi-user-content.ts`:

```typescript
// Pure builder for the pi agent's user-message content parts. Kept free of any
// `../agent` import so it is importable under Vitest (the Agent SDK reads
// Bun.env at import and cannot load there).
import type { RuntimeTaskImage } from "../../core/api-contract";
import type { ResolvedAttachment } from "../../files/attachment-resolver";

export type PiUserTextPart = { type: "text"; text: string };
export type PiUserImagePart = {
	type: "image";
	source: { type: "base64"; media_type: string; data: string };
};
export type PiUserContentPart = PiUserTextPart | PiUserImagePart;

function imagePart(mimeType: string, data: string): PiUserImagePart {
	return { type: "image", source: { type: "base64", media_type: mimeType, data } };
}

/**
 * Build pi user content: the prompt text (with non-image attachment paths noted
 * inline so pi can open them with its file tools), followed by base64 image
 * blocks for legacy inline images and image-category attachments.
 */
export function buildPiUserContent(
	text: string,
	images: RuntimeTaskImage[] | undefined,
	attachments: ResolvedAttachment[] | undefined,
): PiUserContentPart[] {
	const docs = (attachments ?? []).filter((attachment) => attachment.imageData === null);
	const docNote =
		docs.length > 0
			? `\n\nAttached files:\n${docs.map((doc) => `- ${doc.relativePath} (${doc.name})`).join("\n")}`
			: "";

	const parts: PiUserContentPart[] = [{ type: "text", text: `${text}${docNote}` }];

	for (const image of images ?? []) {
		const mimeType = image.mimeType.trim();
		const data = image.data.trim();
		if (mimeType && data) {
			parts.push(imagePart(mimeType, data));
		}
	}

	for (const attachment of attachments ?? []) {
		if (attachment.imageData) {
			parts.push(imagePart(attachment.mimeType, attachment.imageData));
		}
	}

	return parts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/agent-sdk/pi-user-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent-sdk/kanban/pi-user-content.ts test/runtime/agent-sdk/pi-user-content.test.ts
git commit -m "feat(pi): add pure user-content builder for images + attachments"
```

---

### Task 5: Wire pi runtime + service to resolve and send attachments

> Not Vitest-testable (Agent SDK import). Correctness comes from Tasks 3–4 plus a
> `bun -e` smoke check (Step 6). Keep edits mechanical.

**Files:**
- Modify: `src/agent-sdk/kanban/pi-agent-runtime.ts`
- Modify: `src/agent-sdk/kanban/pi-task-session-service.ts`

- [ ] **Step 1: pi-agent-runtime — imports, options, request/session types**

In `src/agent-sdk/kanban/pi-agent-runtime.ts`:

Add to the import on lines 2-7:
```typescript
import type {
	RuntimeReasoningEffort,
	RuntimeTaskAttachment,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "../../core/api-contract";
```

Add new imports (top-level, after line 9):
```typescript
import {
	type FileLibraryFactory,
	defaultFileLibraryFactory,
	resolveTaskAttachments,
} from "../../files/attachment-resolver";
import { buildPiUserContent } from "./pi-user-content";
import type { AgentMessage } from "../types"; // already imported on line 9 — merge, do not duplicate
```
(Note: `AgentMessage` is already imported on line 9 — only add the two new modules.)

Add `attachments?: RuntimeTaskAttachment[];` to `StartPiSessionRequest` (after line 35, next to `images`).

Add `cwd: string;` to `PiAgentSession` (after line 49, next to `taskId`).

Add to `PiAgentRuntime.sendInput` signature (line 58) and `CreatePiAgentRuntimeOptions` (lines 67-70):
```typescript
	sendInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		attachments?: RuntimeTaskAttachment[],
	): Promise<void>;
```
```typescript
export interface CreatePiAgentRuntimeOptions {
	onTaskEvent?: (taskId: string, event: AgentEvent) => void;
	createMcpRuntimeService?: () => PiMcpRuntimeService;
	createFileLibrary?: FileLibraryFactory;
}
```

- [ ] **Step 2: pi-agent-runtime — store the factory, resolve on start/send**

Add a field + constructor wiring (after line 79 / inside the constructor at lines 81-84):
```typescript
	private readonly createFileLibrary: FileLibraryFactory;
```
```typescript
	constructor(options: CreatePiAgentRuntimeOptions = {}) {
		this.onTaskEvent = options.onTaskEvent ?? null;
		this.mcpRuntimeService = (options.createMcpRuntimeService ?? createPiMcpRuntimeService)();
		this.createFileLibrary = options.createFileLibrary ?? defaultFileLibraryFactory;
	}
```

Add `cwd: request.cwd,` to the `session` object literal (in `startSession`, after line 137 `taskId: request.taskId,`).

Replace the kickoff message build (lines 161-168) so attachments resolve first:
```typescript
		const normalizedPrompt = request.prompt.trim();
		if (normalizedPrompt.length > 0 || (request.attachments?.length ?? 0) > 0) {
			const resolvedAttachments = await resolveTaskAttachments(
				this.createFileLibrary(request.cwd),
				request.attachments,
				{ includeImageBytes: true },
			);
			const userMessage = buildUserMessage(normalizedPrompt, request.images, resolvedAttachments);
			// Fire and forget - events will be emitted via subscription
			void agent.prompt(userMessage).catch(() => {
				// Errors are surfaced via agent_end event
			});
		}
```

Replace `sendInput` (lines 173-193):
```typescript
	async sendInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		attachments?: RuntimeTaskAttachment[],
	): Promise<void> {
		const session = this.sessions.get(taskId);
		if (!session) {
			throw new Error(`No active pi session for task ${taskId}`);
		}

		const resolvedAttachments = await resolveTaskAttachments(
			this.createFileLibrary(session.cwd),
			attachments,
			{ includeImageBytes: true },
		);
		const userMessage = buildUserMessage(text, images, resolvedAttachments);

		if (session.agent.state.isStreaming) {
			// Queue as steering message
			session.agent.steer(userMessage);
		} else {
			// Start new turn
			await session.agent.prompt(userMessage);
		}
	}
```

- [ ] **Step 3: pi-agent-runtime — collapse `buildUserMessage` onto the pure builder**

Replace `buildUserMessage` (lines 245-272):
```typescript
import type { ResolvedAttachment } from "../../files/attachment-resolver"; // add to the attachment-resolver import block in Step 1

function buildUserMessage(
	text: string,
	images?: RuntimeTaskImage[],
	attachments?: ResolvedAttachment[],
): AgentMessage {
	return {
		role: "user",
		content: buildPiUserContent(text, images, attachments),
		timestamp: Date.now(),
	} as AgentMessage;
}
```
(Add `ResolvedAttachment` to the `attachment-resolver` import added in Step 1; the `source: any` cast is now gone.)

- [ ] **Step 4: pi-task-session-service — thread attachments**

In `src/agent-sdk/kanban/pi-task-session-service.ts`:

Add `RuntimeTaskAttachment` to the import on lines 4-10.

Add `attachments?: RuntimeTaskAttachment[];` to `StartPiTaskSessionRequest` (after line 44, next to `images`).

Update the `sendTaskSessionInput` signature in the `PiTaskSessionService` interface (lines 62-67) and the implementation (lines 357-362) to add a trailing `attachments?: RuntimeTaskAttachment[],` parameter.

In `startTaskSession`:
- line 225 — also treat attachments as content:
```typescript
		const hasRequestImages = Boolean(
			(request.images && request.images.length > 0) || (request.attachments && request.attachments.length > 0),
		);
```
- line 248 — persist attachments on the user message:
```typescript
			const message = createSessionMessage(request.taskId, "user", normalizedPrompt, request.images, request.attachments);
```
- line 278 (inside `startRequest`) — forward attachments:
```typescript
				attachments: request.attachments,
```

In `sendTaskSessionInput` (lines 357-409):
- line 375 — count attachments as content:
```typescript
		const hasImages = Boolean(images && images.length > 0);
		const hasAttachments = Boolean(attachments && attachments.length > 0);
		if (normalized.length === 0 && !hasImages && !hasAttachments) return null;
```
- line 379 — persist attachments on the message:
```typescript
		const message = createSessionMessage(taskId, "user", normalized, images, attachments);
```
- line 404 — forward attachments to the runtime:
```typescript
		void this.agentRuntime.sendInput(taskId, normalized, effectiveMode, images, attachments).catch((error: unknown) => {
			this.emitTaskFailure(taskId, entry, "send", error);
		});
```

- [ ] **Step 5: Forward the file-library factory option (so tests can inject)**

Add `createFileLibrary?: FileLibraryFactory;` to `CreatePiTaskSessionServiceOptions` (lines 80-84; import `FileLibraryFactory` from `../../files/attachment-resolver`), and pass it through when the runtime is created (lines 195-199):
```typescript
		this.agentRuntime = createAgentRuntime({
			onTaskEvent: (taskId: string, event: AgentEvent) => {
				this.handleTaskEvent(taskId, event);
			},
			createFileLibrary: options.createFileLibrary,
		});
```
(Production wiring in `runtime-server.ts` needs no change — the default factory is used when this is `undefined`.)

- [ ] **Step 6: Typecheck + smoke-check the threading**

Run: `bun run typecheck` (or the project's TS check — confirm the script name in `package.json`).
Expected: PASS (no `any`, no unused imports).

Then a `bun -e` round-trip proving an attachment reaches pi content (the Agent SDK loads fine under Bun):

```bash
bun -e '
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLibraryStore } from "./src/files/file-library-store";
import { resolveTaskAttachments } from "./src/files/attachment-resolver";
import { buildPiUserContent } from "./src/agent-sdk/kanban/pi-user-content";

const repo = await mkdtemp(join(tmpdir(), "pi-smoke-"));
const store = new FileLibraryStore(repo);
const png = await store.add({ name: "p.png", bytes: Buffer.from([1,2,3]), mime: "image/png" });
const resolved = await resolveTaskAttachments(store, [{ fileId: png.id, name: png.name, mime: png.mime, category: png.category }], { includeImageBytes: true });
const parts = buildPiUserContent("hi", undefined, resolved);
const hasImage = parts.some((p) => p.type === "image");
if (!hasImage) { console.error("FAIL: no inline image part"); process.exit(1); }
console.log("OK: pi content has", parts.length, "parts incl image");
'
```
Expected: prints `OK: ...`.

- [ ] **Step 7: Commit**

```bash
git add src/agent-sdk/kanban/pi-agent-runtime.ts src/agent-sdk/kanban/pi-task-session-service.ts
git commit -m "feat(pi): resolve and send Files-library attachments to the agent"
```

---

### Task 6: Refactor `task-image-prompt.ts` → `task-attachment-prompt.ts`

**Files:**
- Rename + rewrite: `src/terminal/task-image-prompt.ts` → `src/terminal/task-attachment-prompt.ts`
- Test: `test/runtime/terminal/task-attachment-prompt.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/runtime/terminal/task-attachment-prompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { buildPromptWithAttachmentPaths, prepareTaskPrompt } from "../../../src/terminal/task-attachment-prompt";

describe("buildPromptWithAttachmentPaths", () => {
	it("returns the prompt unchanged when there are no entries", () => {
		expect(buildPromptWithAttachmentPaths("do the thing", [])).toBe("do the thing");
	});

	it("injects @paths above the prompt", () => {
		const result = buildPromptWithAttachmentPaths("do the thing", [
			{ path: ".kanban/files/blobs/f1/spec.md", name: "spec.md" },
			{ path: ".kanban/files/blobs/f2/shot.png" },
		]);
		expect(result).toBe(
			[
				"Attached files:",
				"@.kanban/files/blobs/f1/spec.md (spec.md)",
				"@.kanban/files/blobs/f2/shot.png",
				"",
				"do the thing",
			].join("\n"),
		);
	});

	it("emits only the attachment list when the prompt is empty", () => {
		const result = buildPromptWithAttachmentPaths("", [{ path: "a/b.png" }]);
		expect(result).toBe(["Attached files:", "@a/b.png"].join("\n"));
	});
});

describe("prepareTaskPrompt", () => {
	it("returns the prompt unchanged with neither images nor attachment paths", async () => {
		expect(await prepareTaskPrompt({ prompt: "hi" })).toBe("hi");
	});

	it("appends already-resolved attachment paths without touching tmpdir", async () => {
		const result = await prepareTaskPrompt({
			prompt: "review",
			attachmentPaths: [{ path: ".kanban/files/blobs/f1/spec.md", name: "spec.md" }],
		});
		expect(result).toContain("@.kanban/files/blobs/f1/spec.md (spec.md)");
		expect(result).toContain("review");
		expect(result).not.toContain(require("node:os").tmpdir());
	});

	it("materializes legacy inline images[] to a temp file and references them with @", async () => {
		const result = await prepareTaskPrompt({
			prompt: "see image",
			images: [{ id: "i1", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png", name: "a.png" }],
		});
		expect(result).toMatch(/@.*kanban-task-images-.*01-a\.png/);
		expect(result).toContain("see image");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/terminal/task-attachment-prompt.test.ts`
Expected: FAIL (module `task-attachment-prompt` does not exist).

- [ ] **Step 3: Create the refactored module**

Create `src/terminal/task-attachment-prompt.ts` (the helpers `sanitizeFileNameSegment`, `resolveTaskImageExtension`, `buildTaskImageFileName`, and `IMAGE_EXTENSION_BY_MIME_TYPE` are carried over verbatim from the old file):

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import type { RuntimeTaskImage } from "../core/api-contract";

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/webp": ".webp",
};

function sanitizeFileNameSegment(value: string): string {
	const normalized = value.normalize("NFKD").replaceAll(/[^A-Za-z0-9._-]+/g, "-");
	const trimmed = normalized.replaceAll(/^-+|-+$/g, "");
	return trimmed.length > 0 ? trimmed : "image";
}

function resolveTaskImageExtension(image: RuntimeTaskImage): string {
	const name = image.name?.trim();
	const nameExtension = name ? extname(name).toLowerCase() : "";
	if (nameExtension) {
		return nameExtension;
	}
	return IMAGE_EXTENSION_BY_MIME_TYPE[image.mimeType.toLowerCase()] ?? "";
}

function buildTaskImageFileName(image: RuntimeTaskImage, index: number): string {
	const displayName = image.name?.trim();
	const extension = resolveTaskImageExtension(image);
	const baseName = displayName ? basename(displayName, extname(displayName)) : `image-${index + 1}`;
	return `${String(index + 1).padStart(2, "0")}-${sanitizeFileNameSegment(baseName)}${extension}`;
}

/** A path to inject into the prompt as an `@`-reference. */
export interface PromptAttachmentEntry {
	path: string;
	name?: string;
}

/**
 * Build a prompt with `@<path>` attachment references listed above the task text.
 * Shared by the CLI kickoff and runtime follow-up input so both inject identically.
 */
export function buildPromptWithAttachmentPaths(prompt: string, entries: PromptAttachmentEntry[]): string {
	if (entries.length === 0) {
		return prompt;
	}
	const lines = [
		"Attached files:",
		...entries.map((entry) => {
			const suffix = entry.name?.trim() ? ` (${entry.name.trim()})` : "";
			return `@${entry.path}${suffix}`;
		}),
	];
	const trimmedPrompt = prompt.trim();
	if (!trimmedPrompt) {
		return lines.join("\n");
	}
	return [...lines, "", trimmedPrompt].join("\n");
}

/**
 * Compose the launch prompt for a CLI agent. Already-resolved Files-library
 * attachment paths (stable, committed) are referenced directly; legacy inline
 * `images[]` (board-card base64, not in the library) are still materialized to a
 * temp file so the agent can read them. Both funnel through the same injector.
 */
export async function prepareTaskPrompt(input: {
	prompt: string;
	images?: RuntimeTaskImage[];
	attachmentPaths?: PromptAttachmentEntry[];
}): Promise<string> {
	const images = input.images?.filter((image) => image.data.trim().length > 0) ?? [];
	const attachmentEntries = input.attachmentPaths ?? [];
	if (images.length === 0 && attachmentEntries.length === 0) {
		return input.prompt;
	}

	const imageEntries: PromptAttachmentEntry[] = [];
	if (images.length > 0) {
		const tempDir = await mkdtemp(join(tmpdir(), "kanban-task-images-"));
		for (const [index, image] of images.entries()) {
			const filePath = join(tempDir, buildTaskImageFileName(image, index));
			await writeFile(filePath, Buffer.from(image.data, "base64"));
			imageEntries.push({ path: filePath, name: image.name });
		}
	}

	return buildPromptWithAttachmentPaths(input.prompt, [...imageEntries, ...attachmentEntries]);
}
```

- [ ] **Step 4: Delete the old file**

```bash
git rm src/terminal/task-image-prompt.ts
```
(If the executor cannot run `git rm`, delete the file with the filesystem; it is fully replaced by `task-attachment-prompt.ts`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/terminal/task-attachment-prompt.test.ts`
Expected: PASS

> Importer (`agent-session-adapters.ts`) is updated in Task 7; a project-wide
> typecheck will fail until then — that is expected and resolved by Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/terminal/task-attachment-prompt.ts test/runtime/terminal/task-attachment-prompt.test.ts
git commit -m "refactor(terminal): generalize image prompt into @path attachment prompt"
```

---

### Task 7: Wire TerminalSessionManager + adapters to resolve attachment paths

**Files:**
- Modify: `src/terminal/agent-session-adapters.ts:23-46, 1286-1295`
- Modify: `src/terminal/session-manager.ts` (imports, `StartTaskSessionRequest`, `SessionEntry`, options, kickoff, new `writeTaskInput`)
- Test: `test/runtime/terminal/session-manager-attachments.test.ts` (new)

- [ ] **Step 1: agent-session-adapters — accept pre-resolved attachment paths**

In `src/terminal/agent-session-adapters.ts`:

Replace the import on line 27:
```typescript
import { type PromptAttachmentEntry, prepareTaskPrompt } from "./task-attachment-prompt";
```

Add `attachmentPaths?: PromptAttachmentEntry[];` to `AgentAdapterLaunchInput` (after line 37, next to `images`).

Replace `prepareAgentLaunch` (lines 1286-1295):
```typescript
export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPrompt({
		prompt: input.prompt,
		images: input.images,
		attachmentPaths: input.attachmentPaths,
	});
	return await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
	});
}
```

- [ ] **Step 2: session-manager — imports, request/entry types, options**

In `src/terminal/session-manager.ts`:

Add `RuntimeTaskAttachment` to the `../core/api-contract` import (lines 6-13).

Add new imports (after line 27):
```typescript
import {
	type FileLibraryFactory,
	defaultFileLibraryFactory,
	resolveTaskAttachments,
} from "../files/attachment-resolver";
```

Add `attachments?: RuntimeTaskAttachment[];` to `StartTaskSessionRequest` (after line 117, next to `images`).

Add a `cwd` field to `SessionEntry` (after line 103 `restartRequest: ...` — pick any spot in the interface):
```typescript
	cwd: string | null;
```
Initialize it wherever `SessionEntry` objects are created (search `ensureEntry`/entry literal) to `null`, and set it in `startTaskSession` (Step 3).

Extend `cloneStartTaskSessionRequest` (lines 192-199) to clone attachments:
```typescript
		attachments: request.attachments ? request.attachments.map((attachment) => ({ ...attachment })) : undefined,
```

Add the factory to options + constructor (lines 268-281):
```typescript
export interface TerminalSessionManagerOptions {
	/** Durable transcript store; defaults to an in-memory-only no-op. */
	messageJournal?: SessionMessageJournal;
	createFileLibrary?: FileLibraryFactory;
}
```
```typescript
	private readonly createFileLibrary: FileLibraryFactory;

	constructor(options: TerminalSessionManagerOptions = {}) {
		this.messageJournal = options.messageJournal ?? new NoopSessionMessageJournal();
		this.createFileLibrary = options.createFileLibrary ?? defaultFileLibraryFactory;
	}
```

- [ ] **Step 3: session-manager — resolve attachments at kickoff**

In `startTaskSession`, set the entry cwd near the top (right after `const entry = this.ensureEntry(request.taskId);`, line ~418):
```typescript
		entry.cwd = request.cwd;
```

Resolve attachment paths just before the `prepareAgentLaunch` call (before line 449) and pass them in:
```typescript
		const resolvedAttachments = await resolveTaskAttachments(this.createFileLibrary(request.cwd), request.attachments);
		const attachmentPaths = resolvedAttachments.map((attachment) => ({
			path: attachment.relativePath,
			name: attachment.name,
		}));
```
Add to the `prepareAgentLaunch({ ... })` argument object (after `images: request.images,` on line 457):
```typescript
			attachmentPaths,
```

- [ ] **Step 4: session-manager — add async `writeTaskInput`**

Add a new method next to `writeInput` (after line 984). It resolves attachments to `@paths`, prepends them to the text, and reuses the existing `writeInput` for the actual PTY write + transcript fold-in (do NOT modify `writeInput`, which is also the per-keystroke hot path):

```typescript
	/**
	 * Programmatic text input that may carry Files-library attachments. Resolves
	 * each attachment to a committed repo-relative path, injects `@<path>` refs,
	 * then writes through the same path as raw keystrokes. `appendNewline` submits
	 * the input to the agent.
	 */
	async writeTaskInput(
		taskId: string,
		payload: { text: string; attachments?: RuntimeTaskAttachment[]; appendNewline?: boolean },
	): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		let text = payload.text;
		if (payload.attachments && payload.attachments.length > 0 && entry.cwd) {
			const resolved = await resolveTaskAttachments(this.createFileLibrary(entry.cwd), payload.attachments);
			const entries = resolved.map((attachment) => ({ path: attachment.relativePath, name: attachment.name }));
			text = buildPromptWithAttachmentPaths(text, entries);
		}
		const data = payload.appendNewline ? `${text}\n` : text;
		return this.writeInput(taskId, Buffer.from(data, "utf8"));
	}
```
Add `buildPromptWithAttachmentPaths` to the `task-attachment-prompt` import (the Step 1 import lives in adapters; add a separate import here):
```typescript
import { buildPromptWithAttachmentPaths } from "./task-attachment-prompt";
```

- [ ] **Step 5: Write the failing test**

Create `test/runtime/terminal/session-manager-attachments.test.ts`. This drives a real `TerminalSessionManager` with a fake `FileLibraryStore` factory and a fake PTY (mirror the setup already used in `session-manager.test.ts` — read it first to reuse its `startTaskSession` harness/fixtures). The assertions:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileLibraryStore } from "../../../src/files/file-library-store";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

describe("TerminalSessionManager attachments", () => {
	it("injects @<relativePath> into runtime input for a Files-library attachment", async () => {
		const repo = await mkdtemp(join(tmpdir(), "tsm-attach-"));
		const store = new FileLibraryStore(repo);
		const doc = await store.add({ name: "spec.md", bytes: Buffer.from("# spec") });

		const writes: string[] = [];
		const manager = new TerminalSessionManager({ createFileLibrary: (p) => new FileLibraryStore(p) });

		// Start a session with a fake binary so a PTY entry exists. Reuse the
		// harness from session-manager.test.ts: spawn `cat` (echoes input) in `repo`,
		// then capture PTY writes via the session's output listener or a PtySession spy.
		// ... (mirror existing test setup) ...

		const summary = await manager.writeTaskInput(/* taskId */ "task-1", {
			text: "summarize",
			attachments: [{ fileId: doc.id, name: doc.name, mime: doc.mime, category: doc.category }],
			appendNewline: true,
		});
		expect(summary).not.toBeNull();
		// The PTY received the injected reference:
		expect(writes.join("")).toContain(`@.kanban/files/blobs/${doc.id}/spec.md`);
	});
});
```
> Implementation note for the executor: open `test/runtime/terminal/session-manager.test.ts` and copy its exact session-start + PTY-capture fixture (binary, cwd, how it reads writes). Keep this new test consistent with that harness rather than inventing a new one. If capturing raw PTY writes is awkward, assert instead on the transcript user message captured by `onMessage` (which records the injected text).

- [ ] **Step 6: Run test to verify it passes**

Run: `bun vitest run test/runtime/terminal/session-manager-attachments.test.ts`
Expected: PASS

- [ ] **Step 7: Run the terminal suite (catches the renamed-import fallout)**

Run: `bun vitest run test/runtime/terminal`
Expected: PASS (including `agent-session-adapters.test.ts`; update any assertion in it that referenced the old `prepareTaskPromptWithImages` name or `"Attached reference images:"` / `"Task:"` format to the new `prepareTaskPrompt` / `"Attached files:"` / `@path` format).

- [ ] **Step 8: Commit**

```bash
git add src/terminal/agent-session-adapters.ts src/terminal/session-manager.ts test/runtime/terminal/session-manager-attachments.test.ts
git commit -m "feat(terminal): resolve Files-library attachments into @path injection for CLI agents"
```

---

### Task 8: Wire runtime-api to forward attachments

**Files:**
- Modify: `src/trpc/runtime-api.ts` (start ~248/300, sendTaskSessionInput ~368-402, sendTaskChatMessage ~633/638/653)
- Test: extend `test/runtime/trpc/runtime-api.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/runtime/trpc/runtime-api.test.ts`, add a test that the input endpoint forwards attachments to the terminal manager's `writeTaskInput`. Follow the file's existing harness (it builds `deps` with mocked `getScopedTerminalManager` returning a `terminalManager` object of `vi.fn()`s — add `writeTaskInput: vi.fn(async () => summaryFixture)` to that mock). Sketch:

```typescript
it("forwards attachments to the terminal manager on sendTaskSessionInput", async () => {
	const writeTaskInput = vi.fn(async () => activeSummary);
	const terminalManager = { /* ...existing mock fields..., */ writeTaskInput, writeInput: vi.fn() };
	// build api with getScopedTerminalManager -> terminalManager and a
	// callTaskSessionService path that returns null (so it falls through to terminal)
	const api = createRuntimeApi(/* deps */);
	const attachments = [{ fileId: "f1", name: "spec.md", mime: "text/markdown", category: "document" as const }];
	const res = await api.sendTaskSessionInput(workspaceScope, { taskId: "t1", text: "go", attachments, appendNewline: true });
	expect(res.ok).toBe(true);
	expect(writeTaskInput).toHaveBeenCalledWith("t1", { text: "go", attachments, appendNewline: true });
});
```
> The executor: read the existing `sendTaskSessionInput`/`writeInput` tests in this file (around the `writeInput: vi.fn()` at line ~1261) and extend that exact `deps`/`terminalManager` fixture rather than constructing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/trpc/runtime-api.test.ts`
Expected: FAIL (endpoint still calls `writeInput` with a pre-built Buffer; `writeTaskInput` never called).

- [ ] **Step 3: Route the input endpoint through `writeTaskInput`**

In `src/trpc/runtime-api.ts`, replace the terminal fallback in `sendTaskSessionInput` (lines 371-382). Note: when the pi service handles the task, the `callTaskSessionService` branch still runs first — extend it to also forward attachments (the pi `sendTaskSessionInput` now accepts them):

```typescript
				const body = parseTaskSessionInputRequest(input);
				const serviceSummary = await callTaskSessionService(workspaceScope, async (svc) =>
					svc.sendTaskSessionInput(body.taskId, body.appendNewline ? `${body.text}\n` : body.text, undefined, undefined, body.attachments),
				);
				if (serviceSummary) {
					return {
						ok: true,
						summary: serviceSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = await terminalManager.writeTaskInput(body.taskId, {
					text: body.text,
					attachments: body.attachments,
					appendNewline: body.appendNewline,
				});
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
```
> Check the `callTaskSessionService` signature for how it passes args to `svc.sendTaskSessionInput`; if it currently hard-codes only `(taskId, text)`, widen it (or inline the call here) so `attachments` reaches the pi service.

- [ ] **Step 4: Forward attachments on the start + pi-chat paths**

`startTaskSession` pi branch — add to the `piTaskSessionService.startTaskSession({ ... })` object (after line 248 `images: body.images,`):
```typescript
						attachments: body.attachments,
```
`startTaskSession` CLI branch — add to `terminalManager.startTaskSession({ ... })` (after line 300 `images: body.images,`):
```typescript
					attachments: body.attachments,
```
`sendTaskChatMessage` (pi) — pass attachments on each `sendTaskSessionInput` (lines 633 & 638) and the home-session `startTaskSession` (line 653):
```typescript
				let summary = await piService.sendTaskSessionInput(body.taskId, body.text, requestedMode, body.images, body.attachments);
```
```typescript
							summary = await piService.sendTaskSessionInput(body.taskId, body.text, requestedMode, body.images, body.attachments);
```
```typescript
							attachments: body.attachments,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun vitest run test/runtime/trpc/runtime-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/trpc/runtime-api.ts test/runtime/trpc/runtime-api.test.ts
git commit -m "feat(runtime-api): forward attachments through start, input, and chat send"
```

---

### Task 9: Full verification

- [ ] **Step 1: Typecheck the runtime + web-ui**

Run: `bun run typecheck` and the web typecheck (confirm script names in `package.json`; likely `bun run web:typecheck`).
Expected: PASS. The web-ui shares the contract via the `@runtime-contract` alias; `attachments` is optional, so existing web code that never sets it still compiles. If any exhaustive switch over message fields breaks, address it minimally (display-only; no producer UI in this task).

- [ ] **Step 2: Run the fast suite**

Run: `bun vitest run test/runtime test/utilities`
Expected: PASS.

- [ ] **Step 3: Confirm no stragglers reference the old module/format**

Run: `grep -rn "task-image-prompt\|prepareTaskPromptWithImages\|Attached reference images" src test`
Expected: no matches.

- [ ] **Step 4: Commit (if anything changed in Steps 1–3)**

```bash
git add -A
git commit -m "chore: finalize unified file-library attachments wiring"
```

---

## Self-Review

**Spec coverage:**
1. *Contract: images[] → attachments[], Files-library id + metadata, coordinate SessionMessage = runtimeTaskChatMessageSchema, avoid drift* → Task 1 (schema + the four request/message schemas; `SessionMessage` is the type alias so it inherits `attachments` automatically — no separate model) + Task 2 (helpers). Coexistence (additive) was confirmed with the user; `images[]` stays.
2. *pi consumption: images → getBytes inline base64; documents → getPath by path* → Tasks 3 (resolver, `includeImageBytes`), 4 (content builder: image blocks + doc-path notes), 5 (runtime/service threading).
3. *CLI consumption: getPath → @path text to PTY; worktree `.kanban/files/` stable* → Tasks 6 (`@path` builder), 7 (resolve via store rooted at session cwd).
4. *Input request gains attachments; runtime-api CLI branch + writeInput parse & inject* → Task 1 (schema), Task 7 (`writeTaskInput`), Task 8 (endpoint routing). `writeInput` itself stays untouched (per-keystroke hot path); a sibling async `writeTaskInput` does resolution.
5. *Refactor task-image-prompt.ts off tmpdir to Files-library paths; kickoff + runtime input share one injector* → Task 6 (`buildPromptWithAttachmentPaths` shared by both; attachments use committed paths, only legacy inline images still use tmpdir).
6. *Tests, AGENTS.md compliance* → every task is TDD; pure modules under Vitest, pi runtime via `bun -e` smoke + mocked runtime-api test; no `any`; no commits unless user authorizes.

**Placeholder scan:** All code steps contain full code. The two test files that must mirror an existing harness (Task 7 Step 5 PTY capture, Task 8 Step 1 deps fixture) are flagged with explicit "read this existing file and reuse its fixture" instructions rather than invented setup, because copying the real harness verbatim is more reliable than a guessed reconstruction.

**Type consistency:** `RuntimeTaskAttachment` (Task 1) is used identically everywhere. `ResolvedAttachment` (Task 3) fields (`relativePath`, `absolutePath`, `name`, `mimeType`, `category`, `imageData`) match their consumers in Tasks 4/7. `resolveTaskAttachments(store, attachments, options?)` signature is identical across pi (Task 5) and terminal (Task 7). `buildPiUserContent(text, images, attachments)` and `prepareTaskPrompt({prompt, images, attachmentPaths})` / `buildPromptWithAttachmentPaths(prompt, entries)` names are stable between definition (Tasks 4/6) and use (Tasks 5/7). `writeTaskInput(taskId, {text, attachments, appendNewline})` signature matches between definition (Task 7) and call (Task 8).
