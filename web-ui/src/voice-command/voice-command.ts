// Pure, deterministic parsing + resolution for voice-driven board commands.
//
// This is intentionally NOT a general NLU engine (see
// `.plan/docs/voice-command-board-control-design.md` and the tech-selection doc
// §4.1/§4.3): the home sidebar agent already turns free-form natural language into
// Kanban CLI calls. This module recognizes only a tiny, high-frequency command
// vocabulary — create / start / move / delete a task — so the UI can show the
// concrete action for an explicit confirmation BEFORE anything with side effects
// runs. Everything it does not recognize is returned as `chat`, which the caller
// drops into the composer draft (the existing "fill draft, never auto-send" path).
//
// Kept free of DOM/React so the intent→action mapping and confirmation outcomes
// are unit-testable in isolation.

import type { RuntimeBoardColumnId } from "@/runtime/types";

/** Minimal board snapshot this module needs. Adapt `RuntimeBoardData` at the call site. */
export interface VoiceCommandBoardCard {
	id: string;
	title?: string;
	prompt: string;
}
export interface VoiceCommandBoardColumn {
	id: RuntimeBoardColumnId;
	title: string;
	cards: VoiceCommandBoardCard[];
}
export interface VoiceCommandBoard {
	columns: VoiceCommandBoardColumn[];
}

/** How the user referred to a task in speech. */
export type TaskReference = { kind: "topBacklog" } | { kind: "title"; query: string };

/** Parsed (not yet resolved against the board) command intent. */
export type ParsedVoiceCommand =
	| { kind: "create"; title: string }
	| { kind: "start"; target: TaskReference }
	| { kind: "move"; target: TaskReference; column: ColumnReference }
	| { kind: "delete"; target: TaskReference }
	| { kind: "chat"; text: string };

/** A spoken column name and the board column id it maps to (null = unmapped). */
export interface ColumnReference {
	raw: string;
	columnId: RuntimeBoardColumnId | null;
}

/** A command fully resolved against the current board — safe to describe and execute. */
export type ResolvedVoiceCommand =
	| { kind: "create"; title: string }
	| { kind: "start"; card: ResolvedCard }
	| { kind: "move"; card: ResolvedCard; columnId: RuntimeBoardColumnId; columnTitle: string }
	| { kind: "delete"; card: ResolvedCard; columnId: RuntimeBoardColumnId; columnTitle: string };

export interface ResolvedCard {
	id: string;
	/** Human label for the card (its title, falling back to a trimmed prompt). */
	name: string;
}

/** Why a recognized command could not be resolved/executed. */
export type VoiceCommandRejectionReason =
	| "needs-task-name"
	| "task-not-found"
	| "task-ambiguous"
	| "empty-backlog"
	| "empty-title"
	| "unknown-column";

export interface VoiceCommandRejection {
	reason: VoiceCommandRejectionReason;
	/** User-facing (zh) explanation for a toast. */
	message: string;
}

/** Top-level outcome the controller acts on. */
export type VoiceCommandOutcome =
	| { kind: "chat"; text: string }
	| { kind: "confirm"; resolved: ResolvedVoiceCommand; summary: VoiceCommandSummary }
	| { kind: "reject"; rejection: VoiceCommandRejection; text: string };

export interface VoiceCommandSummary {
	/** Short action title, e.g. "移动任务". */
	title: string;
	/** Concrete detail of what will happen, e.g. 「登录 bug」→「完成」. */
	detail: string;
}

const MAX_CARD_NAME_LENGTH = 60;

// --- keyword tables -------------------------------------------------------

const CREATE_VERBS = ["新建", "新增", "创建", "添加"];
const START_VERBS = ["启动", "开始", "运行", "跑"];
const DELETE_VERBS = ["删除", "移除", "删掉", "去掉", "丢弃"];
// Longer move phrases first so e.g. "移动到" wins over "移到"/"移".
const MOVE_PHRASES = ["移动到", "移动至", "移到", "移至", "挪到", "拖到", "拖动到", "放到", "改到", "移入", "移"];

const TASK_NOUN_TOKENS = [
	"任务",
	"这条任务",
	"这张卡片",
	"这张卡",
	"这条",
	"这张",
	"那条",
	"那张",
	"卡片",
	"卡",
	"the task",
	"this task",
	"task",
	"card",
];

