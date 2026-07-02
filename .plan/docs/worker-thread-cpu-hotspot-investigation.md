# Bun Worker 线程卸载可行性调研 — 纯 CPU 热点定位

**状态**: 调研完成,**结论:当前不立项**(YAGNI)。无实测阻塞瓶颈达到需要 Worker 的量级。
**范围**: 只做调研 + 数据 + 方案文档,未改任何运行时代码,未引入 Worker 实现。
**日期**: 2026-07-02
**环境**: Bun 1.3.14,Linux。基准脚本一次性运行于本机,原始脚本见文末附录。

---

## 0. TL;DR

| 候选 | 分类 | 主线程占用(实测) | 触发频率 | Worker 净收益 | 结论 |
|---|---|---|---|---|---|
| **js-tiktoken `countTokens`** | 真·纯 CPU | 编码器首次 init **~650ms(一次性)**;压缩一趟 ~100–370ms 同步 | **仅压缩/shake 时**(非每轮) | 低—中,但代码在 vendored omp | **不上 Worker**;建议启动期预热编码器 |
| **jszip `generateAsync`** | 已协作式异步 | 单次最大阻塞 burst **~83ms**(1000 文件),已周期性让出事件循环 | 用户手动导出/下载,罕见 | 负(已让出,搬运成本 > 收益) | **不上 Worker** |
| **beautiful-mermaid 渲染** | 纯 CPU 但**零调用点** | N/A(死代码) | **从不** | N/A | **不上 Worker**;可考虑清理死代码 |
| **board 分片装配 / sharded-json** | 异步 I/O + 极短同步 parse | 装配 <1ms,单 shard parse <5ms | 每次广播(revision 缓存命中即 0) | 负 | **不上 Worker** |
| **session journal JSONL parse** | 异步 I/O + 短同步 parse | 5–80ms(万行最坏情况,后台) | 打开聊天时读一次 | 负 | **不上 Worker** |
| **xterm headless 镜像 decode/提交行** | 已微批处理 | 单次 flush burst,受 16ms/64KB 门限约束 | 高频 PTY 输出(已合批) | 负(已合批 + 串行队列) | **不上 Worker** |

**一句话**:Kanban 历史上的"100% CPU 卡死"根因都是**同步阻塞**(spawnSync(git)、per-chunk GC churn),已用 async 化 / 微批修复。本轮排查的六个候选里,唯一还在主线程上产生**真·纯 CPU 计算**的是 js-tiktoken 压缩路径,但它频率低、量级(<400ms)远低于 stall 看门狗 3s 阈值、且位于不应改动的 vendored omp 层——所以即便"真",也**不值得**上 Worker。其余要么已异步、要么已合批、要么是死代码。

---

## 1. 分类法则:同步阻塞 vs 纯 CPU 计算

### 1.1 stall 看门狗的判据(`src/server/event-loop-stall-watchdog.ts`)

看门狗本身就是一个 **Worker + SharedArrayBuffer** 的心跳观测器(这点很关键——项目里 Worker 的唯一现有用途就是它):

- **主线程**每 250ms 用 `Atomics.add` 递增共享计数器(unref 定时器)。
- **Worker 线程**每 500ms `Atomics.load` 采样;连续 `3000ms`(6 次漏采)计数器没前进 → 判定 stall,读出最后一条 `markStall` 面包屑发到 stderr。
- 纯判定逻辑:`stalled = (漏采次数 × 500ms) >= 3000ms`。

源码原话(lines 6–15):

> 主线程上的同步死循环 / 阻塞调用会把运行时冻在 100% CPU 且永不让出——所以主线程上的任何东西(定时器、信号驱动的 JS)都观测不到它。唯一可靠的观测者是第二个线程。

**法则**:看门狗**只会**因**同步阻塞**而触发。异步 I/O(fetch、`fs.readFile`)会让出事件循环,心跳定时器照常跑,计数器照常前进——异步永远不会触发看门狗。因此:

