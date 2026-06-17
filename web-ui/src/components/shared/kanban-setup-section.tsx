import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, ExternalLink, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";

import {
	buildKanbanAgentModelPickerOptions,
	CLINE_REASONING_EFFORT_OPTIONS,
} from "@/components/detail-panels/kanban-model-picker-options";
import { SearchSelectDropdown, type SearchSelectOption } from "@/components/search-select-dropdown";
import {
	KanbanAddProviderDialog,
	type KanbanProviderDialogInitialValues,
	type KanbanProviderDialogMode,
} from "@/components/shared/kanban-add-provider-dialog";
import { KanbanOauthSignInPanel } from "@/components/shared/kanban-oauth-signin-panel";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	AddKanbanProviderInput,
	UpdateKanbanProviderInput,
	UseRuntimeSettingsKanbanControllerResult,
} from "@/hooks/use-runtime-settings-kanban-controller";
import type { UseRuntimeSettingsKanbanMcpControllerResult } from "@/hooks/use-runtime-settings-kanban-mcp-controller";
import { openFileOnHost } from "@/runtime/runtime-config-query";
import type { RuntimeKanbanMcpServer, RuntimeReasoningEffort } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

export function KanbanSetupSection({
	controller,
	mcpController,
	controlsDisabled,
	workspaceId = null,
	showMcpSettings = true,
	onError,
	onSaved,
}: {
	controller: UseRuntimeSettingsKanbanControllerResult;
	mcpController?: UseRuntimeSettingsKanbanMcpControllerResult;
	controlsDisabled: boolean;
	workspaceId?: string | null;
	showMcpSettings?: boolean;
	onError?: (message: string | null) => void;
	onSaved?: () => void;
}): ReactElement {
	const mcpControlsDisabled = controlsDisabled || (mcpController?.isSavingMcpSettings ?? false);
	const [isAddProviderDialogOpen, setIsAddProviderDialogOpen] = useState(false);
	const [providerDialogMode, setProviderDialogMode] = useState<KanbanProviderDialogMode>("add");

	const kanbanProviderOptions = useMemo((): SearchSelectOption[] => {
		const items: SearchSelectOption[] = controller.providerCatalog.map((provider) => ({
			value: provider.id,
			label: provider.name,
		}));
		const trimmedId = controller.providerId.trim();
		if (
			trimmedId.length > 0 &&
			!controller.providerCatalog.some(
				(provider) => provider.id.trim().toLowerCase() === controller.normalizedProviderId,
			)
		) {
			items.push({ value: trimmedId, label: `${trimmedId} (custom)` });
		}
		return items;
	}, [controller.providerCatalog, controller.providerId, controller.normalizedProviderId]);

	const modelPickerOptions = useMemo(
		() => buildKanbanAgentModelPickerOptions(controller.providerId, controller.providerModels),
		[controller.providerId, controller.providerModels],
	);
	const kanbanModelOptions = modelPickerOptions.options;
	const selectedProvider = useMemo(
		() =>
			controller.providerCatalog.find(
				(provider) => provider.id.trim().toLowerCase() === controller.normalizedProviderId,
			) ?? null,
		[controller.normalizedProviderId, controller.providerCatalog],
	);
	const apiKeyPlaceholder = controller.apiKeyConfigured ? "Saved" : "Enter API key";
	const providerEnvHint = (selectedProvider?.env ?? [])
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.join(", ");
	const shouldShowBaseUrlField =
		!controller.isOauthProviderSelected &&
		(selectedProvider?.supportsBaseUrl ?? controller.baseUrl.trim().length > 0);
	const isBedrockProvider = controller.normalizedProviderId === "bedrock";
	const isVertexProvider = controller.normalizedProviderId === "vertex";
	const selectedProviderOption = useMemo(
		() => kanbanProviderOptions.find((option) => option.value === controller.providerId) ?? null,
		[kanbanProviderOptions, controller.providerId],
	);
	const canEditSelectedProvider = controller.providerId.trim().length > 0 && !controller.isOauthProviderSelected;
	const selectedProviderEditInitialValues = useMemo((): KanbanProviderDialogInitialValues | null => {
		if (!canEditSelectedProvider) {
			return null;
		}
		const fallbackProviderId = controller.providerId.trim();
		const fallbackProviderName = selectedProviderOption?.label.replace(/\s+\(custom\)$/i, "") || fallbackProviderId;
		const modelIds = controller.providerModels.map((model) => model.id);
		const fallbackModelIds =
			modelIds.length > 0 ? modelIds : controller.modelId.trim().length > 0 ? [controller.modelId.trim()] : [];
		// Prefer the provider's persisted model list so the edit dialog echoes
		// exactly what was saved; fall back to the live runtime list otherwise.
		const normalizedModelIds = selectedProvider?.models?.length ? selectedProvider.models : fallbackModelIds;
		return {
			providerId: selectedProvider?.id ?? fallbackProviderId,
			name: selectedProvider?.name ?? fallbackProviderName,
			baseUrl: controller.baseUrl.trim() || selectedProvider?.baseUrl?.trim() || "",
			models: normalizedModelIds,
			defaultModelId: controller.modelId.trim() || selectedProvider?.defaultModelId?.trim() || "",
			modelsSourceUrl: selectedProvider?.modelsSourceUrl ?? "",
		};
	}, [
		canEditSelectedProvider,
		controller.baseUrl,
		controller.modelId,
		controller.providerId,
		controller.providerModels,
		selectedProvider,
		selectedProviderOption,
	]);

	const handleAddMcpServer = () => {
		if (!mcpController) {
			return;
		}
		mcpController.setMcpServers((current) => [
			...current,
			{
				name: "",
				disabled: false,
				type: "streamableHttp",
				url: "",
			},
		]);
	};

	const updateMcpServer = (serverIndex: number, updater: (server: RuntimeKanbanMcpServer) => RuntimeKanbanMcpServer) => {
		if (!mcpController) {
			return;
		}
		mcpController.setMcpServers((current) =>
			current.map((server, index) => (index === serverIndex ? updater(server) : server)),
		);
	};

	const removeMcpServer = (serverIndex: number) => {
		if (!mcpController) {
			return;
		}
		mcpController.setMcpServers((current) => current.filter((_, index) => index !== serverIndex));
	};

	const handleMcpServerOauth = (serverName: string) => {
		void (async () => {
			if (!mcpController) {
				return;
			}
			onError?.(null);
			const result = await mcpController.runMcpServerOauth(serverName);
			if (!result.ok) {
				onError?.(result.message ?? `Failed to authorize MCP server "${serverName}".`);
				return;
			}
			onSaved?.();
		})();
	};

	const handleSetupLinearMcp = () => {
		void (async () => {
			if (!mcpController) {
				return;
			}
			onError?.(null);
			const result = await mcpController.linearMcpPreset.setup();
			if (!result.ok) {
				onError?.(result.message ?? "Failed to set up Linear MCP.");
				return;
			}
			onSaved?.();
		})();
	};

	const handleOpenFilePath = (filePath: string) => {
		onError?.(null);
		void openFileOnHost(workspaceId, filePath).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			onError?.(`Could not open file on host: ${message}`);
		});
	};

	const handleRefreshProviderModels = () => {
		void (async () => {
			onError?.(null);
			const result = await controller.refreshProviderModels();
			if (!result.ok) {
				onError?.(result.message ?? "Failed to refresh Kanban models.");
				return;
			}
		})();
	};

	return (
		<>
			<div className="mt-2">
				<p className="text-text-primary font-semibold text-[12px] mt-0 mb-2">API provider</p>
				<div className="min-w-0 w-1/2 max-w-full">
					<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
						<div className="min-w-0">
							<SearchSelectDropdown
								options={kanbanProviderOptions}
								selectedValue={controller.providerId}
								onSelect={(value) => {
									const normalizedProviderId = value.trim().toLowerCase();
									if (normalizedProviderId === controller.normalizedProviderId) {
										return;
									}
									controller.setProviderId(value);
									const selectedProvider =
										controller.providerCatalog.find(
											(provider) => provider.id.trim().toLowerCase() === normalizedProviderId,
										) ?? null;
									const defaultModelId = selectedProvider?.defaultModelId?.trim() ?? "";
									const defaultBaseUrl = selectedProvider?.baseUrl?.trim() ?? "";
									controller.setModelId(defaultModelId);
									controller.setBaseUrl(defaultBaseUrl);
								}}
								disabled={controlsDisabled || controller.isLoadingProviderCatalog}
								fill
								size="sm"
								buttonText={
									controller.isLoadingProviderCatalog
										? "Loading providers..."
										: kanbanProviderOptions.find((option) => option.value === controller.providerId)?.label
								}
								emptyText="Select provider"
								noResultsText="No matching providers"
								placeholder="Search providers..."
								showSelectedIndicator
								footerAction={{
									label: "+ New Provider",
									onClick: () => {
										onError?.(null);
										setProviderDialogMode("add");
										setIsAddProviderDialogOpen(true);
									},
								}}
							/>
						</div>
						{canEditSelectedProvider && (
							<Button
								variant="ghost"
								size="sm"
								icon={<Pencil size={14} />}
								disabled={controlsDisabled}
								className="shrink-0"
								onClick={() => {
									onError?.(null);
									setProviderDialogMode("edit");
									setIsAddProviderDialogOpen(true);
								}}
							>
								Edit
							</Button>
						)}
					</div>
				</div>
				{controller.isLoadingProviderCatalog ? (
					<p className="text-text-secondary text-[12px] mt-1 mb-0">Fetching Kanban providers...</p>
				) : null}
				<div
					className="grid gap-2 mt-3"
					style={{ gridTemplateColumns: controller.isOauthProviderSelected ? "1fr" : "1fr 1fr" }}
				>
					{controller.isOauthProviderSelected ? null : (
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">API key</p>
							<input
								type="password"
								value={controller.apiKey}
								onChange={(event) => controller.setApiKey(event.target.value)}
								placeholder={apiKeyPlaceholder}
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
							{providerEnvHint ? (
								<p className="text-text-tertiary text-[11px] mt-1 mb-0 break-all">Or use {providerEnvHint}</p>
							) : null}
						</div>
					)}
					{shouldShowBaseUrlField ? (
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">Base URL</p>
							<input
								value={controller.baseUrl}
								onChange={(event) => controller.setBaseUrl(event.target.value)}
								placeholder="https://api.cline.bot"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
					) : null}
				</div>
				{isBedrockProvider ? (
					<div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">AWS region</p>
							<input
								value={controller.awsRegion}
								onChange={(event) => controller.setAwsRegion(event.target.value)}
								placeholder="us-east-1"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">Auth mode</p>
							<NativeSelect
								fill
								value={controller.awsAuthentication}
								onChange={(event) =>
									controller.setAwsAuthentication(event.target.value as "" | "iam" | "api-key" | "profile")
								}
								disabled={controlsDisabled}
							>
								<option value="">Auto</option>
								<option value="iam">IAM</option>
								<option value="api-key">Access keys</option>
								<option value="profile">Profile</option>
							</NativeSelect>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">AWS profile</p>
							<input
								value={controller.awsProfile}
								onChange={(event) => controller.setAwsProfile(event.target.value)}
								placeholder="default"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">Bedrock endpoint</p>
							<input
								value={controller.awsEndpoint}
								onChange={(event) => controller.setAwsEndpoint(event.target.value)}
								placeholder="https://bedrock-runtime.us-east-1.amazonaws.com"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">AWS access key</p>
							<input
								type="password"
								value={controller.awsAccessKey}
								onChange={(event) => controller.setAwsAccessKey(event.target.value)}
								placeholder="AKIA..."
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">AWS secret key</p>
							<input
								type="password"
								value={controller.awsSecretKey}
								onChange={(event) => controller.setAwsSecretKey(event.target.value)}
								placeholder="••••••••"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">AWS session token</p>
							<input
								type="password"
								value={controller.awsSessionToken}
								onChange={(event) => controller.setAwsSessionToken(event.target.value)}
								placeholder="Optional"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
					</div>
				) : null}
				{isVertexProvider ? (
					<div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">GCP project ID</p>
							<input
								value={controller.gcpProjectId}
								onChange={(event) => controller.setGcpProjectId(event.target.value)}
								placeholder="my-gcp-project"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<p className="text-text-secondary text-[12px] mt-0 mb-1">GCP region</p>
							<input
								value={controller.gcpRegion}
								onChange={(event) => controller.setGcpRegion(event.target.value)}
								placeholder="us-central1"
								disabled={controlsDisabled}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
					</div>
				) : null}
				<KanbanOauthSignInPanel
					controller={controller}
					controlsDisabled={controlsDisabled}
					onError={onError}
					onSaved={onSaved}
				/>
			</div>

			<div className="mt-4">
				<p className="text-text-primary font-semibold text-[12px] mt-0 mb-2">Model</p>
				<div
					className="grid gap-2"
					style={{ gridTemplateColumns: controller.selectedModelSupportsReasoningEffort ? "1fr 1fr" : "1fr" }}
				>
					<div className="min-w-0">
						<div className="mb-1 flex items-center justify-between gap-2 h-7">
							<p className="text-text-secondary text-[12px] m-0">Model ID</p>
							{shouldShowBaseUrlField ? (
								<Tooltip side="bottom" content="Save settings and refresh models">
									<Button
										variant="ghost"
										size="sm"
										icon={
											<RefreshCw
												size={14}
												className={controller.isLoadingProviderModels ? "animate-spin" : undefined}
											/>
										}
										aria-label="Save settings and refresh models"
										disabled={
											controlsDisabled ||
											controller.isLoadingProviderModels ||
											controller.providerId.trim().length === 0
										}
										onClick={handleRefreshProviderModels}
									/>
								</Tooltip>
							) : null}
						</div>
						<SearchSelectDropdown
							options={kanbanModelOptions}
							selectedValue={controller.modelId}
							onSelect={(value) => controller.setModelId(value)}
							disabled={controlsDisabled || controller.isLoadingProviderModels}
							fill
							size="sm"
							buttonText={
								controller.isLoadingProviderModels
									? "Loading models..."
									: (kanbanModelOptions.find((option) => option.value === controller.modelId)?.label ??
											controller.modelId.trim()) ||
										undefined
							}
							emptyText="Select model"
							noResultsText="No matching models"
							placeholder="Search models..."
							showSelectedIndicator
							pinSelectedToTop={modelPickerOptions.shouldPinSelectedModelToTop}
							recommendedOptionValues={modelPickerOptions.recommendedModelIds}
							recommendedHeading="Recommended models"
							allowCustomValue
						/>
					</div>
					{controller.selectedModelSupportsReasoningEffort ? (
						<div className="min-w-0">
							<div className="mb-1 flex items-center h-7">
								<p className="text-text-secondary text-[12px] m-0">Reasoning effort</p>
							</div>
							<SearchSelectDropdown
								options={CLINE_REASONING_EFFORT_OPTIONS}
								selectedValue={controller.reasoningEffort}
								onSelect={(value) => controller.setReasoningEffort(value as RuntimeReasoningEffort | "")}
								disabled={controlsDisabled}
								fill
								size="sm"
								buttonText={
									CLINE_REASONING_EFFORT_OPTIONS.find((option) => option.value === controller.reasoningEffort)
										?.label
								}
								emptyText="Default"
								noResultsText="No matching reasoning levels"
								placeholder="Search reasoning levels..."
								showSelectedIndicator
							/>
						</div>
					) : null}
				</div>
				{controller.isLoadingProviderModels ? (
					<p className="text-text-secondary text-[12px] mt-1 mb-0">Fetching Kanban models...</p>
				) : null}
			</div>

			{mcpController && showMcpSettings ? (
				<>
					<div className="flex items-center justify-between mt-4 mb-2">
						<h6 className="font-semibold text-[12px] text-text-primary m-0">MCP servers</h6>
						<Button
							variant="ghost"
							size="sm"
							icon={<Plus size={14} />}
							disabled={mcpControlsDisabled || mcpController.isLoadingMcpSettings}
							onClick={handleAddMcpServer}
						>
							Add
						</Button>
					</div>
					<p className="text-text-secondary text-[12px] mt-0 mb-2">
						Configure MCP servers for tool integrations.
					</p>
					{mcpController.mcpSettingsPath ? (
						<p
							className="text-text-secondary font-mono text-xs mt-0 mb-2 break-all"
							style={{ cursor: "pointer" }}
							onClick={() => {
								handleOpenFilePath(mcpController.mcpSettingsPath);
							}}
						>
							{formatPathForDisplay(mcpController.mcpSettingsPath)}
							<ExternalLink size={12} className="inline ml-1.5 align-middle" />
						</p>
					) : null}
					{mcpController.linearMcpPreset.status !== "connected" ? (
						<div className="rounded-md border border-border bg-surface-1 px-3 py-2 mb-2">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<p className="text-text-primary text-[13px] font-medium mt-0 mb-0.5">Linear</p>
									<p className="text-text-secondary text-[12px] mt-0 mb-0">
										Connect Linear for project management tools.
									</p>
								</div>
								<Button
									variant="primary"
									size="sm"
									disabled={
										mcpControlsDisabled ||
										mcpController.isLoadingMcpSettings ||
										mcpController.linearMcpPreset.isSettingUp
									}
									onClick={handleSetupLinearMcp}
									className="shrink-0"
								>
									{mcpController.linearMcpPreset.isSettingUp
										? "Setting up..."
										: mcpController.linearMcpPreset.status === "configured"
											? "Connect Linear"
											: "Set up Linear"}
								</Button>
							</div>
						</div>
					) : null}

					{mcpController.isLoadingMcpSettings ? (
						<p className="text-text-secondary text-[12px] mt-1 mb-0">Loading MCP settings...</p>
					) : null}

					{!mcpController.isLoadingMcpSettings && mcpController.mcpServers.length === 0 ? (
						<p className="text-text-secondary text-[12px] mt-1 mb-0">No MCP servers configured.</p>
					) : null}

					{mcpController.mcpServers.map((server, serverIndex) => {
						const authStatus = mcpController.mcpAuthStatusByServerName[server.name];
						const oauthSupported = server.type !== "stdio";
						const oauthConfigured = authStatus?.oauthConfigured ?? false;
						const isAuthenticating = mcpController.authenticatingMcpServerName === server.name;

						return (
							<div key={serverIndex} className="flex items-start gap-2 mt-2">
								<div className="rounded-md border border-border p-2 flex-1 min-w-0">
									<div className="grid gap-2" style={{ gridTemplateColumns: "1.2fr 1fr" }}>
										<div className="min-w-0">
											<p className="text-text-secondary text-[12px] mt-0 mb-1">Server name</p>
											<input
												value={server.name}
												onChange={(event) => {
													updateMcpServer(serverIndex, (current) => ({
														...current,
														name: event.target.value,
													}));
												}}
												placeholder="linear"
												disabled={mcpControlsDisabled}
												className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
											/>
										</div>
										<div className="min-w-0">
											<p className="text-text-secondary text-[12px] mt-0 mb-1">Transport</p>
											<NativeSelect
												fill
												value={server.type}
												onChange={(event) => {
													const nextType = event.target.value as RuntimeKanbanMcpServer["type"];
													updateMcpServer(serverIndex, (current) => {
														if (nextType === "stdio") {
															return {
																name: current.name,
																disabled: current.disabled,
																type: "stdio",
																command: "",
															};
														}
														return {
															name: current.name,
															disabled: current.disabled,
															type: nextType,
															url: "",
														};
													});
												}}
												disabled={mcpControlsDisabled}
											>
												<option value="streamableHttp">HTTP</option>
												<option value="sse">SSE</option>
												<option value="stdio">Stdio</option>
											</NativeSelect>
										</div>
									</div>

									{server.type === "stdio" ? (
										<div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
											<div className="min-w-0">
												<p className="text-text-secondary text-[12px] mt-0 mb-1">Command</p>
												<input
													value={server.command}
													onChange={(event) => {
														updateMcpServer(serverIndex, (current) => {
															if (current.type !== "stdio") {
																return current;
															}
															return {
																...current,
																command: event.target.value,
															};
														});
													}}
													placeholder="Command"
													disabled={mcpControlsDisabled}
													className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
												/>
											</div>
											<div className="min-w-0">
												<p className="text-text-secondary text-[12px] mt-0 mb-1">Arguments</p>
												<input
													value={(server.args ?? []).join(" ")}
													onChange={(event) => {
														updateMcpServer(serverIndex, (current) => {
															if (current.type !== "stdio") {
																return current;
															}
															return {
																...current,
																args: event.target.value
																	.split(/\s+/)
																	.map((value) => value.trim())
																	.filter((value) => value.length > 0),
															};
														});
													}}
													placeholder="Args"
													disabled={mcpControlsDisabled}
													className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
												/>
											</div>
											<div className="min-w-0" style={{ gridColumn: "1 / -1" }}>
												<p className="text-text-secondary text-[12px] mt-0 mb-1">Working directory</p>
												<input
													value={server.cwd ?? ""}
													onChange={(event) => {
														updateMcpServer(serverIndex, (current) => {
															if (current.type !== "stdio") {
																return current;
															}
															return {
																...current,
																cwd: event.target.value,
															};
														});
													}}
													placeholder="Working directory (optional)"
													disabled={mcpControlsDisabled}
													className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
												/>
											</div>
										</div>
									) : (
										<div className="min-w-0 mt-2">
											<p className="text-text-secondary text-[12px] mt-0 mb-1">URL</p>
											<input
												value={server.url}
												onChange={(event) => {
													updateMcpServer(serverIndex, (current) => {
														if (current.type === "stdio") {
															return current;
														}
														return {
															...current,
															url: event.target.value,
														};
													});
												}}
												placeholder="https://example.com/mcp"
												disabled={mcpControlsDisabled}
												className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
											/>
										</div>
									)}

									{oauthSupported ? (
										<div className="mt-2">
											<p className="text-text-secondary text-[12px] mt-0 mb-1">
												OAuth:{" "}
												<span className="text-text-primary">
													{oauthConfigured ? "Connected" : "Not connected"}
												</span>
											</p>
											{authStatus?.lastError ? (
												<p className="text-status-red text-[12px] mt-0 mb-1">{authStatus.lastError}</p>
											) : null}
											<Button
												variant="default"
												size="sm"
												disabled={mcpControlsDisabled || isAuthenticating}
												onClick={() => {
													handleMcpServerOauth(server.name);
												}}
											>
												{isAuthenticating
													? "Connecting OAuth..."
													: oauthConfigured
														? "Reconnect OAuth"
														: "Connect OAuth"}
											</Button>
										</div>
									) : null}

									<label
										htmlFor={`mcp-disabled-${serverIndex}`}
										className="flex items-center gap-2 text-[12px] text-text-primary mt-2 cursor-pointer select-none"
									>
										<RadixCheckbox.Root
											id={`mcp-disabled-${serverIndex}`}
											checked={server.disabled}
											disabled={mcpControlsDisabled}
											onCheckedChange={(checked) => {
												updateMcpServer(serverIndex, (current) => ({
													...current,
													disabled: checked === true,
												}));
											}}
											className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
										>
											<RadixCheckbox.Indicator>
												<Check size={12} className="text-white" />
											</RadixCheckbox.Indicator>
										</RadixCheckbox.Root>
										<span>Disabled</span>
									</label>
								</div>
								<Button
									variant="ghost"
									size="sm"
									icon={<X size={14} />}
									aria-label={`Remove MCP server ${server.name || serverIndex + 1}`}
									disabled={mcpControlsDisabled}
									onClick={() => removeMcpServer(serverIndex)}
								/>
							</div>
						);
					})}
				</>
			) : null}
			<KanbanAddProviderDialog
				open={isAddProviderDialogOpen}
				onOpenChange={setIsAddProviderDialogOpen}
				existingProviderIds={controller.providerCatalog.map((provider) => provider.id)}
				agentId="pi"
				mode={providerDialogMode}
				initialValues={providerDialogMode === "edit" ? selectedProviderEditInitialValues : null}
				onSubmit={async (input) => {
					onError?.(null);
					const result =
						providerDialogMode === "edit"
							? await controller.updateCustomProvider(input as UpdateKanbanProviderInput)
							: await controller.addCustomProvider(input as AddKanbanProviderInput);
					if (!result.ok) {
						onError?.(
							result.message ??
								(providerDialogMode === "edit" ? "Failed to update provider." : "Failed to add provider."),
						);
						return result;
					}
					onSaved?.();
					return result;
				}}
			/>
		</>
	);
}
