// Settings dialog composition for Kanban.
// Generic app settings live here, while Kanban-specific provider state and
// side effects should stay in use-runtime-settings-kanban-controller.ts.
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixSelect from "@radix-ui/react-select";
import * as RadixSwitch from "@radix-ui/react-switch";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import {
	Bell,
	Check,
	ChevronDown,
	CircleUser,
	ExternalLink,
	FolderOpen,
	GitCommit,
	Globe,
	Key,
	Palette,
	Pencil,
	Plus,
	Settings,
	SlidersHorizontal,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountOrganizationSection } from "@/components/shared/account-organization-section";
import { AgentProviderSelector } from "@/components/shared/agent-provider-selector";
import {
	KanbanAddProviderDialog,
	type KanbanProviderDialogInitialValues,
} from "@/components/shared/kanban-add-provider-dialog";
import { KanbanOauthSignInPanel } from "@/components/shared/kanban-oauth-signin-panel";
import {
	getRuntimeShortcutIconComponent,
	getRuntimeShortcutPickerOption,
	RUNTIME_SHORTCUT_ICON_OPTIONS,
	type RuntimeShortcutIconOption,
	type RuntimeShortcutPickerIconId,
} from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { TASK_GIT_BASE_REF_PROMPT_VARIABLE, type TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useRuntimeSettingsKanbanController } from "@/hooks/use-runtime-settings-kanban-controller";
import { previewThemeId, readStoredThemeId, saveThemeId, THEME_GROUPS, THEMES, type ThemeId } from "@/hooks/use-theme";
import { useLayoutCustomizations } from "@/resize/layout-customizations";
import { fetchKanbanProviderCatalog, openFileOnHost } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeKanbanProviderCatalogItem, RuntimeProjectShortcut } from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import {
	type BrowserNotificationPermission,
	getBrowserNotificationPermission,
	requestBrowserNotificationPermission,
} from "@/utils/notification-permission";
import { formatPathForDisplay } from "@/utils/path-display";
import { useUnmount, useWindowEvent } from "@/utils/react-use";

interface RuntimeSettingsAgentRowModel {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	command: string;
	installed: boolean | null;
}

function quoteCommandPartForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function buildDisplayedAgentCommand(agentId: RuntimeAgentId, binary: string, autonomousModeEnabled: boolean): string {
	if (agentId === "pi") {
		return "";
	}
	const args = autonomousModeEnabled ? (getRuntimeAgentCatalogEntry(agentId)?.autonomousArgs ?? []) : [];
	return [binary, ...args.map(quoteCommandPartForDisplay)].join(" ");
}

function normalizeTemplateForComparison(value: string): string {
	return value.replaceAll("\r\n", "\n").trim();
}

const GIT_PROMPT_VARIANT_OPTIONS: Array<{ value: TaskGitAction; label: string }> = [
	{ value: "commit", label: "Commit" },
	{ value: "pr", label: "Make PR" },
];

export type RuntimeSettingsSection = "shortcuts";

const SETTINGS_AGENT_ORDER: readonly RuntimeAgentId[] = ["pi", "claude", "codex", "droid", "kiro"];

type SettingsNavId = "general" | "account" | "providers" | "proxy" | "git-prompts" | "notifications" | "appearance" | "project";

const SETTINGS_NAV_ITEMS: ReadonlyArray<{
	id: SettingsNavId;
	label: string;
	icon: React.ReactNode;
	accountOnly?: boolean;
}> = [
	{ id: "general", label: "General", icon: <SlidersHorizontal size={16} /> },
	{ id: "account", label: "Account", icon: <CircleUser size={16} />, accountOnly: true },
	{ id: "providers", label: "Providers", icon: <Key size={16} /> },
	{ id: "proxy", label: "Network Proxy", icon: <Globe size={16} /> },
	{ id: "git-prompts", label: "Git Prompts", icon: <GitCommit size={16} /> },
	{ id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
	{ id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
	{ id: "project", label: "Project", icon: <FolderOpen size={16} /> },
];

function getShortcutIconOption(icon: string | undefined): RuntimeShortcutIconOption {
	return getRuntimeShortcutPickerOption(icon);
}

function ShortcutIconComponent({ icon, size = 14 }: { icon: string | undefined; size?: number }): React.ReactElement {
	const Component = getRuntimeShortcutIconComponent(icon);
	return <Component size={size} />;
}

function formatNotificationPermissionStatus(permission: BrowserNotificationPermission): string {
	if (permission === "default") {
		return "not requested yet";
	}
	return permission;
}

function getNextShortcutLabel(shortcuts: RuntimeProjectShortcut[], baseLabel: string): string {
	const normalizedTakenLabels = new Set(
		shortcuts.map((shortcut) => shortcut.label.trim().toLowerCase()).filter((label) => label.length > 0),
	);
	const normalizedBaseLabel = baseLabel.trim().toLowerCase();
	if (!normalizedTakenLabels.has(normalizedBaseLabel)) {
		return baseLabel;
	}

	let suffix = 2;
	while (normalizedTakenLabels.has(`${normalizedBaseLabel} ${suffix}`)) {
		suffix += 1;
	}
	return `${baseLabel} ${suffix}`;
}

function AgentRow({
	agent,
	disabled,
	workspaceId,
	onAddProvider,
}: {
	agent: RuntimeSettingsAgentRowModel;
	disabled: boolean;
	workspaceId: string | null;
	onAddProvider?: () => void;
}): React.ReactElement {
	const installUrl = getRuntimeAgentCatalogEntry(agent.id)?.installUrl;
	const isNativeKanban = agent.id === "pi";
	const isInstalled = agent.installed === true;
	const isInstallStatusPending = !isNativeKanban && agent.installed === null;

	return (
		<div className="flex items-center justify-between gap-3 py-1.5">
			<div className="flex items-start gap-2 min-w-0">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-primary">{agent.label}</span>
						{!isNativeKanban && isInstalled ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-green/10 text-status-green">
								Installed
							</span>
						) : isInstallStatusPending ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-surface-3 text-text-secondary">
								Checking...
							</span>
						) : null}
					</div>
					{agent.command ? (
						<p className="text-text-secondary font-mono text-xs mt-0.5 m-0">{agent.command}</p>
					) : null}
				</div>
			</div>
			{!isNativeKanban && agent.installed === false && installUrl ? (
				<a
					href={installUrl}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center justify-center rounded-md font-medium duration-150 cursor-default select-none h-7 px-2 text-xs bg-surface-2 border border-border text-text-primary hover:bg-surface-3 hover:border-border-bright"
				>
					Install
				</a>
			) : !isNativeKanban && agent.installed === false ? (
				<Button size="sm" disabled>
					Install
				</Button>
			) : (
				<AgentProviderSelector
					agentId={agent.id}
					workspaceId={workspaceId}
					controlsDisabled={disabled}
					onAddProvider={onAddProvider}
				/>
			)}
		</div>
	);
}

