# Kanban CLI Redesign

Status: **Design proposal — review pending.** This document is design + rationale only.
It does **not** change any command implementation. Once approved, it gets split into
independent implementation tasks (see *Phased rollout*).

Scope: the entire `kanban` CLI surface — root flags, `task`, `db`, `file`, `vault`,
`service`, `passcode`, `hooks`, the deprecated `mcp`/`--agent`/`--update`, and the
output/error/exit-code contracts that cut across all of them.

Audience: two distinct consumers, both first-class.
1. **Humans** running `kanban` in a terminal (operators, devs).
2. **Coding agents / LLMs** that invoke the CLI and parse its output programmatically.

---

## 1. Current-state inventory

Source files read for this inventory (line references are to current `HEAD`):
`src/cli.ts` (814), `src/commands/task.ts` (1320), `src/commands/db.ts` (448),
`src/commands/file.ts` (264), `src/commands/vault.ts` (355), `src/commands/service.ts` (219),
`src/commands/passcode.ts` (31), `src/commands/hooks.ts` (911),
`src/commands/runtime-workspace.ts` (shared helpers), `src/cli-output.ts` (`printLine`).

### 1.1 Full command tree (as built)

Registration happens in `createProgram` (`src/cli.ts:724`), which calls each
`register*Command` and adds the bare root action plus `mcp` / `update`.

