/**
 * Pure priority resolution for the remote-access passcode.
 *
 * The single source of truth for the precedence rule:
 *   explicit (`--passcode` / `KANBAN_PASSCODE`) > persisted (reused on restart) > freshly generated.
 *
 * Kept free of I/O so it is exhaustively unit-testable; the disk read/write
 * and in-memory wiring live in {@link ../security/passcode-store}.
 */

export type PasscodeSource = "explicit" | "persisted" | "generated";

export interface ResolvePasscodeInput {
	/** Passcode the operator pinned via `--passcode` or `KANBAN_PASSCODE`. `null`/blank ⇒ none. */
	explicit: string | null;
	/** Passcode previously written to disk, reused across restarts. `null`/blank ⇒ none. */
	persisted: string | null;
	/** Fresh random generator, invoked only when neither explicit nor persisted is present. */
	generate: () => string;
}

export interface ResolvedPasscode {
	value: string;
	source: PasscodeSource;
}

/** Normalize a candidate passcode: trim, and treat empty/whitespace as absent. */
function normalize(value: string | null): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the effective passcode by precedence: explicit > persisted > generated.
 * The returned `value` is trimmed; `source` reports which input won.
 */
export function resolvePasscode(input: ResolvePasscodeInput): ResolvedPasscode {
	const explicit = normalize(input.explicit);
	if (explicit !== null) {
		return { value: explicit, source: "explicit" };
	}
	const persisted = normalize(input.persisted);
	if (persisted !== null) {
		return { value: persisted, source: "persisted" };
	}
	return { value: input.generate(), source: "generated" };
}