function InlineUtilityButton({
	text,
	onClick,
	disabled,
	monospace,
	widthCh,
}: {
	text: string;
	onClick: () => void;
	disabled?: boolean;
	monospace?: boolean;
	widthCh?: number;
}): React.ReactElement {
	return (
		<Button
			size="sm"
			disabled={disabled}
			onClick={onClick}
			className={cn(monospace && "font-mono")}
			style={{
				fontSize: 10,
				verticalAlign: "middle",
				...(typeof widthCh === "number"
					? {
							width: `${widthCh}ch`,
							justifyContent: "center",
						}
					: {}),
			}}
		>
			{text}
		</Button>
	);
}

function ShortcutIconPicker({
	value,
	onSelect,
}: {
	value: string | undefined;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getShortcutIconOption(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					className="inline-flex items-center gap-1 h-7 px-1.5 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3"
				>
					<ShortcutIconComponent icon={value} size={14} />
					<ChevronDown size={12} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 rounded-md border border-border bg-surface-2 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex gap-0.5">
						{RUNTIME_SHORTCUT_ICON_OPTIONS.map((option) => {
							const IconComponent = getRuntimeShortcutIconComponent(option.value);
							return (
								<button
									key={option.value}
									type="button"
									aria-label={option.label}
									className={cn(
										"p-1.5 rounded hover:bg-surface-3",
										selectedOption.value === option.value && "bg-surface-3",
									)}
									onClick={() => {
										onSelect(option.value);
										setOpen(false);
									}}
								>
									<IconComponent size={14} />
								</button>
							);
						})}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

function SettingsNav({
	items,
	activeId,
	onSelect,
}: {
	items: ReadonlyArray<{ id: SettingsNavId; label: string; icon: React.ReactNode }>;
	activeId: SettingsNavId;
	onSelect: (id: SettingsNavId) => void;
}): React.ReactElement {
	return (
		<nav className="hidden md:flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface-1 p-3 overflow-y-auto">
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					onClick={() => onSelect(item.id)}
					className={cn(
						"flex items-center gap-2.5 text-left px-3 py-2 rounded-md text-[13px] font-medium cursor-pointer",
						activeId === item.id
							? "bg-surface-3 text-text-primary"
							: "text-text-secondary hover:text-text-primary hover:bg-surface-2",
					)}
				>
					<span className="shrink-0 opacity-80">{item.icon}</span>
					<span>{item.label}</span>
				</button>
			))}
		</nav>
	);
}