const TOP_BACKLOG_PATTERNS = [
	/顶部.*(待办|代办|任务)/,
	/最(上面|上).*(待办|代办|任务)/,
	/第一个.*(待办|代办|任务)/,
	/首个.*(待办|代办|任务)/,
	/(待办|代办).*顶部/,
	/\b(top|first)\b.*\b(backlog|todo|to-?do|task)\b/,
];

interface ColumnSynonym {
	id: RuntimeBoardColumnId;
	words: string[];
}
const COLUMN_SYNONYMS: ColumnSynonym[] = [
	{ id: "backlog", words: ["待办", "代办", "backlog", "todo", "to do", "to-do", "队列"] },
	{ id: "in_progress", words: ["进行中", "进行", "正在做", "doing", "in progress", "in-progress", "wip"] },
	{ id: "review", words: ["评审", "审查", "审核", "待审", "复审", "审阅", "review"] },
	// done == trash (终态桶, see repo memory): "完成"/"done"/"删除列" all land here.
	{ id: "trash", words: ["完成", "做完", "已完成", "完结", "结束", "done", "trash", "垃圾", "回收"] },
];

// --- helpers --------------------------------------------------------------

function normalize(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function stripQuotes(text: string): string {
	return text.replace(/^[「『"'“”‘’\s]+|[」』"'“”‘’\s]+$/g, "").trim();
}

function startsWithAny(text: string, words: string[]): string | null {
	for (const word of words) {
		if (text.startsWith(word)) {
			return word;
		}
	}
	return null;
}

/** Clean a raw spoken task phrase into a TaskReference (top-backlog vs a title query). */
function toTaskReference(raw: string): TaskReference {
	const cleaned = cleanTaskPhrase(raw);
	if (cleaned.length === 0) {
		// Demonstrative-only ("这条任务") or empty — caller rejects with needs-task-name.
		return { kind: "title", query: "" };
	}
	for (const pattern of TOP_BACKLOG_PATTERNS) {
		if (pattern.test(raw)) {
			return { kind: "topBacklog" };
		}
	}
	return { kind: "title", query: cleaned };
}

/** Remove surrounding quotes, task-noun/demonstrative tokens, and connective words. */
function cleanTaskPhrase(raw: string): string {
	let text = stripQuotes(raw);
	text = text.replace(/^把\s*/, "");
	// Strip task-noun tokens (longest first) wherever they sit at the edges.
	const sorted = [...TASK_NOUN_TOKENS].sort((a, b) => b.length - a.length);
	let changed = true;
	while (changed) {
		changed = false;
		const before = text;
		for (const token of sorted) {
			const lower = text.toLowerCase();
			if (lower.startsWith(token.toLowerCase())) {
				text = text.slice(token.length).trim();
			}
			const lowerEnd = text.toLowerCase();
			if (lowerEnd.endsWith(token.toLowerCase())) {
				text = text.slice(0, text.length - token.length).trim();
			}
		}
		text = text
			.replace(/^(那|这|名为|叫|的)\s*/, "")
			.replace(/(那张|那个)$/, "")
			.trim();
		if (text !== before) {
			changed = true;
		}
	}
	return stripQuotes(text);
}

function resolveColumnReference(raw: string): ColumnReference {
	const lower = raw.toLowerCase();
	for (const synonym of COLUMN_SYNONYMS) {
		for (const word of synonym.words) {
			if (lower.includes(word.toLowerCase())) {
				return { raw, columnId: synonym.id };
			}
		}
	}
	return { raw, columnId: null };
}

// --- parsing --------------------------------------------------------------

/** Parse a transcript into a command intent. Unrecognized text becomes `chat`. */
export function parseVoiceCommand(transcript: string): ParsedVoiceCommand {
	const text = normalize(transcript);
	if (text.length === 0) {
		return { kind: "chat", text: "" };
	}

	const move = parseMove(text);
	if (move) {
		return move;
	}
	const create = parseCreate(text);
	if (create) {
		return create;
	}
	const del = parseDelete(text);
	if (del) {
		return del;
	}
	const start = parseStart(text);
	if (start) {
		return start;
	}
	return { kind: "chat", text };
}

function parseMove(text: string): ParsedVoiceCommand | null {
	// English: move <target> to <column>
	const en = /^move\s+(.+?)\s+to\s+(.+)$/i.exec(text);
	if (en) {
		return { kind: "move", target: toTaskReference(en[1] ?? ""), column: resolveColumnReference(en[2] ?? "") };
	}
	// Chinese: [把] <target> <move-phrase> <column>[列/栏]
	for (const phrase of MOVE_PHRASES) {
		const idx = text.indexOf(phrase);
		if (idx <= 0) {
			continue;
		}
		const targetRaw = text.slice(0, idx);
		const columnRaw = text
			.slice(idx + phrase.length)
			.replace(/(列|那列|栏|里|中)$/g, "")
			.trim();
		if (columnRaw.length === 0) {
			continue;
		}
		return { kind: "move", target: toTaskReference(targetRaw), column: resolveColumnReference(columnRaw) };
	}
	return null;
}

function parseCreate(text: string): ParsedVoiceCommand | null {
	// English: (create|add|make|new) [a] task[:] <title>
	const en = /^(?:create|add|make|new)\s+(?:a\s+|an\s+)?task\s*[:：]?\s*(.*)$/i.exec(text);
	if (en) {
		return { kind: "create", title: stripQuotes(en[1] ?? "") };
	}
	// Chinese: <create-verb> [一个/个] [任务][:] <title> [任务]
	const verb = startsWithAny(text, CREATE_VERBS);
	if (verb) {
		let rest = text.slice(verb.length).trim();
		rest = rest.replace(/^(一个|一项|个|项)\s*/, "").trim();
		rest = rest.replace(/^任务\s*/, "").trim();
		rest = rest.replace(/^[:：,，\-—]\s*/, "").trim();
		rest = rest.replace(/(的)?任务$/, "").trim();
		return { kind: "create", title: stripQuotes(rest) };
	}
	return null;
}

function parseStart(text: string): ParsedVoiceCommand | null {
	const en = /^(?:start|run|launch)\s+(.+)$/i.exec(text);
	if (en) {
		return { kind: "start", target: toTaskReference(en[1] ?? "") };
	}
	const verb = startsWithAny(text, START_VERBS);
	if (verb) {
		const rest = text.slice(verb.length).trim();
		if (rest.length === 0) {
			return null;
		}
		return { kind: "start", target: toTaskReference(rest) };
	}
	return null;
}

function parseDelete(text: string): ParsedVoiceCommand | null {
	const en = /^(?:delete|remove|trash)\s+(.+)$/i.exec(text);
	if (en) {
		return { kind: "delete", target: toTaskReference(en[1] ?? "") };
	}
	// Chinese trailing form: [把] <target> 删掉/删除/移除/去掉
	const trailing = /^把?\s*(.+?)\s*(删掉|删除|移除|去掉|丢弃)$/.exec(text);
	if (trailing) {
		return { kind: "delete", target: toTaskReference(trailing[1] ?? "") };
	}
	// Chinese leading form: <delete-verb> [任务] <target>
	const verb = startsWithAny(text, DELETE_VERBS);
	if (verb) {
		let rest = text.slice(verb.length).trim();
		rest = rest.replace(/^任务\s*/, "").trim();
		if (rest.length === 0) {
			return null;
		}
		return { kind: "delete", target: toTaskReference(rest) };
	}
	return null;
}

// --- resolution -----------------------------------------------------------

function cardName(card: VoiceCommandBoardCard): string {
	const raw = (card.title && card.title.trim().length > 0 ? card.title : card.prompt).trim();
	if (raw.length <= MAX_CARD_NAME_LENGTH) {
		return raw;
	}
	return `${raw.slice(0, MAX_CARD_NAME_LENGTH - 1)}…`;
}

function allCards(board: VoiceCommandBoard): VoiceCommandBoardCard[] {
	return board.columns.flatMap((column) => column.cards);
}

function findColumnTitle(board: VoiceCommandBoard, columnId: RuntimeBoardColumnId): string {
	return board.columns.find((column) => column.id === columnId)?.title ?? columnId;
}

function resolveTaskReference(
	board: VoiceCommandBoard,
	reference: TaskReference,
): ResolvedCard | VoiceCommandRejection {
	if (reference.kind === "topBacklog") {
		const backlog = board.columns.find((column) => column.id === "backlog");
		const top = backlog?.cards[0];
		if (!top) {
			return { reason: "empty-backlog", message: "待办列没有可启动的任务。" };
		}
		return { id: top.id, name: cardName(top) };
	}
	const query = reference.query.trim();
	if (query.length === 0) {
		return { reason: "needs-task-name", message: "请说出要操作的任务标题。" };
	}
	const lowerQuery = query.toLowerCase();
	const cards = allCards(board);
	const exact = cards.filter((card) => cardName(card).toLowerCase() === lowerQuery);
	if (exact.length === 1) {
		const card = exact[0];
		if (card) {
			return { id: card.id, name: cardName(card) };
		}
	}
	const matches = cards.filter((card) => {
		const name = cardName(card).toLowerCase();
		const prompt = card.prompt.toLowerCase();
		return name.includes(lowerQuery) || prompt.includes(lowerQuery) || lowerQuery.includes(name);
	});
	if (matches.length === 0) {
		return { reason: "task-not-found", message: `未找到任务「${query}」。` };
	}
	if (matches.length > 1) {
		return { reason: "task-ambiguous", message: `「${query}」匹配到多个任务,请说得更具体。` };
	}
	const card = matches[0];
	if (!card) {
		return { reason: "task-not-found", message: `未找到任务「${query}」。` };
	}
	return { id: card.id, name: cardName(card) };
}

function isRejection(value: ResolvedCard | VoiceCommandRejection): value is VoiceCommandRejection {
	return "reason" in value;
}

/** Resolve a parsed command against the board, or explain why it can't run. */
export function resolveVoiceCommand(
	parsed: ParsedVoiceCommand,
	board: VoiceCommandBoard,
): ResolvedVoiceCommand | VoiceCommandRejection {
	switch (parsed.kind) {
		case "create": {
			const title = parsed.title.trim();
			if (title.length === 0) {
				return { reason: "empty-title", message: "请说出新任务的标题。" };
			}
			return { kind: "create", title };
		}
		case "start": {
			const card = resolveTaskReference(board, parsed.target);
			if (isRejection(card)) {
				return card;
			}
			return { kind: "start", card };
		}
		case "delete": {
			const card = resolveTaskReference(board, parsed.target);
			if (isRejection(card)) {
				return card;
			}
			return { kind: "delete", card, columnId: "trash", columnTitle: findColumnTitle(board, "trash") };
		}
		case "move": {
			const card = resolveTaskReference(board, parsed.target);
			if (isRejection(card)) {
				return card;
			}
			if (parsed.column.columnId === null) {
				return { reason: "unknown-column", message: `无法识别目标列「${parsed.column.raw}」。` };
			}
			return {
				kind: "move",
				card,
				columnId: parsed.column.columnId,
				columnTitle: findColumnTitle(board, parsed.column.columnId),
			};
		}
		case "chat":
			// Not a recognized command — caller treats as chat. Shouldn't normally reach here.
			return { reason: "task-not-found", message: "" };
	}
}

// --- description + instruction -------------------------------------------

/** Build the zh confirmation summary shown before executing. */
export function describeResolvedCommand(resolved: ResolvedVoiceCommand): VoiceCommandSummary {
	switch (resolved.kind) {
		case "create":
			return { title: "新建任务", detail: `标题:「${resolved.title}」` };
		case "start":
			return { title: "启动任务", detail: `「${resolved.card.name}」` };
		case "move":
			return { title: "移动任务", detail: `「${resolved.card.name}」 →「${resolved.columnTitle}」` };
		case "delete":
			return { title: "删除任务", detail: `「${resolved.card.name}」(移入「${resolved.columnTitle}」)` };
	}
}

/**
 * Build the explicit, id-qualified instruction sent to the home agent on confirm.
 * Passing the resolved task id removes the agent's card-resolution ambiguity, so what
 * the user confirmed is what executes (the agent is a deterministic CLI executor here).
 */
export function buildAgentInstruction(resolved: ResolvedVoiceCommand): string {
	switch (resolved.kind) {
		case "create":
			return `请新建一个任务,标题:${resolved.title}`;
		case "start":
			return `请启动任务「${resolved.card.name}」(任务 id: ${resolved.card.id})`;
		case "move":
			return `请把任务「${resolved.card.name}」(任务 id: ${resolved.card.id})移动到「${resolved.columnTitle}」列`;
		case "delete":
			return `请删除任务「${resolved.card.name}」(任务 id: ${resolved.card.id})`;
	}
}

/**
 * Single pure entry point: transcript + board → what the UI should do.
 * `chat`/`reject` both carry `text` so the controller can fall back to the draft.
 */
export function planVoiceCommand(transcript: string, board: VoiceCommandBoard): VoiceCommandOutcome {
	const text = normalize(transcript);
	const parsed = parseVoiceCommand(text);
	if (parsed.kind === "chat") {
		return { kind: "chat", text: parsed.text };
	}
	const resolved = resolveVoiceCommand(parsed, board);
	if ("reason" in resolved) {
		return { kind: "reject", rejection: resolved, text };
	}
	return { kind: "confirm", resolved, summary: describeResolvedCommand(resolved) };
}
