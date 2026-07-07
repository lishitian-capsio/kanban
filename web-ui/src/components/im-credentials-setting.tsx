import { AlertTriangle, MessageSquare, RefreshCw, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useImCredentials } from "@/hooks/use-im-credentials";
import type { RuntimeImCredentialPlatformStatus, RuntimeImSetCredentialsRequest } from "@/runtime/types";

/**
 * Settings → Project "IM 渠道凭证" control. Manages the machine-local IM **outbound** credentials
 * (bot tokens / webhook URLs) used to push task notifications to a bound IM channel. Reads/drives
 * the machine-global `im` tRPC router via {@link useImCredentials}: shows which platforms are
 * configured, accepts a pasted token/webhook per platform, and removes a platform's credential.
 * The secret values are never exposed back; only the secret-free status crosses the wire
 * (requirement ac99c, 阶段2). Mirrors the pasted-credential shape of {@link GiteeAuthSetting}.
 */
type ImPlatform = RuntimeImSetCredentialsRequest["platform"];

interface PlatformFieldSpec {
	key: "botToken" | "webhookUrl" | "webhookSecret";
	label: string;
	placeholder: string;
	/** A required field must be non-empty to save (the credential needs a token or a webhook). */
	required: boolean;
	secret: boolean;
}

interface PlatformSpec {
	platform: ImPlatform;
	label: string;
	hint: string;
	fields: PlatformFieldSpec[];
}

const PLATFORM_SPECS: PlatformSpec[] = [
	{
		platform: "lark",
		label: "飞书 (Lark)",
		hint: "机器人凭证 app_id:app_secret，用于通过飞书应用发送消息。",
		fields: [
			{
				key: "botToken",
				label: "Bot token",
				placeholder: "app_id:app_secret",
				required: true,
				secret: true,
			},
		],
	},
	{
		platform: "dingtalk",
		label: "钉钉 (DingTalk)",
		hint: "自定义机器人 Webhook 地址（可选加签密钥），用于推送消息到群。",
		fields: [
			{
				key: "webhookUrl",
				label: "Webhook URL",
				placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…",
				required: true,
				secret: false,
			},
			{
				key: "webhookSecret",
				label: "Webhook secret（可选，加签）",
				placeholder: "SEC…",
				required: false,
				secret: true,
			},
		],
	},
];

const inputClass =
	"h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60";

export function ImCredentialsSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const {
		status,
		statusLoading,
		statusError,
		pendingPlatform,
		statusFor,
		saveCredentials,
		clearCredentials,
		refreshStatus,
	} = useImCredentials(workspaceId);

	const firstLoad = statusLoading && status === null;
	const unreachable = statusError !== null && status === null;

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<MessageSquare size={13} />
				IM 渠道凭证
			</h6>

			{firstLoad ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : unreachable ? (
				<UnreachableState onRetry={() => void refreshStatus()} loading={statusLoading} />
			) : (
				<>
					<div className="flex flex-col gap-3">
						{PLATFORM_SPECS.map((spec) => (
							<PlatformCredentialCard
								key={spec.platform}
								spec={spec}
								status={statusFor(spec.platform)}
								degraded={statusError !== null}
								pending={pendingPlatform === spec.platform}
								onSave={saveCredentials}
								onClear={clearCredentials}
							/>
						))}
					</div>
					<p className="text-text-secondary text-[12px] mt-3 mb-0">
						凭证仅保存在本机（<span className="font-mono">~/.kanban/settings/im-credentials.json</span>
						，0600），从不提交到 Git、从不回显。
					</p>
				</>
			)}
		</div>
	);
}

interface PlatformCredentialCardProps {
	spec: PlatformSpec;
	status: RuntimeImCredentialPlatformStatus | null;
	degraded: boolean;
	pending: boolean;
	onSave: (input: RuntimeImSetCredentialsRequest) => Promise<boolean>;
	onClear: (platform: ImPlatform) => Promise<void>;
}

function PlatformCredentialCard({
	spec,
	status,
	degraded,
	pending,
	onSave,
	onClear,
}: PlatformCredentialCardProps): React.ReactElement {
	const [values, setValues] = useState<Record<string, string>>({});
	const configured = status?.configured ?? false;

	const requiredField = spec.fields.find((field) => field.required);
	const requiredFilled = requiredField ? (values[requiredField.key]?.trim() ?? "") !== "" : true;

	const handleSave = async () => {
		const credential: RuntimeImSetCredentialsRequest["credential"] = {};
		for (const field of spec.fields) {
			const value = values[field.key]?.trim();
			if (value) {
				credential[field.key] = value;
			}
		}
		const ok = await onSave({ platform: spec.platform, credential });
		if (ok) {
			setValues({});
		}
	};

	return (
		<div className="rounded-md border border-border-bright bg-surface-1 p-3">
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 min-w-0">
					<span className="truncate text-[13px] font-medium text-text-primary">{spec.label}</span>
					{configured ? (
						<span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-green/10 text-status-green">
							已配置
						</span>
					) : (
						<span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-surface-3 text-text-tertiary">
							未配置
						</span>
					)}
				</div>
				{configured ? (
					<Button
						variant="ghost"
						size="sm"
						icon={pending ? <Spinner size={12} /> : <Trash2 size={13} />}
						onClick={() => void onClear(spec.platform)}
						disabled={pending}
					>
						移除
					</Button>
				) : null}
			</div>

			{spec.fields.map((field) => (
				<div key={field.key} className="mb-2 last:mb-0">
					<label
						htmlFor={`im-${spec.platform}-${field.key}`}
						className="block text-[12px] text-text-secondary mb-1"
					>
						{configured && field.required ? `${field.label}（替换）` : field.label}
					</label>
					<input
						id={`im-${spec.platform}-${field.key}`}
						type={field.secret ? "password" : "text"}
						value={values[field.key] ?? ""}
						onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
						placeholder={field.placeholder}
						spellCheck={false}
						autoComplete="off"
						disabled={pending}
						className={inputClass}
					/>
				</div>
			))}

			<div className="mt-2 flex items-center justify-between gap-2">
				<span className="text-text-tertiary text-[11px]">{spec.hint}</span>
				<Button
					variant="primary"
					size="sm"
					icon={pending ? <Spinner size={12} /> : <Save size={14} />}
					onClick={() => void handleSave()}
					disabled={pending || !requiredFilled}
				>
					{pending ? "保存中…" : configured ? "更新" : "保存"}
				</Button>
			</div>

			{degraded && configured ? (
				<p className="text-status-orange text-[11px] mt-2 mb-0">状态刷新失败——显示上次已知结果。</p>
			) : null}
		</div>
	);
}

function UnreachableState({ onRetry, loading }: { onRetry: () => void; loading: boolean }): React.ReactElement {
	return (
		<div className="flex items-start gap-2 rounded-md border border-status-orange/30 bg-status-orange/5 p-2.5">
			<AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-orange" />
			<div className="min-w-0 flex-1">
				<p className="text-text-primary text-[13px] m-0">无法连接到 IM 凭证服务。</p>
				<p className="text-text-secondary text-[12px] mt-0.5 mb-0">运行时可能已离线或正在重启。</p>
				<Button
					variant="ghost"
					size="sm"
					className="mt-1.5"
					icon={loading ? <Spinner size={12} /> : <RefreshCw size={13} />}
					onClick={onRetry}
					disabled={loading}
				>
					重试
				</Button>
			</div>
		</div>
	);
}
