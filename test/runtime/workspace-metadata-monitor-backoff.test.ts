import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The workspace metadata monitor used to poll every tracked task on a fixed 1s
// `setInterval`, spawning git probes unconditionally even when nothing changed.
// These tests pin the adaptive-backoff behavior: when the workspace is idle the
// poll cadence backs off toward a cap, and the moment a refresh detects a change
// the cadence snaps back to the fast base interval. Git work is mocked so we can
// count probe spawns (`git status`) deterministically under fake timers.

vi.mock("../../src/workspace/git-utils", () => ({
	runGit: vi.fn(),
}));
vi.mock("../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: vi.fn(),
}));

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import {
	computeNextPollIntervalMs,
	createWorkspaceMetadataMonitor,
	WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS,
	WORKSPACE_METADATA_POLL_INTERVAL_MS,
} from "../../src/server/workspace-metadata-monitor";
import { runGit } from "../../src/workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../../src/workspace/task-worktree";

const runGitMock = vi.mocked(runGit);
const getTaskWorkspacePathInfoMock = vi.mocked(getTaskWorkspacePathInfo);

function gitOk(stdout: string) {
	return {
		ok: true as const,
		stdout,
		stderr: "",
		output: stdout,
		error: null,
		exitCode: 0,
	};
}

const CLEAN_STATUS = "# branch.head main\n# branch.ab +0 -0\n";

// While a worktree is actively changing, each probe observes a fresh state. We model
// that by returning a distinct (but changed-file-free, so no fs stat) status string on
// every read. A stable string instead models an idle, unchanging worktree.
let activityCounter = 0;
let worktreeActive = false;

function currentStatusOutput(): string {
	if (!worktreeActive) {
		return CLEAN_STATUS;
	}
	activityCounter += 1;
	return `${CLEAN_STATUS}# branch.oid commit-${activityCounter}\n`;
}

function makeCard(id: string): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `prompt-${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function boardWith(taskIds: string[]): RuntimeBoardData {
	return {
		columns: [{ id: "in_progress", title: "In Progress", cards: taskIds.map(makeCard) }],
		dependencies: [],
	};
}

function countStatusSpawns(): number {
	return runGitMock.mock.calls.filter(([, args]) => args[0] === "status").length;
}

// Implementations are installed once and kept across tests (only call history is
// cleared). A poll refresh that is still in flight when a test ends would otherwise
// hit a reset mock and reject; keeping the implementation makes the suite robust to
// that benign dangling async.
runGitMock.mockImplementation(async (_cwd: string, args: string[]) => {
	if (args.includes("--show-toplevel")) {
		return gitOk("/repo/root");
	}
	if (args[0] === "status") {
		return gitOk(currentStatusOutput());
	}
	if (args[0] === "rev-parse" && args.includes("HEAD")) {
		return gitOk("abc123");
	}
	if (args[0] === "diff") {
		return gitOk("");
	}
	return gitOk("");
});
getTaskWorkspacePathInfoMock.mockImplementation(async ({ taskId, baseRef }) => ({
	taskId,
	path: `/repo/root/.kanban/worktrees/${taskId}`,
	exists: true,
	baseRef,
}));

beforeEach(() => {
	vi.useFakeTimers();
	activityCounter = 0;
	worktreeActive = false;
	runGitMock.mockClear();
	getTaskWorkspacePathInfoMock.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("computeNextPollIntervalMs", () => {
	it("resets to the base interval when a change was detected", () => {
		expect(computeNextPollIntervalMs(WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS, true)).toBe(
			WORKSPACE_METADATA_POLL_INTERVAL_MS,
		);
	});

	it("backs off exponentially while idle, capped at the max interval", () => {
		let interval = WORKSPACE_METADATA_POLL_INTERVAL_MS;
		const seen: number[] = [interval];
		for (let i = 0; i < 6; i += 1) {
			interval = computeNextPollIntervalMs(interval, false);
			seen.push(interval);
		}
		// Strictly non-decreasing, ends pinned at the cap, never exceeds it.
		expect(Math.max(...seen)).toBe(WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS);
		expect(seen[seen.length - 1]).toBe(WORKSPACE_METADATA_MAX_POLL_INTERVAL_MS);
		expect(interval).toBeGreaterThan(WORKSPACE_METADATA_POLL_INTERVAL_MS);
	});
});

describe("workspace metadata monitor adaptive polling", () => {
	it("polls far less often than a fixed 1s cadence while idle", async () => {
		const monitor = createWorkspaceMetadataMonitor({ onMetadataUpdated: () => {} });
		await monitor.connectWorkspace({
			workspaceId: "ws-idle",
			workspacePath: "/repo/root/idle",
			board: boardWith(["task-1"]),
		});

		const afterConnect = countStatusSpawns();
		await vi.advanceTimersByTimeAsync(15_000);
		const idlePolls = countStatusSpawns() - afterConnect;

		// A fixed 1s poll over 15s would spawn ~15 rounds × (home + 1 task) = ~30
		// status calls. Adaptive backoff (cap 5s) should produce far fewer.
		expect(idlePolls).toBeLessThan(20);
		monitor.close();
	});

	it("holds the fast cadence while a worktree keeps changing", async () => {
		const monitor = createWorkspaceMetadataMonitor({ onMetadataUpdated: () => {} });
		await monitor.connectWorkspace({
			workspaceId: "ws-active",
			workspacePath: "/repo/root/active",
			board: boardWith(["task-1"]),
		});

		// Let it go idle and back off toward the cap.
		await vi.advanceTimersByTimeAsync(15_000);

		// The worktree starts changing every tick (agent writing files). Each poll now
		// detects a fresh state, so the cadence should stay at the fast base interval.
		worktreeActive = true;
		const beforeActive = countStatusSpawns();
		await vi.advanceTimersByTimeAsync(10 * WORKSPACE_METADATA_POLL_INTERVAL_MS);
		const activePolls = countStatusSpawns() - beforeActive;

		// After the first detected change (which can lag by up to one backed-off
		// interval) the cadence holds at the base interval, so a 10s window yields many
		// rounds × (home + 1 task). A still-backed-off cadence (5s) would manage only ~4.
		expect(activePolls).toBeGreaterThanOrEqual(8);
		monitor.close();
	});
});
