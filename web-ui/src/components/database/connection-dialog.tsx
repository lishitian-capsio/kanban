import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, Database, PlugZap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import type {
	RuntimeDbConnection,
	RuntimeDbEngine,
	RuntimeDbSslConfig,
	RuntimeDbTestConnectionRequest,
	RuntimeDbUpsertConnectionRequest,
} from "@/runtime/types";
import { dbErrorMessage } from "./db-utils";

const ENGINE_LABELS: Record<RuntimeDbEngine, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	sqlite: "SQLite",
	redis: "Redis",
};

const DEFAULT_PORT: Record<RuntimeDbEngine, number | null> = {
	postgres: 5432,
	mysql: 3306,
	sqlite: null,
	redis: 6379,
};

const SSL_MODES: RuntimeDbSslConfig["mode"][] = ["disable", "require", "verify-ca", "verify-full"];

interface DraftState {
	label: string;
	engine: RuntimeDbEngine;
	host: string;
	port: string;
	database: string;
	user: string;
	password: string;
	passwordTouched: boolean;
	filePath: string;
	sslMode: RuntimeDbSslConfig["mode"];
	allowWrites: boolean;
}

function initialDraft(connection: RuntimeDbConnection | null): DraftState {
	return {
		label: connection?.label ?? "",
		engine: connection?.engine ?? "postgres",
		host: connection?.host ?? "",
		port: connection?.port != null ? String(connection.port) : "",
		database: connection?.database ?? "",
		user: connection?.user ?? "",
		password: "",
		passwordTouched: false,
		filePath: connection?.filePath ?? "",
		sslMode: connection?.ssl?.mode ?? "disable",
		allowWrites: connection?.allowWrites ?? false,
	};
}

function buildUpsertRequest(draft: DraftState, connId: string | undefined): RuntimeDbUpsertConnectionRequest {
	const isSqlite = draft.engine === "sqlite";
	const port = draft.port.trim() ? Number.parseInt(draft.port.trim(), 10) : null;
	return {
		connId,
		label: draft.label.trim(),
		engine: draft.engine,
		host: isSqlite ? null : draft.host.trim() || null,
		port: isSqlite || !Number.isFinite(port) ? null : port,
		database: isSqlite ? null : draft.database.trim() || null,
		user: isSqlite ? null : draft.user.trim() || null,
		filePath: isSqlite ? draft.filePath.trim() || null : null,
		ssl: isSqlite || draft.sslMode === "disable" ? null : { mode: draft.sslMode },
		allowWrites: draft.engine === "redis" ? false : draft.allowWrites,
		password: draft.passwordTouched ? (draft.password === "" ? null : draft.password) : undefined,
	};
}

function buildTestRequest(draft: DraftState, connId: string | undefined): RuntimeDbTestConnectionRequest {
	const upsert = buildUpsertRequest(draft, connId);
	return {
		connId,
		engine: draft.engine,
		host: upsert.host,
		port: upsert.port,
		database: upsert.database,
		user: upsert.user,
		filePath: upsert.filePath,
		ssl: upsert.ssl,
		password: upsert.password,
	};
}

const FIELD_LABEL_CLASS = "block text-[12px] font-medium text-text-secondary mb-1";
const INPUT_CLASS =
	"w-full h-8 px-2 rounded-md border border-border-bright bg-surface-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none";

export interface ConnectionDialogProps {
	open: boolean;
	/** The connection being edited, or null to create a new one. */
	connection: RuntimeDbConnection | null;
	isSaving: boolean;
	onClose: () => void;
	onSave: (request: RuntimeDbUpsertConnectionRequest) => Promise<void>;
	onTest: (request: RuntimeDbTestConnectionRequest) => Promise<{ ok: boolean; serverVersion: string | null; error: string | null }>;
}

