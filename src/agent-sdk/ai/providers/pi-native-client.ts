/**
 * Pi-native client stub — excluded from embedded source.
 *
 * The full pi-native provider connects to the omp local server for
 * native model access. This stub throws when called.
 */
import type { Context, Model } from "../types";

export function streamPiNative(
	_model: Model,
	_context: Context,
	_options?: Record<string, unknown>,
): AsyncIterable<never> {
	throw new Error("pi-native provider is not available in embedded mode. Use a remote provider instead.");
}
