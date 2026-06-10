import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import type {
	RuntimeRequirementItem,
	RuntimeRequirementPriority,
	RuntimeRequirementStatus,
	RuntimeRequirementVersion,
} from "../core/api-contract";
import { addRequirement, deleteRequirement, updateRequirement } from "../core/requirement-mutations";
import { analyzeRequirements, applyReviewPlan, reviewPlanSchema } from "../core/requirement-review";
import {
	appendRequirementVersion,
	formatRequirementVersionLabel,
	revertRequirementToVersion,
} from "../core/requirement-versions";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	createRuntimeTrpcClient,
	ensureRuntimeWorkspace,
	type JsonRecord,
	printJson,
	resolveRuntimeWorkspace,
	resolveWorkspaceRepoPath,
	toErrorMessage,
	updateRuntimeWorkspaceState,
} from "./runtime-workspace";

const REQUIREMENT_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const REQUIREMENT_STATUSES = ["draft", "active", "done", "archived"] as const;

function parsePriority(value: string | undefined): RuntimeRequirementPriority | undefined {
	if (value === undefined) {
		return undefined;
	}
	if ((REQUIREMENT_PRIORITIES as readonly string[]).includes(value)) {
		return value as RuntimeRequirementPriority;
	}
	throw new Error(`Invalid priority "${value}". Expected one of: ${REQUIREMENT_PRIORITIES.join(", ")}.`);
}

function parseStatus(value: string | undefined): RuntimeRequirementStatus | undefined {
	if (value === undefined) {
		return undefined;
	}
	if ((REQUIREMENT_STATUSES as readonly string[]).includes(value)) {
		return value as RuntimeRequirementStatus;
	}
	throw new Error(`Invalid status "${value}". Expected one of: ${REQUIREMENT_STATUSES.join(", ")}.`);
}

function parseVersionNumber(value: string): number {
	const trimmed = value.trim();
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
		throw new Error(`Invalid version "${value}". Expected a positive integer.`);
	}
	return parsed;
}

function parseStaleDays(value: string): number {
	const trimmed = value.trim();
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
		throw new Error(`Invalid stale-days "${value}". Expected a positive integer.`);
	}
	return parsed;
}