export function ConnectionDialog({
	open,
	connection,
	isSaving,
	onClose,
	onSave,
	onTest,
}: ConnectionDialogProps): React.ReactElement {
	// Re-key the draft to the connection identity so reopening for a different row resets fields.
	const draftKey = connection?.connId ?? "__new__";
	const [draft, setDraft] = useState<DraftState>(() => initialDraft(connection));
	const [renderedKey, setRenderedKey] = useState(draftKey);
	const [isTesting, setIsTesting] = useState(false);
	if (renderedKey !== draftKey) {
		setRenderedKey(draftKey);
		setDraft(initialDraft(connection));
		setIsTesting(false);
	}

	const isSqlite = draft.engine === "sqlite";
	const isRedis = draft.engine === "redis";
	const isEdit = Boolean(connection);
	const canSubmit = useMemo(() => {
		if (!draft.label.trim()) {
			return false;
		}
		return isSqlite ? draft.filePath.trim().length > 0 : draft.host.trim().length > 0;
	}, [draft.label, draft.filePath, draft.host, isSqlite]);

	const patch = useCallback((next: Partial<DraftState>) => setDraft((prev) => ({ ...prev, ...next })), []);

	const handleEngineChange = useCallback((engine: RuntimeDbEngine) => {
		setDraft((prev) => {
			const port = prev.port.trim() === "" || Object.values(DEFAULT_PORT).map(String).includes(prev.port)
				? (DEFAULT_PORT[engine] != null ? String(DEFAULT_PORT[engine]) : "")
				: prev.port;
			return { ...prev, engine, port };
		});
	}, []);

	const handleTest = useCallback(async () => {
		setIsTesting(true);
		try {
			const result = await onTest(buildTestRequest(draft, connection?.connId));
			if (result.ok) {
				showAppToast({
					intent: "success",
					message: result.serverVersion ? `Connected · ${result.serverVersion}` : "Connection succeeded.",
				});
			} else {
				showAppToast({ intent: "danger", message: result.error ?? "Connection failed." });
			}
		} catch (error) {
			showAppToast({ intent: "danger", message: dbErrorMessage(error, "Connection test failed.") });
		} finally {
			setIsTesting(false);
		}
	}, [draft, connection, onTest]);

	const handleSave = useCallback(async () => {
		try {
			await onSave(buildUpsertRequest(draft, connection?.connId));
			showAppToast({ intent: "success", message: isEdit ? "Connection updated." : "Connection added." });
			onClose();
		} catch (error) {
			showAppToast({ intent: "danger", message: dbErrorMessage(error, "Failed to save connection.") });
		}
	}, [draft, connection, isEdit, onSave, onClose]);

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
			<DialogHeader title={isEdit ? "Edit connection" : "Add connection"} icon={<Database size={16} />} />
			<DialogBody className="space-y-3">
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-label">
						Name
					</label>
					<input
						id="db-conn-label"
						className={INPUT_CLASS}
						value={draft.label}
						onChange={(event) => patch({ label: event.target.value })}
						placeholder="My database"
					/>
				</div>
				<div>
					<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-engine">
						Engine
					</label>
					<NativeSelect
						id="db-conn-engine"
						fill
						value={draft.engine}
						onChange={(event) => handleEngineChange(event.target.value as RuntimeDbEngine)}
					>
						{(Object.keys(ENGINE_LABELS) as RuntimeDbEngine[]).map((engine) => (
							<option key={engine} value={engine}>
								{ENGINE_LABELS[engine]}
							</option>
						))}
					</NativeSelect>
				</div>

				{isSqlite ? (
					<div>
						<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-file">
							Database file path
						</label>
						<input
							id="db-conn-file"
							className={INPUT_CLASS}
							value={draft.filePath}
							onChange={(event) => patch({ filePath: event.target.value })}
							placeholder="/path/to/database.db"
						/>
					</div>
				) : (
					<>
						<div className="flex gap-2">
							<div className="flex-1">
								<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-host">
									Host
								</label>
								<input
									id="db-conn-host"
									className={INPUT_CLASS}
									value={draft.host}
									onChange={(event) => patch({ host: event.target.value })}
									placeholder="localhost"
								/>
							</div>
							<div className="w-24">
								<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-port">
									Port
								</label>
								<input
									id="db-conn-port"
									className={INPUT_CLASS}
									value={draft.port}
									onChange={(event) => patch({ port: event.target.value.replace(/[^0-9]/g, "") })}
									inputMode="numeric"
								/>
							</div>
						</div>
						<div className="flex gap-2">
							<div className="flex-1">
								<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-db">
									{isRedis ? "Database (db index)" : "Database"}
								</label>
								<input
									id="db-conn-db"
									className={INPUT_CLASS}
									value={draft.database}
									onChange={(event) => patch({ database: event.target.value })}
								/>
							</div>
							<div className="flex-1">
								<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-user">
									User
								</label>
								<input
									id="db-conn-user"
									className={INPUT_CLASS}
									value={draft.user}
									onChange={(event) => patch({ user: event.target.value })}
								/>
							</div>
						</div>
						<div>
							<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-password">
								Password
							</label>
							<input
								id="db-conn-password"
								type="password"
								className={INPUT_CLASS}
								value={draft.password}
								onChange={(event) => patch({ password: event.target.value, passwordTouched: true })}
								placeholder={isEdit && connection?.hasCredential ? "•••••• (unchanged)" : ""}
							/>
						</div>
						<div>
							<label className={FIELD_LABEL_CLASS} htmlFor="db-conn-ssl">
								SSL mode
							</label>
							<NativeSelect
								id="db-conn-ssl"
								fill
								value={draft.sslMode}
								onChange={(event) => patch({ sslMode: event.target.value as RuntimeDbSslConfig["mode"] })}
							>
								{SSL_MODES.map((mode) => (
									<option key={mode} value={mode}>
										{mode}
									</option>
								))}
							</NativeSelect>
						</div>
					</>
				)}

				{!isRedis && (
					<label htmlFor="db-conn-allow-writes" className="flex items-center gap-2 pt-1 cursor-pointer select-none">
						<Checkbox.Root
							id="db-conn-allow-writes"
							checked={draft.allowWrites}
							onCheckedChange={(checked) => patch({ allowWrites: checked === true })}
							className={cn(
								"flex h-4 w-4 items-center justify-center rounded border border-border-bright bg-surface-2",
								"data-[state=checked]:bg-accent data-[state=checked]:border-accent",
							)}
						>
							<Checkbox.Indicator>
								<Check size={12} className="text-white" />
							</Checkbox.Indicator>
						</Checkbox.Root>
						<span className="text-[13px] text-text-primary">Allow writes (inline editing)</span>
					</label>
				)}
				{!isRedis && (
					<p className="text-[11px] text-text-tertiary leading-relaxed">
						When off, this connection is read-only — browse only. The Kanban agent is always restricted to
						read-only regardless of this setting.
					</p>
				)}
				{isRedis && (
					<p className="text-[11px] text-text-tertiary leading-relaxed">
						Redis connections are always read-only (browse only). Only read commands are permitted.
					</p>
				)}
			</DialogBody>
			<DialogFooter>
				<Button
					variant="default"
					size="sm"
					icon={isTesting ? <Spinner size={14} /> : <PlugZap size={14} />}
					disabled={isTesting || !canSubmit}
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