| Command | Verb/noun shape | Key args / options | Defaults | Output | Exit on error |
|---|---|---|---|---|---|
| `kanban` (bare) | verb-only (implicit "serve") | `--host`, `--port <n\|auto>`, `--no-open`, `--skip-shutdown-cleanup`, `--https`, `--cert`, `--key`, `--update`, `--passcode <v>`, `--no-passcode`, `--agent <id>` (hidden, ignored) | host `127.0.0.1`, port `3484` (`DEFAULT_KANBAN_RUNTIME_PORT`), open=true, passcode auto in remote mode | `printLine` banner (human) | `process.exit(1)` via top-level catch (`cli.ts:809`) |
| `kanban task list` | noun-verb | `--project-path`, `--column` | project = cwd workspace | `printJson` `{ok:true, workspacePath, column, tasks[], dependencies[], count}` | `exitCode=1`, `{ok:false, error:string}` |
| `kanban task create` | noun-verb | `--prompt` (required), `--title`, `--project-path`, `--base-ref`, `--start-in-plan-mode [v]`, `--auto-review-enabled [v]`, `--auto-review-mode <commit\|pr>`, `--owner`, `--agent-id`, `--provider`, `--model`, `--reasoning-effort` | column=backlog | `printJson` `{ok:true,...}` | `exitCode=1` |
| `kanban task update` | noun-verb | `--task-id` (required), + most create flags, `--provider`/`--model` accept `"default"` to clear | — | `printJson` | `exitCode=1` |
| `kanban task trash` (alias `done`) | noun-verb | `--task-id` *or* `--column`, `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban task delete` | noun-verb | `--task-id` *or* `--column`, `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban task link` | noun-verb | `--task-id`, `--linked-task-id` (both required), `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban task unlink` | noun-verb | `--dependency-id` (required), `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban task start` | noun-verb | `--task-id` (required), `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban db connection list` | noun-noun-verb | `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban db connection add` | noun-noun-verb | `--label`, `--engine` (required), `--id`, `--host`, `--port`, `--database`, `--user`, `--file-path`, `--ssl-*`, `--allow-writes [v]`, `--password`, `--project-path` | secrets machine-local | `printJson` | `exitCode=1` |
| `kanban db connection remove` (alias `rm`) | noun-noun-verb | `--connection` (required), `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban db connection test` | noun-noun-verb | `--connection` (required) | — | `printJson` | `exitCode=1` |
| `kanban db tables` | noun-verb | `--connection` (required), `--schema` | — | `printJson` | `exitCode=1` |
| `kanban db describe <table>` | noun-verb + positional | `--connection` (required), `--schema` | — | `printJson` | `exitCode=1` |
| `kanban db browse <table>` | noun-verb + positional | `--connection`, `--schema` (required), `--page-size`, `--cursor` | core row cap | `printJson` | `exitCode=1` |
| `kanban db query <sql>` | noun-verb + positional | `--connection` (required), `--page-size`, `--cursor` | read-only | `printJson` | `exitCode=1` |
| `kanban file list` (alias `files`) | noun-verb | `--project-path`, `--category` | — | `printJson` | `exitCode=1` |
| `kanban file show` | noun-verb | `--id` (required) | — | `printJson` | `exitCode=1` |
| `kanban file add` | noun-verb | `--path` (required), `--name`, `--mime` | name = source filename | `printJson` | `exitCode=1` |
| `kanban file update` | noun-verb | `--id`, `--name` (required) | — | `printJson` | `exitCode=1` |
| `kanban file delete` | noun-verb | `--id` (required) | — | `printJson` | `exitCode=1` |
| `kanban file path` | noun-verb | `--id` (required) | — | `printJson` | `exitCode=1` |
| `kanban file bytes` | noun-verb | `--id` (required) | — | `printJson` (base64) | `exitCode=1` |
| `kanban vault type list` | noun-noun-verb | `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban vault type show` | noun-noun-verb | `--type` (required) | — | `printJson` | `exitCode=1` |
| `kanban vault doc list` | noun-noun-verb | `--type`, `--project-path` | — | `printJson` | `exitCode=1` |
| `kanban vault doc show` | noun-noun-verb | `--id` (required) | — | `printJson` | `exitCode=1` |
| `kanban vault doc create` | noun-noun-verb | `--type`, `--title` (required), `--body`, `--body-file`, `--set <k=v>` (repeatable) | — | `printJson` | `exitCode=1` |
| `kanban vault doc update` | noun-noun-verb | `--id` (required), `--title`, `--body`, `--body-file`, `--set` | omitted = unchanged | `printJson` | `exitCode=1` |
| `kanban vault doc delete` | noun-noun-verb | `--id` (required) | — | `printJson` | `exitCode=1` |
| `kanban service install` | noun-verb | `--name`, `--host`, `--port`, `--passcode <v>`, `--no-passcode`, `--https`, `--cert`, `--key` | name `kanban`, host `127.0.0.1` | `printJson` `{ok,action,platform,name,message,artifactPath,hints}` + `printLine` passcode banner | `exitCode=1` |
| `kanban service uninstall/start/stop/restart` | noun-verb | `--name` | — | `printJson` | `exitCode=1` |
| `kanban service status` | noun-verb | `--name` | — | `printJson` `{ok,action,platform,name,...status}` + `printLine` passcode | `exitCode=1` |
| `kanban passcode` | verb-only (top-level) | none | reads persisted file | `printLine` (human only, no JSON) | returns 0 even when none set |
| `kanban hooks ingest/notify/gemini-hook/codex-hook/codex-wrapper/cleanup` | noun-verb | wire-protocol flags (`--event`, `--source`, …) | — | raw stdout (wire protocol) | varies; `notify` never throws |
| `kanban update` | verb-only (top-level) | none | — | `printLine` | throws → `exit(1)` |
| `kanban mcp` | verb-only (top-level) | none | — | `cliLog.warn` (deprecated) | 0 |
| `--agent <id>` (root) | hidden flag | ignored | — | — | — |

### 1.2 Inconsistencies (the explicit problem list)

These are the things the redesign must fix. Each is sourced to a concrete line.

