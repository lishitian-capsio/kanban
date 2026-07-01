import type React from "react";
import { lazy, Suspense } from "react";

import { Spinner } from "@/components/ui/spinner";

// Code-split CodeMirror (and every dynamically-imported language pack it pulls)
// out of the entry bundle. CRITICAL (memory `web-ui-perf-round2`): nothing on a
// first-paint path may statically import `./code-editor`, or modulepreload drags
// CodeMirror back into the entry chunk and defeats this boundary. It is only ever
// referenced through this lazy shell, itself reached only inside the (lazily
// mounted) File library overlay.
const CodeEditor = lazy(() => import("./code-editor").then((m) => ({ default: m.CodeEditor })));

interface CodeEditorLazyProps {
	value: string;
	fileName: string;
	editable?: boolean;
	onChange?: (next: string) => void;
}

export function CodeEditorLazy(props: CodeEditorLazyProps): React.ReactElement {
	return (
		<Suspense
			fallback={
				<div className="flex h-full items-center justify-center">
					<Spinner size={20} />
				</div>
			}
		>
			<CodeEditor {...props} />
		</Suspense>
	);
}
