import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

// Scrollback retained by the headless mirror. The transcript folds committed
// (scrolled-off) lines into an assistant message at every turn boundary, so the
// mirror only needs to hold a single turn's worth of scrollback between reads;
// 5k lines is comfortably more than any realistic turn while roughly halving the
// per-scroll clone/trim cost and memory versus the previous 10k.
const TERMINAL_SCROLLBACK = 5_000;

// Depth of scrollback included in a reconnect restore snapshot. A reconnecting
// viewer only needs enough history to repaint its viewport and scroll back a little
// — not the full 5k-line buffer, which `SerializeAddon.serialize()` would otherwise
// walk into one large ANSI string on every control-socket (re)connect (finding T7).
// The full transcript is preserved separately via the committed-lines path, so this
// cap does not affect transcript fidelity, only the visual restore depth.
const RESTORE_SNAPSHOT_SCROLLBACK = 1_000;

// Micro-batching: PTY output arrives as a flood of tiny chunks (one escape
// sequence / line each). Feeding every chunk to @xterm/headless individually
// allocates a Uint8Array + a Promise and walks the serial queue per chunk, which
// dominated idle CPU (GC churn) far more than the actual terminal parsing. We
// instead accumulate raw chunks and write them to xterm in a single batched call
// on a short timer or once a byte threshold is crossed. Reads (snapshot / committed
// lines) and resizes force a flush first so observable state is never stale.
const FLUSH_INTERVAL_MS = 16;
const FLUSH_BYTE_THRESHOLD = 64 * 1024;

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
	// Set once dispose() has torn down the xterm terminal. Reads/writes that lose the
	// race against teardown (e.g. a queued turn-boundary transcript capture firing after
	// the session is closed via Ctrl+C / /exit) must not touch the disposed terminal:
	// the lazy `Terminal.buffer` getter would register on an already-disposed
	// DisposableStore and log "Trying to add a disposable ... already been disposed of".
	private disposed = false;
	// Raw output chunks awaiting a single batched xterm write. Retained by reference
	// (no per-chunk copy): the protocol filter hands back retainable buffers/views per
	// its ownership contract, and concat at flush produces the single owned write buffer.
	private pendingChunks: Buffer[] = [];
	private pendingBytes = 0;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	// Physical scrollback row count already returned as committed by getCommittedLines.
	// Advancing it in the mirror lets each turn-boundary read scan only the freshly
	// scrolled-off rows instead of materializing the entire ~5k-line scrollback.
	private committedRowCount = 0;

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
		if (this.disposed) {
			return;
		}
		// Retain by reference, no per-chunk copy. Under a token flood this is the hot
		// path, and Buffer.from(chunk) here was one heap allocation per chunk feeding GC.
		// The chunk is retainable per filterTerminalProtocolOutput's ownership contract
		// (ultimately the onData contract in pty-session.ts): its bytes are not mutated
		// by the producer, so holding the view until the batched flush is safe. The single
		// owning copy happens once per batch in flushPendingOutput (Buffer.concat).
		this.pendingChunks.push(chunk);
		this.pendingBytes += chunk.byteLength;
		if (this.pendingBytes >= FLUSH_BYTE_THRESHOLD) {
			this.flushPendingOutput();
			return;
		}
		this.scheduleFlush();
	}

	resize(cols: number, rows: number): void {
		if (this.disposed) {
			return;
		}
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		// Flush buffered output first so it is written at the old dimensions, keeping
		// the write/resize/write ordering identical to an unbatched feed.
		this.flushPendingOutput();
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
		});
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flushPendingOutput();
		}, FLUSH_INTERVAL_MS);
		// Do not keep the event loop alive solely to flush the mirror; reads force a
		// flush, and dispose() clears any pending timer.
		this.flushTimer.unref?.();
	}

	private flushPendingOutput(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.pendingChunks.length === 0 || this.disposed) {
			this.pendingChunks = [];
			this.pendingBytes = 0;
			return;
		}
		// A Node Buffer is a Uint8Array, so it can be handed to xterm directly with no
		// extra allocation. A single pending chunk is written as-is (it is retainable per
		// the filter contract); multiple chunks concat into one fresh, privately-owned
		// buffer — the only output copy, amortized across the whole batch.
		const batch =
			this.pendingChunks.length === 1 ? this.pendingChunks[0] : Buffer.concat(this.pendingChunks, this.pendingBytes);
		this.pendingChunks = [];
		this.pendingBytes = 0;
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(batch, () => {
						resolve();
					});
				}),
		);
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		this.flushPendingOutput();
		await this.operationQueue;
		if (this.disposed) {
			return { snapshot: "", cols: this.terminal.cols, rows: this.terminal.rows };
		}
		return {
			snapshot: this.serializeAddon.serialize({ scrollback: RESTORE_SNAPSHOT_SCROLLBACK }),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	/**
	 * Plain-text lines that have scrolled above the live viewport since the previous
	 * call — the freshly "committed" part of the transcript (the volatile viewport,
	 * live input box and spinners are excluded). Callers can treat each result as an
	 * append-only delta: a per-mirror cursor advances so we scan only the newly
	 * scrolled-off rows rather than the whole ~5k-line scrollback. Wrapped continuation
	 * rows are re-joined into their logical line. Returns an empty array while the
	 * alternate screen buffer is active (full-screen TUIs), since those do not produce
	 * linear scrollback, and the cursor is left untouched across that excursion.
	 */
	async getCommittedLines(): Promise<string[]> {
		this.flushPendingOutput();
		await this.operationQueue;
		// Re-check after the await: dispose() can win the race while we yield (the
		// session closing mid-capture), and touching `terminal.buffer` afterwards
		// would register on a disposed DisposableStore.
		if (this.disposed) {
			return [];
		}
		const buffer = this.terminal.buffer.active;
		if (buffer.type !== "normal") {
			return [];
		}
		// Re-anchor one row before the cursor so a wrapped continuation row sitting at
		// the boundary rejoins the logical line already emitted last call; that
		// re-emitted line is then dropped from the delta. On the first read there is
		// nothing prior to re-anchor against, so scan from row 0 and keep everything.
		const reprocessPrev = this.committedRowCount > 0;
		const start = reprocessPrev ? this.committedRowCount - 1 : 0;
		const lines: string[] = [];
		for (let y = start; y < buffer.baseY; y += 1) {
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
		this.committedRowCount = buffer.baseY;
		return reprocessPrev ? lines.slice(1) : lines;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingChunks = [];
		this.pendingBytes = 0;
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
