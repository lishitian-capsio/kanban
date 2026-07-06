/**
 * Request queue for throttling concurrent model API calls.
 *
 * When the page refreshes, multiple task sessions may try to start simultaneously,
 * causing a burst of API calls that triggers 503 capacity errors. This queue
 * serializes requests with minimum spacing and implements exponential backoff
 * for capacity-related errors (503, 429, 529).
 */
import { createLogger } from "../../logging";

const log = createLogger("model-request-queue");

export interface RequestQueueOptions {
	/**
	 * Minimum time in milliseconds between starting consecutive requests.
	 * Default: 1000ms (1 second spacing)
	 */
	minDelayMs?: number;

	/**
	 * Maximum delay cap in milliseconds for exponential backoff.
	 * Default: 60000ms (60 seconds)
	 */
	maxDelayMs?: number;

	/**
	 * Base delay for capacity errors (503, 429, 529) in milliseconds.
	 * Default: 10000ms (10 seconds)
	 */
	capacityBaseDelayMs?: number;

	/**
	 * Maximum number of retry attempts for failed requests.
	 * Default: 5
	 */
	maxRetries?: number;
}

interface QueuedRequest<T> {
	execute: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	attempts: number;
}

/**
 * Check if an error is a capacity-related error that should use longer backoff.
 */
export function isCapacityError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;

	const err = error as { status?: number; message?: string };
	const status = err.status;

	// Check HTTP status codes
	if (status === 503 || status === 429 || status === 529) {
		return true;
	}

	// Check error message for capacity-related keywords
	const message = err.message?.toLowerCase() ?? "";
	return (
		message.includes("capacity") ||
		message.includes("overloaded") ||
		message.includes("too many concurrent") ||
		message.includes("rate limit")
	);
}

/**
 * Calculate delay with exponential backoff. Adds jitter (±50%) for capacity
 * errors to prevent thundering herd when many clients retry simultaneously.
 */
export function calculateBackoffDelay(attempts: number, isCapacity: boolean, options: RequestQueueOptions): number {
	const baseDelay = isCapacity ? (options.capacityBaseDelayMs ?? 10000) : (options.minDelayMs ?? 1000);
	const maxDelay = options.maxDelayMs ?? 60000;

	// Exponential backoff: baseDelay * 2^attempts
	const exponentialDelay = baseDelay * Math.pow(2, attempts);
	const cappedDelay = Math.min(exponentialDelay, maxDelay);

	// Add jitter for capacity errors (0.5x to 1.5x random variation)
	if (isCapacity) {
		const jitter = 0.5 + Math.random(); // 0.5 to 1.5
		return cappedDelay * jitter;
	}

	return cappedDelay;
}

/**
 * Request queue that throttles concurrent model API calls and implements
 * exponential backoff for capacity-related errors.
 */
export class ModelRequestQueue {
	private readonly queue: Array<QueuedRequest<unknown>> = [];
	private activeCount = 0;
	private lastStartTime = 0;
	private readonly options: Required<RequestQueueOptions>;
	private processing = false;

	constructor(options: RequestQueueOptions = {}) {
		this.options = {
			minDelayMs: options.minDelayMs ?? 1000,
			maxDelayMs: options.maxDelayMs ?? 60000,
			capacityBaseDelayMs: options.capacityBaseDelayMs ?? 10000,
			maxRetries: options.maxRetries ?? 5,
		};
	}

	/**
	 * Enqueue a request and return a promise that resolves when the request completes.
	 * Requests are executed sequentially with minimum spacing between starts.
	 * Failed requests are retried with exponential backoff for capacity errors.
	 */
	enqueue<T>(execute: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const request: QueuedRequest<T> = {
				execute,
				resolve,
				reject,
				attempts: 0,
			};
			this.queue.push(request as QueuedRequest<unknown>);
			this.processNext();
		});
	}

	/**
	 * Process the next queued request if capacity allows.
	 */
	private processNext(): void {
		if (this.processing) return;
		if (this.queue.length === 0) return;
		if (this.activeCount >= 1) return; // Sequential execution

		this.processing = true;

		// Enforce minimum spacing between request starts
		const now = Date.now();
		const timeSinceLastStart = now - this.lastStartTime;
		const needsSpacing = timeSinceLastStart < this.options.minDelayMs && this.lastStartTime > 0;

		const startRequest = () => {
			const request = this.queue.shift();
			if (!request) {
				this.processing = false;
				return;
			}

			this.activeCount++;
			this.lastStartTime = Date.now();
			this.processing = false;

			// Execute request with retry logic (fire-and-forget)
			this.executeWithRetry(request);
		};

		if (needsSpacing) {
			const waitTime = this.options.minDelayMs - timeSinceLastStart;
			log.debug("model-request-queue: spacing requests", {
				waitTime,
				queueLength: this.queue.length,
			});
			setTimeout(() => {
				startRequest();
			}, waitTime);
		} else {
			startRequest();
		}
	}

	/**
	 * Execute a request with retry logic for capacity errors.
	 * Manages activeCount lifecycle: increments on entry, decrements on completion.
	 */
	private async executeWithRetry<T>(request: QueuedRequest<T>): Promise<void> {
		try {
			const result = await request.execute();
			request.resolve(result);
		} catch (error) {
			request.attempts++;

			// Check if we should retry
			if (request.attempts > this.options.maxRetries) {
				log.warn("model-request-queue: max retries exceeded", {
					attempts: request.attempts,
				});
				request.reject(error);
			} else {
				const isCapacity = isCapacityError(error);
				const delay = calculateBackoffDelay(request.attempts - 1, isCapacity, this.options);

				log.warn("model-request-queue: request failed, retrying", {
					attempt: request.attempts,
					isCapacity,
					delayMs: Math.round(delay),
					error: error instanceof Error ? error.message : String(error),
				});

				// Wait before retrying
				await new Promise<void>((resolve) => setTimeout(resolve, delay));

				// Re-queue at front for immediate retry (after delay)
				this.queue.unshift(request as QueuedRequest<unknown>);
			}
		} finally {
			this.activeCount--;
			this.processNext();
		}
	}

	/**
	 * Get current queue statistics.
	 */
	getStats(): { queueLength: number; activeCount: number } {
		return {
			queueLength: this.queue.length,
			activeCount: this.activeCount,
		};
	}

	/**
	 * Clear all queued requests (does not cancel active requests).
	 */
	clear(): void {
		const pending = this.queue.splice(0);
		for (const request of pending) {
			request.reject(new Error("Request queue cleared"));
		}
	}
}

// Global singleton queue for model API requests
let globalQueue: ModelRequestQueue | null = null;

/**
 * Get or create the global model request queue.
 */
export function getModelRequestQueue(options?: RequestQueueOptions): ModelRequestQueue {
	if (!globalQueue) {
		globalQueue = new ModelRequestQueue(options);
	}
	return globalQueue;
}

/**
 * Execute a function through the global request queue.
 * Throttles concurrent requests and retries capacity errors with backoff.
 */
export function enqueueModelRequest<T>(execute: () => Promise<T>): Promise<T> {
	return getModelRequestQueue().enqueue(execute);
}
