# File surface —「文件系统」块设计(VS Code 式仓库工作区资源管理器)

Status: **design only**(本任务不含实现代码)。日期 2026-07-01。
任务链:58e3b → b0f9f → 88b11 → 33608(见 memory `file-filesystem-upgrade`)。

前置设计:本文档在 `file-surface-design.md`(File 独立成 surface)与 `file-surface-migration-design.md`(把二进制文件库从 Vault 迁入 File overlay)之上继续生长。**File overlay 的外壳、`fileSurfaceStore`、`?file=`/`?files` 路由、"board 不 unmount 的 portaled overlay" 性能论都直接复用,本设计只在 `?files` overlay 内部长出一个新的子 tab,并新增一条后端 tRPC。**

---

## 0. TL;DR

File surface 的 `?files` overlay 顶部分成两个子 tab:

| 子 tab | 内容 | 数据源 | 本次改动 |
| --- | --- | --- | --- |
| **文件系统**(默认) | VS Code 式资源管理器,操作**当前项目主工作区**的真实仓库文件树(源码 + 文档) | 新增 `workspaceFs` tRPC,直读仓库根 | **全新块** |
| **上传** | 现有二进制文件库(`components/files` / `RuntimeFileItem` / `.kanban/files`) | 现有 `workspace.listFiles` 等 | **零改动**,原样搬进 tab |

- 「文件系统」根 = `scope.workspacePath`(仓库根),**仅此一棵**;不含任务 worktree、不含 board worktree、不含其它 workspace。
- 全功能:浏览 / 打开 / 编辑 / 保存 + 新建 / 重命名 / 删除 / 移动(文件与文件夹)。
- 显示过滤:遵循 `.gitignore`,始终隐藏 `.git` 与 `.kanban`;提供「显示隐藏/忽略项」开关。
- 编辑器:CodeMirror 6(懒加载,按扩展名语言高亮);markdown 复用现有 `DocEditor`;图片/二进制→预览;超大文件(>1 MB)只读或拒开。
- 形态仍是 overlay,盖在 board 之上;board 按需 mount、不 unmount(不重蹈 vault/database 整页慢,见 memory `fullscreen-toggle-slow-board-unmount-fix`)。
- 分期:**P1** 后端 list/read + 左树懒加载 + 右侧只读;**P2** 编辑+保存(mtime 并发校验);**P3** 新建/重命名/删除/移动 + 拖拽。

---

## 1. 范围与非目标

**范围内**
- File overlay 内新增两个子 tab 的布局与路由接线。
- 「文件系统」tab:左懒加载文件树 + 右 CodeMirror/预览 + 面包屑 + 保存态。
- 新增 `workspaceFs` tRPC(listDir / readFile / writeFile / create / rename / delete / move),路径安全、懒列一层、size cap、遵循 gitignore。
- 契约同步更新 `src/core/api-contract.ts` 与 tRPC app-router。

**非目标(v1 明确不做)**
- **不做文件监听 / watch**:靠手动刷新按钮 + 窗口聚焦(`focus`)刷新;fs.watch/chokidar 留后续。
- 不做多标签编辑器(右侧同一时刻只开一个文件;切文件即换)。
- 不做 diff / git blame / 搜索面板(可在 P3 之后)。
- 不动「上传」tab 内部实现(`FilesView` 及其 hooks 保持原样)。
- 不触碰任务 worktree / board worktree(严格锁死在仓库根)。

---

## 2. 两 tab 布局与路由接线

### 2.1 overlay 内的 tab 外壳

改造点集中在 `web-ui/src/components/file-surface/file-library-overlay.tsx`(现在直接 `<FilesView />`):在其 slim header 里加一条子 tab strip,body 按 active tab 分流。

```
┌ Radix Dialog(96vw × 94vh,已存在)────────────────────────────┐
│  [ 文件系统 ][ 上传 ]                    [Open document ⌘K] [✕] │  ← header + tab strip
├──────────────────────────────────────────────────────────────┤
│  active === "fs"       → <FileSystemExplorer workspaceId/>     │
│  active === "uploads"  → <FilesView workspaceId/>  (原样)      │
└──────────────────────────────────────────────────────────────┘
```