| # | Inconsistency | Evidence | Impact |
|---|---|---|---|
| I1 | **Mixed verb/noun depth.** Most commands are `<noun> <verb>` (`task list`), but `passcode`, `update`, `mcp` are bare top-level verbs, and the bare root is an implicit "serve" verb with no noun. `db connection add` and `vault doc create` are three levels deep. | `cli.ts:758,768,761`; `task.ts:1055`; `db.ts:248`; `vault.ts:259` | Hard to predict; humans and agents must memorize special cases. |
| I2 | **Inconsistent aliasing & pluralization.** `task`/`tasks`, `file`/`files` alias the plural; `db`/`vault`/`service` do not. `task trash` aliases `done`; `db connection`→`conn`, `db remove`→`rm`. No rule. | `task.ts:1055,1212`; `file.ts:168`; `db.ts:249,323` | Inconsistent muscle memory; agents can't infer alias availability. |
| I3 | **Error payload is a free-text string, not a structured object.** Every family returns `{ok:false, error: "<Family> command failed at <origin>: <message>"}`. No stable `code`. The human-readable prefix differs per family. | `task.ts:1046`; `db.ts:236`; `file.ts:156`; `vault.ts:222` | Agents must regex natural-language strings to classify failures. |
| I4 | **Output is always pretty-printed JSON — even for humans.** `printJson` = `JSON.stringify(payload, null, 2)`. There is no human table/summary mode and no `--json` toggle. The only human output is the server banner / passcode via `printLine`. | `runtime-workspace.ts` `printJson`; `cli-output.ts`; `cli.ts:310,645` | Humans get raw JSON; there is no machine-vs-human split at all. |
| I5 | **Success envelope is non-uniform.** `task list` returns `{ok:true, workspacePath, column, tasks, …}`; `service install` returns `{ok, action, platform, name, message, artifactPath, hints}`; some formatters return raw records without `ok`. No `schemaVersion`. | `task.ts:382`; `service.ts:109`; `task.ts:293` (`formatTaskRecord` no `ok`) | No single shape to parse; no versioning for forward-compat. |
| I6 | **`--project-path` is re-declared on every subcommand** instead of being a shared/global option; the bare server command uses `process.cwd()` with no flag. | repeated `.option("--project-path", …)` across all files | Boilerplate; easy to forget; can't be set once globally. |
| I7 | **Duplicated, divergent flags across root and `service`.** `--host/--port/--passcode/--no-passcode/--https/--cert/--key` exist on both, with different parsers (`parseCliPortValue` accepts `auto`; `parseServicePort` does not) and different help text. | `cli.ts:731-746`; `service.ts:160-167` | Two sources of truth for the same concepts; drift risk. |
| I8 | **`--passcode`/`--no-passcode` collapse into one `boolean\|string` field** (a commander quirk). | `cli.ts:90`, `cli.ts:788-789`; `service.ts:26,61` | Confusing typing; subtle bugs around `passcode === false`. |
| I9 | **Exit codes are binary (0/1) with no documented taxonomy.** Handler errors set `exitCode=1`; commander usage errors exit via `showHelpAfterError`; `hooks notify` never throws; `passcode` returns 0 even when nothing is set. | `task.ts:1050`; `cli.ts:747`; `passcode.ts:24` | Agents can't distinguish "not found" from "runtime down" from "bad usage". |
| I10 | **`passcode` lives at top level**, disconnected from the `service`/remote subsystem it belongs to. | `cli.ts:758`; `passcode.ts:16` | Discoverability: the remote-access story is split across `service` + `passcode` + root flags. |
| I11 | **Dead/deprecated surface still listed.** `mcp` (warns), `--agent` (hidden, ignored), `--update` flag duplicates the `update` command. | `cli.ts:750,761,768,775` | Noise in `--help`; ambiguity. |
| I12 | **No machine-discoverable capability manifest.** Self-description is only commander `--help` text (prose). | (absence) | Agents cannot enumerate commands/options/output schemas deterministically. |

---

## 2. Design principles

1. **Two audiences, one contract.** Humans get a readable default; agents get `--json`.
   The *data* behind both is identical; only the rendering differs.
2. **Resource-oriented, predictable shape.** Settle on **`<noun> <verb>`** everywhere
   (see §3.1 for why over `<verb> <noun>`). Depth is at most `<group> <noun> <verb>`.
3. **One global-flag source of truth.** Cross-cutting flags (`--project-path`, `--json`,
   `--no-color`, `--quiet`, and runtime-targeting `--host`/`--port`) are declared once at
   program level and read via `optsWithGlobals()`.
4. **Deterministic, versioned machine contract.** Every `--json` response is a single
   envelope with `schemaVersion`, `ok`, and either `data` or a structured `error`.
5. **No state encoded only in prose.** Status, success, and failure are expressed in
   structured fields and a stable `error.code` — never *only* in an English sentence.
6. **Self-describing.** `kanban schema` emits the full command/option/output manifest as
   JSON so an agent can discover capabilities without scraping `--help`.
7. **Backwards-compatible migration.** Old spellings keep working (aliased + deprecation
   warning to stderr) for one minor-version window; nothing breaks on upgrade.
