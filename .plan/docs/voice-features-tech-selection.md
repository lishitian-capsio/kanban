# Kanban 语音功能技术选型建议

> 调研性文档,不含实现代码。目标:为后续"语音输入(STT)"与"语音指令控制看板"两个实现任务提供方案对比、推荐与分阶段落地路径。
> 日期:2026-06-27

---

## 0. 一句话结论(TL;DR)

- **STT 路线:直接走云端/本地 STT 单轨(Whisper 类),不做原生兜底。** 前端 `MediaRecorder` 录音 → runtime 新增 `transcribe` 代理 endpoint → 经统一代理转发云端 STT(或自托管 whisper.cpp/faster-whisper)。理由见 §2.3:浏览器原生 Web Speech API 的中文质量参差、Firefox 不支持、音频被浏览器私自上传第三方(不经我们的统一代理),与本项目对中文质量、隐私可控、内网可部署的要求不符,因此**不作为兜底**。
- **交互形态:Push-to-talk(按住说话)优先。** 不做常驻监听/唤醒词。转写文字落到输入框**默认需二次确认再发送**(填入草稿,不自动发),复用 composer 现成的 `appendToDraft`。
- **"语音指令控制看板":不需要独立意图解析。** 本工作区侧边栏 agent 已能把自然语言翻译成 Kanban CLI 调用,STT 把语音转成文字填入输入框后,绝大部分"语音指令"直接复用现有 agent 通路。额外要做的只是 **UX(一个可选的"命令模式"措辞提示 + 确认流)**,不是新的 NLU 引擎。
- **TTS(语音播报):先记录为扩展点,本期不做。** 见 §6。

落地集成面非常小:语音输入按钮只需挂在**一个组件** `KanbanChatComposer` 上,home 侧边栏与任务详情两个面板自动同时获得能力。

---

## 1. 现状盘点(集成点已摸清)

### 1.1 前端:聊天输入是单一共享组件

| 组件 | 路径 | 作用 |
|------|------|------|
| `KanbanChatComposer` | `web-ui/src/components/detail-panels/kanban-chat-composer.tsx` | **唯一输入框组件**:受控 `textarea`(`draft` + `onDraftChange`),Enter / 点击按钮发送 |
| `KanbanAgentChatPanel` | `web-ui/src/components/detail-panels/kanban-agent-chat-panel.tsx` | 容器层,暴露 imperative handle:`appendToDraft(text)`(填入草稿)/ `sendText(text)`(直发) |
| `HomeSidebarAgentPanel` | `web-ui/src/components/home-agent/home-sidebar-agent-panel.tsx` | 侧边栏 home chat,用 `KanbanAgentChatPanel` |
| `CardDetailView` | `web-ui/src/components/card-detail-view.tsx` | 任务聊天,用同一个 `KanbanAgentChatPanel` |

**关键事实(决定了集成成本极低):**
- composer 是**受控 textarea**,`value={draft}`、`onChange → onDraftChange`。把转写文字塞进去 = 调一次 `appendToDraft(text)`,无需触碰底层 DOM。
- 发送有明确触发点(Enter 或发送按钮),`canSubmit` 要求 `draft.trim()` 非空。**这意味着"转写→草稿→人工确认→发送"是天然支持的**,不需要为二次确认额外造轮子。
- 两个面板共用 composer,**麦克风按钮挂一处(composer 的 model/send 按钮行)即可覆盖全部聊天入口**。

### 1.2 后端:tRPC + 统一代理已就绪(若走云端 STT)

| 关注点 | 结论 | 位置 |
|--------|------|------|
| 新增 endpoint | schema(`api-contract.ts`)→ 实现(`runtime-api.ts`)→ 路由(`app-router.ts`),三处即可加一个 `transcribe` procedure | `src/trpc/` |
| 二进制上传范式 | 已有 `addFile`:音频走 **base64 字符串**入参,后端 `Buffer.from(data,"base64")`,可直接照搬 | `app-router.ts` / `workspace-api.ts` `addFile` |
| 出站请求走代理 | runtime 的 `globalThis.fetch` 已被 monkey-patch,**普通 `fetch(sttUrl)` 自动经统一代理**,无需手动接线(除非显式传 `dispatcher`/`proxy`) | `src/config/proxy-fetch.ts` |
| 密钥管理范式 | 机器本地 0600 文件(参考 `github-auth.json` / `passcode.json`),**绝不写入 `<repo>/.kanban`、绝不提交** | `~/.kanban/settings/` 约定 |
| 消息通路 | `sendTaskChatMessage`(taskId/text/mode/providerId/images)→ agent;广播走 `task_chat_message` ws | `runtime-api.ts` / `runtime-state-hub.ts` |