- **两个 tab 都常驻 mount、用 CSS 隐藏切换**(`hidden` class),不 unmount。理由与 board 相同:`FileSystemExplorer` 的树展开态 / CodeMirror 实例重建代价高,切 tab 时销毁重挂会闪 + 丢状态。overlay 关闭(`?files` 消失)时整体卸载即可。
- header 现有的「Open document ⌘K」跳单文档 palette 的能力保留(它属于 markdown 单文档 lane,与两个 tab 正交)。

### 2.2 路由:复用 `?files`,加子 tab 与 fs 路径

现状:`?files`(无值 flag)= overlay 开;`?file=<id>` = vault 单文档 overlay(独立轴,保持不变)。

新增(全部走 `fileSurfaceStore` 既有的 push/replaceState 机制,`web-ui/src/hooks/app-utils.tsx` 加 parse/build 函数):

| query | 含义 | 默认 |
| --- | --- | --- |
| `?files` | overlay 开(向后兼容:旧的无值链接仍能开) | — |
| `?files=fs` / `?files=uploads` | 显式选中子 tab | 无值 ⇒ `fs`(文件系统为主) |
| `?fsPath=<repo-relative-path>` | 「文件系统」tab 当前选中/打开的路径。文件→右侧打开;目录→展开并 reveal | 仅 `fs` tab 有意义 |

- **向后兼容**:历史上的无值 `?files` 直接落到默认子 tab(`fs`)。旧链接不 404、不空白。
- `?fsPath` 让「打开某源文件」可深链、可刷新存活、可前进后退——与 `?file=`/`?task=`/`?chat=` 同构。
- **不新造第二套弹窗**:fs 编辑器是 `?files` overlay 内的**内联右栏**,不复用 `FileOverlay`(那是 vault 文档 id 轴);`FileOverlay`(`?file=`)保持不变。

### 2.3 store 切片(最小扩展 `FileSurfaceState`)

只把**需要路由/需要 top-bar ring 感知**的状态放进全局 store;树展开态、选中态、编辑缓冲是组件局部 state。

```ts
// file-surface-store.ts —— 在现有 FileSurfaceState 上加两个字段
interface FileSurfaceState {
  fileId: string | null;
  workspaceId: string | null;
  paletteOpen: boolean;
  libraryOpen: boolean;              // = overlay 开(?files)
  filesTab: "fs" | "uploads";       // 新:子 tab,seed 自 ?files=<v>,默认 "fs"
  fsPath: string | null;            // 新:?fsPath,fs tab 的深链路径
}
```

- `openLibrary()` 保持;新增 `setFilesTab(tab)`(写 `?files=<tab>`,replace 不污染历史)、`openFsPath(path)`(写 `?fsPath=`,push,可后退)。
- `isFileSurfaceActive()` 无需改(`libraryOpen` 已覆盖)。
- seed:`readLibraryFromLocation` 扩成读取 `?files` 的值;`fsPath` 同步 seed。

---

## 3. 「文件系统」tab 组件边界

目录:`web-ui/src/components/file-surface/filesystem/`(新)。

```
FileSystemExplorer            两栏容器 + 刷新/聚焦刷新 + 「显示隐藏项」开关
├─ FileTree                   左:懒加载文件树(react-virtuoso 虚拟化)
│   └─ FileTreeRow            单行:缩进/展开箭头/图标/名字;右键菜单;拖拽 handle
├─ FileViewerPane            右:面包屑 + 保存态 + 编辑器/预览路由
│   ├─ Breadcrumbs            仓库根 → … → 当前文件(复用 remote-file-browser 的面包屑写法)
│   ├─ CodeEditorLazy         CodeMirror6 懒加载壳(见 §5)
│   ├─ MarkdownEditor         复用 vault DocEditor(见 §5)
│   └─ BinaryPreview          图片/音视频/二进制预览(见 §5)
├─ hooks/
│   ├─ useFsDir(path)         listDir 查询 + 缓存(懒:点开目录才拉该层)
│   ├─ useFsFile(path)        readFile + 记录 mtime(并发基线)
│   └─ useFsMutations()       create/rename/delete/move(P3)
└─ fs-language-map.ts         扩展名 → CodeMirror 语言 + 编辑器路由判定
```

