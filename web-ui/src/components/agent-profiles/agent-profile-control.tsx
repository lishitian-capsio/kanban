// The composer's inline "config profile" entry point, scoped to one agent.
//
// It binds the agent's profile library (useAgentProfiles) to a compact switcher
// plus a quick model/reasoning picker, and owns the create/edit/rename/delete
// dialogs. Switching a profile or saving an edit goes straight through the 6c49b
// tRPC layer, which bumps the session context version — so the next message in
// the thread already runs with the new config; no Settings trip, no restart.
import { useMemo, useState } from "react";

import { AgentProfileEditDialog } from "@/components/agent-profiles/agent-profile-edit-dialog";
import { AgentProfileRenameDialog } from "@/components/agent-profiles/agent-profile-rename-dialog";
import { AgentProfileSelector } from "@/components/agent-profiles/agent-profile-selector";
import { useAgentProfileModelData } from "@/components/agent-profiles/use-agent-profile-model-data";
import { KanbanChatModelSelector } from "@/components/detail-panels/kanban-chat-model-selector";
import { buildKanbanSelectedModelButtonText } from "@/components/detail-panels/kanban-model-picker-options";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { useAgentProfiles } from "@/hooks/use-agent-profiles";
import type { RuntimeAgentId, RuntimeAgentProfile, RuntimeReasoningEffort } from "@/runtime/types";

export interface AgentProfileControlProps {
	workspaceId: string | null;
	agentId: RuntimeAgentId | null;
	disabled?: boolean;
}

export function AgentProfileControl({
	workspaceId,
	agentId,
	disabled = false,
}: AgentProfileControlProps): React.ReactElement | null {
	const profiles = useAgentProfiles({ workspaceId, agentId, enabled: agentId !== null });
	const [editOpen, setEditOpen] = useState(false);
	// null while editOpen === true => create mode.
	const [editTarget, setEditTarget] = useState<RuntimeAgentProfile | null>(null);
	const [renameTarget, setRenameTarget] = useState<RuntimeAgentProfile | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<RuntimeAgentProfile | null>(null);
	const [isSavingModel, setIsSavingModel] = useState(false);

	const selectedProfile = profiles.selectedProfile;
	const selectedProviderId = selectedProfile?.providerId ?? "";

	// Model data for the *selected* profile, powering the inline quick switch.
	const modelData = useAgentProfileModelData({
		workspaceId,
		providerId: selectedProviderId,
		enabled: selectedProviderId.trim().length > 0,
	});

	const selectedModelId = selectedProfile?.modelId ?? "";
	const selectedReasoningEffort: RuntimeReasoningEffort | "" = selectedProfile?.reasoningEffort ?? "";
	const selectedModelSupportsReasoningEffort = modelData.reasoningEnabledModelIds.includes(selectedModelId);

	const selectedModelButtonText = useMemo(
		() =>
			buildKanbanSelectedModelButtonText({
				modelOptions: modelData.modelOptions,
				selectedModelId,
				reasoningEffort: selectedReasoningEffort,
				showReasoningEffort: selectedModelSupportsReasoningEffort,
				isModelLoading: modelData.isLoadingModels,
				isModelSaving: isSavingModel,
				emptyLabel: "Select model",
			}),
		[
			isSavingModel,
			modelData.isLoadingModels,
			modelData.modelOptions,
			selectedModelId,
			selectedModelSupportsReasoningEffort,
			selectedReasoningEffort,
		],
	);

	if (agentId === null) {
		return null;
	}

	const existingNames = profiles.profiles.map((profile) => profile.name);

	const persistSelectedProfileField = async (
		patch: { modelId?: string; reasoningEffort?: RuntimeReasoningEffort | "" },
	): Promise<void> => {
		if (!selectedProfile) {
			return;
		}
		setIsSavingModel(true);
		try {
			await profiles.updateProfile({
				id: selectedProfile.id,
				...(patch.modelId !== undefined ? { modelId: patch.modelId.trim() || null } : {}),
				...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort || null } : {}),
			});
		} finally {
			setIsSavingModel(false);
		}
	};

	const handleOpenNew = (): void => {
		setEditTarget(null);
		setEditOpen(true);
	};
	const handleOpenEdit = (profile: RuntimeAgentProfile): void => {
		setEditTarget(profile);
		setEditOpen(true);
	};

	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<AgentProfileSelector
				profiles={profiles.profiles}
				selectedProfileId={profiles.selectedProfileId}
				isLoading={profiles.isLoading}
				disabled={disabled}
				onSelect={(profileId) => void profiles.selectProfile(profileId)}
				onNew={handleOpenNew}
				onEdit={handleOpenEdit}
				onRename={setRenameTarget}
				onDuplicate={(profile) => void profiles.duplicateProfile(profile.id)}
				onDelete={setDeleteTarget}
			/>

			{selectedProfile && selectedProviderId.trim().length > 0 ? (
				<div className="min-w-0 shrink overflow-hidden">
					<KanbanChatModelSelector
						modelOptions={modelData.modelOptions}
						recommendedModelIds={modelData.recommendedModelIds}
						pinSelectedModelToTop={modelData.shouldPinSelectedModelToTop}
						selectedModelId={selectedModelId}
						selectedModelButtonText={selectedModelButtonText}
						onSelectModel={(value) => {
							if (value.trim() === selectedModelId.trim()) {
								return;
							}
							void persistSelectedProfileField({ modelId: value });
						}}
						reasoningEnabledModelIds={modelData.reasoningEnabledModelIds}
						selectedReasoningEffort={selectedReasoningEffort}
						onSelectReasoningEffort={(value) => {
							if (value === selectedReasoningEffort) {
								return;
							}
							void persistSelectedProfileField({ reasoningEffort: value });
						}}
						disabled={disabled || isSavingModel}
						isModelLoading={modelData.isLoadingModels}
						isModelSaving={isSavingModel}
					/>
				</div>
			) : null}

			<AgentProfileEditDialog
				open={editOpen}
				onOpenChange={setEditOpen}
				workspaceId={workspaceId}
				profile={editTarget}
				existingNames={existingNames}
				onCreate={profiles.createProfile}
				onUpdate={profiles.updateProfile}
			/>
			<AgentProfileRenameDialog
				profile={renameTarget}
				onOpenChange={(open) => {
					if (!open) {
						setRenameTarget(null);
					}
				}}
				onRename={(id, name) => profiles.updateProfile({ id, name })}
			/>
			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDeleteTarget(null);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete profile</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						Delete the profile “{deleteTarget?.name}”? This can’t be undone. The agent falls back to its saved
						provider settings if this profile was selected.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<button
							type="button"
							className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
						>
							Cancel
						</button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<button
							type="button"
							className="cursor-pointer rounded-md bg-status-red px-3 py-1.5 text-[13px] font-medium text-white hover:bg-status-red/90"
							onClick={() => {
								const target = deleteTarget;
								setDeleteTarget(null);
								if (target) {
									void profiles.deleteProfile(target.id);
								}
							}}
						>
							Delete
						</button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
