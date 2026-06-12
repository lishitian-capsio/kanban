// Create/edit form for a single agent config profile.
//
// `profile === null` puts the dialog in create mode (and auto-suggests a name);
// otherwise it edits that profile. Which fields render is driven by the chosen
// provider: managed-OAuth providers hide base URL / API key (their credentials
// live in the global provider settings, not the profile record), and Vertex
// exposes the GCP project/region + region fields the record carries.
import { useEffect, useMemo, useRef, useState } from "react";

import { KanbanChatModelSelector } from "@/components/detail-panels/kanban-chat-model-selector";
import { buildKanbanSelectedModelButtonText } from "@/components/detail-panels/kanban-model-picker-options";
import { useAgentProfileModelData } from "@/components/agent-profiles/use-agent-profile-model-data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import type { AgentProfileActionResult, AgentProfileCreateInput } from "@/hooks/use-agent-profiles";
import { buildNewProfileName } from "@/hooks/agent-profile-utils";
import type {
	RuntimeAgentProfile,
	RuntimeAgentProfileUpdateRequest,
	RuntimeReasoningEffort,
} from "@/runtime/types";

// Providers whose credentials are managed via OAuth in the global provider
// settings; the profile record can't carry a base URL or API key for them.
const MANAGED_OAUTH_PROVIDER_IDS = new Set(["cline", "oca", "openai-codex"]);

function isManagedOauthProvider(providerId: string): boolean {
	return MANAGED_OAUTH_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

function isVertexProvider(providerId: string): boolean {
	return providerId.trim().toLowerCase() === "vertex";
}

interface FieldLabelProps {
	label: string;
	children: React.ReactNode;
	hint?: string;
}

function Field({ label, children, hint }: FieldLabelProps): React.ReactElement {
	// A plain wrapper rather than <label> — some fields hold a button-based
	// control (the model picker), so implicit label association doesn't apply.
	return (
		<div className="flex flex-col gap-1 text-[13px] text-text-secondary">
			<span>{label}</span>
			{children}
			{hint ? <span className="text-[11px] text-text-tertiary">{hint}</span> : null}
		</div>
	);
}

const TEXT_INPUT_CLASS =
	"h-8 rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none";

export interface AgentProfileEditDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string | null;
	/** null => create mode; a profile => edit mode. */
	profile: RuntimeAgentProfile | null;
	existingNames: readonly string[];
	onCreate: (input: AgentProfileCreateInput) => Promise<AgentProfileActionResult>;
	onUpdate: (input: RuntimeAgentProfileUpdateRequest) => Promise<AgentProfileActionResult>;
}

interface DraftState {
	name: string;
	providerId: string;
	modelId: string;
	reasoningEffort: RuntimeReasoningEffort | "";
	baseUrl: string;
	apiKey: string;
	region: string;
	gcpProjectId: string;
	gcpRegion: string;
}

function profileToDraft(profile: RuntimeAgentProfile | null, fallbackName: string): DraftState {
	return {
		name: profile?.name ?? fallbackName,
		providerId: profile?.providerId ?? "",
		modelId: profile?.modelId ?? "",
		reasoningEffort: profile?.reasoningEffort ?? "",
		baseUrl: profile?.baseUrl ?? "",
		apiKey: "",
		region: profile?.region ?? "",
		gcpProjectId: profile?.gcpProjectId ?? "",
		gcpRegion: profile?.gcpRegion ?? "",
	};
}