**职责边界**
- `FileSystemExplorer` 拥有:当前选中路径(镜像 `fsPath`)、树的展开集合 `Set<dirPath>`、每个已展开目录的 children 缓存、「显示隐藏项」布尔、刷新触发器。这些是**组件局部**,不进全局 store(路由需要的仅 `fsPath`)。
- `FileTree` 纯受控:给它 `expandedDirs` + `childrenByDir` + 回调,懒调 `useFsDir` 拉未加载的层。大目录(>~200 行)用 `react-virtuoso`(已是依赖,用于 chat/db/vault 表格)。
- `FileViewerPane` 按 `fs-language-map` 判定用哪个编辑器/预览,并管理右栏的 dirty/save 态(P2 起)。

**性能规则(与既有一致)**
- overlay 关闭即整体卸载;两 tab 内部用 CSS 隐藏而非卸载。
- 树严格**一次一层**:展开目录才 `listDir` 该层,绝不递归全盘。
- 订阅走 leaf fiber 的 `useSyncExternalStore`(top-bar ring / provider),不在 App 层订阅高频切片。

---

## 4. `workspaceFs` tRPC 契约与安全 / 性能

### 4.1 router 落点

在 `src/trpc/app-router.ts` 新增 `workspaceFs` 子 router(用现有 `workspaceProcedure` 中间件,拿到 `scope: { workspaceId, workspacePath }`)。后端实现放 `src/workspace/workspace-fs-api.ts`(新);schema 全部进 `src/core/api-contract.ts`(单一契约源,web-ui 经 `@runtime-contract` alias 复用类型)。

**根 = `scope.workspacePath`(仓库根)。** 与 vault 一致(vault 用同一 `workspacePath` 再拼 `.kanban/...`);本 router 直接把仓库根当 fs 根,故看到的就是**当前代码分支的真实工作树**。

### 4.2 过程(procedures)

| 过程 | 输入 | 输出(均含 `ok` / `error?`) | 期 |
| --- | --- | --- | --- |
| `listDir` | `{ path, showHidden? }` | `{ ok, path, entries: FsEntry[] }` | P1 |
| `readFile` | `{ path }` | `{ ok, path, encoding: "utf8"\|"base64", content, size, mtimeMs, binary, tooLarge, truncated }` | P1 |
| `writeFile` | `{ path, content, encoding?, expectedMtimeMs? }` | `{ ok, mtimeMs, conflict? }` | P2 |
| `createEntry` | `{ path, kind: "file"\|"dir" }` | `{ ok, entry: FsEntry }` | P3 |
| `rename` | `{ path, newName }` | `{ ok, entry: FsEntry }` | P3 |
| `move` | `{ fromPath, toPath }` | `{ ok, entry: FsEntry }` | P3 |
| `deleteEntry` | `{ path, recursive? }` | `{ ok }` | P3 |
| `stat` | `{ path }` | `{ ok, entry: FsEntry \| null }` | P1(并发刷新用) |

```ts
// api-contract.ts(新增,风格对齐 runtimeDirectoryList* 等)
runtimeFsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),                       // 仓库根相对路径,POSIX 分隔
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  isSymlink: z.boolean(),
  gitIgnored: z.boolean(),                // 供「显示隐藏项」时打忽略角标
});
```

- **所有 `path` 为仓库根相对、POSIX 风格**(前端不传绝对路径);后端 `resolve(root, path)` 后校验。
- `writeFile` 的 `expectedMtimeMs` 缺省=强制覆盖;带上则做并发校验(§6)。

### 4.3 路径安全(后端兜底,不信前端)

