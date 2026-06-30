## npx kanban (Research Preview)

<p align="center">
  <img src="https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe" width="100%" />
</p>

A replacement for your IDE better suited for running many agents in parallel and reviewing diffs. Each task card gets its own terminal and worktree, all handled for you automatically. Enable auto-commit and link cards together to create dependency chains that complete large amounts of work autonomously.

> [!WARNING]
> Kanban is a research preview and uses experimental features of CLI agents like bypassing permissions and runtime hooks for more autonomy. We'd love your feedback in #kanban on our [discord](https://discord.gg/cline).

<div align="left">
<table>
<tbody>
<td align="center">
<a href="https://www.npmjs.com/package/kanban" target="_blank">NPM</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban" target="_blank">GitHub</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank">Feature Requests</a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank">Discord</a>
</td>
<td align="center">
<a href="https://x.com/cline" target="_blank">@cline</a>
</td>
</tbody>
</table>
</div>

### 1. Open kanban
```bash
# Run directly (no install required)
npx kanban

# Or install globally
npm i -g kanban
kanban
```
Run this from the root of any git repo. Kanban will detect your installed CLI agent and launch a local running webserver in your browser. No account or setup required, it works right out of the box.

By default the runtime binds to `127.0.0.1`, so only the local machine can connect. To expose it on your LAN, start it with `kanban --host 0.0.0.0` (or a specific interface IP). The startup output lists usable URLs for detected network interfaces; if another machine still cannot connect, check the OS firewall/security group. For a background service, bake the bind address in with `kanban service install --host 0.0.0.0`.

### 2. Create tasks
Create a task card manually, or open the sidebar chat and ask your agent to break work down into tasks for you. Kanban injects board-management instructions into that session so you can simply ask it to add tasks, link tasks, or start work on your board.

### 3. Link and automate
<kbd>⌘</kbd> + click a card to link it to another task. When a card is completed and moved to trash, linked tasks auto-start. Combine with auto-commit for fully autonomous dependency chains: one task completes → commits → kicks off the next → repeat. It’s a pretty magical experience asking your agent to decompose a big task into subtasks that auto-commit - he’ll cleverly do it in a way that parallelizes for maximum efficiency and links tasks together for end-to-end autonomy.

### 4. Start tasks
Hit the play button on a card. Kanban creates an ephemeral worktree just for that task so agents work in parallel without merge conflicts. Under the hood, it also symlinks gitignored files like `node_modules` so you don't have to worry about slow `npm install`s for each copy of your project.

> [!NOTE]
> [Symlinks (symbolic links)](https://en.wikipedia.org/wiki/Symbolic_link) are special "shortcuts" pointing to another file or directory, allowing access to the target from a new location without duplicating data. They work great in this case since you typically don't modify gitignored files in day-to-day work, but for when you do then don't use Kanban.

As agents work, Kanban uses hooks to display the latest message or tool call on each card, so you can monitor hundreds of agents at a glance without opening each one.

### 5. Review changes
Click a card to view the agent's TUI and a diff of all the changes in that worktree. Kanban includes its own checkpointing system so you can also see a diff from the last messages you've sent. Click on lines to leave comments and send them back to the agent.

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar instead of remembering commands or asking your agent to do it.

### 6. Ship it
When the work looks good, hit **Commit** or **Open PR**. Kanban sends a dynamic prompt to the agent to convert the worktree into a commit on your base ref or a new PR branch, and work through any merge conflicts intelligently. Or skip review by enabling auto-commit / auto-PR and the agent ships as soon as it's done. Move the card to trash to clean up the worktree (you can always resume later since Kanban tracks the resume ID).

### 7. Keep track with git interface
Click the branch name in the navbar to open a full git interface to browse commit history, switch branches, fetch, pull, push, and visualize your git all without leaving Kanban. Keep track of everything your agents are doing across branches as work is completed.

### 8. Run as a background service (optional)
Instead of keeping a terminal open, you can register the runtime as an OS-level service that starts automatically at login. Run these from the root of your git repo:

```bash
kanban service install            # register + enable at login, and start now
kanban service status             # JSON status (installed / running / enabled / pid)
kanban service stop               # stop the running service
kanban service start              # start it again
kanban service restart            # restart
kanban service uninstall          # disable + remove
```

Options for `install` (baked into the service definition): `--name <name>` (default `kanban`, useful for multiple boards), `--host <ip>` (use `0.0.0.0` for LAN access), `--port <n>`, `--no-passcode`, and TLS passthrough `--https --cert <path> --key <path>`. The other subcommands only take `--name` to identify the service. Every command prints JSON.

The generated launch command always includes `--skip-shutdown-cleanup` (so a service restart never deletes your in-flight task worktrees) and `--no-open` (a background service must not open a browser tab).

Each platform uses its own native mechanism — no extra daemon to install:

- **Linux — systemd user service** at `~/.config/systemd/user/kanban.service`, controlled with `systemctl --user`. Logs go to journald (`journalctl --user -u kanban -f`). To keep the service running after logout / at boot, run the hint it prints: `loginctl enable-linger <user>`.
- **macOS — launchd LaunchAgent** at `~/Library/LaunchAgents/ai.capsio.kanban.plist` (`RunAtLoad` + `KeepAlive`), controlled with `launchctl load -w` / `unload -w`. stdout/stderr go to `~/.kanban/logs/kanban.out.log` and `kanban.err.log`.
- **Windows — Task Scheduler** task (trigger: at logon), managed with `schtasks`. No admin rights required. For a true always-on Windows *Service* (starts before login, survives logout), wrap the same launch command with [NSSM](https://nssm.cc/).

---

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