**结论:** 云端 STT 后端代理在本架构里是"熟路"——上传范式、代理出站、密钥落盘约定全部已有先例,新增面很小。

---

## 2. STT 路线对比

### 2.1 方案 A:浏览器原生 Web Speech API(`SpeechRecognition`)

纯前端,调用浏览器内置语音识别(Chrome/Edge 走 Google 云端识别,Safari 走 Apple)。

| 维度 | 评价 |
|------|------|
| 集成成本 | **极低**。纯 web-ui,无 runtime 改动、无 tRPC、无密钥。一个 hook + composer 上一个按钮。 |
| 成本 | **零**(无 API 计费)。 |
| 中文支持 | **参差**。Chrome/Edge 的 `lang="zh-CN"` 实际效果尚可(底层是 Google 识别),但**不可控、无标点/术语定制**,质量随浏览器与版本波动。 |
| 离线 | **基本不可用**。Chrome/Edge 需联网(音频上传到 Google);Safari 部分场景可本地,但不保证。 |
| 隐私 | **差到中**。Chrome/Edge 把音频发到 Google,**不经过 Kanban 的统一代理,也不受我们控制**。对隐私敏感/内网部署是硬伤。 |
| 兼容性 | Chrome/Edge ✅;Safari 部分(带前缀 `webkitSpeechRecognition`);**Firefox ❌**。需特性检测 + 优雅降级(无则隐藏按钮)。 |
| 可控性 | 低。无法换模型、无法做术语/热词、错误信息含糊。 |

**适合:** 快速出 MVP、个人/本地使用、对中文质量要求不极致的场景。

### 2.2 方案 B:云端 / 模型 STT API(Whisper 类 或各家 STT)

前端录音(`MediaRecorder` 取音频 blob)→ base64 上传到 runtime 新 endpoint → 后端经统一代理转发给 STT API → 返回文本。

| 维度 | 评价 |
|------|------|
| 集成成本 | **中**。需:前端录音 + 上传;runtime 一个 `transcribe` procedure;密钥落盘;错误映射。但每一步本仓库都有现成范式(见 §1.2),非从零。 |
| 成本 | 有 API 计费(Whisper API 约 \$0.006/分钟量级;自托管 whisper.cpp/faster-whisper 则零边际成本但需运维)。 |
| 中文支持 | **好**。Whisper large/各家中文 STT 中文识别与标点显著优于浏览器原生,且可控(可加 prompt/热词偏置)。 |
| 离线 | 取决于后端:云 API 需联网;**自托管 whisper.cpp 可完全离线/内网**——这是对隐私部署的关键卖点。 |
| 隐私 | **可控**。音频经 Kanban 统一代理出站,或自托管不出网。符合本项目"密钥机器本地、出站统一代理"的既有姿态。 |
| 兼容性 | **好**。`MediaRecorder` 跨浏览器一致(含 Firefox),不依赖 `SpeechRecognition`。 |
| 可控性 | **高**。可选模型(云 vs 本地)、可加领域热词、统一错误处理(复用 `model-discovery.ts` 那种错误分类范式)。 |

**适合:** 中文为主、对识别质量有要求、隐私/内网部署、需要可控与可演进。

### 2.3 推荐:云端/本地 STT 单轨(方案 B),不做原生兜底

**不采用 Web Speech API 作为兜底**,直接做云端/本地 STT。理由:
1. **中文质量是硬需求**——原生引擎中文识别参差、不可控(无标点/热词定制、随浏览器版本波动),云端/本地 Whisper 显著更好且可调。
2. **隐私可控是本项目一贯姿态**——原生引擎(Chrome/Edge)把音频私自发给 Google,**不经 Kanban 统一代理、无法控制**;方案 B 音频经统一代理出站或自托管不出网,符合"密钥机器本地、出站统一代理"的既有约定。
3. **兼容性更一致**——`MediaRecorder` 跨浏览器(含 Firefox)一致,不必为原生引擎做特性检测/降级分支。
4. **本项目后端范式都现成**(base64 上传、`globalThis.fetch` 自动走代理、密钥 0600 落盘),云端 STT 不是从零,集成成本可控。

> 引擎抽象仍保留可插拔:`transcribe` 后端可在"云端 API"与"自托管 whisper.cpp/faster-whisper"之间切换(满足内网离线),前端只关心"拿到文本"。但**默认即云端/本地 Whisper,不含原生引擎这一档**。
>
> 取舍代价:相比原生方案,第一版就需要 runtime 改动 + 密钥配置(无法"几天纯前端上线")。这是为换取中文质量与隐私可控而接受的前置成本。