每个过程在任何 fs 操作**之前**:
1. 拒绝绝对路径 / 含 `..` 逃逸:`resolve(root, path)` 后用 `isPathWithinRoot(root, resolved)`(`src/workspace/path-sandbox.ts`,已存在,POSIX/Windows 正确)。
2. **软链逃逸**:对目标(及父目录)`realpath()`,再次 `isPathWithinRoot(realpath(root), realpath(target))`;指向根外的软链**拒绝**(listDir 中标 `isSymlink` 但不跟随到根外)。
3. 越界一律返回 `{ ok:false, error:"…outside workspace root" }`(不抛,前端友好提示);内部约束违背(如 create 已存在)用 `TRPCError`。
4. 始终隐藏 `.git`、`.kanban`(引擎/运行期目录),无论 showHidden 与否。

### 4.4 gitignore 实现选型

**推荐:`git check-ignore`(真 git 语义),而非引入 `ignore` 库手拼多级 .gitignore。**

- 理由:嵌套 `.gitignore`、否定规则(`!`)、git 全局 excludes 只有 git 自己算得准;`ignore` 库需手动逐级装配,易错。`ignore` 目前**不是依赖**,CodeMirror 已经要新增一堆包,能不加就不加。
- 调用:每次 `listDir` 对该层所有 entry **一次** `execFileAsync("git", ["check-ignore", "--stdin", "-z", ...], { cwd: root, timeout, maxBuffer })`,把名字从 stdin 批量喂入 —— **一个目录一次子进程**,异步、有界,遵守 AGENTS.md「No sync subprocess on hot paths」(用 `execFileAsync`,绝不 `execFileSync`)。
- **缓存**:结果按 `(dirPath, dir.mtimeMs)` 缓存(短 TTL / 单飞),仿 `detectGitRepositoryInfo` 的 single-flight+TTL,避免用户反复展开时重复 spawn。
- **非 git 仓库**:`check-ignore` 失败→降级为「只隐藏 `.git`/`.kanban` + dotfile 可选」,不报错。
- 「显示隐藏项」开关 ON:后端 `showHidden:true` 跳过 gitignore 过滤(仍算 `gitIgnored` 用于角标),`.git`/`.kanban` 依旧永久隐藏。

> 备选:若后续要去子进程化,可切 `ignore` 库 + 逐级 `.gitignore` 读取缓存。契约不变,纯后端替换。

### 4.5 size cap 与二进制

- `FS_EDIT_MAX_BYTES = 1 MB`:`readFile` 超过→返回 `tooLarge:true` + 不带 content(右栏显示「文件过大,只读/拒开」)。
- `FS_PREVIEW_MAX_BYTES = 8 MB`:图片 base64 预览上限(对齐 `useFileBytes` 的 8 MB)。
- 二进制识别:先按 `mime.getType(name)`(`mime` 已是依赖)分类;文本类走 utf8,图片/音视频/二进制走 base64/预览。对无扩展名文件,读前 sniff 头部字节(NUL 判定)兜底,`binary:true` 则不当文本打开。
- listDir 只 `stat` 不读内容;绝不递归。

---

## 5. 编辑器选型与接线

### 5.1 分流(`fs-language-map.ts`)

`FileViewerPane` 按扩展名 + `readFile` 的 `binary`/`tooLarge` 决策:

| 情况 | 渲染 |
| --- | --- |
| `.md` / `.markdown` | **复用 vault `DocEditor`**(`web-ui/src/components/vault/editor/doc-editor.tsx`,`@uiw/react-md-editor`,已含防 ghosting) |
| 文本代码(其余文本扩展) | **CodeMirror 6**,按扩展名映射语言 |
| 图片 / 音视频 / 二进制 | **预览**(见 §5.3) |
| `tooLarge`(>1 MB)文本 | CodeMirror **只读**、不高亮(或直接「拒开」提示 + 仅显示元信息) |

### 5.2 CodeMirror 6 懒加载