export function RuntimeSettingsDialog({
	open,
	workspaceId,
	initialConfig = null,
	onOpenChange,
	onSaved,
	onAccountSwitched,
	initialSection,
}: {
	open: boolean;
	workspaceId: string | null;
	initialConfig?: RuntimeConfigResponse | null;
	onOpenChange: (open: boolean) => void;
	onSaved?: () => void;
	onAccountSwitched?: () => void;
	initialSection?: RuntimeSettingsSection | null;
}): React.ReactElement {
	const { config, isLoading, isSaving, save, refresh } = useRuntimeConfig(open, workspaceId, initialConfig);
	const { resetLayoutCustomizations } = useLayoutCustomizations();
	const [agentAutonomousModeEnabled, setAgentAutonomousModeEnabled] = useState(true);
	const [readyForReviewNotificationsEnabled, setReadyForReviewNotificationsEnabled] = useState(true);
	const [initialThemeId, setInitialThemeId] = useState<ThemeId>(readStoredThemeId);
	const [draftThemeId, setDraftThemeId] = useState<ThemeId>(readStoredThemeId);
	const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>("unsupported");
	const [shortcuts, setShortcuts] = useState<RuntimeProjectShortcut[]>([]);
	const [commitPromptTemplate, setCommitPromptTemplate] = useState("");
	const [openPrPromptTemplate, setOpenPrPromptTemplate] = useState("");
	const [proxyEnabled, setProxyEnabled] = useState(false);
	const [proxyHost, setProxyHost] = useState("");
	const [proxyPort, setProxyPort] = useState("");
	const [proxyUsername, setProxyUsername] = useState("");
	const [proxyPassword, setProxyPassword] = useState("");
	const [noProxy, setNoProxy] = useState("");
	const [selectedPromptVariant, setSelectedPromptVariant] = useState<TaskGitAction>("commit");
	const [copiedVariableToken, setCopiedVariableToken] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [pendingShortcutScrollIndex, setPendingShortcutScrollIndex] = useState<number | null>(null);
	const copiedVariableResetTimerRef = useRef<number | null>(null);
	const shortcutsSectionRef = useRef<HTMLHeadingElement | null>(null);
	const shortcutRowRefs = useRef<Array<HTMLDivElement | null>>([]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const isScrollingProgrammatically = useRef(false);
	const [activeSection, setActiveSection] = useState<SettingsNavId>("general");
	// ── Providers dialog state ──────────────────────────────────────────────
	const [providerDialogOpen, setProviderDialogOpen] = useState(false);
	const [providerDialogMode, setProviderDialogMode] = useState<"add" | "edit">("add");
	const [providerDialogInitialValues, setProviderDialogInitialValues] = useState<KanbanProviderDialogInitialValues | null>(null);
	const controlsDisabled = isLoading || isSaving || config === null;
	const commitPromptTemplateDefault = config?.commitPromptTemplateDefault ?? "";
	const openPrPromptTemplateDefault = config?.openPrPromptTemplateDefault ?? "";
	const isCommitPromptAtDefault =
		normalizeTemplateForComparison(commitPromptTemplate) ===
		normalizeTemplateForComparison(commitPromptTemplateDefault);
	const isOpenPrPromptAtDefault =
		normalizeTemplateForComparison(openPrPromptTemplate) ===
		normalizeTemplateForComparison(openPrPromptTemplateDefault);
	const selectedPromptValue = selectedPromptVariant === "commit" ? commitPromptTemplate : openPrPromptTemplate;
	const selectedPromptDefaultValue =
		selectedPromptVariant === "commit" ? commitPromptTemplateDefault : openPrPromptTemplateDefault;
	const isSelectedPromptAtDefault =
		selectedPromptVariant === "commit" ? isCommitPromptAtDefault : isOpenPrPromptAtDefault;
	const selectedPromptPlaceholder =
		selectedPromptVariant === "commit" ? "Commit prompt template" : "PR prompt template";
	const bypassPermissionsCheckboxId = "runtime-settings-bypass-permissions";
	const refreshNotificationPermission = useCallback(() => {
		setNotificationPermission(getBrowserNotificationPermission());
	}, []);

	const handleOpenAddProviderDialog = useCallback(() => {
		setProviderDialogMode("add");
		setProviderDialogInitialValues(null);
		setProviderDialogOpen(true);
	}, []);

	// ── Provider catalog (for Providers nav section) ─────────────────────────
	const [providerCatalogAll, setProviderCatalogAll] = useState<RuntimeKanbanProviderCatalogItem[]>([]);
	const reloadProviderCatalog = useCallback(() => {
		if (!open) return;
		void fetchKanbanProviderCatalog(workspaceId).then(setProviderCatalogAll).catch(() => setProviderCatalogAll([]));
	}, [open, workspaceId]);
	useEffect(() => {
		reloadProviderCatalog();
	}, [reloadProviderCatalog]);

	const handleOpenEditProviderDialog = useCallback((provider: RuntimeKanbanProviderCatalogItem) => {
		setProviderDialogMode("edit");
		setProviderDialogInitialValues({
			providerId: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl ?? "",
			defaultModelId: provider.defaultModelId ?? "",
			protocols: provider.protocols.map((p) => p.protocol),
			protocolConfigs: provider.protocols.map((p) => ({ protocol: p.protocol, baseUrl: p.baseUrl })),
			models: [],
		});
		setProviderDialogOpen(true);
	}, []);

	const supportedAgents = useMemo<RuntimeSettingsAgentRowModel[]>(() => {
		const agents =
			config?.agents.map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: agent.id === "pi" ? true : agent.installed,
			})) ??
			getRuntimeLaunchSupportedAgentCatalog().map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: agent.id === "pi" ? true : null,
			}));
		const orderIndexByAgentId = new Map(SETTINGS_AGENT_ORDER.map((agentId, index) => [agentId, index] as const));
		const orderedAgents = [...agents].sort((left, right) => {
			const leftOrderIndex = orderIndexByAgentId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
			const rightOrderIndex = orderIndexByAgentId.get(right.id) ?? Number.MAX_SAFE_INTEGER;
			return leftOrderIndex - rightOrderIndex;
		});
		return orderedAgents.map((agent) => ({
			...agent,
			command: buildDisplayedAgentCommand(agent.id, agent.binary, agentAutonomousModeEnabled),
		}));
	}, [agentAutonomousModeEnabled, config?.agents]);
	const displayedAgents = useMemo(() => supportedAgents, [supportedAgents]);
	const agentSettings = useRuntimeSettingsKanbanController({
		open,
		workspaceId,
		config,
	});
	const handleProviderDialogSubmit = useCallback(
		async (input: import("@/hooks/use-runtime-settings-kanban-controller").AddKanbanProviderInput | import("@/hooks/use-runtime-settings-kanban-controller").UpdateKanbanProviderInput) => {
			try {
				if (providerDialogMode === "add") {
					await agentSettings.addCustomProvider(input as import("@/hooks/use-runtime-settings-kanban-controller").AddKanbanProviderInput);
				} else {
					await agentSettings.updateCustomProvider(input as import("@/hooks/use-runtime-settings-kanban-controller").UpdateKanbanProviderInput);
				}
				reloadProviderCatalog();
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[agentSettings, providerDialogMode, reloadProviderCatalog],
	);
	// The slim Account section only manages managed-provider OAuth + account/org/credits;
	// per-agent provider/model/MCP config now lives inline in the home chat composer.
	const showAccountSection = agentSettings.isOauthProviderSelected;
	const showClineAccountControls = showAccountSection && agentSettings.providerId.trim() === "cline";
	const navItems = useMemo(
		() => SETTINGS_NAV_ITEMS.filter((item) => !item.accountOnly || showAccountSection),
		[showAccountSection],
	);
	const initialAgentAutonomousModeEnabled = config?.agentAutonomousModeEnabled ?? true;
	const initialReadyForReviewNotificationsEnabled = config?.readyForReviewNotificationsEnabled ?? true;
	const initialShortcuts = config?.shortcuts ?? [];
	const initialCommitPromptTemplate = config?.commitPromptTemplate ?? "";
	const initialOpenPrPromptTemplate = config?.openPrPromptTemplate ?? "";
	const initialProxyEnabled = config?.proxyEnabled ?? false;
	const initialProxyHost = config?.proxyHost ?? "";
	const initialProxyPort = config?.proxyPort ?? "";
	const initialProxyUsername = config?.proxyUsername ?? "";
	const initialProxyPassword = config?.proxyPassword ?? "";
	const initialNoProxy = config?.noProxy ?? "";
	const hasUnsavedChanges = useMemo(() => {
		if (!config) {
			return false;
		}
		if (agentAutonomousModeEnabled !== initialAgentAutonomousModeEnabled) {
			return true;
		}
		if (readyForReviewNotificationsEnabled !== initialReadyForReviewNotificationsEnabled) {
			return true;
		}
		if (draftThemeId !== initialThemeId) {
			return true;
		}
		if (!areRuntimeProjectShortcutsEqual(shortcuts, initialShortcuts)) {
			return true;
		}
		if (
			normalizeTemplateForComparison(commitPromptTemplate) !==
			normalizeTemplateForComparison(initialCommitPromptTemplate)
		) {
			return true;
		}
		if (proxyEnabled !== initialProxyEnabled) return true;
		if (proxyHost !== initialProxyHost) return true;
		if (proxyPort !== initialProxyPort) return true;
		if (proxyUsername !== initialProxyUsername) return true;
		if (proxyPassword !== initialProxyPassword) return true;
		if (noProxy !== initialNoProxy) return true;
		return (
			normalizeTemplateForComparison(openPrPromptTemplate) !==
			normalizeTemplateForComparison(initialOpenPrPromptTemplate)
		);
	}, [
		agentAutonomousModeEnabled,
		commitPromptTemplate,
		config,
		draftThemeId,
		initialAgentAutonomousModeEnabled,
		initialCommitPromptTemplate,
		initialOpenPrPromptTemplate,
		initialNoProxy,
		initialProxyEnabled,
		initialProxyHost,
		initialProxyPassword,
		initialProxyPort,
		initialProxyUsername,
		initialReadyForReviewNotificationsEnabled,
		initialShortcuts,
		initialThemeId,
		noProxy,
		openPrPromptTemplate,
		proxyEnabled,
		proxyHost,
		proxyPassword,
		proxyPort,
		proxyUsername,
		readyForReviewNotificationsEnabled,
		shortcuts,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		setAgentAutonomousModeEnabled(config?.agentAutonomousModeEnabled ?? true);
		setReadyForReviewNotificationsEnabled(config?.readyForReviewNotificationsEnabled ?? true);
		setShortcuts(config?.shortcuts ?? []);
		setCommitPromptTemplate(config?.commitPromptTemplate ?? "");
		setOpenPrPromptTemplate(config?.openPrPromptTemplate ?? "");
		setProxyEnabled(config?.proxyEnabled ?? false);
		setProxyHost(config?.proxyHost ?? "");
		setProxyPort(config?.proxyPort ?? "");
		setProxyUsername(config?.proxyUsername ?? "");
		setProxyPassword(config?.proxyPassword ?? "");
		setNoProxy(config?.noProxy ?? "");
		setSaveError(null);
	}, [
		config?.agentAutonomousModeEnabled,
		config?.commitPromptTemplate,
		config?.openPrPromptTemplate,
		config?.proxyEnabled,
		config?.proxyHost,
		config?.proxyPort,
		config?.proxyUsername,
		config?.proxyPassword,
		config?.noProxy,
		config?.readyForReviewNotificationsEnabled,
		config?.shortcuts,
		open,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const persistedThemeId = readStoredThemeId();
		setInitialThemeId(persistedThemeId);
		setDraftThemeId(persistedThemeId);
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		refreshNotificationPermission();
	}, [open, refreshNotificationPermission]);
	useWindowEvent("focus", open ? refreshNotificationPermission : null);

	useEffect(() => {
		if (!open || initialSection !== "shortcuts") {
			return;
		}
		const timeout = window.setTimeout(() => {
			shortcutsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
		}, 500);
		return () => {
			window.clearTimeout(timeout);
		};
	}, [initialSection, open]);

	useEffect(() => {
		if (pendingShortcutScrollIndex === null) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const target = shortcutRowRefs.current[pendingShortcutScrollIndex] ?? null;
			if (target) {
				target.scrollIntoView({ block: "nearest", behavior: "smooth" });
				const firstInput = target.querySelector("input");
				firstInput?.focus();
				setPendingShortcutScrollIndex(null);
			}
		});
		return () => {
			window.cancelAnimationFrame(frame);
		};
	}, [pendingShortcutScrollIndex, shortcuts]);

	useUnmount(() => {
		if (copiedVariableResetTimerRef.current !== null) {
			window.clearTimeout(copiedVariableResetTimerRef.current);
			copiedVariableResetTimerRef.current = null;
		}
	});

	useEffect(() => {
		if (activeSection === "account" && !showAccountSection) {
			setActiveSection("general");
		}
	}, [activeSection, showAccountSection]);

	const handleBodyScroll = useCallback(() => {
		if (isScrollingProgrammatically.current) return;
		const body = bodyRef.current;
		if (!body) return;
		const headings = body.querySelectorAll<HTMLElement>("[data-settings-section]");
		const bodyRect = body.getBoundingClientRect();
		let current: SettingsNavId = "general";

		for (const heading of headings) {
			const rect = heading.getBoundingClientRect();
			if (rect.top - bodyRect.top <= 40) {
				const id = heading.getAttribute("data-settings-section");
				if (id) current = id as SettingsNavId;
			}
		}

		setActiveSection(current);
	}, []);

	const handleNavSelect = useCallback((id: SettingsNavId) => {
		setActiveSection(id);
		isScrollingProgrammatically.current = true;
		const body = bodyRef.current;
		if (!body) return;
		const target = body.querySelector(`[data-settings-section="${id}"]`);
		if (target) {
			const bodyRect = body.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			body.scrollTo({
				top: targetRect.top - bodyRect.top + body.scrollTop,
				behavior: "smooth",
			});
		}
		window.setTimeout(() => {
			isScrollingProgrammatically.current = false;
		}, 600);
	}, []);

	const handleCopyVariableToken = (token: string) => {
		void (async () => {
			try {
				await navigator.clipboard.writeText(token);
				setCopiedVariableToken(token);
				if (copiedVariableResetTimerRef.current !== null) {
					window.clearTimeout(copiedVariableResetTimerRef.current);
				}
				copiedVariableResetTimerRef.current = window.setTimeout(() => {
					setCopiedVariableToken((current) => (current === token ? null : current));
					copiedVariableResetTimerRef.current = null;
				}, 2000);
			} catch {
				// Ignore clipboard failures.
			}
		})();
	};

	const handleSelectedPromptChange = (value: string) => {
		if (selectedPromptVariant === "commit") {
			setCommitPromptTemplate(value);
			return;
		}
		setOpenPrPromptTemplate(value);
	};

	const handleResetSelectedPrompt = () => {
		handleSelectedPromptChange(selectedPromptDefaultValue);
	};

	const handleSave = async () => {
		setSaveError(null);
		if (!config) {
			setSaveError("Runtime settings are still loading. Try again in a moment.");
			return;
		}
		const shouldRequestNotificationPermission =
			!initialReadyForReviewNotificationsEnabled &&
			readyForReviewNotificationsEnabled &&
			notificationPermission === "default";
		if (shouldRequestNotificationPermission) {
			const nextPermission = await requestBrowserNotificationPermission();
			setNotificationPermission(nextPermission);
		}
		const saved = await save({
			selectedAgentId: "pi",
			agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled,
			shortcuts,
			commitPromptTemplate,
			openPrPromptTemplate,
			proxyEnabled,
			proxyHost,
			proxyPort,
			proxyUsername,
			proxyPassword,
			noProxy,
		});
		if (!saved) {
			setSaveError("Could not save runtime settings. Check runtime logs and try again.");
			return;
		}
		if (draftThemeId !== initialThemeId) {
			saveThemeId(draftThemeId);
			setInitialThemeId(draftThemeId);
		}
		onSaved?.();
		handleDialogOpenChange(false);
	};

	const handleRequestPermission = () => {
		void (async () => {
			const nextPermission = await requestBrowserNotificationPermission();
			setNotificationPermission(nextPermission);
		})();
	};

	const handleOpenFilePath = useCallback(
		(filePath: string) => {
			setSaveError(null);
			void openFileOnHost(workspaceId, filePath).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				setSaveError(`Could not open file on host: ${message}`);
			});
		},
		[workspaceId],
	);

	const handleAccountSaved = useCallback(() => {
		refresh();
		onSaved?.();
	}, [onSaved, refresh]);

	const handleDialogOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen) {
				const persistedThemeId = readStoredThemeId();
				if (draftThemeId !== persistedThemeId) {
					previewThemeId(persistedThemeId);
				}
				setDraftThemeId(persistedThemeId);
				setInitialThemeId(persistedThemeId);
			}
			onOpenChange(nextOpen);
		},
		[draftThemeId, onOpenChange],
	);

	const currentThemeDef = THEMES.find((t) => t.id === draftThemeId);

	return (
		<Dialog open={open} onOpenChange={handleDialogOpenChange} contentClassName="!max-w-[780px]">
			<DialogHeader title="Settings" icon={<Settings size={16} />} />
			<div className="flex h-[min(480px,60vh)]">
				<SettingsNav items={navItems} activeId={activeSection} onSelect={handleNavSelect} />
				<div
					ref={bodyRef}
					onScroll={handleBodyScroll}
					className="px-5 pb-5 overflow-y-auto overscroll-contain flex-1 min-h-0 bg-surface-1"
				>
					{/* ---- General ---- */}
					<div data-settings-section="general" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<SlidersHorizontal size={16} className="text-text-secondary" />
							General
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-1">
							Agent
						</h6>
						{displayedAgents.map((agent) => (
							<AgentRow
								key={agent.id}
								agent={agent}
								disabled={controlsDisabled}
								workspaceId={workspaceId}
								onAddProvider={handleOpenAddProviderDialog}
							/>
						))}
						{config === null ? (
							<p className="text-text-secondary py-2">Checking which CLIs are installed for this project...</p>
						) : null}
						<label
							htmlFor={bypassPermissionsCheckboxId}
							className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
						>
							<RadixCheckbox.Root
								id={bypassPermissionsCheckboxId}
								aria-label="Enable bypass permissions flag"
								checked={agentAutonomousModeEnabled}
								disabled={controlsDisabled}
								onCheckedChange={(checked) => setAgentAutonomousModeEnabled(checked === true)}
								className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
							>
								<RadixCheckbox.Indicator>
									<Check size={12} className="text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							<span>Enable bypass permissions flag</span>
						</label>
						<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
							Allows agents to use tools without stopping for permission. Use at your own risk.
						</p>
					</div>

					{/* ---- Account ---- */}
					{showAccountSection ? (
						<>
							<div data-settings-section="account" />
							<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
								<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
									<CircleUser size={16} className="text-text-secondary" />
									Account
								</h2>
							</div>
							<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
								<p className="text-text-secondary text-[13px] mt-0 mb-2">
									Sign in to the managed provider your agents use. Provider, model, and other per-agent
									settings are configured inline in the chat composer.
								</p>
								<KanbanOauthSignInPanel
									controller={agentSettings}
									controlsDisabled={controlsDisabled}
									onError={setSaveError}
									onSaved={handleAccountSaved}
								/>
								{showClineAccountControls ? (
									<div className="mt-4">
										<AccountOrganizationSection
											workspaceId={workspaceId}
											open={open}
											onAccountSwitched={onAccountSwitched}
										/>
									</div>
								) : null}
							</div>
						</>
					) : null}

					{/* ---- Providers ---- */}
					<div data-settings-section="providers" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Key size={16} className="text-text-secondary" />
							Providers
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<p className="text-text-secondary text-[13px] mt-0 mb-3">
							Configure providers for the Pi agent. Each provider defines an API endpoint and available models.
						</p>
						<div className="flex flex-col gap-1">
							{providerCatalogAll.length === 0 ? (
								<p className="text-text-tertiary text-[13px] py-2">No providers configured. Click "Add Provider" to get started.</p>
							) : (
								providerCatalogAll.map((provider) => (
									<div
										key={provider.id}
										className="flex items-center justify-between gap-3 py-2 px-2 rounded hover:bg-surface-1"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="text-[13px] text-text-primary font-medium">{provider.name}</span>
												<span className="text-[11px] text-text-tertiary font-mono">{provider.id}</span>
											</div>
											{provider.defaultModelId ? (
												<p className="text-text-secondary text-[11px] mt-0.5 m-0 truncate">
													Default model: {provider.defaultModelId}
												</p>
											) : null}
											{provider.protocols.length > 0 ? (
												<p className="text-text-tertiary text-[10px] mt-0.5 m-0">
													{provider.protocols.map((p) => p.protocol).join(", ")}
												</p>
											) : null}
										</div>
										<div className="flex items-center gap-1.5 shrink-0">
											<Button
												size="sm"
												variant="ghost"
												icon={<Pencil size={12} />}
												onClick={() => handleOpenEditProviderDialog(provider)}
											>
												Edit
											</Button>
										</div>
									</div>
								))
							)}
						</div>
						<div className="mt-3 pt-3 border-t border-border">
							<Button
								size="sm"
								icon={<Plus size={14} />}
								onClick={handleOpenAddProviderDialog}
								disabled={controlsDisabled}
							>
								Add Provider
							</Button>
						</div>
					</div>

					{/* ---- Network Proxy ---- */}
					<div data-settings-section="proxy" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Globe size={16} className="text-text-secondary" />
							Network Proxy
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<div className="flex items-center gap-2 mb-3">
							<RadixSwitch.Root
								checked={proxyEnabled}
								disabled={controlsDisabled}
								onCheckedChange={setProxyEnabled}
								className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
							>
								<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
							</RadixSwitch.Root>
							<span className="text-[13px] text-text-primary">Enable proxy</span>
						</div>
						<div className={`space-y-3 ${proxyEnabled ? "" : "opacity-40"}`}>
							<div>
								<label className="block text-[12px] text-text-secondary mb-1">Host</label>
								<input
									value={proxyHost}
									onChange={(event) => setProxyHost(event.target.value)}
									placeholder="proxy.example.com"
									disabled={controlsDisabled}
									className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
								/>
							</div>
							<div>
								<label className="block text-[12px] text-text-secondary mb-1">Port (optional)</label>
								<input
									value={proxyPort}
									onChange={(event) => setProxyPort(event.target.value)}
									placeholder="8080"
									disabled={controlsDisabled}
									className="h-8 w-36 rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
								/>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<div>
									<label className="block text-[12px] text-text-secondary mb-1">Username (optional)</label>
									<input
										value={proxyUsername}
										onChange={(event) => setProxyUsername(event.target.value)}
										placeholder=""
										disabled={controlsDisabled}
										className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
									/>
								</div>
								<div>
									<label className="block text-[12px] text-text-secondary mb-1">Password (optional)</label>
									<input
										value={proxyPassword}
										onChange={(event) => setProxyPassword(event.target.value)}
										type="password"
										placeholder=""
										disabled={controlsDisabled}
										className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
									/>
								</div>
							</div>
							<div>
								<label className="block text-[12px] text-text-secondary mb-1">
									No Proxy (optional, comma-separated)
								</label>
								<input
									value={noProxy}
									onChange={(event) => setNoProxy(event.target.value)}
									placeholder="localhost,127.0.0.1,re:\.aliyuncs\.com$"
									disabled={controlsDisabled}
									className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
								/>
								<p className="text-text-tertiary text-[12px] mt-1 mb-0">
									Hosts that bypass the proxy and connect directly. Each entry is an exact host, a domain
									suffix (<code className="text-text-secondary">example.com</code> also matches its
									subdomains), or a regex prefixed with <code className="text-text-secondary">re:</code>{" "}
									matched against the host (e.g.{" "}
									<code className="text-text-secondary">{"re:\\.aliyuncs\\.com$"}</code> for mainland
									endpoints).
								</p>
							</div>
							<p className="text-text-tertiary text-[12px] m-0">
								Proxy and direct-connect changes apply immediately to in-app requests and to newly started agent
								sessions.
							</p>
						</div>
					</div>

					{/* ---- Git Prompts ---- */}
					<div data-settings-section="git-prompts" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<GitCommit size={16} className="text-text-secondary" />
							Git Prompts
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<p className="text-text-secondary text-[13px] mt-0 mb-2">
							Modify the prompts sent to the agent when using Commit or Make PR on tasks in Review.
						</p>
						<div className="flex items-center justify-between gap-2 mb-2">
							<NativeSelect
								value={selectedPromptVariant}
								onChange={(event) => setSelectedPromptVariant(event.target.value as TaskGitAction)}
								disabled={controlsDisabled}
								style={{ minWidth: 220 }}
							>
								{GIT_PROMPT_VARIANT_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleResetSelectedPrompt}
								disabled={controlsDisabled || isSelectedPromptAtDefault}
							>
								Reset
							</Button>
						</div>
						<textarea
							rows={5}
							value={selectedPromptValue}
							onChange={(event) => handleSelectedPromptChange(event.target.value)}
							placeholder={selectedPromptPlaceholder}
							disabled={controlsDisabled}
							className="w-full rounded-md border border-border bg-surface-2 p-3 text-[13px] text-text-primary font-mono placeholder:text-text-tertiary focus:border-border-focus focus:outline-none resize-none disabled:opacity-40"
						/>
						<p className="text-text-secondary text-[13px] mt-2 mb-0">
							Use{" "}
							<InlineUtilityButton
								text={
									copiedVariableToken === TASK_GIT_BASE_REF_PROMPT_VARIABLE.token
										? "Copied!"
										: TASK_GIT_BASE_REF_PROMPT_VARIABLE.token
								}
								monospace
								widthCh={Math.max(TASK_GIT_BASE_REF_PROMPT_VARIABLE.token.length, "Copied!".length) + 2}
								onClick={() => {
									handleCopyVariableToken(TASK_GIT_BASE_REF_PROMPT_VARIABLE.token);
								}}
								disabled={controlsDisabled}
							/>{" "}
							to reference {TASK_GIT_BASE_REF_PROMPT_VARIABLE.description}
						</p>
					</div>

					{/* ---- Notifications ---- */}
					<div data-settings-section="notifications" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Bell size={16} className="text-text-secondary" />
							Notifications
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<div className="flex items-center gap-2">
							<RadixSwitch.Root
								checked={readyForReviewNotificationsEnabled}
								disabled={controlsDisabled}
								onCheckedChange={setReadyForReviewNotificationsEnabled}
								className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
							>
								<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
							</RadixSwitch.Root>
							<span className="text-[13px] text-text-primary">Notify when a task is ready for review</span>
						</div>
						<div className="flex items-center gap-2 mt-2">
							<p className="text-text-secondary text-[13px] m-0">
								Browser permission: {formatNotificationPermissionStatus(notificationPermission)}
							</p>
							{notificationPermission !== "granted" && notificationPermission !== "unsupported" ? (
								<InlineUtilityButton
									text="Request permission"
									onClick={handleRequestPermission}
									disabled={controlsDisabled}
								/>
							) : null}
						</div>
					</div>

					{/* ---- Appearance ---- */}
					<div data-settings-section="appearance" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<Palette size={16} className="text-text-secondary" />
							Appearance
						</h2>
					</div>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
							Theme
						</h6>
						<div className="min-w-0 w-1/2 max-w-full">
							<RadixSelect.Root
								value={draftThemeId}
								onValueChange={(value) => {
									setDraftThemeId(value as ThemeId);
									previewThemeId(value as ThemeId);
								}}
								onOpenChange={(selectOpen) => {
									if (!selectOpen) {
										previewThemeId(draftThemeId);
									}
								}}
							>
								<RadixSelect.Trigger
									className="flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-border-bright bg-surface-2 px-3 text-[13px] text-text-primary outline-none hover:bg-surface-3 hover:border-border-bright focus:border-border-focus focus:outline-none"
									aria-label="Theme"
								>
									<span className="flex items-center gap-2.5">
										<span className="flex shrink-0 h-5 w-10 rounded overflow-hidden border border-border">
											<span
												className="flex-1"
												style={{ background: currentThemeDef?.surface ?? "#1F2428" }}
											/>
											<span
												className="flex-1"
												style={{ background: currentThemeDef?.accent ?? "#0084FF" }}
											/>
											<span
												className="flex-1"
												style={{ background: currentThemeDef?.accent2 ?? "#7C5CFF" }}
											/>
										</span>
										<RadixSelect.Value />
									</span>
									<RadixSelect.Icon>
										<ChevronDown size={14} className="text-text-tertiary" />
									</RadixSelect.Icon>
								</RadixSelect.Trigger>
								<RadixSelect.Portal>
									<RadixSelect.Content
										className="z-50 max-h-72 w-(--radix-select-trigger-width) overflow-auto rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
										position="popper"
										sideOffset={4}
										align="start"
									>
										<RadixSelect.Viewport>
											{THEME_GROUPS.map((group) => {
												const groupThemes = THEMES.filter((t) => t.group === group.key);
												if (groupThemes.length === 0) return null;
												return (
													<RadixSelect.Group key={group.key}>
														<RadixSelect.Label className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
															{group.label}
														</RadixSelect.Label>
														{groupThemes.map((theme) => (
															<RadixSelect.Item
																key={theme.id}
																value={theme.id}
																className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
																onMouseEnter={() => previewThemeId(theme.id)}
																onFocus={() => previewThemeId(theme.id)}
															>
																<span className="flex shrink-0 h-5 w-10 rounded overflow-hidden border border-border">
																	<span className="flex-1" style={{ background: theme.surface }} />
																	<span className="flex-1" style={{ background: theme.accent }} />
																	<span className="flex-1" style={{ background: theme.accent2 }} />
																</span>
																<RadixSelect.ItemText>{theme.label}</RadixSelect.ItemText>
																<RadixSelect.ItemIndicator className="ml-auto">
																	<Check size={14} className="text-accent-2" />
																</RadixSelect.ItemIndicator>
															</RadixSelect.Item>
														))}
													</RadixSelect.Group>
												);
											})}
										</RadixSelect.Viewport>
									</RadixSelect.Content>
								</RadixSelect.Portal>
							</RadixSelect.Root>
						</div>

						<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary mt-5 mb-2">
							Layout
						</h6>
						<Button size="sm" onClick={resetLayoutCustomizations}>
							Reset layout
						</Button>
						<p className="text-text-secondary text-[13px] mt-2 mb-0">
							Reset sidebar, split pane, and terminal resize customizations back to their defaults.
						</p>
					</div>
					<div data-settings-section="project" />
					<div className="sticky top-0 -mx-5 px-5 pt-4 pb-2 bg-surface-1 z-10">
						<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary m-0">
							<FolderOpen size={16} className="text-text-secondary" />
							Project
						</h2>
					</div>
					<p
						className="text-text-secondary font-mono text-xs m-0 mb-3 break-all"
						style={{ cursor: config?.projectConfigPath ? "pointer" : undefined }}
						onClick={() => {
							if (config?.projectConfigPath) {
								handleOpenFilePath(config.projectConfigPath);
							}
						}}
					>
						{config?.projectConfigPath
							? formatPathForDisplay(config.projectConfigPath)
							: "<project>/.kanban/kanban/config.json"}
						{config?.projectConfigPath ? <ExternalLink size={12} className="inline ml-1.5 align-middle" /> : null}
					</p>
					<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
						<div className="flex items-center justify-between mb-2">
							<h6
								ref={shortcutsSectionRef}
								className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0"
							>
								Script shortcuts
							</h6>
							<Button
								variant="ghost"
								size="sm"
								icon={<Plus size={14} />}
								onClick={() => {
									setShortcuts((current) => {
										const nextLabel = getNextShortcutLabel(current, "Run");
										setPendingShortcutScrollIndex(current.length);
										return [
											...current,
											{
												label: nextLabel,
												command: "",
												icon: "play",
											},
										];
									});
								}}
								disabled={controlsDisabled}
							>
								Add
							</Button>
						</div>

						{shortcuts.map((shortcut, shortcutIndex) => (
							<div
								key={shortcutIndex}
								ref={(node) => {
									shortcutRowRefs.current[shortcutIndex] = node;
								}}
								className="grid gap-2 mb-1"
								style={{
									gridTemplateColumns: "max-content 1fr 2fr auto",
								}}
							>
								<ShortcutIconPicker
									value={shortcut.icon}
									onSelect={(icon) =>
										setShortcuts((current) =>
											current.map((item, itemIndex) =>
												itemIndex === shortcutIndex ? { ...item, icon } : item,
											),
										)
									}
								/>
								<input
									value={shortcut.label}
									onChange={(event) =>
										setShortcuts((current) =>
											current.map((item, itemIndex) =>
												itemIndex === shortcutIndex ? { ...item, label: event.target.value } : item,
											),
										)
									}
									placeholder="Label"
									className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
								/>
								<input
									value={shortcut.command}
									onChange={(event) =>
										setShortcuts((current) =>
											current.map((item, itemIndex) =>
												itemIndex === shortcutIndex ? { ...item, command: event.target.value } : item,
											),
										)
									}
									placeholder="Command"
									className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
								/>
								<Button
									variant="ghost"
									size="sm"
									icon={<X size={14} />}
									aria-label={`Remove shortcut ${shortcut.label}`}
									onClick={() =>
										setShortcuts((current) => current.filter((_, itemIndex) => itemIndex !== shortcutIndex))
									}
								/>
							</div>
						))}
						{shortcuts.length === 0 ? (
							<p className="text-text-secondary text-[13px]">No shortcuts configured.</p>
						) : null}
					</div>

					{saveError ? (
						<div className="flex gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px]">
							<span className="text-text-primary">{saveError}</span>
						</div>
					) : null}
				</div>
			</div>
			<DialogFooter>
				<Button onClick={() => handleDialogOpenChange(false)} disabled={controlsDisabled}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={() => void handleSave()}
					disabled={controlsDisabled || !hasUnsavedChanges}
				>
					Save
				</Button>
			</DialogFooter>
			<KanbanAddProviderDialog
				open={providerDialogOpen}
				onOpenChange={setProviderDialogOpen}
				workspaceId={workspaceId}
				existingProviderIds={providerCatalogAll.map((p) => p.id)}
				mode={providerDialogMode}
				initialValues={providerDialogInitialValues}
				onSubmit={handleProviderDialogSubmit}
			/>
		</Dialog>
	);
}