8. **Secrets never enter the machine channel.** The passcode stays on the human channel
   (`printLine`) and is never embedded in `--json` output or logs (preserves the current
   invariant in `service.ts:139` / `cli-output.ts`).

---

## 3. New command tree

### 3.1 Noun-verb vs verb-noun — decision

**Decision: keep `<noun> <verb>` (resource-first).** Rationale:

- It is already the dominant shape (`task`, `db`, `file`, `vault`, `service` are all
  noun-first); migration cost is lowest.
- It matches the mental model agents already have from `gh`, `docker`, `kubectl`,
  `aws` — "pick the resource, then the action."
- Tab-completion and `kanban <noun> --help` naturally enumerate the verbs for a resource.
- The only outliers (`passcode`, `update`, `mcp`, bare-serve) are few and get regrouped.

Verb-first (`create task`) was considered and rejected: it would force a larger rename and
fights the existing structure for no discoverability gain.

### 3.2 The tree

```
kanban                              # bare = launch the runtime (alias: kanban serve)
kanban serve                        # explicit launch (same as bare)
kanban version                      # prints version (also -v / --version)
kanban schema [command]            # NEW: machine-readable capability manifest (--json default)
kanban help [command]              # commander help

kanban task list
kanban task show <id>              # NEW: single-task detail (today you must list+filter)
kanban task create
kanban task update <id>            # id becomes a positional (was --task-id)
kanban task start <id>
kanban task done <id>             # canonical name (was: trash; "done" was the alias)
kanban task delete <id>
kanban task link <id> <to-id>
kanban task unlink <dependency-id>

kanban db connection list
kanban db connection add
kanban db connection remove <id>
kanban db connection test <id>
kanban db tables
kanban db describe <table>
kanban db browse <table>
kanban db query <sql>

kanban file list
kanban file show <id>
kanban file add <path>
kanban file update <id>
kanban file delete <id>
kanban file path <id>
kanban file bytes <id>

kanban vault type list
kanban vault type show <type>
kanban vault doc list
kanban vault doc show <id>
kanban vault doc create
kanban vault doc update <id>
kanban vault doc delete <id>

kanban service install
kanban service uninstall
kanban service start
kanban service stop
kanban service restart
kanban service status            # enriched (see §5)

kanban remote status             # NEW: bind host, URL, passcode presence, health
kanban remote passcode show      # was: top-level `kanban passcode`
kanban remote passcode set <v>   # NEW: set/persist a fixed passcode
kanban remote passcode disable   # NEW: explicit disable

kanban hooks …                    # unchanged surface, marked "internal" in help
kanban update                     # unchanged (also: replaces the --update root flag)
```

### 3.3 Naming rules (the rule that removes I1/I2)

1. **Resource first, action second.** `<noun> [<sub-noun>] <verb>`. Max depth 3.
2. **Verbs are a closed vocabulary:** `list`, `show`, `create`, `update`, `delete`,
   plus domain verbs (`start`, `done`, `link`, `unlink`, `add`, `remove`, `test`,
   `tables`, `describe`, `browse`, `query`, `install`, `status`, …). Prefer `show`
   for "one item by id"; `list` for "many".
3. **Identifiers are positionals, not flags** where there is exactly one obvious id
   (`task update <id>`, `db connection remove <id>`). Multi-id verbs keep ordered
   positionals (`task link <id> <to-id>`). This removes the `--task-id` / `--id` /
   `--connection` / `--dependency-id` inconsistency.
4. **Singular nouns are canonical; plural is an alias** uniformly (`task`↔`tasks`,
   `file`↔`files`, `db`, `vault`, `service` get `dbs` only if useful — default: no plural
   alias unless it already exists). Short aliases (`conn`, `rm`) are retained as documented
   aliases but the canonical long form is shown in help.
5. **Deprecated names are aliases with a stderr deprecation note** (`task trash` → warns,
   runs `task done`; top-level `passcode` → warns, runs `remote passcode show`).

---

## 4. Output contract

### 4.1 Two channels, one data model

Every command computes a **result object** once, then renders it through one of two
renderers chosen by mode:

- **Human renderer (default when stdout is a TTY and `--json` not set):** colorized
  tables, summaries, spinners, and a one-line status footer. Goes through `cli-output.ts`
  (`printLine` + new helpers), honors TTY detection and `--no-color`/`NO_COLOR`.
