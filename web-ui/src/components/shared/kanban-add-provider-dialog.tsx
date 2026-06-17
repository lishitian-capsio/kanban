import {
	AGENT_PROTOCOL_COMPATIBILITY,
	PROVIDER_PROTOCOLS,
	type ProviderProtocol,
} from "@runtime-provider-protocol";
import { Check, Eye, EyeOff, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import type {
	AddKanbanProviderInput,
	AnthropicProviderSettingsInput,
	UpdateKanbanProviderInput,
} from "@/hooks/use-runtime-settings-kanban-controller";
import { fetchRemoteProviderModels } from "@/runtime/runtime-config-query";
import type { RuntimeKanbanProviderCapability } from "@/runtime/types";

const PROTOCOL_OPTIONS: readonly { value: ProviderProtocol; label: string; description: string }[] = [
	{ value: "openai", label: "OpenAI-compatible", description: "OpenAI, Ollama, OpenRouter, most providers" },
	{ value: "anthropic", label: "Anthropic-compatible", description: "Anthropic, Amazon Bedrock, some proxies" },
];

type ApiKeyField = "auth_token" | "api_key";
const API_KEY_FIELD_OPTIONS: readonly { value: ApiKeyField; label: string; description: string }[] = [
	{ value: "auth_token", label: "Authorization (Bearer)", description: "ANTHROPIC_AUTH_TOKEN — most relays/gateways" },
	{ value: "api_key", label: "x-api-key", description: "ANTHROPIC_API_KEY — official api.anthropic.com" },
];
const DEFAULT_API_KEY_FIELD: ApiKeyField = "auth_token";

const ANTHROPIC_MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
type AnthropicModelTier = (typeof ANTHROPIC_MODEL_TIERS)[number];
type AnthropicDefaultModelsForm = Record<AnthropicModelTier, string>;

/**
 * Resolve the protocols an agent can actually use. An empty/undefined
 * compatibility entry (e.g. gemini's independent protocol) is treated as
 * "no restriction" so every protocol stays selectable.
 */
function resolveAllowedProtocols(agentId: string | undefined): ProviderProtocol[] {
	if (!agentId) {
		return [...PROVIDER_PROTOCOLS];
	}
	const compatible = AGENT_PROTOCOL_COMPATIBILITY[agentId];
	if (!compatible || compatible.length === 0) {
		return [...PROVIDER_PROTOCOLS];
	}
	return compatible;
}

/** Pick the default protocol for a new provider, honoring the display order. */
function pickDefaultProtocol(allowedProtocols: ProviderProtocol[]): ProviderProtocol {
	const ordered = PROTOCOL_OPTIONS.find((option) => allowedProtocols.includes(option.value));
	return ordered?.value ?? allowedProtocols[0] ?? "openai";
}

const CAPABILITY_OPTIONS: readonly RuntimeKanbanProviderCapability[] = [
	"streaming",
	"tools",
	"reasoning",
	"vision",
	"prompt-cache",
];

interface HeaderEntry {
	id: string;
	key: string;
	value: string;
}

interface FormState {
	providerId: string;
	name: string;
	apiKey: string;
	/** The single protocol this provider speaks for the owning agent. */
	protocol: ProviderProtocol;
	/** The endpoint URL for that protocol — the single source of truth. */
	baseUrl: string;
	modelsSourceUrl: string;
	models: string[];
	defaultModelId: string;
	timeoutMs: string;
	headers: HeaderEntry[];
	capabilities: RuntimeKanbanProviderCapability[];
	/** Anthropic-only: which header the key is sent under. */
	apiKeyField: ApiKeyField;
	/** Anthropic-only: per-tier model overrides (ANTHROPIC_DEFAULT_*_MODEL). */
	anthropicDefaultModels: AnthropicDefaultModelsForm;
}

interface SaveResult {
	ok: boolean;
	message?: string;
}

export type KanbanProviderDialogMode = "add" | "edit";

export interface KanbanProviderDialogInitialValues {
	providerId: string;
	name: string;
	baseUrl?: string;
	apiKey?: string;
	protocols?: ProviderProtocol[];
	protocolConfigs?: Array<{ protocol: ProviderProtocol; baseUrl?: string }>;
	modelsSourceUrl?: string;
	models: string[];
	defaultModelId?: string;
	timeoutMs?: number | null;
	headers?: Record<string, string>;
	capabilities?: RuntimeKanbanProviderCapability[];
	anthropic?: {
		apiKeyField?: ApiKeyField;
		defaultModels?: { haiku?: string; sonnet?: string; opus?: string };
	};
}

let nextHeaderEntryId = 0;

/**
 * Resolve the single protocol + base URL to echo into the form. A per-agent
 * provider speaks exactly one protocol; we read it from the (single) stored
 * protocol config, falling back to the legacy scalar baseUrl, and finally to the
 * default protocol the owning agent allows. No per-protocol-tab duplication.
 */
function resolveInitialProtocol(
	initialValues: KanbanProviderDialogInitialValues | null | undefined,
	allowedProtocols: ProviderProtocol[],
): { protocol: ProviderProtocol; baseUrl: string } {
	const fromConfig = initialValues?.protocolConfigs?.[0];
	const candidate = fromConfig?.protocol ?? initialValues?.protocols?.[0];
	const baseUrl = fromConfig?.baseUrl ?? initialValues?.baseUrl ?? "";
	return {
		protocol: candidate ?? pickDefaultProtocol(allowedProtocols),
		baseUrl,
	};
}

function createInitialFormState(
	initialValues: KanbanProviderDialogInitialValues | null | undefined,
	allowedProtocols: ProviderProtocol[],
): FormState {
	const initialHeaders = Object.entries(initialValues?.headers ?? {}).map(([key, value]) => ({
		...createHeaderEntry(),
		key,
		value,
	}));
	const initialModels = [...new Set(initialValues?.models?.map((model) => model.trim()).filter(Boolean) ?? [])];
	const { protocol, baseUrl } = resolveInitialProtocol(initialValues, allowedProtocols);

	return {
		providerId: initialValues?.providerId ?? "",
		name: initialValues?.name ?? "",
		apiKey: initialValues?.apiKey ?? "",
		protocol,
		baseUrl,
		modelsSourceUrl: initialValues?.modelsSourceUrl ?? "",
		models: initialModels,
		defaultModelId: initialValues?.defaultModelId?.trim() || initialModels[0] || "",
		timeoutMs: initialValues?.timeoutMs ? String(initialValues.timeoutMs) : "",
		headers: initialHeaders,
		capabilities: initialValues?.capabilities?.length ? initialValues.capabilities : ["streaming", "tools"],
		apiKeyField: initialValues?.anthropic?.apiKeyField ?? DEFAULT_API_KEY_FIELD,
		anthropicDefaultModels: {
			haiku: initialValues?.anthropic?.defaultModels?.haiku ?? "",
			sonnet: initialValues?.anthropic?.defaultModels?.sonnet ?? "",
			opus: initialValues?.anthropic?.defaultModels?.opus ?? "",
		},
	};
}

/**
 * Build the Anthropic-protocol payload from form state, or `undefined` when the
 * Anthropic protocol isn't enabled. Trims and drops empty model overrides so an
 * untouched section doesn't persist empty strings.
 */
function buildAnthropicPayload(form: FormState): AnthropicProviderSettingsInput | undefined {
	if (form.protocol !== "anthropic") {
		return undefined;
	}
	const defaultModels: { haiku?: string; sonnet?: string; opus?: string } = {};
	for (const tier of ANTHROPIC_MODEL_TIERS) {
		const value = form.anthropicDefaultModels[tier].trim();
		if (value) {
			defaultModels[tier] = value;
		}
	}
	return {
		apiKeyField: form.apiKeyField,
		...(Object.keys(defaultModels).length > 0 ? { defaultModels } : {}),
	};
}

function createHeaderEntry(): HeaderEntry {
	return {
		id: `header-${nextHeaderEntryId++}`,
		key: "",
		value: "",
	};
}

export function KanbanAddProviderDialog({
	open,
	onOpenChange,
	workspaceId = null,
	existingProviderIds,
	agentId,
	mode = "add",
	initialValues = null,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId?: string | null;
	existingProviderIds: string[];
	/**
	 * The agent the provider is being configured for. Constrains which API
	 * protocols are selectable to those the agent supports
	 * (see AGENT_PROTOCOL_COMPATIBILITY). Omit for no constraint.
	 */
	agentId?: string;
	mode?: KanbanProviderDialogMode;
	initialValues?: KanbanProviderDialogInitialValues | null;
	onSubmit: (input: AddKanbanProviderInput | UpdateKanbanProviderInput) => Promise<SaveResult>;
}): ReactElement {
	const allowedProtocols = useMemo(() => resolveAllowedProtocols(agentId), [agentId]);
	const visibleProtocolOptions = useMemo(
		() => PROTOCOL_OPTIONS.filter((option) => allowedProtocols.includes(option.value)),
		[allowedProtocols],
	);
	const protocolLocked = allowedProtocols.length === 1;
	const initialForm = useMemo(
		() => createInitialFormState(initialValues, allowedProtocols),
		[initialValues, allowedProtocols],
	);
	const [form, setForm] = useState<FormState>(() => initialForm);
	const [modelInput, setModelInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const [showApiKey, setShowApiKey] = useState(false);
	const [isFetchingModels, setIsFetchingModels] = useState(false);

	useEffect(() => {
		if (open) {
			setForm(initialForm);
			setModelInput("");
			setError(null);
			setIsSaving(false);
			setShowApiKey(false);
			setIsFetchingModels(false);
			return;
		}
		setForm(initialForm);
		setModelInput("");
		setError(null);
		setIsSaving(false);
		setShowApiKey(false);
		setIsFetchingModels(false);
	}, [initialForm, open]);

	const normalizedProviderId = useMemo(
		() => form.providerId.trim().toLowerCase().replace(/\s+/g, "-"),
		[form.providerId],
	);
	const duplicateProviderId = useMemo(() => {
		if (mode === "edit" && initialForm.providerId.trim().toLowerCase() === normalizedProviderId) {
			return false;
		}
		return existingProviderIds.some((providerId) => providerId.trim().toLowerCase() === normalizedProviderId);
	}, [existingProviderIds, initialForm.providerId, mode, normalizedProviderId]);
	const normalizedPendingModel = modelInput.trim().replace(/,$/, "");
	const draftModels = useMemo(() => {
		if (!normalizedPendingModel || form.models.includes(normalizedPendingModel)) {
			return form.models;
		}
		return [...form.models, normalizedPendingModel];
	}, [form.models, normalizedPendingModel]);
	const hasManualModels = draftModels.length > 0;
	const hasModelsSource = form.modelsSourceUrl.trim().length > 0;
	const hasBaseUrl = form.baseUrl.trim().length > 0;
	const anthropicEnabled = form.protocol === "anthropic";
	const anthropicPayload = useMemo(() => buildAnthropicPayload(form), [form]);

	const hasChangedProviderConfiguration = useMemo(() => {
		const normalizedHeaders = Object.fromEntries(
			form.headers.map((entry) => [entry.key.trim(), entry.value.trim()] as const).filter(([key]) => key.length > 0),
		);
		const initialHeaders = Object.fromEntries(
			initialForm.headers
				.map((entry) => [entry.key.trim(), entry.value.trim()] as const)
				.filter(([key]) => key.length > 0),
		);
		return (
			form.name.trim() !== initialForm.name.trim() ||
			form.protocol !== initialForm.protocol ||
			form.baseUrl.trim() !== initialForm.baseUrl.trim() ||
			form.modelsSourceUrl.trim() !== initialForm.modelsSourceUrl.trim() ||
			form.defaultModelId.trim() !== initialForm.defaultModelId.trim() ||
			form.timeoutMs.trim() !== initialForm.timeoutMs.trim() ||
			JSON.stringify(draftModels) !== JSON.stringify(initialForm.models) ||
			JSON.stringify(form.capabilities) !== JSON.stringify(initialForm.capabilities) ||
			JSON.stringify(normalizedHeaders) !== JSON.stringify(initialHeaders) ||
			JSON.stringify(anthropicPayload) !== JSON.stringify(buildAnthropicPayload(initialForm)) ||
			form.apiKey.trim().length > 0
		);
	}, [
		anthropicPayload,
		draftModels,
		form.apiKey,
		form.baseUrl,
		form.capabilities,
		form.defaultModelId,
		form.headers,
		form.modelsSourceUrl,
		form.name,
		form.protocol,
		form.timeoutMs,
		initialForm,
	]);
	const canSubmit =
		normalizedProviderId.length > 0 &&
		form.name.trim().length > 0 &&
		hasBaseUrl &&
		(hasManualModels || hasModelsSource) &&
		!duplicateProviderId &&
		(form.timeoutMs.trim().length === 0 ||
			(Number.isInteger(Number(form.timeoutMs)) && Number(form.timeoutMs) > 0)) &&
		(mode === "add" || hasChangedProviderConfiguration);

	const addModel = (rawValue: string) => {
		const value = rawValue.trim().replace(/,$/, "");
		if (!value || form.models.includes(value)) {
			return;
		}
		setForm((current) => ({
			...current,
			models: [...current.models, value],
			defaultModelId: current.defaultModelId || value,
		}));
	};

	const handleModelKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if ((event.key === "Enter" || event.key === ",") && modelInput.trim()) {
			event.preventDefault();
			addModel(modelInput);
			setModelInput("");
			return;
		}
		if (event.key === "Backspace" && modelInput.length === 0 && form.models.length > 0) {
			event.preventDefault();
			const previousModel = form.models[form.models.length - 1] ?? "";
			setForm((current) => {
				const nextModels = current.models.slice(0, -1);
				return {
					...current,
					models: nextModels,
					defaultModelId:
						current.defaultModelId === previousModel ? (nextModels[0] ?? "") : current.defaultModelId,
				};
			});
		}
	};

	const removeModel = (model: string) => {
		setForm((current) => {
			const nextModels = current.models.filter((entry) => entry !== model);
			return {
				...current,
				models: nextModels,
				defaultModelId: current.defaultModelId === model ? (nextModels[0] ?? "") : current.defaultModelId,
			};
		});
	};

	const toggleCapability = (capability: RuntimeKanbanProviderCapability) => {
		setForm((current) => ({
			...current,
			capabilities: current.capabilities.includes(capability)
				? current.capabilities.filter((entry) => entry !== capability)
				: [...current.capabilities, capability],
		}));
	};

	const selectProtocol = (protocol: ProviderProtocol) => {
		setForm((current) => (current.protocol === protocol ? current : { ...current, protocol }));
	};

	const handleFetchModels = async () => {
		const baseUrl = form.baseUrl.trim();
		if (!baseUrl || isFetchingModels) return;
		setIsFetchingModels(true);
		setError(null);
		try {
			const result = await fetchRemoteProviderModels(workspaceId, {
				baseUrl,
				protocol: form.protocol,
				apiKey: form.apiKey.trim() || undefined,
			});
			if (result.models.length === 0) {
				setError("No models found in response. Check the base URL.");
			} else {
				setForm((current) => ({
					...current,
					models: result.models,
					defaultModelId: current.defaultModelId || result.models[0] || "",
				}));
			}
		} catch (fetchError) {
			setError(`Failed to fetch models: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
		} finally {
			setIsFetchingModels(false);
		}
	};

	const handleSubmit = async () => {
		if (!canSubmit || isSaving) {
			return;
		}
		setIsSaving(true);
		setError(null);
		const normalizedHeaders = Object.fromEntries(
			form.headers.map((entry) => [entry.key.trim(), entry.value.trim()] as const).filter(([key]) => key.length > 0),
		);
		const nextTimeoutMs = form.timeoutMs.trim().length > 0 ? Number(form.timeoutMs) : undefined;
		const nextDefaultModelId = form.defaultModelId.trim() || draftModels[0] || null;
		const nextModelsSourceUrl = form.modelsSourceUrl.trim() || null;

		// A per-agent provider speaks exactly one protocol; the base URL lives on it
		// (the single source of truth). No legacy scalar baseUrl is written.
		const trimmedBaseUrl = form.baseUrl.trim();
		const protocolConfigsPayload = [
			{ protocol: form.protocol, ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}) },
		];
		const initialProtocolPayload = [
			{
				protocol: initialForm.protocol,
				...(initialForm.baseUrl.trim() ? { baseUrl: initialForm.baseUrl.trim() } : {}),
			},
		];

		const payload =
			mode === "edit"
				? ({
						providerId: normalizedProviderId,
						...(form.name.trim() !== initialForm.name.trim() ? { name: form.name.trim() } : {}),
						...(form.apiKey.trim().length > 0 ? { apiKey: form.apiKey.trim() } : {}),
						...(JSON.stringify(normalizedHeaders) !==
						JSON.stringify(
							Object.fromEntries(
								initialForm.headers
									.map((entry) => [entry.key.trim(), entry.value.trim()] as const)
									.filter(([key]) => key.length > 0),
							),
						)
							? { headers: normalizedHeaders }
							: {}),
						...(form.timeoutMs.trim() !== initialForm.timeoutMs.trim()
							? { timeoutMs: nextTimeoutMs ?? null }
							: {}),
						...(JSON.stringify(draftModels) !== JSON.stringify(initialForm.models)
							? { models: draftModels }
							: {}),
						...(nextDefaultModelId !== (initialForm.defaultModelId.trim() || initialForm.models[0] || null)
							? { defaultModelId: nextDefaultModelId }
							: {}),
						...(nextModelsSourceUrl !== (initialForm.modelsSourceUrl.trim() || null)
							? { modelsSourceUrl: nextModelsSourceUrl }
							: {}),
						...(JSON.stringify(form.capabilities) !== JSON.stringify(initialForm.capabilities)
							? { capabilities: form.capabilities.length > 0 ? form.capabilities : [] }
							: {}),
						...(JSON.stringify(protocolConfigsPayload) !== JSON.stringify(initialProtocolPayload)
							? { protocols: protocolConfigsPayload }
							: {}),
						...(JSON.stringify(anthropicPayload) !== JSON.stringify(buildAnthropicPayload(initialForm))
							? { anthropic: anthropicPayload }
							: {}),
					} satisfies UpdateKanbanProviderInput)
				: ({
						providerId: normalizedProviderId,
						name: form.name.trim(),
						apiKey: form.apiKey.trim() || null,
						headers: normalizedHeaders,
						timeoutMs: nextTimeoutMs,
						models: draftModels,
						defaultModelId: nextDefaultModelId,
						modelsSourceUrl: nextModelsSourceUrl,
						capabilities: form.capabilities.length > 0 ? form.capabilities : undefined,
						protocols: protocolConfigsPayload,
						anthropic: anthropicPayload,
					} satisfies AddKanbanProviderInput);
		const result = await onSubmit(payload);
		setIsSaving(false);
		if (!result.ok) {
			setError(result.message ?? (mode === "edit" ? "Failed to update provider." : "Failed to add provider."));
			return;
		}
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-3xl">
			<DialogHeader title={mode === "edit" ? "Edit provider" : "Add provider"} />
			<DialogBody className="space-y-4">
				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<p className="mb-2 text-[12px] text-text-secondary">Protocol</p>
					{protocolLocked ? (
						<div className="mb-3 flex items-center gap-2">
							<span
								className={cn(
									"inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
									form.protocol === "anthropic" ? "bg-orange-500/10 text-orange-500" : "bg-blue-500/10 text-blue-500",
								)}
							>
								{form.protocol}
							</span>
							<span className="text-[12px] text-text-tertiary">
								{PROTOCOL_OPTIONS.find((option) => option.value === form.protocol)?.description}
							</span>
						</div>
					) : (
						<div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Provider protocol">
							{visibleProtocolOptions.map((option) => {
								const selected = form.protocol === option.value;
								return (
									<button
										key={option.value}
										type="button"
										role="radio"
										aria-checked={selected}
										onClick={() => selectProtocol(option.value)}
										className={cn(
											"flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors",
											selected
												? "border-accent bg-accent/5 text-text-primary"
												: "border-border bg-surface-2 text-text-secondary hover:border-border-bright hover:text-text-primary",
										)}
									>
										<span className="text-[13px] font-medium">{option.label}</span>
										<span className="text-[11px] text-text-tertiary">{option.description}</span>
									</button>
								);
							})}
						</div>
					)}
					<div className="flex items-center gap-2">
						<input
							value={form.baseUrl}
							onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
							placeholder={form.protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
							className="h-8 flex-1 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={<RefreshCw size={14} />}
							disabled={!form.baseUrl.trim() || isFetchingModels}
							onClick={() => void handleFetchModels()}
						>
							{isFetchingModels ? "Fetching..." : "Fetch models"}
						</Button>
					</div>
					<p className="mt-1 text-[12px] text-text-tertiary">
						Base URL for the {form.protocol} endpoint. Click "Fetch models" to auto-populate.
					</p>
				</section>

				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<div className="grid gap-3 md:grid-cols-2">
						<div className="min-w-0">
							<p className="mb-1 text-[12px] text-text-secondary">Provider ID</p>
							<input
								value={form.providerId}
								onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value }))}
								placeholder="my-provider"
								disabled={mode === "edit"}
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
							<p className="mt-1 text-[12px] text-text-tertiary">
								{mode === "edit"
									? "Provider ID is fixed for existing providers."
									: "Used as the saved provider key."}
							</p>
							{duplicateProviderId ? (
								<p className="mt-1 text-[12px] text-status-red">This provider ID already exists.</p>
							) : null}
						</div>
						<div className="min-w-0">
							<p className="mb-1 text-[12px] text-text-secondary">Provider name</p>
							<input
								value={form.name}
								onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
								placeholder="My Provider"
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
					</div>
				</section>

				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<p className="mb-1 text-[12px] text-text-secondary">API key</p>
					<div className="relative">
						<input
							type={showApiKey ? "text" : "password"}
							value={form.apiKey}
							onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
							placeholder="Optional"
							className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 pr-9 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
							className="absolute right-1 top-1/2 -translate-y-1/2"
							aria-label={showApiKey ? "Hide API key" : "Show API key"}
							onClick={() => setShowApiKey((current) => !current)}
						/>
					</div>
				</section>

				{anthropicEnabled ? (
					<section className="rounded-lg border border-border bg-surface-1 p-3">
						<p className="mb-2 text-[12px] text-text-secondary">Anthropic settings</p>
						<div className="mb-3">
							<p className="mb-1.5 text-[11px] text-text-tertiary">API key header</p>
							<div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Anthropic API key header">
								{API_KEY_FIELD_OPTIONS.map((option) => {
									const selected = form.apiKeyField === option.value;
									return (
										<button
											key={option.value}
											type="button"
											role="radio"
											aria-checked={selected}
											onClick={() => setForm((current) => ({ ...current, apiKeyField: option.value }))}
											className={cn(
												"flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors",
												selected
													? "border-accent bg-accent/5 text-text-primary"
													: "border-border bg-surface-2 text-text-secondary hover:border-border-bright hover:text-text-primary",
											)}
										>
											<span className="text-[13px] font-medium">{option.label}</span>
											<span className="text-[11px] text-text-tertiary">{option.description}</span>
										</button>
									);
								})}
							</div>
						</div>
						<div>
							<p className="mb-1.5 text-[11px] text-text-tertiary">Default model overrides (optional)</p>
							<div className="grid gap-2 md:grid-cols-3">
								{ANTHROPIC_MODEL_TIERS.map((tier) => (
									<div key={tier} className="min-w-0">
										<label
											htmlFor={`anthropic-model-${tier}`}
											className="mb-1 block text-[11px] capitalize text-text-tertiary"
										>
											{tier}
										</label>
										<input
											id={`anthropic-model-${tier}`}
											value={form.anthropicDefaultModels[tier]}
											onChange={(event) =>
												setForm((current) => ({
													...current,
													anthropicDefaultModels: {
														...current.anthropicDefaultModels,
														[tier]: event.target.value,
													},
												}))
											}
											placeholder={`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`}
											className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
										/>
									</div>
								))}
							</div>
							<p className="mt-1 text-[12px] text-text-tertiary">
								Map Claude's haiku/sonnet/opus tiers to your provider's model IDs.
							</p>
						</div>
					</section>
				) : null}

				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<p className="mb-1 text-[12px] text-text-secondary">Model source URL</p>
					<input
						value={form.modelsSourceUrl}
						onChange={(event) => setForm((current) => ({ ...current, modelsSourceUrl: event.target.value }))}
						placeholder="https://api.example.com/v1/models"
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<p className="mt-1 text-[12px] text-text-tertiary">
						Optional. If set, the SDK can fetch models from a compatible `/models` endpoint.
					</p>
				</section>

				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<p className="mb-1 text-[12px] text-text-secondary">Models</p>
					<div className="flex min-h-10 flex-wrap gap-1 rounded-md border border-border bg-surface-2 px-2 py-1.5">
						{form.models.map((model) => (
							<span
								key={model}
								className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-1 text-[12px] text-text-primary"
							>
								<span className="font-mono">{model}</span>
								<button
									type="button"
									className="text-text-secondary hover:text-text-primary"
									onClick={() => removeModel(model)}
									aria-label={`Remove ${model}`}
								>
									<X size={12} />
								</button>
							</span>
						))}
						<input
							value={modelInput}
							onChange={(event) => setModelInput(event.target.value)}
							onKeyDown={handleModelKeyDown}
							onBlur={() => {
								if (normalizedPendingModel) {
									addModel(normalizedPendingModel);
									setModelInput("");
								}
							}}
							placeholder={form.models.length === 0 ? "Type a model ID and press Enter" : ""}
							className="min-w-40 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
						/>
					</div>
					<p className="mt-1 text-[12px] text-text-tertiary">Add at least one model or set a model source URL.</p>
				</section>

				{draftModels.length > 1 ? (
					<section className="rounded-lg border border-border bg-surface-1 p-3">
						<p className="mb-1 text-[12px] text-text-secondary">Default model</p>
						<NativeSelect
							fill
							value={form.defaultModelId}
							onChange={(event) => setForm((current) => ({ ...current, defaultModelId: event.target.value }))}
						>
							{draftModels.map((model) => (
								<option key={model} value={model}>
									{model}
								</option>
							))}
						</NativeSelect>
					</section>
				) : null}

				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<p className="mb-2 text-[12px] text-text-secondary">Capabilities</p>
					<div className="flex flex-wrap gap-2">
						{CAPABILITY_OPTIONS.map((capability) => {
							const selected = form.capabilities.includes(capability);
							return (
								<Button
									key={capability}
									variant={selected ? "primary" : "default"}
									size="sm"
									icon={selected ? <Check size={12} /> : undefined}
									aria-pressed={selected}
									className={cn("px-2.5", !selected && "text-text-secondary")}
									onClick={() => toggleCapability(capability)}
								>
									{capability}
								</Button>
							);
						})}
					</div>
				</section>

				<section className="rounded-lg border border-border bg-surface-1 p-3">
					<h3 className="mb-3 text-[12px] font-medium text-text-primary">Advanced settings</h3>
					<div className="space-y-3">
						<div className="min-w-0">
							<p className="mb-1 text-[12px] text-text-secondary">Timeout (ms)</p>
							<input
								value={form.timeoutMs}
								onChange={(event) => setForm((current) => ({ ...current, timeoutMs: event.target.value }))}
								placeholder="30000"
								inputMode="numeric"
								className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						</div>
						<div className="min-w-0">
							<div className="mb-1 flex items-center justify-between">
								<p className="text-[12px] text-text-secondary">Custom headers</p>
								<Button
									variant="ghost"
									size="sm"
									icon={<Plus size={14} />}
									onClick={() =>
										setForm((current) => ({
											...current,
											headers: [...current.headers, createHeaderEntry()],
										}))
									}
								>
									Add
								</Button>
							</div>
							<div className="space-y-2">
								{form.headers.map((entry, index) => (
									<div key={entry.id} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
										<input
											value={entry.key}
											onChange={(event) =>
												setForm((current) => ({
													...current,
													headers: current.headers.map((header, headerIndex) =>
														headerIndex === index ? { ...header, key: event.target.value } : header,
													),
												}))
											}
											placeholder="Header name"
											className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
										/>
										<input
											value={entry.value}
											onChange={(event) =>
												setForm((current) => ({
													...current,
													headers: current.headers.map((header, headerIndex) =>
														headerIndex === index ? { ...header, value: event.target.value } : header,
													),
												}))
											}
											placeholder="Header value"
											className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
										/>
										<Button
											variant="ghost"
											size="sm"
											icon={<Trash2 size={14} />}
											aria-label="Remove header"
											onClick={() =>
												setForm((current) => ({
													...current,
													headers: current.headers.filter((_, headerIndex) => headerIndex !== index),
												}))
											}
										/>
									</div>
								))}
							</div>
						</div>
					</div>
				</section>

				{error ? <p className="text-[12px] text-status-red">{error}</p> : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="md" disabled={!canSubmit || isSaving} onClick={() => void handleSubmit()}>
					{isSaving
						? mode === "edit"
							? "Updating..."
							: "Adding..."
						: mode === "edit"
							? "Update provider"
							: "Add provider"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
