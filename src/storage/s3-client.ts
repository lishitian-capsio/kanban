import type { S3ListObjectsOptions, S3ListObjectsResponse, S3Stats } from "bun";

import type { ResolvedS3ClientOptions } from "./storage-connection-store";

/** The minimal `Bun.S3Client` surface this subsystem uses — lets tests inject a fake under vitest. */
export interface S3ClientLike {
	list(input: S3ListObjectsOptions): Promise<S3ListObjectsResponse>;
	stat(key: string): Promise<S3Stats>;
	/** Read at most `maxBytes` of an object via an HTTP Range slice (never downloads more than the cap). */
	readBytes(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; contentType: string }>;
}

export type S3ClientFactory = (opts: ResolvedS3ClientOptions) => S3ClientLike;

/**
 * Default factory: the real Bun-native S3 client. `Bun.S3Client` is referenced LAZILY via the `Bun`
 * global so this module stays importable under Node/vitest, where tests inject a fake and never
 * invoke it. A static `import { S3Client } from "bun"` would fail to resolve on Node.
 */
export const defaultS3ClientFactory: S3ClientFactory = (opts) => {
	const client = new Bun.S3Client({
		bucket: opts.bucket,
		endpoint: opts.endpoint,
		region: opts.region,
		virtualHostedStyle: opts.virtualHostedStyle,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		sessionToken: opts.sessionToken,
	});
	return {
		list: (input) => client.list(input),
		stat: (key) => client.stat(key),
		async readBytes(key, maxBytes) {
			const file = client.file(key);
			// slice(0, maxBytes+1): the extra byte tells us whether the object exceeds the cap.
			const probe = file.slice(0, maxBytes + 1);
			const buf = await probe.arrayBuffer();
			const all = new Uint8Array(buf);
			const truncated = all.byteLength > maxBytes;
			const bytes = truncated ? all.subarray(0, maxBytes) : all;
			return { bytes, truncated, contentType: file.type };
		},
	};
};