- **Machine renderer (`--json`, or auto when stdout is not a TTY — see §4.4):** a single
  JSON envelope, one document per invocation.

> Implementation note: the result object is the same shape used by `--json`. The human
> renderer is a pure view over it. This guarantees the two channels never drift (fixes I4/I5).

### 4.2 Machine envelope (`--json`)

```jsonc
// success
{
  "schemaVersion": "1",          // bumped on breaking shape changes
  "ok": true,
  "command": "task.list",        // dotted canonical command id
  "data": { /* command-specific, see §4.5 */ },
  "warnings": [                    // optional, machine-stable
    { "code": "deprecated_alias", "message": "`task trash` is deprecated; use `task done`." }
  ]
}
```

```jsonc
// failure
{
  "schemaVersion": "1",
  "ok": false,
  "command": "task.update",
  "error": {
    "code": "task_not_found",     // stable enum (see §6.3)
    "message": "No task with id \"abc\" in workspace.",
    "details": { "taskId": "abc" }   // optional structured context
  }
}
```

Rules:
- **Exactly one JSON document on stdout**, nothing else (no banner, no log lines —
  diagnostics go to stderr via the logger). This is what makes the output safely
  `JSON.parse`-able by an agent.
- `ok` is always present; `data` present iff `ok`; `error` present iff `!ok`.
- `command` is the canonical dotted id (matches `kanban schema` entries) so an agent can
  correlate output to the command definition.
- `schemaVersion` is a string; additive fields do not bump it, shape/removal changes do.

### 4.3 Human rendering (default)

- **`list` verbs** → aligned tables with a colored header and a trailing summary
  (`12 tasks · 3 in_progress · 2 review`). Truncate wide cells; full values available via
  `--json` or `show`.
- **`show`/`create`/`update`** → a key/value summary block; the affected id is
  highlighted; a green ✓ status line on success.
- **Long-running** (`task start`, `service install`, server boot) → `ora` spinner with a
  terminal ✓/✗ (the pattern already used by `createShutdownIndicator`).
- **Errors** → red `✗ <message>` plus a dim `(code: <error.code>)` so the stable code is
  still visible to a human, and a hint line when one applies.
- **Colors** auto-disable when not a TTY, on `--no-color`, or when `NO_COLOR` is set.

Library choice: prefer a small, well-maintained table/format dep over hand-rolled padding
(per AGENTS.md "evaluate third-party first"). Colors via the existing toolchain; no new
heavy framework.

### 4.4 Mode selection precedence

1. `--json` flag → machine. `--human` flag (escape hatch) → human.
2. `KANBAN_OUTPUT=json|human` env.
3. **Auto:** if stdout is **not** a TTY → machine (safe default for pipes/agents);
   if a TTY → human.

> This makes naive `kanban task list | jq` work for agents without a flag, while keeping
> interactive use pretty. `--human` exists for the rare "pretty output into a file" case.
> (The user asked for "human default + `--json`"; auto-json-when-piped is the agent-safety
> refinement and can be disabled with `KANBAN_OUTPUT=human` if undesired.)

### 4.5 Per-command `data` schemas (illustrative)

`task.list` → `{ workspacePath, column, count, tasks: Task[], dependencies: Dependency[] }`
where `Task` is the existing `formatTaskRecord` shape (frozen and versioned).
`service.status` / `remote.status` → see §5. Each schema is enumerated by `kanban schema`.

---

## 5. Remote / service subsystem

This consolidates the host/CORS/passcode/install work into one coherent, discoverable
story. The driving requirement: an operator who binds to a remote host must be able to
**find their access URL + passcode + health** from one command, and be guided when they
forget the passcode.

### 5.1 `kanban remote status` (new, the hub)

One command answers "is it up, where, and how do I get in?". `--json` `data`:

