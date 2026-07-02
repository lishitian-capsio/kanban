import * as Switch from "@radix-ui/react-switch";
import { HardDrive, PlugZap } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeStorageConnection, RuntimeStorageUpsertConnectionRequest } from "@/runtime/types";
import type { UseStorageConnectionsResult } from "./use-storage-connections";

interface DraftState {
	label: string;
	endpoint: string;
	region: string;
	bucket: string;
	virtualHostedStyle: boolean;
	accessKeyId: string;
	accessKeyIdTouched: boolean;
	secretAccessKey: string;
	secretTouched: boolean;
	sessionToken: string;
	sessionTokenTouched: boolean;
}

function initialDraft(connection: RuntimeStorageConnection | null): DraftState {
	return {
		label: connection?.label ?? "",
		endpoint: connection?.endpoint ?? "",
		region: connection?.region ?? "",
		bucket: connection?.bucket ?? "",
		virtualHostedStyle: connection?.virtualHostedStyle ?? false,
		accessKeyId: "",
		accessKeyIdTouched: false,
		secretAccessKey: "",
		secretTouched: false,
		sessionToken: "",
		sessionTokenTouched: false,
	};
}

function buildUpsertRequest(draft: DraftState, connId: string | undefined): RuntimeStorageUpsertConnectionRequest {
	return {
		connId,
		label: draft.label.trim(),
		endpoint: draft.endpoint.trim() || null,
		region: draft.region.trim() || null,
		bucket: draft.bucket.trim(),
		virtualHostedStyle: draft.virtualHostedStyle,
		accessKeyId: draft.accessKeyIdTouched ? draft.accessKeyId.trim() || null : undefined,
		secretAccessKey: draft.secretTouched ? (draft.secretAccessKey || null) : undefined,
		sessionToken: draft.sessionTokenTouched ? draft.sessionToken.trim() || null : undefined,
	};
}

const FIELD_LABEL_CLASS = "block text-[12px] font-medium text-text-secondary mb-1";
const INPUT_CLASS =
	"w-full h-8 px-2 rounded-md border border-border-bright bg-surface-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none";

export interface StorageConnectionDialogProps {
	open: boolean;
	connection: RuntimeStorageConnection | null;
	isSaving: boolean;
	onClose: () => void;
	onSave: UseStorageConnectionsResult["upsertConnection"];
	onTest: UseStorageConnectionsResult["testConnection"];
}

