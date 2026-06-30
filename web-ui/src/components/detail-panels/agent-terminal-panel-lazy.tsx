import { lazy, type ReactElement, Suspense } from "react";

import type { AgentTerminalPanelProps } from "@/components/detail-panels/agent-terminal-panel";
import { LazyViewFallback } from "@/components/lazy-fallback";

// `agent-terminal-panel` statically pulls `@xterm/xterm` + 5 addons (webgl, fit,
// unicode11, web-links, clipboard) through `persistent-terminal-manager` — the
// `xterm-vendor` chunk is ~620 KB raw / 142 KB gzip. It must never reach the
// entry bundle: the first-paint home sidebar chat (`home-agent-conversation`)
// and the (lazy) card detail view both render a terminal panel, but only after
// the user opens a terminal. A static import from the first-paint conversation
// defeated App.tsx's own `lazy()` boundary and pulled `xterm-vendor` into the
// entry `modulepreload`. Routing every call site through this one wrapper keeps
// xterm behind a single dynamic import, so it downloads only when a terminal
// actually mounts.
const AgentTerminalPanelInner = lazy(() =>
	import("@/components/detail-panels/agent-terminal-panel").then((module) => ({
		default: module.AgentTerminalPanel,
	})),
);

export function LazyAgentTerminalPanel(props: AgentTerminalPanelProps): ReactElement {
	return (
		<Suspense fallback={<LazyViewFallback />}>
			<AgentTerminalPanelInner {...props} />
		</Suspense>
	);
}