- **新增依赖**(web-ui 当前无 CodeMirror):`@uiw/react-codemirror` + `@codemirror/state`/`view` + 按需语言包(`@codemirror/lang-javascript`/`json`/`python`/`css`/`html`/`markdown`/`rust`/…)。
- **懒加载壳**:`CodeEditorLazy` 遵循项目既定 pattern(`agent-terminal-panel-lazy.tsx` / `kanban-markdown-content-lazy.tsx`)——单层 wrapper `lazy(() => import("./code-editor").then(m => ({ default: m.CodeEditor })))` + Suspense。**关键坑**(memory `web-ui-perf-round2`):任何从首屏路径来的**静态 import** 会经 modulepreload 击穿 `lazy()` 边界,把 CodeMirror 拉进入口包 —— 所以 `filesystem/` 里对 `code-editor` 只能动态 import,且首屏组件不得静态引用它。
- 语言包也按 ext **动态 import**(`fs-language-map` 返回一个 `() => import(...)` thunk),避免一次性打包所有语法。
- 主题:沿用 dark 设计 token(自定 CodeMirror theme extension 映射 `surface-*`/`text-*`),不引第三方主题包。

### 5.3 图片/二进制预览

- 复用 `components/files` 的**呈现**:图标映射 `file-meta.tsx`(`CATEGORY_ICON`/颜色)、图片框样式同 `FileThumbnail`/`FileDetailPanel`。
- **数据源不同**:`FileThumbnail`/`useFileBytes` 绑定 `RuntimeFileItem`(上传库),fs 文件走 `workspaceFs.readFile` 的 base64。因此提炼一个**无数据源的呈现核**(`<ImagePreviewFrame src>` / `<CategoryIconTile>`),上传库与 fs 各自喂 bytes——诚实记录:这是「复用呈现、不复用取数」。
- 音视频:`data:` URL 直接喂 `<img>/<video>/<audio>`;超 `FS_PREVIEW_MAX_BYTES` 显示「过大,不预览」+ 元信息。

### 5.4 面包屑 + 保存态

- 面包屑复用 `remote-file-browser-dialog.tsx` 的 `buildBreadcrumbs` 写法(root → 段 → 当前;末段非交互)。
- 保存态镜像 `FileOverlay`:本地 draft 缓冲、dirty 标记、显式 Save 按钮(可加 `Cmd+S`);dirty 时切文件/关 overlay 弹 `AlertDialog` 拦截。

---

## 6. 并发与错误处理

- **打开记 mtime**:`readFile` 返回 `mtimeMs`,前端 `useFsFile` 存为并发基线。
- **保存前比对**:`writeFile` 带 `expectedMtimeMs`;后端 `stat` 现值,若 ≠ 基线→`{ ok:false, conflict:true }`(不写盘)。
- **冲突提示**:前端弹「文件已被外部修改,是否覆盖 / 放弃我的修改重载」。覆盖=重发不带 `expectedMtimeMs`(强制);重载=丢弃 draft 重新 `readFile`。
- 删除/移动的目标已存在、目录非空未 `recursive`、越界、权限失败:统一 `{ ok:false, error }`,前端 toast(`showAppToast`)。
- v1 无 watch:右栏「刷新」按钮 + 窗口 `focus` 事件触发轻量 re-stat(仅当前打开文件比 mtime,变了则提示重载),树的刷新是手动重拉当前展开层。

---

## 7. 分期与验收

### P1 — 后端 list/read + 左树懒加载 + 右侧只读
- 后端:`workspaceFs.listDir` / `readFile` / `stat`;路径安全(§4.3)、gitignore 过滤(§4.4)、size/二进制(§4.5)。
- 前端:overlay 两 tab 外壳 + `?files=<tab>` 路由;「文件系统」左树懒加载 + 虚拟化 + 「显示隐藏项」开关;右侧**只读**查看(CodeMirror 只读 + md 预览 + 图片/二进制预览)+ 面包屑;`?fsPath` 深链。
- **验收**:①「上传」tab 与旧行为逐像素一致;② 展开目录只拉该层(网络面板证明无递归);③ `.git`/`.kanban` 永不出现,gitignore 命中项默认隐藏、开关可显(带角标);④ 越界/`..`/根外软链被后端拒;⑤ 深链 `?files=fs&fsPath=src/x.ts` 刷新后直接打开且只读渲染;⑥ 打开 board 不 unmount、关 overlay 整体卸载;⑦ 大文件(>1 MB)不塞 content、右栏提示只读/拒开。

