import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import type React from "react";
import { useEffect, useState } from "react";

import { getLanguageLoader } from "./fs-language-map";

// Dark theme mapped onto the design-system surface/text tokens (AGENTS.md). Kept
// inline rather than pulling a third-party CodeMirror theme package (design §5.2).
const kanbanDarkTheme = EditorView.theme(
	{
		"&": {
			height: "100%",
			backgroundColor: "#1F2428",
			color: "#E6EDF3",
			fontSize: "12.5px",
		},
		".cm-scroller": {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
			lineHeight: "1.6",
		},
		".cm-content": { caretColor: "#0084FF" },
		".cm-gutters": {
			backgroundColor: "#1F2428",
			color: "#6E7681",
			border: "none",
		},
		".cm-activeLine": { backgroundColor: "transparent" },
		".cm-activeLineGutter": { backgroundColor: "transparent", color: "#8B949E" },
		".cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#264F78" },
		"&.cm-focused .cm-selectionBackground": { backgroundColor: "#264F78" },
		".cm-cursor": { borderLeftColor: "#0084FF" },
	},
	{ dark: true },
);

interface CodeEditorProps {
	value: string;
	/** File name (drives the extension → language mapping). */
	fileName: string;
	/** When false (default) the editor is a read-only viewer. */
	editable?: boolean;
	/** Called on every edit when `editable`. */
	onChange?: (next: string) => void;
}

/**
 * CodeMirror 6 code viewer/editor. The language extension is resolved from the
 * file name and dynamically imported so only the needed syntax package loads.
 * `editable` flips it between the P1 read-only viewer and the P2 editor; `onChange`
 * streams edits back to the owning draft buffer.
 */
export function CodeEditor({ value, fileName, editable = false, onChange }: CodeEditorProps): React.ReactElement {
	const [languageExtension, setLanguageExtension] = useState<Extension[]>([]);

	useEffect(() => {
		let active = true;
		const loader = getLanguageLoader(fileName);
		if (!loader) {
			setLanguageExtension([]);
			return;
		}
		loader()
			.then((extension) => {
				if (active) {
					setLanguageExtension([extension]);
				}
			})
			.catch(() => {
				if (active) {
					setLanguageExtension([]);
				}
			});
		return () => {
			active = false;
		};
	}, [fileName]);

	return (
		<CodeMirror
			value={value}
			readOnly={!editable}
			editable={editable}
			onChange={editable ? onChange : undefined}
			theme={kanbanDarkTheme}
			height="100%"
			style={{ height: "100%" }}
			extensions={[EditorView.lineWrapping, ...languageExtension]}
			basicSetup={{
				lineNumbers: true,
				foldGutter: false,
				highlightActiveLine: editable,
				highlightActiveLineGutter: false,
				autocompletion: false,
				searchKeymap: editable,
				closeBrackets: editable,
			}}
		/>
	);
}