---

## 3. 交互形态选型

### 3.1 Push-to-talk vs 常驻监听/唤醒词 → 选 Push-to-talk

| | Push-to-talk(按住/点按说话) | 常驻监听 + 唤醒词 |
|---|---|---|
| 实现复杂度 | 低 | 高(需 VAD 静音检测、唤醒词模型、长连音频流) |
| 隐私 | 好(用户主动触发才录音) | 差(麦克风长开) |
| 误触发 | 无 | 多(开发环境嘈杂、多人) |
| 契合 Kanban | ✅ 桌面/IDE 场景,手在键鼠上,按一下说话很自然 | ❌ 过度设计 |

**推荐:Push-to-talk。** 具体:点按麦克风按钮开始录音 → 再点一次(或松开)结束 → 转写。按钮挂在 `KanbanChatComposer` 的按钮行(model selector / send 同排)。录音中给明确视觉反馈(波形/计时/红点)。

**不做**唤醒词/常驻监听——成本高、隐私差、与本项目场景不符,且 §4 的"语音指令"也不依赖它。

### 3.2 转写后是否二次确认 → 默认需要确认(填草稿,不自动发)

**推荐:转写文本 → `appendToDraft()` 填入输入框,光标停在文本后,由用户 Enter/点发送。**

理由:
- STT(尤其原生引擎)会出错,**直发等于把错误指令直接喂给会执行 CLI 的 agent**,风险不对称(见 §4 风险)。
- composer 本就要求人工触发发送,顺势而为,零额外成本。
- 可提供一个设置项"转写后自动发送"给追求效率的用户,但**默认关闭**。

---

## 4. "语音指令控制看板"的实现路径

### 4.1 核心判断:复用现有 agent 通路,不造独立 NLU

本工作区的侧边栏 home agent **已经能把自然语言意图翻译成 Kanban CLI 调用**(创建任务、移动卡片、改 owner 等都已是 agent 能做的事)。因此:

> **STT 把语音转成文字 → 填入输入框 → 走现有 `sendTaskChatMessage` → agent 解析并执行 CLI。语音指令 = 语音输入 + 现有 agent。无需独立意图解析层。**

这是本方案最省的地方:"语音控制看板"几乎是"语音输入"的免费副产品。

### 4.2 真正需要补的是 UX,不是 NLU

1. **命令模式 vs 聊天模式(措辞,非引擎):**
   - 不需要两套解析。可在 home agent 的系统提示里已有的"自然语言→CLI"能力上,**不做特殊区分**——用户说"把登录 bug 那张卡移到 review",agent 自然会调对应 CLI。
   - 可选轻量增强:一个"命令模式"开关,仅改变**提交前的提示文案/确认强度**(命令模式下对"执行类"意图要求一次确认),底层仍是同一 agent。

2. **确认流(关键安全点):**
   - 语音转写不稳定 + agent 会执行**有副作用的 CLI**(移卡、改状态、甚至建/删任务),所以**执行类指令应有确认**。
   - 推荐复用 §3.2 的"填草稿不自动发"作为第一道确认;若未来做自动发,则 agent 侧对破坏性操作应回一句"确认要 X 吗"再执行。
   - 参考既有姿态:本项目对"难以撤销/对外"的动作一贯要求确认,语音指令同理。

3. **反馈:** 指令执行后,现有 ws `task_chat_message` 广播已能把 agent 的回应/结果显示在聊天里,无需新通道。

### 4.3 何时才需要独立意图解析?

仅当出现以下需求才考虑(**本期不做,记录为未来分支**):
- 想要**不经过 LLM agent**的纯本地、低延迟、确定性命令(如"下一张卡""刷新")——这类高频导航类指令可做一个极小的本地规则匹配,绕过 agent 往返。但收益有限,优先级低。

---

## 5. 分阶段落地步骤

### 阶段 1 — 后端 STT 代理 endpoint
1. `api-contract.ts` 加 `transcribe` 请求/响应 schema(`audioData: base64`, `mime`, `lang?` → `{ text }`)。
2. `runtime-api.ts` 实现 `transcribe`:`globalThis.fetch` 调 STT API(自动走统一代理),并支持指向自托管 whisper.cpp/faster-whisper 以满足内网离线。
3. STT 密钥/endpoint 配置按 `github-auth.json` 范式落机器本地 0600 文件,绝不入 repo、绝不进 `--json`/日志。
4. 错误分类参考 `model-discovery.ts`(把 Bun 的 `ECONNREFUSED` 等映射成可读错误)。
5. 限制单次录音/音频时长(如 ≤60s),控制 base64 体积与内存。