### P2 — 编辑 + 保存(mtime 并发校验)
- 后端:`workspaceFs.writeFile`(§6 并发)。
- 前端:CodeMirror 可编辑、md 走 `DocEditor` 可编辑;draft 缓冲 + dirty 守卫 + Save;冲突对话框。
- **验收**:①编辑保存后磁盘内容正确、mtime 更新;②外部改动后保存被 `conflict` 拦、覆盖/重载两路都对;③ dirty 时切文件/关闭被拦;④ CodeMirror 懒加载不进入口包(产物分析:入口 modulepreload 不含 codemirror);⑤ 保存越界仍被后端拒。

### P3 — 新建/重命名/删除/移动 + 拖拽
- 后端:`createEntry` / `rename` / `move` / `deleteEntry`(全部路径安全 + 目标校验)。
- 前端:树右键菜单(新建文件/夹、重命名、删除)+ 拖拽移动(文件与文件夹);删除二次确认(`AlertDialog`)。
- **验收**:①四类操作对文件与文件夹都生效、树增量刷新(仅受影响层重拉);②移动/重命名到已存在名被拒并提示;③删除非空目录需 `recursive`;④拖拽跨目录移动正确、越界被拒;⑤所有变更后 `?fsPath` 与选中态自洽(如删除当前文件→右栏清空)。

---

## 8. 已定决策(依锁定项)

1. File overlay 顶部两子 tab:**文件系统(新)** / **上传(现有库,零改动)**;文件系统为默认。
2. 文件系统根 = 当前项目主工作区仓库根(`scope.workspacePath`),单树;排除任务/board worktree 与其它 workspace。
3. 显示过滤遵循 `.gitignore`(`git check-ignore` 批量、异步、缓存),永久隐藏 `.git`/`.kanban`,提供显示隐藏项开关。
4. 编辑器:CodeMirror 6 懒加载 + 按 ext 语言;md 复用 `DocEditor`;图片/二进制复用呈现层预览;>1 MB 只读/拒开。
5. 形态复用现有 `?files` portaled overlay(board 不 unmount);**不新造第二套弹窗**,fs 编辑器内联右栏。
6. 并发:打开记 mtime、保存前比对、冲突提示覆盖/重载。
7. v1 不做 watch,手动刷新 + 聚焦刷新。
8. `ignore` 库暂不引入(用 `git check-ignore`);CodeMirror 相关包为**新增依赖**。

---

## 9. 触碰文件清单(实现时导航用)

**后端(new/edit)**
- `src/workspace/workspace-fs-api.ts`(新):fs 过程实现 + 路径安全 + gitignore + size/二进制。
- `src/trpc/app-router.ts`:挂 `workspaceFs` 子 router(`workspaceProcedure`)。
- `src/core/api-contract.ts`:`runtimeFsEntrySchema` + 各过程 req/resp schema。
- 复用:`src/workspace/path-sandbox.ts`(`isPathWithinRoot`)、`execFileAsync` git 模式(参 `src/state/workspace-state.ts`)、`mime`。

**前端(new/edit)**
- `web-ui/src/components/file-surface/file-library-overlay.tsx`:加子 tab strip + body 分流。
- `web-ui/src/components/file-surface/file-surface-store.ts` + `web-ui/src/hooks/app-utils.tsx`:`filesTab`/`fsPath` 状态 + `?files=<v>`/`?fsPath` parse/build。
- `web-ui/src/components/file-surface/filesystem/*`(新):`FileSystemExplorer` / `FileTree` / `FileViewerPane` / `CodeEditorLazy` / `code-editor` / `fs-language-map` / hooks。
- 复用:`components/vault/editor/doc-editor.tsx`(md)、`components/files/file-meta.tsx`(图标/分类)、`react-virtuoso`(虚拟化)、`buildBreadcrumbs`(面包屑写法)。
- 依赖:`web-ui/package.json` 加 CodeMirror 6 相关包。
