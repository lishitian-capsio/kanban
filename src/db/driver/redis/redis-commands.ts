import { DbQueryError } from "../../errors";

/** Read-only Redis commands the policy + driver allow. Everything else is refused (fail closed). */
export const READ_ONLY_REDIS_COMMANDS: ReadonlySet<string> = new Set([
	"GET", "GETRANGE", "STRLEN", "SUBSTR", "MGET", "EXISTS", "TYPE", "TTL", "PTTL",
	"EXPIRETIME", "PEXPIRETIME", "OBJECT", "DUMP",
	"HGET", "HGETALL", "HMGET", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN", "HSTRLEN", "HRANDFIELD",
	"LRANGE", "LLEN", "LINDEX", "LPOS",
	"SMEMBERS", "SISMEMBER", "SMISMEMBER", "SCARD", "SSCAN", "SRANDMEMBER", "SINTERCARD",
	"ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZCARD", "ZCOUNT",
	"ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK", "ZSCAN", "ZLEXCOUNT",
	"SCAN", "KEYS", "DBSIZE", "RANDOMKEY", "MEMORY",
	"XLEN", "XRANGE", "XREVRANGE", "XINFO",
	"PING", "INFO",
	"GEOPOS", "GEODIST", "GEOSEARCH", "BITCOUNT", "GETBIT",
]);

export function isReadOnlyRedisCommand(command: string): boolean {
	return READ_ONLY_REDIS_COMMANDS.has(command.trim().toUpperCase());
}

/**
 * Parse one Redis command line into `{ command, args }`. Supports bare tokens and
 * double-quoted tokens (so a key/value containing spaces can be passed). Throws
 * {@link DbQueryError} on an empty line. Not a full RESP parser — good enough for the
 * read-only command surface a human types.
 */
export function parseRedisCommandLine(line: string): { command: string; args: string[] } {
	const tokens: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(line)) !== null) {
		tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] as string));
	}
	if (tokens.length === 0) {
		throw new DbQueryError("empty redis command");
	}
	const [command, ...args] = tokens as [string, ...string[]];
	return { command: command.toUpperCase(), args };
}