async function readReviewPlanInput(planPath: string | undefined): Promise<string> {
	if (planPath !== undefined) {
		return await readFile(planPath, "utf8");
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function formatRequirementRecord(item: RuntimeRequirementItem): JsonRecord {
	return {
		id: item.id,
		title: item.title,
		description: item.description,
		priority: item.priority,
		status: item.status,
		linkedTaskIds: item.linkedTaskIds,
		order: item.order,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

function formatVersionRecord(version: RuntimeRequirementVersion): JsonRecord {
	return {
		requirementId: version.requirementId,
		version: version.version,
		versionLabel: formatRequirementVersionLabel(version.version),
		changeKind: version.changeKind,
		source: version.source,
		reason: version.reason,
		createdAt: version.createdAt,
		snapshot: formatRequirementRecord(version.snapshot),
	};
}

async function listRequirements(input: {
	cwd: string;
	projectPath?: string;
	status?: RuntimeRequirementStatus;
	priority?: RuntimeRequirementPriority;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const requirements = [...state.requirements.items]
		.filter((item) => (input.status ? item.status === input.status : true))
		.filter((item) => (input.priority ? item.priority === input.priority : true))
		.sort((left, right) => left.order - right.order)
		.map(formatRequirementRecord);

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		status: input.status ?? null,
		priority: input.priority ?? null,
		requirements,
		count: requirements.length,
	};
}

async function showRequirement(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const requirement = state.requirements.items.find((item) => item.id === input.id);
	if (!requirement) {
		throw new Error(`Requirement "${input.id}" was not found in workspace ${workspace.repoPath}.`);
	}
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		requirement: formatRequirementRecord(requirement),
	};
}

async function createRequirementCommand(input: {
	cwd: string;
	title: string;
	description?: string;
	priority?: RuntimeRequirementPriority;
	status?: RuntimeRequirementStatus;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const created = await updateRuntimeWorkspaceState(
		runtimeClient,
		workspaceRepoPath,
		(state, { requirementVersions }) => {
			const result = addRequirement(
				state.requirements,
				{
					title: input.title,
					description: input.description,
					priority: input.priority,
					status: input.status,
				},
				() => globalThis.crypto.randomUUID(),
			);
			const appended = appendRequirementVersion(requirementVersions, {
				requirementId: result.requirement.id,
				snapshot: result.requirement,
				changeKind: "create",
				source: "human",
			});
			return {
				board: state.board,
				requirements: result.data,
				requirementVersions: appended.data,
				value: result.requirement,
			};
		},
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		requirement: formatRequirementRecord(created),
	};
}

async function updateRequirementCommand(input: {
	cwd: string;
	id: string;
	title?: string;
	description?: string;
	priority?: RuntimeRequirementPriority;
	status?: RuntimeRequirementStatus;
	projectPath?: string;
}): Promise<JsonRecord> {
	if (
		input.title === undefined &&
		input.description === undefined &&
		input.priority === undefined &&
		input.status === undefined
	) {
		throw new Error("requirement update requires at least one field to change.");
	}
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const updated = await updateRuntimeWorkspaceState(
		runtimeClient,
		workspaceRepoPath,
		(state, { requirementVersions }) => {
			const result = updateRequirement(state.requirements, input.id, {
				title: input.title,
				description: input.description,
				priority: input.priority,
				status: input.status,
			});
			if (!result.updated || !result.requirement) {
				throw new Error(`Requirement "${input.id}" was not found in workspace ${workspaceRepoPath}.`);
			}
			const appended = appendRequirementVersion(requirementVersions, {
				requirementId: result.requirement.id,
				snapshot: result.requirement,
				changeKind: "update",
				source: "human",
			});
			return {
				board: state.board,
				requirements: result.data,
				requirementVersions: appended.data,
				value: formatRequirementRecord(result.requirement),
			};
		},
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		requirement: updated,
	};
}

async function deleteRequirementCommand(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removed = await updateRuntimeWorkspaceState(
		runtimeClient,
		workspaceRepoPath,
		(state, { requirementVersions }) => {
			const result = deleteRequirement(state.requirements, input.id);
			if (!result.deleted || !result.requirement) {
				throw new Error(`Requirement "${input.id}" was not found in workspace ${workspaceRepoPath}.`);
			}
			const appended = appendRequirementVersion(requirementVersions, {
				requirementId: result.requirement.id,
				snapshot: result.requirement,
				changeKind: "delete",
				source: "human",
			});
			return {
				board: state.board,
				requirements: result.data,
				requirementVersions: appended.data,
				value: formatRequirementRecord(result.requirement),
			};
		},
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		requirement: removed,
	};
}

async function listRequirementHistory(input: { cwd: string; id: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const response = await runtimeClient.workspace.getRequirementVersions.query({ requirementId: input.id });
	const versions = [...response.versions].sort((left, right) => left.version - right.version).map(formatVersionRecord);
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		requirementId: input.id,
		versions,
		count: versions.length,
	};
}

async function revertRequirementCommand(input: {
	cwd: string;
	id: string;
	version: number;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const reverted = await updateRuntimeWorkspaceState(
		runtimeClient,
		workspaceRepoPath,
		(state, { requirementVersions }) => {
			const result = revertRequirementToVersion(state.requirements, requirementVersions, input.id, input.version, {
				source: "human",
			});
			const latest = result.versions.versions[result.versions.versions.length - 1];
			return {
				board: state.board,
				requirements: result.data,
				requirementVersions: result.versions,
				value: {
					requirement: formatRequirementRecord(result.requirement),
					revertedToVersion: input.version,
					revertedToVersionLabel: formatRequirementVersionLabel(input.version),
					newVersion: latest ? latest.version : null,
					newVersionLabel: latest ? formatRequirementVersionLabel(latest.version) : null,
				},
			};
		},
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		...reverted,
	};
}

async function reviewRequirements(input: {
	cwd: string;
	projectPath?: string;
	staleDays?: number;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const packet = analyzeRequirements(state.requirements, { staleDays: input.staleDays });
	const requirements = [...state.requirements.items]
		.sort((left, right) => left.order - right.order)
		.map(formatRequirementRecord);
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		staleDays: packet.staleDays,
		requirements,
		signals: packet.signals,
		skippedGates: packet.skippedGates,
		gateGuide: packet.gateGuide,
		count: requirements.length,
	};
}

async function applyRequirementReviewCommand(input: {
	cwd: string;
	planPath?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const raw = await readReviewPlanInput(input.planPath);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Review plan is not valid JSON: ${toErrorMessage(error)}`);
	}
	const parsed = reviewPlanSchema.safeParse(parsedJson);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
		throw new Error(`Invalid review plan: ${issues}`);
	}
	const plan = parsed.data;

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const report = await updateRuntimeWorkspaceState(
		runtimeClient,
		workspaceRepoPath,
		(state, { requirementVersions }) => {
			const result = applyReviewPlan(state.requirements, requirementVersions, plan, {
				randomUuid: () => globalThis.crypto.randomUUID(),
			});
			return {
				board: state.board,
				requirements: result.data,
				requirementVersions: result.versions,
				value: result.report,
			};
		},
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		actions: report.actions,
		summary: report.summary,
	};
}

async function runRequirementCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Requirement command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerRequirementCommand(program: Command): void {
	const requirement = program
		.command("requirement")
		.alias("req")
		.alias("requirements")
		.description("Manage Kanban requirement items from the CLI.");

	requirement
		.command("list")
		.description("List requirement items for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--status <status>", "Filter by status: draft | active | done | archived.", parseStatus)
		.option("--priority <priority>", "Filter by priority: low | medium | high | urgent.", parsePriority)
		.action(
			async (options: { projectPath?: string; status?: RuntimeRequirementStatus; priority?: RuntimeRequirementPriority }) => {
				await runRequirementCommand(
					async () =>
						await listRequirements({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							status: options.status,
							priority: options.priority,
						}),
				);
			},
		);

	requirement
		.command("show")
		.description("Show a single requirement item.")
		.requiredOption("--id <id>", "Requirement ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await showRequirement({
						cwd: process.cwd(),
						id: options.id,
						projectPath: options.projectPath,
					}),
			);
		});

	requirement
		.command("create")
		.description("Create a requirement item.")
		.requiredOption("--title <text>", "Requirement title.")
		.option("--description <text>", "Requirement description.")
		.option("--priority <priority>", "Priority: low | medium | high | urgent. Defaults to medium.", parsePriority)
		.option("--status <status>", "Status: draft | active | done | archived. Defaults to draft.", parseStatus)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				title: string;
				description?: string;
				priority?: RuntimeRequirementPriority;
				status?: RuntimeRequirementStatus;
				projectPath?: string;
			}) => {
				await runRequirementCommand(
					async () =>
						await createRequirementCommand({
							cwd: process.cwd(),
							title: options.title,
							description: options.description,
							priority: options.priority,
							status: options.status,
							projectPath: options.projectPath,
						}),
				);
			},
		);

	requirement
		.command("update")
		.description("Update an existing requirement item.")
		.requiredOption("--id <id>", "Requirement ID.")
		.option("--title <text>", "Replacement title.")
		.option("--description <text>", "Replacement description.")
		.option("--priority <priority>", "Replacement priority: low | medium | high | urgent.", parsePriority)
		.option("--status <status>", "Replacement status: draft | active | done | archived.", parseStatus)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				id: string;
				title?: string;
				description?: string;
				priority?: RuntimeRequirementPriority;
				status?: RuntimeRequirementStatus;
				projectPath?: string;
			}) => {
				await runRequirementCommand(
					async () =>
						await updateRequirementCommand({
							cwd: process.cwd(),
							id: options.id,
							title: options.title,
							description: options.description,
							priority: options.priority,
							status: options.status,
							projectPath: options.projectPath,
						}),
				);
			},
		);

	requirement
		.command("delete")
		.description("Permanently delete a requirement item.")
		.requiredOption("--id <id>", "Requirement ID to delete.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await deleteRequirementCommand({
						cwd: process.cwd(),
						id: options.id,
						projectPath: options.projectPath,
					}),
			);
		});

	requirement
		.command("history")
		.description("List the version history of a requirement item.")
		.requiredOption("--id <id>", "Requirement ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await listRequirementHistory({
						cwd: process.cwd(),
						id: options.id,
						projectPath: options.projectPath,
					}),
			);
		});

	const review = requirement
		.command("review")
		.description("Analyze requirement items and emit a review packet for an agent to reason over.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--stale-days <number>", "Days an active requirement may be idle before it is flagged stale.", parseStaleDays)
		.action(async (options: { projectPath?: string; staleDays?: number }) => {
			await runRequirementCommand(
				async () =>
					await reviewRequirements({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						staleDays: options.staleDays,
					}),
			);
		});

	review
		.command("apply")
		.description("Apply an agent-decided review plan; every change is versioned with source=agent.")
		.option("--plan <file>", "Path to a JSON review plan. Reads from stdin when omitted.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async function (this: Command) {
			const options = this.optsWithGlobals() as { plan?: string; projectPath?: string };
			await runRequirementCommand(
				async () =>
					await applyRequirementReviewCommand({
						cwd: process.cwd(),
						planPath: options.plan,
						projectPath: options.projectPath,
					}),
			);
		});

	requirement
		.command("revert")
		.description("Revert a requirement item to a previous version (recorded as a new version).")
		.requiredOption("--id <id>", "Requirement ID.")
		.requiredOption("--version <number>", "Version number to revert to.", parseVersionNumber)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { id: string; version: number; projectPath?: string }) => {
			await runRequirementCommand(
				async () =>
					await revertRequirementCommand({
						cwd: process.cwd(),
						id: options.id,
						version: options.version,
						projectPath: options.projectPath,
					}),
			);
		});
}