- **看门狗触发** ⇒ 去找从该面包屑可达的**同步子进程 / 同步 CPU 循环**,**不是**异步 I/O。
- 面包屑是 spin **之前**最后一次 `markStall`,不是 spin 现场;未打点的同步热点会误归因到它的调用者(这正是 task-done CPU hang 初次排查误追 board-shard 读路径的原因——那条路径是异步且有界,从不 spin)。

### 1.2 六个候选的分类结果

| 候选 | 文件 I/O | CPU 计算 | 分类 |
|---|---|---|---|
| tiktoken countTokens | 无 I/O | 同步、CPU-bound、可达数百 ms | **真·纯 CPU**(唯一) |
| jszip generateAsync | 无(内存) | 已内部分片 setTimeout 让出 | **已协作式异步**(不是纯同步) |
| mermaid 渲染 | 无 | 同步 CPU,但零调用 | **死代码** |
| board 分片装配 | `fs/promises.readFile` 异步 | JSON.parse + sort/map,<5ms | **异步 I/O + 极短同步 parse** |
| journal JSONL parse | `fs/promises.readFile` 异步 | 逐行 parse + dedup,5–80ms | **异步 I/O + 短同步 parse** |
| xterm 镜像 | 无 | 已 16ms/64KB 微批 + 串行队列 | **已合批**(同步阻塞已消除) |

**关键区分**:除 tiktoken 外,其余"CPU"候选要么 I/O 已异步(parse 只是让出间隙里一小段同步)、要么已合批/已协作式让出。它们的正解**不是** Worker,而是"保持异步/合批现状"。只有 tiktoken 是不可再拆的纯 CPU 计算——但它自身的量级和频率也不构成需要 Worker 的瓶颈(见 §3)。

---

## 2. 各候选实测数据

### 2.1 js-tiktoken(`src/agent-sdk/natives-shim.ts` → `getEncoding("o200k_base")`)

**调用点**:仅 `src/agent-sdk/compaction/{compaction.ts,shake.ts,pruning.ts,branch-summarization.ts}`。全部在 **Bun 主线程**(pi 是源码内嵌、进程内运行)。web-ui 侧**零使用**。

**触发频率(已核实,修正"每轮"的直觉)**:

- **每轮压缩*门控*不用 tiktoken**。`shouldCompact(contextTokens, …)` 里的 `contextTokens = calculateContextTokens(usage)`,`usage` 来自 `getLastAssistantUsage(entries)`——即 **provider 回报的真实 token 用量**(compaction.ts:167/196/217)。所以判断"要不要压缩"这个每轮都跑的热路径是**免费的**,不碰 js-tiktoken。
- `countTokens`/`estimateTokens` 只在**真正执行一次压缩/shake/handoff/pruning 时**跑——`findCutPoint`、`prepareCompaction`、`shake`、`pruneToolOutputs`、`branch-summarization` 内部,遍历整个 transcript 逐消息编码。这是**低频**事件(仅当上下文逼近窗口上限时)。

**实测(基准脚本 A,o200k_base,~4 字符/token)**:

```
getEncoding("o200k_base") 一次性 init: ~648 ms      ← 进程生命周期内一次(懒加载,首次 countTokens 时付)
编码吞吐 ~4.3 MB/s:
  50k 字符 (~14k tok):   ~17 ms
  200k 字符 (~55k tok):  ~63 ms
  800k 字符 (~219k tok): ~185 ms
  1.6M 字符 (~438k tok): ~368 ms
模拟一趟压缩(整 transcript 逐 2KB 消息编码):
  400k 字符 / 200 msgs:  ~92 ms 同步
  800k 字符 / 400 msgs:  ~193 ms 同步
  1.6M 字符 / 800 msgs:  ~369 ms 同步
```

**解读**:

