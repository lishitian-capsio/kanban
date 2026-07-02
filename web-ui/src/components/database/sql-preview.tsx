import { useEffect, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import type { RuntimeDbPreviewWriteRequest } from "@/runtime/types";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { dbErrorMessage } from "./db-utils";

interface PreviewState {
	status: "loading" | "ready" | "error";
	sql?: string;
	params?: Array<string | null>;
	error?: string;
}

export interface SqlPreviewProps {
	workspaceId: string;
	/** The write to preview. When null, nothing is fetched or rendered. */
	request: RuntimeDbPreviewWriteRequest | null;
}

/**
 * Renders the exact parameterized SQL (and bound params) the runtime will run for a row write,
 * fetched via the read-only `previewWrite` procedure — it builds but never executes the statement.
 * Shown in the edit/insert/delete confirmation surfaces so the human can review before applying.
 */
export function SqlPreview({ workspaceId, request }: SqlPreviewProps): React.ReactElement | null {
	const [state, setState] = useState<PreviewState>({ status: "loading" });
	// Serialize the request so a new object identity per render doesn't re-fire the effect.
	const requestKey = request ? JSON.stringify(request) : null;

	useEffect(() => {
		if (!request) {
			return;
		}
		let cancelled = false;
		setState({ status: "loading" });
		getRuntimeTrpcClient(workspaceId)
			.database.previewWrite.query(request)
			.then((res) => {
				if (!cancelled) {
					setState({ status: "ready", sql: res.sql, params: res.params });
				}
			})
			.catch((error) => {
				if (!cancelled) {
					setState({ status: "error", error: dbErrorMessage(error, "Could not build the SQL preview.") });
				}
			});
		return () => {
			cancelled = true;
		};
		// `requestKey` is the serialized `request`, so it stands in for the object in the dep list
		// (avoids refetching on a new-but-equal object identity each render).
	}, [requestKey, workspaceId, request]);

	if (!request) {
		return null;
	}

	return (
		<div className="rounded-md border border-border bg-surface-0">
			<div className="border-b border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
				SQL preview
			</div>
			<div className="px-2 py-1.5">
				{state.status === "loading" ? (
					<span className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
						<Spinner size={12} /> Building…
					</span>
				) : state.status === "error" ? (
					<span className="text-[12px] text-status-red">{state.error}</span>
				) : (
					<>
						<pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] text-text-primary">
							{state.sql}
						</pre>
						{state.params && state.params.length > 0 ? (
							<div className="mt-1.5 flex flex-wrap items-center gap-1">
								<span className="text-[10px] uppercase tracking-wide text-text-tertiary">Params</span>
								{state.params.map((param, index) => (
									<span
										key={`${index}:${param ?? "NULL"}`}
										className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
									>
										{param === null ? "NULL" : param}
									</span>
								))}
							</div>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}