### 阶段 2 — 前端语音输入(push-to-talk + 录音上传)
1. 新增 `useVoiceInput` hook:`MediaRecorder` 录音(push-to-talk),结束后 base64 上传调 `transcribe`,`lang` 默认 `zh-CN` 可配。
2. 在 `KanbanChatComposer` 按钮行加麦克风按钮 + 录音中视觉反馈(波形/计时/红点)。
3. 转写结果 → `appendToDraft()`,**默认不自动发**(人工确认)。
4. 处理麦克风权限失败(尤其 LAN 明文 HTTP 下 secure context 限制,见 §7)。
5. 产出:home + task 两个面板同时可用语音输入(挂一处 composer)。

### 阶段 3 — 语音指令 UX 打磨(复用 agent,无新 NLU)
1. 验证现有 home agent 对常见看板口语指令的翻译质量,按需补系统提示示例。
2. 加"执行类指令确认"流(默认填草稿即是确认;若开自动发,破坏性操作 agent 侧二次确认)。
3. (可选)"命令模式"开关,仅调整确认强度与提示文案。

### 阶段 4 — (扩展点,本期不做)TTS 语音播报 / 纯本地命令快捷匹配

---

## 6. TTS(语音播报)——记录为扩展点

- **需求场景:** agent 回应/任务完成播报,适合"动手忙、看屏不便"或无障碍场景。
- **路线同样双轨:** 浏览器原生 `SpeechSynthesis`(零成本、中文音色一般、即时可用)vs 云端 TTS(音质好、需后端+密钥+计费)。
- **建议:** 本期**不做**。若做,从 `SpeechSynthesis` 起步,只读 agent 的最终文本回应(从 `task_chat_message` 流里取),加一个全局开关。优先级低于 STT。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 云端 STT 需密钥 + 后端,无法"纯前端几天上线" | 首版前置成本更高 | 接受:为换中文质量与隐私可控;后端范式(base64 上传/代理出站/0600 密钥)均现成,非从零 |
| 云端 STT 计费/延迟 | 成本与响应 | 支持指向自托管 whisper.cpp/faster-whisper(零边际成本、内网低延迟)作为可选 endpoint |
| STT 误识别 + agent 执行有副作用 CLI | **错误指令被执行(移卡/删任务)** | 默认填草稿不自动发(二次确认);破坏性操作 agent 侧确认;这是最高优先级风险 |
| 云端 STT 密钥泄露 | 安全 | 严格走 `~/.kanban/settings/` 0600 机器本地,绝不入 repo、绝不进 `--json`/日志(参考 passcode 约定) |
| 音频 base64 体积大 | 长录音上传慢/内存 | 限制单次录音时长(如 ≤60s);必要时分段;参考既有 base64 文件上传无特殊处理但本场景应限长 |
| `MediaRecorder`/麦克风权限在非 HTTPS + LAN 下受限 | LAN 部署麦克风拿不到权限 | 注意:浏览器麦克风 API 多要求 secure context;与本项目 `safe-uuid` 在 LAN+HTTP 下的限制同源问题,需在文档提示用 HTTPS 或 localhost |

> 最后一条值得特别注意:本项目已知 `crypto.randomUUID` 在非 secure context(LAN + 明文 HTTP)会崩(见 `safe-uuid` 记录)。`getUserMedia`/`MediaRecorder` **同样要求 secure context**,LAN 明文 HTTP 下麦克风会直接拿不到权限。这会影响阶段二录音上传方案,需在选型时明确:语音功能在 LAN 部署下要求 HTTPS 或经 localhost 访问。

---

## 8. 推荐总览

| 决策点 | 推荐 | 一句话理由 |
|--------|------|-----------|
| STT 引擎 | 云端/本地 Whisper 单轨,不做原生兜底 | 中文质量 + 隐私可控是硬需求,原生引擎两者都不达标 |
| 交互 | Push-to-talk | 隐私好、误触发少、契合桌面场景 |
| 转写后 | 默认填草稿、人工确认发送 | STT 会错 + agent 会执行 CLI,确认是必须的 |
| 语音指令 | 复用现有 agent 通路,补 UX/确认 | 已有自然语言→CLI 能力,不造独立 NLU |
| TTS | 本期不做,记为扩展点 | 优先级低于 STT |
| 集成面 | 麦克风按钮挂 `KanbanChatComposer` 一处 | home + task 两面板自动覆盖 |