- 一趟压缩把整段历史(接近 200k 上下文窗 ≈ 800k 字符)重编码,**~193ms 同步**阻塞主线程;超大历史 ~370ms。**远低于 stall 看门狗 3s 阈值**,不会触发看门狗,但确实会在压缩那一刻冻结事件循环 ~200ms——期间其他 workspace 的广播、其他 agent 的 turn、HTTP 请求都会等待。
- **编码器首次 init ~650ms** 是最扎眼的单点:进程内**第一次**压缩会额外吃 ~650ms 同步冻结(构建 BPE rank 表)。之后编码器单例复用,不再付。

### 2.2 jszip(`src/vault/vault-export.ts`、`src/workspace/workspace-fs-api.ts`)

**调用点**:仅两处,均 **Bun 主线程 / 用户手动触发**——Vault 导出 ZIP(`exportArchive` tRPC)、文件浏览器目录下载(`fsDownloadEntry`,目录递归有 100MB 上限)。**非每轮热路径**。web-ui 侧零使用。

**实测(基准脚本 B,generateAsync 期间用 20ms ticker 测事件循环让出情况)**:

```
per-file ~5.8KB
50 文件,  DEFLATE L6: 84 ms,  期间 ticker 跳动 3 次, 最大单次阻塞 gap ~25 ms
200 文件, DEFLATE L6: 130 ms, 跳动 6 次,  最大 gap ~26 ms
1000 文件,DEFLATE L6: 558 ms, 跳动 23 次, 最大 gap ~83 ms
1000 文件,STORE  L0: 252 ms, 跳动 11 次, 最大 gap ~26 ms  (输出 5.9MB)
```

**解读**:`generateAsync` **已经是协作式异步**——它内部用 setTimeout 分片,总耗时 558ms 期间事件循环跳动了 23 次,**单次最大阻塞仅 ~83ms**。这推翻了"base64 编码在事件循环上同步"的直觉。也就是说 jszip 已经自己让出,主线程从不被冻结整段。加上它只在用户手动导出时跑(罕见),**没有任何理由上 Worker**。

### 2.3 beautiful-mermaid(`src/agent-sdk/shared/mermaid-ascii.ts`)

**调用点**:**零**。`renderMermaidAscii` / `renderMermaidAsciiSafe` / `extractMermaidBlocks` 仅经 `shared/index.ts` re-export,`src/` 与 `web-ui/src/` 全库 grep 无任何实际调用。属 vendored omp 携带但 Kanban 未启用的能力(**死代码**)。

**结论**:频率为零,ROI 无从谈起。Worker 讨论不适用。附带建议:若确认永不启用,可清理以减小依赖面(但属 vendored omp,依 AGENTS.md 不轻动)。

### 2.4 board 分片装配 / sharded-json-store

**路径**:`src/state/task-shard-store.ts`(`loadShardedBoard`/`assembleBoard`)、`src/state/sharded-json-store.ts`(`readShardDir`)。

- **文件 I/O 全异步**:`fs/promises.readFile`,**无 `readFileSync`**;并发读经 `src/fs/concurrent-files.ts` 限流(fd 上限 48,防 EMFILE)。
- **CPU 极小**:单 shard `JSON.parse` + Zod 校验 <5ms;`assembleBoard`(sort + map + filter,150 任务)<1ms。
- **有 revision 缓存**:`loadWorkspaceBoardMemoized` 按 `(repoPath, workspaceId, meta.revision)` 缓存;多数聊天/session 广播不改 board → 命中即**零 shard 重读**。
- 瓶颈是 I/O(150 文件 ~0.48s I/O)不是 parse(<1ms),I/O 比 parse 大 ~480×。**Worker 只能搬 CPU,搬不了 I/O**,净收益为负。

### 2.5 session journal JSONL parse(`src/session/session-message-journal.ts`)

- 读取 `fs/promises.readFile` 异步;`parseTranscript` 逐行 parse + 按 id dedup,万行最坏 ~5–80ms,且在**打开聊天时读一次**(后台),非广播热路径。
- 搬运整段 transcript 到 Worker 的 structured-clone 成本 ≈ 或超过 parse 本身。净收益为负。

### 2.6 xterm headless 镜像(`src/terminal/terminal-state-mirror.ts` 等)