```jsonc
{
  "bind": { "host": "0.0.0.0", "port": 3484, "https": false },
  "accessUrls": [
    "http://192.168.1.20:3484",   // enumerated NICs (loopback always included)
    "http://127.0.0.1:3484"
  ],
  "remoteMode": true,             // bound to a non-loopback host
  "passcode": {
    "required": true,
    "set": true,                  // never the value in --json
    "source": "persisted",       // persisted | explicit | generated | none
    "viewCommand": "kanban remote passcode show"
  },
  "health": { "reachable": true, "checkedUrl": "http://127.0.0.1:3484/api/...", "latencyMs": 12 },
  "allowedHosts": ["192.168.1.20", "127.0.0.1"],   // mirrors the Host/CORS gate
  "service": { "installed": true, "running": true, "platform": "systemd", "name": "kanban" }
}
```

Human render: a compact panel — bind line, clickable URL(s), "🔐 passcode: set (run
`kanban remote passcode show`)", health ✓/✗, service line. This is the single
"is my remote access working" screen, directly addressing the recent host/CORS/passcode
bug cluster.

### 5.2 `kanban remote passcode show|set|disable`

- `show` → the existing persisted-passcode read (human channel only; never `--json` value).
  When unset, the existing guidance text (how a passcode is created) is preserved.
- `set <value>` → persist a fixed passcode (wraps `resolveAndPersistPasscode({explicit})`),
  no need to re-pass `--passcode` on every launch.
- `disable` → explicit `--no-passcode` equivalent, persisted.

Top-level `kanban passcode` becomes a deprecated alias of `remote passcode show`.

### 5.3 `service` + `remote` relationship

- `service install/uninstall/start/stop/restart` unchanged in behavior; the install
  passcode banner stays (it is the moment the operator needs it).
- `service status` keeps its service-centric `--json` (process/platform/artifact), and its
  human render gains a pointer: "for access URL + passcode run `kanban remote status`".
- `remote status` is the cross-cutting view; it *includes* a `service` sub-object so one
  command suffices for the common case.

### 5.4 Bind-time guidance (carry the recent fixes forward)