export function AgentProfileEditDialog({
	open,
	onOpenChange,
	workspaceId,
	profile,
	existingNames,
	onCreate,
	onUpdate,
}: AgentProfileEditDialogProps): React.ReactElement {
	const isEditMode = profile !== null;
	const [draft, setDraft] = useState<DraftState>(() => profileToDraft(profile, ""));
	const [isSubmitting, setIsSubmitting] = useState(false);
	// Read at open time only (to seed a create-mode name), so re-renders that
	// produce a fresh existingNames array don't reset the form mid-edit.
	const existingNamesRef = useRef(existingNames);
	existingNamesRef.current = existingNames;

	// Seed the form whenever the dialog opens (or its target profile changes).
	useEffect(() => {
		if (!open) {
			return;
		}
		const fallbackName = profile ? profile.name : buildNewProfileName(existingNamesRef.current);
		setDraft(profileToDraft(profile, fallbackName));
		setIsSubmitting(false);
	}, [open, profile]);

	const modelData = useAgentProfileModelData({
		workspaceId,
		providerId: draft.providerId,
		enabled: open,
	});

	const providerOptions = useMemo(() => {
		const options = modelData.providerCatalog.map((item) => ({ id: item.id, name: item.name }));
		const hasCurrent = options.some((item) => item.id.trim().toLowerCase() === draft.providerId.trim().toLowerCase());
		if (!hasCurrent && draft.providerId.trim().length > 0) {
			options.unshift({ id: draft.providerId, name: draft.providerId });
		}
		return options;
	}, [draft.providerId, modelData.providerCatalog]);

	const managedOauth = isManagedOauthProvider(draft.providerId);
	const vertex = isVertexProvider(draft.providerId);
	const selectedModelSupportsReasoningEffort = modelData.reasoningEnabledModelIds.includes(draft.modelId);

	const selectedModelButtonText = buildKanbanSelectedModelButtonText({
		modelOptions: modelData.modelOptions,
		selectedModelId: draft.modelId,
		reasoningEffort: draft.reasoningEffort,
		showReasoningEffort: selectedModelSupportsReasoningEffort,
		isModelLoading: modelData.isLoadingModels,
		emptyLabel: "Select model",
	});

	const update = <Key extends keyof DraftState>(key: Key, value: DraftState[Key]): void => {
		setDraft((current) => ({ ...current, [key]: value }));
	};

	const handleProviderChange = (nextProviderId: string): void => {
		const catalogDefault =
			modelData.providerCatalog.find((item) => item.id === nextProviderId)?.defaultModelId?.trim() ?? "";
		setDraft((current) => ({
			...current,
			providerId: nextProviderId,
			modelId: catalogDefault,
			reasoningEffort: "",
			baseUrl: "",
		}));
	};

	const trimmedName = draft.name.trim();
	const canSubmit = trimmedName.length > 0 && !isSubmitting;

	const handleSubmit = async (): Promise<void> => {
		if (!canSubmit) {
			return;
		}
		setIsSubmitting(true);
		try {
			const providerId = draft.providerId.trim() || null;
			const modelId = draft.modelId.trim() || null;
			const reasoningEffort = draft.reasoningEffort || null;
			const baseUrl = managedOauth ? null : draft.baseUrl.trim() || null;
			const region = vertex ? draft.region.trim() || null : null;
			const gcpProjectId = vertex ? draft.gcpProjectId.trim() || null : null;
			const gcpRegion = vertex ? draft.gcpRegion.trim() || null : null;
			const enteredApiKey = managedOauth ? "" : draft.apiKey.trim();

			const result = isEditMode
				? await onUpdate({
						id: profile.id,
						name: trimmedName,
						providerId,
						modelId,
						reasoningEffort,
						baseUrl,
						region,
						gcpProjectId,
						gcpRegion,
						...(enteredApiKey.length > 0 ? { apiKey: enteredApiKey } : {}),
					})
				: await onCreate({
						name: trimmedName,
						providerId,
						modelId,
						reasoningEffort,
						baseUrl,
						region,
						gcpProjectId,
						gcpRegion,
						...(enteredApiKey.length > 0 ? { apiKey: enteredApiKey } : {}),
						select: true,
					});
			if (result.ok) {
				onOpenChange(false);
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title={isEditMode ? "Edit profile" : "New profile"} />
			<DialogBody className="flex flex-col gap-3">
				<Field label="Name">
					<input
						type="text"
						value={draft.name}
						autoFocus
						placeholder="e.g. Fast, Reasoning, Local"
						onChange={(event) => update("name", event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void handleSubmit();
							}
						}}
						className={TEXT_INPUT_CLASS}
					/>
				</Field>

				<Field label="Provider">
					<NativeSelect
						fill
						value={draft.providerId}
						onChange={(event) => handleProviderChange(event.target.value)}
					>
						<option value="">Select provider…</option>
						{providerOptions.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</NativeSelect>
				</Field>

				<Field label="Model">
					<KanbanChatModelSelector
						modelOptions={modelData.modelOptions}
						recommendedModelIds={modelData.recommendedModelIds}
						pinSelectedModelToTop={modelData.shouldPinSelectedModelToTop}
						selectedModelId={draft.modelId}
						selectedModelButtonText={selectedModelButtonText}
						onSelectModel={(value) => update("modelId", value)}
						reasoningEnabledModelIds={modelData.reasoningEnabledModelIds}
						selectedReasoningEffort={draft.reasoningEffort}
						onSelectReasoningEffort={(value) => update("reasoningEffort", value)}
						disabled={draft.providerId.trim().length === 0}
						isModelLoading={modelData.isLoadingModels}
						fill
						triggerVariant="default"
					/>
				</Field>

				{managedOauth ? (
					<p className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[11px] text-text-tertiary">
						This provider signs in with OAuth. Manage its account in Settings; the profile only pins the model
						and reasoning effort.
					</p>
				) : (
					<>
						<Field label="Base URL" hint="Leave blank to use the provider default.">
							<input
								type="text"
								value={draft.baseUrl}
								placeholder="https://api.example.com/v1"
								onChange={(event) => update("baseUrl", event.target.value)}
								className={TEXT_INPUT_CLASS}
							/>
						</Field>
						<Field
							label="API key"
							hint={
								profile?.apiKeyConfigured
									? "A key is configured. Enter a new one to replace it."
									: "Stored securely on this machine, never committed."
							}
						>
							<input
								type="password"
								value={draft.apiKey}
								autoComplete="off"
								placeholder={profile?.apiKeyConfigured ? "••••••••" : "sk-…"}
								onChange={(event) => update("apiKey", event.target.value)}
								className={TEXT_INPUT_CLASS}
							/>
						</Field>
					</>
				)}

				{vertex ? (
					<>
						<Field label="GCP project ID">
							<input
								type="text"
								value={draft.gcpProjectId}
								onChange={(event) => update("gcpProjectId", event.target.value)}
								className={TEXT_INPUT_CLASS}
							/>
						</Field>
						<Field label="GCP region">
							<input
								type="text"
								value={draft.gcpRegion}
								placeholder="us-east5"
								onChange={(event) => update("gcpRegion", event.target.value)}
								className={TEXT_INPUT_CLASS}
							/>
						</Field>
						<Field label="Region">
							<input
								type="text"
								value={draft.region}
								onChange={(event) => update("region", event.target.value)}
								className={TEXT_INPUT_CLASS}
							/>
						</Field>
					</>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
					{isEditMode ? "Save" : "Create"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