**已经修过、已经合批**(对应 AGENTS.md 的 "per-chunk GC churn" / "Bun busy-wait freeze" 92f07):

- `applyOutput` 按**引用**推入 `pendingChunks`(不拷贝),`pendingBytes >= 64KB` 或 16ms 定时器触发一次 `Buffer.concat` + 单次 `terminal.write`——数百 chunk 合成一次写,消除了 per-chunk malloc/GC。
- `getCommittedLines` 只读滚出可视区的**增量行**(每轮边界 ~10–50 行,不是 5000),且在 operation 队列里与写串行。
- `serialize`(重)只在**重连恢复**时跑,且 `RESTORE_SNAPSHOT_SCROLLBACK` 封顶 1000 行。
- per-chunk decode 有 `needsDecodedOutput` 门(`workspaceTrustBuffer === null` 后关闭,T4)。

同步阻塞已被合批消除;xterm 的写本身走串行 operation 队列,**上 Worker 无并行收益**,而把每 chunk 拷到 Worker 的成本远超合批已省下的量。

---

## 3. Worker 卸载的净收益评估(针对唯一的真 CPU 热点 tiktoken)

只有 tiktoken 值得认真算这笔账;其余候选已在 §2 判为负收益。

### 3.1 跨线程传输成本 vs 省下的主线程时间

- **要传的数据**:压缩一趟需把整段历史文本(~800k 字符 ≈ 0.8MB 的 UTF-16 字符串,structured-clone 下字符串是**拷贝**)postMessage 给 Worker,再传回一个 `number[]`(每消息一个计数)。0.8MB 字符串的 structured-clone 序列化 + 拷贝在 ms 级(远小于 200ms 编码),**不是**瓶颈。
- **省下的主线程时间**:~193ms(典型)/ ~370ms(超大)/ **~650ms(仅首次 init)**。
- **transfer / 零拷贝**:文本是 string,无法 transfer(只有 `ArrayBuffer` 可 transfer)。若改传 `Uint8Array` 可 transfer 零拷贝,但那要求上游先编码成字节——反而多一步。Bun 当前支持 `postMessage` 的 transferList(ArrayBuffer),但对本场景收益不明显(拷贝本就不是瓶颈)。

结论:**传输成本不是障碍,省下的主线程时间也真实存在**(尤其首次 650ms)。所以"技术上能省"成立。

### 3.2 为什么依然**不值得**上 Worker

1. **频率低**:只在压缩事件发生(上下文逼近窗口)时跑,不是每轮。一次会话可能只压缩几次。
2. **量级低于警戒线**:单次 ~200ms 同步 << stall 看门狗 3s;不构成"卡死"级问题,只是偶发 ~200ms 的其他任务延迟。项目历史上真正的 P0 都是 **秒级~无限** 的同步阻塞(spawnSync、死循环),不是几百 ms 的有界计算。
3. **代码在 vendored omp 层**:`src/agent-sdk/compaction/*` 是内嵌的 oh-my-pi,AGENTS.md 明确"vendored omp 保留自己的一套、不要合并/改动"。把 `countTokens` 改成 async-Worker 调用会侵入 omp 的同步压缩算法(`findCutPoint` 等是同步遍历),需要把整条压缩链改成 async——**改动面大、与上游漂移、维护成本高**,不符合 YAGNI。
4. **Worker API 仍实验性**:尤其 `terminate` 语义;引入 Worker 池 = 新的生命周期/错误处理/复杂度,换取一个低频、有界、非卡死级的收益,ROI 不成立。
5. **无实测用户可感瓶颈**:没有任何 stall 面包屑、卡死报告指向 tiktoken。项目 YAGNI 取向:**没有实测瓶颈就不上 Worker**。

### 3.3 更廉价的替代(如果将来真觉得那 200/650ms 碍事)

**优先于 Worker 的低成本缓解**(仍属"若将来需要",现在不做):