When the runtime binds to a non-loopback host (the `isKanbanRemoteHost` path,
`cli.ts:604`), the startup banner already prints the passcode + URL. The redesign keeps
that and adds: on a wildcard/remote bind, a one-line "view later: `kanban remote passcode
show` · status: `kanban remote status`" pointer, so the discoverability chain is explicit
from first boot. The Host/CORS allowlist computed by the middleware is surfaced in
`remote status.allowedHosts` so a locked-out operator can self-diagnose.

---

## 6. Cross-cutting specifications

### 6.1 Global flags (declared once, inherited)

Declared at program level; subcommand actions read them via `this.optsWithGlobals()`
(regular `function`, not arrow — the commander gotcha already documented in AGENTS.md).

| Flag | Meaning | Default |
|---|---|---|
| `--project-path <path>` | Workspace to operate on | cwd workspace |
| `--json` / `--human` | Force output channel | auto (§4.4) |
| `--no-color` | Disable ANSI color | color if TTY & `NO_COLOR` unset |
| `--quiet` | Suppress the human summary footer / spinners (no effect on `--json`) | off |
| `--host <ip>` / `--port <n\|auto>` | Runtime target for client commands; bind host/port for `serve`/`service` | `127.0.0.1` / `3484` |

This removes per-command `--project-path` boilerplate (I6) and gives `--host`/`--port` a
single parser (`parseCliPortValue`, which already supports `auto`) shared by root and
`service` (I7). `service install` still accepts them as the bind target — but via the same
declared option + parser, not a divergent copy.

`--passcode <value>` / `--no-passcode`: keep on `serve` and `service install`, but document
the `boolean|string` collapse explicitly and, going forward, prefer `remote passcode
set/disable` for the persistent case so the launch flags become rarely-needed overrides
(mitigates I8 without a breaking change).

### 6.2 Exit-code taxonomy

| Code | Meaning | When |
|---|---|---|
| `0` | Success | `ok:true` |
| `1` | Runtime/handler error | caught exception in a command handler (`ok:false`) |
| `2` | Usage error | commander parse failure: unknown command, missing required arg/positional |
| `3` | Not found | the targeted task/file/doc/connection does not exist (`error.code` ends `_not_found`) |
| `4` | Runtime unreachable | the Kanban server is required but not reachable (`canReachKanbanServer` false) |
| `5` | Conflict / precondition failed | e.g. dependency cycle, write blocked on read-only connection |

Codes 3–5 are a refinement of today's blanket `1`; they map deterministically from
`error.code` (§6.3) so agents can branch on exit status without parsing. `hooks notify`
keeps its "never fail" contract (always 0) by design.

### 6.3 Error-code enum (the structured `error.code`)

A closed, documented set. Examples (full list lives next to the implementation and is
emitted by `kanban schema`):

`workspace_not_found`, `runtime_unreachable`, `task_not_found`, `file_not_found`,
`document_not_found`, `connection_not_found`, `invalid_argument`, `validation_failed`,
`dependency_cycle`, `write_not_allowed`, `passcode_not_set`, `service_unsupported_platform`,
`internal_error` (catch-all). Each maps to an exit code per §6.2.

This replaces the free-text `"<Family> command failed at <origin>: <msg>"` string (I3).
The origin/message stays in `error.message` for humans; the *classification* moves to
`error.code`.

### 6.4 Help text style

- One-line description per command, imperative mood ("Create a task in backlog.").
- Examples block on every leaf command (`addHelpText("after", …)`), including a `--json`
  example for agent users.
- `kanban <noun> --help` lists verbs; `kanban <noun> <verb> --help` shows options +
  positionals + the `data` schema reference (`see: kanban schema <command>`).
- Internal/agent commands (`hooks …`) grouped under an "Internal" heading and hidden from
  the top-level summary (kept discoverable via `--help` for integrators).

### 6.5 Argument consistency

- Booleans use the `--flag [value]` convention already in `task create`
  (`--start-in-plan-mode [v]`), parsed by one shared boolean parser; flag-only ⇒ `true`.
- `"default"` sentinel to clear an override is kept (`--model default`) and documented as a
  cross-cutting convention.
- Repeatable options use the `collectSet` pattern (`vault doc create --set k=v`).

---

## 7. AI-readability contract

This is the load-bearing section for the "agents must parse the CLI reliably" requirement.

1. **Stable, versioned envelope.** §4.2. `schemaVersion` lets an agent assert it
   understands the shape; additive changes are safe, breaking changes bump the version.
2. **Deterministic errors.** `{ ok:false, error:{ code, message, details } }` with a closed
   `code` enum (§6.3) and a matching exit code (§6.2). Agents branch on `code`/exit status,
   never on English text.
3. **Single-document stdout in `--json`.** No banners, no interleaved logs (those go to
   stderr). `kanban <anything> --json` ⇒ exactly one `JSON.parse`-able object.
4. **Self-describing manifest — `kanban schema`.** Emits the full capability catalog as
   JSON so an agent can discover commands without scraping help:

   ```jsonc
   {
     "schemaVersion": "1",
     "kanbanVersion": "0.1.68",
     "commands": [
       {
         "id": "task.create",
         "path": ["task", "create"],
         "summary": "Create a task in backlog.",
         "positionals": [],
         "options": [
           { "name": "prompt", "type": "string", "required": true },
           { "name": "agent-id", "type": "enum",
             "values": ["pi","claude","codex","droid","gemini","opencode","default"] },
           { "name": "auto-review-mode", "type": "enum", "values": ["commit","pr"] }
           /* … */
         ],
         "output": { "ref": "#/schemas/Task" },
         "errors": ["workspace_not_found","validation_failed","runtime_unreachable"]
       }
       /* … every command … */
     ],
     "schemas": { "Task": { /* JSON-schema-ish field map */ } },
     "errorCodes": [ /* the §6.3 enum with exit-code mapping */ ]
   }
   ```

   `kanban schema task.create` narrows to one command. This manifest is generated from the
   same option/parser definitions commander already holds (single source of truth), so it
   cannot drift from actual behavior.
5. **No NL-only state.** Every status an agent needs (task column, session state, service
   running, passcode present, health reachable) is a structured field, not only a sentence.
6. **Discoverability endpoint parity.** `kanban schema --json` is the CLI analogue of an
   OpenAPI document; combined with stable `command` ids in every response, an agent can
   plan → invoke → parse → branch entirely on machine fields.

---

## 8. Backward compatibility & migration

Guiding rule: **nothing an existing script/agent calls today should break on upgrade.**

| Old | New | Compat mechanism |
|---|---|---|
| `kanban task trash` | `kanban task done` | `trash` kept as alias; stderr deprecation warning + `warnings[]` in `--json` |
| `kanban passcode` | `kanban remote passcode show` | top-level `passcode` kept as deprecated alias |
| `kanban mcp` | (removed) | keep the deprecation warning one more cycle, then delete |
| `--agent <id>` (root) | (removed) | already hidden+ignored; keep ignoring, drop from `schema` |
| `--update` (root flag) | `kanban update` | flag kept as alias of the command |
| `--task-id <id>` etc. | positional `<id>` | **accept both**: positional preferred, `--task-id` still parsed (alias) during the compat window |
| per-command `--project-path` | global `--project-path` | global declared; per-command still accepted (commander inheritance), so existing invocations work unchanged |
| output: always pretty JSON | human default + `--json` | **auto-json when piped** (§4.4) preserves `| jq` pipelines; interactive users see the new human view. A `KANBAN_OUTPUT=json` escape hatch restores always-JSON for any script that ran interactively. |
| error string `{ok:false,error:"..."}` | `{ok:false,error:{code,message}}` | **shape change** — gated behind `schemaVersion` bump to `"1"`. During the window, also emit a top-level `error` *string* mirror alongside the object so naive readers keep working; drop the mirror at the next major. |

Deprecations are surfaced two ways: a one-line stderr warning (human) and a
`warnings:[{code:"deprecated_*"}]` entry (machine). A single env
(`KANBAN_SUPPRESS_DEPRECATION=1`) silences the stderr line for known-migrated scripts.

---

## 9. Phased rollout (task-splitting guide)

Each phase is independently shippable and separately reviewable.

- **P0 — Output/error foundation (no surface change).**
  Introduce the result-object + dual-renderer seam, the `{schemaVersion, ok, data|error}`
  envelope, the `error.code` enum, the exit-code taxonomy, and `--json`/`--human`/auto
  selection. Wire all existing commands to emit through it (keeping current command names).
  This is the highest-leverage, lowest-risk change and unblocks everything else.
  *Touches:* `runtime-workspace.ts` (`printJson`→envelope), `cli-output.ts` (human helpers),
  every `run*Command` wrapper.

- **P1 — Global flags.**
  Declare `--project-path`/`--json`/`--no-color`/`--quiet`/`--host`/`--port` once; read via
  `optsWithGlobals()`. Keep per-command `--project-path` working. Unify the port parser.

- **P2 — Naming & tree normalization.**
  Promote ids to positionals (alias old flags), rename `trash`→`done` (alias), add
  `task show`, regularize aliases/pluralization. Pure additive + alias work.

- **P3 — `kanban schema`.**
  Generate the capability manifest from commander definitions + a small per-command
  output-schema registry. Add `errorCodes` and exit-code mapping.

- **P4 — Remote/service consolidation.**
  Add `remote status` / `remote passcode show|set|disable`; enrich `service status` human
  render with the pointer; add bind-time discoverability line. Deprecate top-level
  `passcode`.

- **P5 — Human rendering polish.**
  Tables, summaries, colors, spinners across `list`/`show`/long-running commands. Pick the
  table/format dependency.

- **P6 — Deprecation cleanup (next minor/major).**
  Remove `mcp`, `--agent`, the legacy `error` string mirror, and (optionally) the oldest
  flag aliases per the §8 schedule.

Suggested ordering dependency: **P0 → P1 → {P2, P3, P4} (parallelizable) → P5 → P6.**

---

## 10. Open questions for review

1. **Auto-json-when-piped (§4.4):** the user spec says "human default + `--json`". Auto
   machine mode on a non-TTY is the agent-safety refinement. Accept, or require an explicit
   `--json` always (and keep pretty-JSON-when-piped via `KANBAN_OUTPUT`)?
2. **`schemaVersion` value:** start at `"1"` (this redesign is the first stable contract) —
   confirm we are not treating the *current* always-JSON shape as v0 that needs its own
   compat envelope.
3. **`remote` vs folding into `service`:** introduce a new `remote` noun, or put
   `status`/`passcode` under `service`? Recommendation: separate `remote` noun, because
   remote access applies to the bare `kanban --host …` launch too, not only the installed
   service.
4. **Drop vs keep short aliases** (`conn`, `rm`): recommendation keep (documented), since
   they cost nothing and aid humans; agents use canonical forms from `kanban schema`.
```
