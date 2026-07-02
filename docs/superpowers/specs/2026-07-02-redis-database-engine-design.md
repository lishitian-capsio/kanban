# Redis 引擎(只读浏览)设计 — Database 功能

**日期**: 2026-07-02
**状态**: 待评审
**范围**: 给 Kanban 的 Database 功能新增 `redis` 引擎,基于 Bun 原生 `Bun.redis`(`import { RedisClient } from "bun"`),**严格只读**浏览。

---

## 1. 目标与非目标

**目标**
- 用户配置 Redis 连接(`redis://` / `rediss://` / `unix://`),在 Database 视图 + `kanban db` CLI + tRPC 中只读浏览 keyspace。
- keyspace 按 **key 前缀**映射为"表",value 按 Redis 类型渲染。
- 严格只读:只放行只读命令,写命令一律拒绝(三层防御)。
- 复用现有 `DatabaseDriver` 契约、access gate、pool、超时/并发/字节上限、错误映射。
- vitest(Node)全绿:`Bun.redis` 不可用时注入 fake;真实连接走 `bun test`。

**非目标(YAGNI,本期不做)**
- 任何写命令 / inline editing / row 编辑(Redis 连接强制只读,不接 update/insert/delete row 路径)。
- pub/sub、事务、Lua、cluster 拓扑浏览、多节点。
- stream(`XRANGE`)全量浏览 —— 仅显示 `XLEN` 作为预览。
- 完整命令解析器 —— 命令分类用**只读命令白名单**,而非语法树。

---

## 2. Redis → `DatabaseDriver` 契约映射

Redis 是 KV,契约是 `schemas → tables → tableDetail → browse rows` + `query`。映射如下:

