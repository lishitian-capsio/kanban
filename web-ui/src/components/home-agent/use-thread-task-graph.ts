// Derives the dependency relationships AMONG a single thread's tasks, so the
// "Session tasks" dialog can show, per task, what it's waiting on and what it
// blocks. The board's dependency edges are one-way `fromTaskId → toTaskId` and
// intentionally shallow (backlog↔non-backlog only, no transitive chains), so a
// per-task in/out adjacency map is all the relationship view needs.
//
// Only edges whose BOTH endpoints belong to this thread are included — the dialog
// is thread-scoped, and a dependency to a task from another session isn't
// actionable here. Dangling edges (referencing a task not in the thread set) are
// silently dropped rather than rendered as an orphan pill.

import { useMemo } from "react";

import { useHomeThreadTaskCards } from "@/components/home-agent/thread-tasks";
import { useRuntimeWorkspaceState } from "@/runtime/runtime-stream-store";
import type { RuntimeBoardColumnId, RuntimeBoardDependency } from "@/runtime/types";

/** A resolved endpoint of a dependency edge, ready to render as a directional pill. */
export interface LinkedTaskRef {
	dependencyId: string;
	taskId: string;
	title: string;
	columnId: RuntimeBoardColumnId;
}

export interface ThreadTaskLinks {
	/** Tasks this task depends on (edges where this task is the `to`). */
	waitingOn: LinkedTaskRef[];
	/** Tasks that depend on this task (edges where this task is the `from`). */
	blocking: LinkedTaskRef[];
}

interface ThreadTaskMeta {
	title: string;
	columnId: RuntimeBoardColumnId;
}

/**
 * Build the per-task in/out adjacency for the thread. Pure: `metaById` supplies
 * the title/column for each of the thread's tasks; only edges with both endpoints
 * present in `metaById` are kept. Returns a Map keyed by taskId.
 */
export function buildThreadTaskGraph(
	dependencies: readonly RuntimeBoardDependency[],
	metaById: ReadonlyMap<string, ThreadTaskMeta>,
): Map<string, ThreadTaskLinks> {
	const graph = new Map<string, ThreadTaskLinks>();
	const linksFor = (taskId: string): ThreadTaskLinks => {
		let links = graph.get(taskId);
		if (!links) {
			links = { waitingOn: [], blocking: [] };
			graph.set(taskId, links);
		}
		return links;
	};

	for (const dependency of dependencies) {
		const from = metaById.get(dependency.fromTaskId);
		const to = metaById.get(dependency.toTaskId);
		if (!from || !to) {
			continue;
		}
		// `from` blocks `to`; equivalently, `to` is waiting on `from`.
		linksFor(dependency.fromTaskId).blocking.push({
			dependencyId: dependency.id,
			taskId: dependency.toTaskId,
			title: to.title,
			columnId: to.columnId,
		});
		linksFor(dependency.toTaskId).waitingOn.push({
			dependencyId: dependency.id,
			taskId: dependency.fromTaskId,
			title: from.title,
			columnId: from.columnId,
		});
	}
	return graph;
}

const EMPTY_LINKS: ThreadTaskLinks = { waitingOn: [], blocking: [] };

/**
 * Leaf-subscribed dependency adjacency for a thread's tasks. Reads the board's
 * dependency edges and the thread's cards, memoized on both. Per the store's
 * leaf-subscription rule, call this inside the dialog, not at App level.
 */
export function useThreadTaskGraph(threadId: string | null): Map<string, ThreadTaskLinks> {
	const workspaceState = useRuntimeWorkspaceState();
	const dependencies = workspaceState?.board.dependencies ?? null;
	const threadCards = useHomeThreadTaskCards(threadId);
	return useMemo(() => {
		if (!dependencies || threadCards.length === 0) {
			return new Map<string, ThreadTaskLinks>();
		}
		const metaById = new Map<string, ThreadTaskMeta>(
			threadCards.map(({ card, columnId }) => [card.id, { title: card.title, columnId }]),
		);
		return buildThreadTaskGraph(dependencies, metaById);
	}, [dependencies, threadCards]);
}

/** Convenience accessor: never-null links for a task (empty when it has no edges). */
export function threadTaskLinks(graph: Map<string, ThreadTaskLinks>, taskId: string): ThreadTaskLinks {
	return graph.get(taskId) ?? EMPTY_LINKS;
}
