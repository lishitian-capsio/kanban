import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

const TERMINAL_SCROLLBACK = 10_000;

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: TERMINAL_SCROLLBACK,
		});
		this.terminal.loadAddon(this.serializeAddon);
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	applyOutput(chunk: Buffer): void {
		const chunkCopy = new Uint8Array(chunk);
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(chunkCopy, () => {
						resolve();
					});
				}),
		);
	}

	resize(cols: number, rows: number): void {
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		await this.operationQueue;
		return {
			snapshot: this.serializeAddon.serialize(),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	/**
	 * Plain-text lines that have scrolled above the live viewport — the stable,
	 * "committed" part of the transcript. The volatile viewport (live input box,
	 * spinners) is excluded so callers can treat the result as append-only history.
	 * Wrapped continuation rows are re-joined into their logical line. Returns an
	 * empty array while the alternate screen buffer is active (full-screen TUIs),
	 * since those do not produce linear scrollback.
	 */
	async getCommittedLines(): Promise<string[]> {
		await this.operationQueue;
		const buffer = this.terminal.buffer.active;
		if (buffer.type !== "normal") {
			return [];
		}
		const lines: string[] = [];
		for (let y = 0; y < buffer.baseY; y += 1) {
			const line = buffer.getLine(y);
			if (!line) {
				continue;
			}
			const text = line.translateToString(true);
			if (line.isWrapped && lines.length > 0) {
				lines[lines.length - 1] += text;
			} else {
				lines.push(text);
			}
		}
		return lines;
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