export function StorageConnectionDialog({
	open,
	connection,
	isSaving,
	onClose,
	onSave,
	onTest,
}: StorageConnectionDialogProps): React.ReactElement {
	const draftKey = connection?.connId ?? "__new__";
	const [draft, setDraft] = useState<DraftState>(() => initialDraft(connection));
	const [renderedKey, setRenderedKey] = useState(draftKey);
	const [isTesting, setIsTesting] = useState(false);

	if (renderedKey !== draftKey) {
		setRenderedKey(draftKey);
		setDraft(initialDraft(connection));
		setIsTesting(false);
	}

	const isEdit = Boolean(connection);
	const canSubmit = useMemo(
		() => draft.label.trim().length > 0 && draft.bucket.trim().length > 0,
		[draft.label, draft.bucket],
	);

	const patch = useCallback((next: Partial<DraftState>) => setDraft((prev) => ({ ...prev, ...next })), []);

	const handleTest = useCallback(async () => {
		if (!connection) {
			showAppToast({ intent: "warning", message: "Save the connection first, then test." });
			return;
		}
		setIsTesting(true);
		try {
			const result = await onTest(connection.connId);
			if (result.ok) {
				showAppToast({
					intent: "success",
					message: `Connection OK · ${result.latencyMs}ms`,
				});
			} else {
				showAppToast({ intent: "danger", message: result.error ?? "Connection failed." });
			}
		} catch (error) {
			showAppToast({ intent: "danger", message: error instanceof Error ? error.message : "Connection test failed." });
		} finally {
			setIsTesting(false);
		}
	}, [connection, onTest]);

	const handleSave = useCallback(async () => {
		try {
			await onSave(buildUpsertRequest(draft, connection?.connId));
			showAppToast({ intent: "success", message: isEdit ? "Connection updated." : "Connection added." });
			onClose();
		} catch (error) {
			showAppToast({ intent: "danger", message: error instanceof Error ? error.message : "Failed to save connection." });
		}
	}, [draft, connection, isEdit, onSave, onClose]);

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
			<DialogHeader title={isEdit ? "Edit storage connection" : "Add storage connection"} icon={<HardDrive size={16} />} />
			<DialogBody className="space-y-3">
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-label">Name</label>
					<input
						id="st-conn-label"
						className={INPUT_CLASS}
						value={draft.label}
						onChange={(e) => patch({ label: e.target.value })}
						placeholder="My S3 bucket"
					/>
				</div>
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-endpoint">Endpoint (optional)</label>
					<input
						id="st-conn-endpoint"
						className={INPUT_CLASS}
						value={draft.endpoint}
						onChange={(e) => patch({ endpoint: e.target.value })}
						placeholder="https://<acct>.r2.cloudflarestorage.com / http://localhost:9000"
					/>
				</div>
				<div className="flex gap-2">
					<div className="flex-1">
						<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-bucket">Bucket</label>
						<input
							id="st-conn-bucket"
							className={INPUT_CLASS}
							value={draft.bucket}
							onChange={(e) => patch({ bucket: e.target.value })}
							placeholder="my-bucket"
						/>
					</div>
					<div className="flex-1">
						<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-region">Region (optional)</label>
						<input
							id="st-conn-region"
							className={INPUT_CLASS}
							value={draft.region}
							onChange={(e) => patch({ region: e.target.value })}
							placeholder="us-east-1"
						/>
					</div>
				</div>
				<label htmlFor="st-conn-vhs" className="flex items-center gap-3 cursor-pointer select-none">
					<Switch.Root
						id="st-conn-vhs"
						checked={draft.virtualHostedStyle}
						onCheckedChange={(checked) => patch({ virtualHostedStyle: checked })}
						className="relative h-4 w-7 cursor-pointer rounded-full bg-surface-4 outline-none data-[state=checked]:bg-accent"
					>
						<Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-3.5" />
					</Switch.Root>
					<span className="text-[13px] text-text-primary">Virtual-hosted-style</span>
					<span className="text-[11px] text-text-tertiary">off = path-style, needed for MinIO</span>
				</label>
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-akid">Access Key ID</label>
					<input
						id="st-conn-akid"
						className={INPUT_CLASS}
						value={draft.accessKeyId}
						onChange={(e) => patch({ accessKeyId: e.target.value, accessKeyIdTouched: true })}
						placeholder={isEdit && connection?.hasCredential ? "(unchanged)" : "AKIAIOSFODNN7EXAMPLE"}
					/>
				</div>
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-secret">Secret Access Key</label>
					<input
						id="st-conn-secret"
						type="password"
						className={INPUT_CLASS}
						value={draft.secretAccessKey}
						onChange={(e) => patch({ secretAccessKey: e.target.value, secretTouched: true })}
						placeholder={isEdit && connection?.hasCredential ? "leave blank to keep" : "wJalrXUtnFEMI/K7MDENG"}
					/>
				</div>
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="st-conn-token">Session Token (optional)</label>
					<input
						id="st-conn-token"
						type="password"
						className={INPUT_CLASS}
						value={draft.sessionToken}
						onChange={(e) => patch({ sessionToken: e.target.value, sessionTokenTouched: true })}
						placeholder={isEdit && connection?.hasCredential ? "(unchanged)" : "For temporary credentials only"}
					/>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button
					variant="default"
					size="sm"
					icon={isTesting ? <Spinner size={14} /> : <PlugZap size={14} />}
					disabled={isTesting || !isEdit}
					onClick={() => void handleTest()}
				>
					Test
				</Button>
				<Button variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="sm"
					disabled={!canSubmit || isSaving}
					icon={isSaving ? <Spinner size={14} /> : undefined}
					onClick={() => void handleSave()}
				>
					{isEdit ? "Save" : "Add"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}