| 契约概念 | Redis 映射 |
|---|---|
| **schema**(命名空间) | **逻辑库** `db0`…`dbN`。N 来自 `CONFIG GET databases`;被禁用/cluster 时回退单个 `db0`(连接串选中的库)。 |
| **table**(schema 内的表) | **key 前缀命名空间**:key 第一个 `:` 之前的段(`user:1` → `user`)。无 `:` 的裸 key 归到合成表 `(root)`。 |
| **tableDetail 的 columns** | 固定合成 4 列:`key`(**isPrimaryKey=true**)、`type`、`ttl`、`value`。无 index / 无 FK。 |
| **browse 一张表的 rows** | `SCAN MATCH <prefix>:* COUNT n`(TYPE=`(root)` 时 `MATCH *` 且过滤掉带 `:` 的 key);每个 key 取 `TYPE`/`TTL`/**有界 value 预览**,一行 = `{key,type,ttl,value}`。SCAN 游标编进分页 cursor。 |
| **query**(原始语句) | `request.sql` 承载一条 **Redis 命令行**(`HGETALL user:1`),而非 SQL。driver 解析 `command+args`,校验只读白名单,`RedisClient.send()` 执行,reply 按运行时类型 shape 成 rows。 |
| **testConnection** | `PING` + `INFO server` 解析 `redis_version` 作为 `serverVersion`。 |
| **metadataSignature** | 返回 `""`(同 remote 引擎):无廉价 schema 变更探针,缓存靠进程内 mutation 代际(Redis 只读,几乎不失效)。 |

### 契约适配点清单(需要改动的接缝)

- **A. 引擎枚举**:`DatabaseEngine`(types.ts)、`databaseEngineSchema`(connection-record.ts)、`runtimeDbEngineSchema`(api-contract.ts)、web-ui `RuntimeDbEngine` 均加 `"redis"`。
- **B. ConnectionConfig 复用**:host/port/user(ACL user,Redis6+)/password/database(库序号字符串)/ssl.mode(`rediss` 时非 disable)/filePath(→ `unix://` socket 路径)。**不新增字段**,由 driver 组装连接 URL。
- **C. 分类(policy)**:`classifySql` 增加 redis 分支 —— 取首 token,查**只读命令白名单**;命中→`read`,否则→`write`(fail closed,被 policy 拦截)。不走 node-sql-parser。
- **D. 有界化**:`buildBoundedQuery` 对 redis **不包 LIMIT**(`wrapped:false`)—— Redis 读命令自带边界(SCAN COUNT、LRANGE/ZRANGE 区间)。driver 内部再夹一层硬上限;executor 的行/字节后置上限仍作为兜底。
- **E. 引擎原生游标**:`QueryResult` 增加可选 `scanCursor?: string`。Redis SCAN 回填;SQL driver 不设(保持现状)。executor 的 redis browse 分支用它算 `nextCursor`(`"0"` = done),不用"多取一行"探测法。
- **F. 能力接口 `KeyspaceBrowser`**:driver 可选实现 `browseKeyspace(...)`(只有 Redis 实现)。`DatabaseService` 加 `browseKeyspace()` 代理(policy 恒 read-only,所有 caller 放行,同 SQL browse);`QueryExecutor.browseTable` 按 `engine==="redis"` 分派到它,公开签名不变。

---

## 3. 架构与新增文件

```
src/db/driver/redis/
  redis-client.ts     RedisClientLike 接口 + defaultRedisClientFactory(懒引用 Bun 全局,模块可在 Node 导入)
  redis-driver.ts     RedisDriver implements DatabaseDriver, KeyspaceBrowser
  redis-commands.ts    只读命令白名单 + parseCommandLine(纯函数,单测)
  redis-reply-shaper.ts reply(any)→{rows,fields}(纯函数,单测)
  register.ts          registerDriver("redis", …)(副作用)
src/db/driver/driver.ts        + KeyspaceBrowser 接口 + isKeyspaceBrowser 守卫
src/db/types.ts                + "redis";QueryResult.scanCursor?
src/db/policy/sql-classifier.ts + classifyRedisCommand 分支
src/db/execution/query-bounds.ts + redis 跳过 LIMIT
src/db/execution/query-executor.ts + browseTable 的 redis 分派
src/db/db-service.ts           + browseKeyspace()
src/db/index.ts                + import "./driver/redis/register"
```

**连接 URL 组装**(driver 内,`buildRedisUrl(config)`):
- `filePath` 存在 → `redis+unix://<filePath>`(TLS N/A)。
- 否则 scheme = `ssl.mode !== "disable"` ? `rediss` : `redis`;拼 `[user:password@]host:port/db`。
- TLS 校验:`RedisOptions.tls` 按 `ssl.mode` 映射 `rejectUnauthorized`(verify-* → true),`caPath`/PEM 复用现有 SSL 字段(与 bun-sql `buildRemoteSqlOptions` 同款处理)。

**统一走 `send(command, args: string[])`**:driver 的所有操作(SCAN/TYPE/TTL/GET/HGETALL/LRANGE/SMEMBERS/ZRANGE/XLEN/INFO/CONFIG/DBSIZE/PING)都经 `send`,好处:(1) reply shaper 一条路径;(2) 测试 fake 只需实现 `send`。选库用 `send("SELECT", [n])`(连接级有状态,browse/query 前显式 SELECT 目标库)。

---

## 4. 只读强制(要求 3)—— 三层防御

1. **policy 分类白名单**(`redis-commands.ts` `READ_ONLY_COMMANDS`):`GET GETRANGE STRLEN MGET EXISTS TYPE TTL PTTL EXPIRETIME OBJECT HGET HGETALL HMGET HKEYS HVALS HLEN HEXISTS HSCAN HSTRLEN LRANGE LLEN LINDEX SMEMBERS SISMEMBER SCARD SSCAN SRANDMEMBER ZRANGE ZRANGEBYSCORE ZCARD ZSCORE ZRANK ZREVRANGE ZSCAN SCAN KEYS DBSIZE RANDOMKEY MEMORY XLEN XRANGE XREVRANGE PING INFO DBSIZE`。命中→`read`;否则→`write`,被 `assertOperationAllowed` 拦(non-read 只有 human+allowWrites 放行,而 Redis 连接 allowWrites 恒 false → 一律拒)。
2. **driver 内白名单校验**:`query()` 执行前再查一次白名单,非只读命令抛 `DbPolicyError`(防绕过 policy 的调用路径)。`SELECT`/`SCAN` 等内部命令由 driver 自己发,不经此校验。
3. **连接强制只读**:Redis 连接 `allowWrites` 在后端强制视为 `false`(UI 不显示 allow-writes 勾选;后端 upsert 时若 engine=redis 则 `allowWrites=false`)。无 Redis 写路径(不接 row 编辑构造器)。
- access gate(`resolveDbWorkspace` / `database_access_disabled`)**不变**,继续对 CLI/agent 生效。

> Redis 无 SQL 的"只读事务会话"模式(不像 PG `BEGIN READ ONLY`),因此**白名单即强制机制** —— 需在文档中写明。

---

## 5. reply → rows shaping(value 按类型)

`send()` 返回 `any`,shaper 按 **JS 运行时类型**归一(通用,免逐命令):
- `null` → 0 行。
- 标量(string/number)→ 1 行 `{value}`,field `value`。
- 扁平数组 `[a,b,c]` → 行 `{index,value}`。
- 数组对(HGETALL/ZRANGE WITHSCORES 在 RESP2 是 `[k,v,k,v]`)→ 命令感知:HGETALL/HMGET → `{field,value}`;ZRANGE WITHSCORES → `{member,score}`。
- 对象(RESP3 map,如 HGETALL)→ 行 `{field,value}`。
- 嵌套 → 每元素 `JSON.stringify`。

**browse 的 value 预览**(driver 按 TYPE,全部有界):
| type | 预览命令 | 上限 |
|---|---|---|
| string | `GET`(截断 N 字节) | valuePreviewBytes |
| hash | `HGETALL` 取前 K 字段 | K 字段 |
| list | `LRANGE 0 K-1` | K 元素 |
| set | `SSCAN`/`SMEMBERS` 前 K | K 元素 |
| zset | `ZRANGE 0 K-1 WITHSCORES` | K 元素 |
| stream | `XLEN`(仅长度) | — |

预览渲染成紧凑字符串(JSON),放 `value` 列;超限追加 `…(+more)` 标记。

---

## 6. 连接生命周期 / 超时 / 错误映射(对齐现有 driver)

- **connect/disconnect**:`connect()` 懒建 `RedisClient` 并 `await connect()`;失败包 `DbConnectionError`(同 bun-sql)。`disconnect()` `close()`。幂等。
- **超时**:Redis(`send`)是异步,executor 的 `runWithDeadline` + `onAbandon`(`service.invalidate` 拆连接)照常生效。`QueryRequest.timeoutMs` 的**服务端**语义 Redis 无对应(不像 PG `statement_timeout`)→ driver 忽略它,仅靠进程内 deadline + 拆连接(同 SQLite 的处理:无法服务端取消)。
- **并发/行上限/字节上限**:全部走 executor,不变。
- **错误映射**:driver 抛 `DbConnectionError`/`DbQueryError`/`DbPolicyError`;`normalizeQueryError` 与 tRPC `toTrpcError` 已覆盖,无需新错误类型。

---

## 7. 打通三个 surface(要求 4)

- **tRPC**:`db-api.ts`(CLI 通道,caller=`cli`)与 `workspace-db-api.ts`(human UI,caller=`human`)天然多态 —— 只要 driver 注册 + 引擎枚举放开即可。human UI 的 `browseTable` 走 `buildBrowseQuery`(SQL)→ 对 redis 需改为:engine=redis 时不建 SQL,而调 `executor.browseTable`(内部分派到 `browseKeyspace`)。`introspect`(eager)对 redis 返回合成表列表(前缀→表,列=4 固定列)。
- **CLI `kanban db`**:`--engine` 增加 `redis`;`VALID_ENGINES` 加 `redis`。`db tables`/`db describe`/`db browse`/`db query` 直接复用(browse 走 keyspace 分派,query 传 Redis 命令行)。`--host/--port` 语义不变(Redis host/port)。
- **Database 视图 UI**:`connection-dialog.tsx` `ENGINE_LABELS` + `DEFAULT_PORT`(redis=6379)加 redis;redis 表单字段 = host/port/user/password/db(database 字段复用为库序号)+ TLS(rediss);**隐藏 allow-writes 勾选**(Redis 恒只读)。sidebar 引擎图标/标签加 redis。value 列渲染复用现有 cell 渲染(字符串)。

---

## 8. 测试(要求 5)

- **纯函数单测(vitest)**:`redis-commands`(白名单/parse)、`redis-reply-shaper`(各 reply 形状)、`buildRedisUrl`、classifier 的 redis 分支、query-bounds 的 redis 跳过。
- **driver 单测(vitest,注入 fake)**:`RedisDriver` 全流程用 fake `RedisClientLike`(仅实现 `send`,按命令返回桩数据)覆盖 connect/testConnection/listSchemas/listTables(前缀去重)/describeTable/browseKeyspace(SCAN 游标分页)/query(只读校验 + shape)。**模块导入零副作用、不碰 Bun**(工厂懒引用 Bun 全局,同 bun-sql)。
- **executor/service 集成(vitest)**:`browseTable` 对 redis 分派到 `browseKeyspace`;policy 拦截写命令。
- **真实连接(`bun test`,可选)**:`redis-driver.bun.test.ts`,`REDIS_TEST_URL` 存在才连,否则 skip。
- CI 注意:沿用 `--exclude='**/.kanban/**'`;不引入 Node 下会失败的顶层 `import from "bun"`。

---

## 9. 文档更新(要求 6)

- `AGENTS.md`:加一条 tribal-knowledge —— Redis 引擎的白名单即只读强制、send-only 统一路径 + fake 接缝、前缀→表映射、scanCursor 契约扩展、Redis 连接恒只读。
- Database 相关用户/CLI 文档(`.plan/docs/` 下 DB 文档 + `kanban db` help / `db query` 帮助文案)补 redis 引擎与"命令行即 query"的说明。

---

## 10. 主要风险 / 权衡

- **前缀表列表要扫一遍库**:`listTables` 的 SCAN 去重前缀在大库上是 O(keys)。缓解:硬上限(最多扫 M 个 key / X 次迭代),超限记 log 并返回已见前缀(契约在此级无 truncation 标记,靠日志)。走 `IntrospectionCache` 复用。
- **RESP2/RESP3 reply 形状差异**:shaper 同时处理数组对与对象两种 HGETALL 形状。
- **`SELECT` 有状态**:pool 复用同一 client 时,browse/query 前显式 `SELECT` 目标库,避免串库。
- **契约扩展 `scanCursor` + `KeyspaceBrowser`**:均为**可选、加性**,SQL 引擎不受影响,是引入 KV 引擎的最小契约代价。