1. **启动期预热编码器**:在 `startServer()` 空闲阶段调一次 `countTokens("warm")`,把 ~650ms 的 init 从"首次用户压缩"挪到启动期,用户永远不感知。**零架构改动、零 Worker**,是性价比最高的一招。
2. **压缩内 per-entry 记忆化**:若 `findCutPoint` 的割点搜索对同一批 entries 重复调 `estimateTokens`(需进一步核实 omp 内部是否重复编码),在 entry 上缓存 token 数比 Worker 更省——避免重复编码胜过把重复编码搬到别的线程。但这要动 omp,同样先不做。
3. 二者都比 Worker 便宜且不引入线程复杂度。

---

## 4. 最终结论

1. **不立项 Worker**。六个候选无一构成需要 Worker 的实测瓶颈:
   - 三个(board 装配 / journal parse / xterm 镜像)已是"异步 I/O + 极短同步"或"已合批",正解是保持现状,不是 Worker。
   - jszip 已协作式异步(单次阻塞 ~83ms)且用户手动触发,Worker 净收益为负。
   - mermaid 是死代码(零调用)。
   - **唯一的真·纯 CPU 热点 tiktoken** 频率低、量级(<400ms,首次 init ~650ms)低于卡死警戒线、且在不应改动的 vendored omp 层——即便技术上能省,ROI 也不成立。
2. **符合项目历史与 YAGNI**:过去的"100% CPU 卡死"都是同步阻塞(已 async 化 / 微批修复);Worker 是给"不可拆的、高频的、秒级的纯 CPU"准备的,本代码库当前没有这种负载。
3. **可选的后续建议(非 Worker,低成本,按需再做)**:
   - **[推荐] 启动期预热 tiktoken 编码器**——把 ~650ms 一次性 init 挪出用户可感路径,零 Worker、零 omp 改动。这是本调研唯一"可能值得顺手做"的动作,且不属于本任务范围(本任务只调研)。
   - 观测:若将来 stall 面包屑指向 `compaction`/`shake`,再回来看 §3.3 的记忆化;仍未必需要 Worker。
   - 死代码 `mermaid-ascii` 可在清理 vendored omp 时一并评估(低优先)。

---

## 附录 A:基准脚本

> 一次性测量脚本,运行于 scratchpad,未写入运行时代码。复现:`bun <file>`。

### A.1 tiktoken 基准(bench-tiktoken.ts)

要点:`getEncoding("o200k_base")` 单例;测 init 一次性成本、不同尺寸文本编码耗时(中位数/5 次)、模拟一趟压缩(逐 2KB 消息编码整段历史)。见 §2.1 数据。

### A.2 jszip 基准(bench-jszip.ts)

要点:`zip.generateAsync` 期间挂一个 20ms `setInterval` ticker,统计 ticker 触发次数与最大间隔,以此判断 generateAsync 是否让出事件循环。结论:让出(见 §2.2)。

## 附录 B:关键源码坐标

- 分类法则:`src/server/event-loop-stall-watchdog.ts`(Worker + SAB 心跳,3s 阈值)
- tiktoken:`src/agent-sdk/natives-shim.ts`;调用点 `src/agent-sdk/compaction/{compaction.ts:262,318, shake.ts:107,109,207, pruning.ts:65, branch-summarization.ts:237}`;压缩门控用 provider usage 而非 tiktoken:`compaction.ts:167(calculateContextTokens)/196(getLastAssistantUsage)/217(shouldCompact)`
- jszip:`src/vault/vault-export.ts:18`、`src/workspace/workspace-fs-api.ts:892`
- mermaid(死代码):`src/agent-sdk/shared/mermaid-ascii.ts`
- board 分片:`src/state/task-shard-store.ts`、`src/state/sharded-json-store.ts`、`src/state/workspace-state.ts`(revision 缓存)、`src/fs/concurrent-files.ts`(fd 48)
- journal:`src/session/session-message-journal.ts`
- xterm 镜像:`src/terminal/terminal-state-mirror.ts`、`src/terminal/terminal-transcript-capture.ts`、`src/terminal/session-manager.ts`(per-chunk onData 门控)
