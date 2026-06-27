---
_id: 81a8d
type: requirement
_created: 1782554714914
_updated: 1782558872945
priority: high
status: proposed
title: 'Add GitHub project by picking from authorized repos, not pasting a URL'
---
## Who is affected

The Kanban operator adding a project that lives on GitHub.

## What hurts today

Adding a project via clone is a blind "paste a git URL" action. Whether the runtime's GitHub credentials are actually usable for that repo is only discovered **after** the clone fails — there is no up-front signal that auth works, and no way to discover which repos the logged-in account can even reach. The operator has to know the exact URL and hope the token has access.

## What the customer needs

Add-project supports **two coequal, coexisting methods** — neither replaces the other:

### Method A — pick from authorized GitHub repos (auth-backed)

- **Auth gates visibility — show it only when authenticated**: the GitHub repo-picker entry is **shown only when GitHub auth is set up** (the existing device-flow login in Settings). When **not** authenticated, the picker entry is simply **not displayed at all** — no disabled control, no inline 'log in first' prompt on this path. Authentication lives in Settings; once logged in, the picker appears (and disappears on logout), live.
- **Auth as the data source**: when shown, the picker lists the organizations and repositories reachable under that authenticated account as candidates (searchable for large accounts).
- **Pick, don't type**: the operator selects an org → repo and Kanban clones that one over HTTPS.
- **Auth validity is confirmed early**: the candidate list populating proves the credentials are usable — surfacing auth problems at add-project time, not at clone-failure time.

### Method B — manual / paste-URL (no auth required, the current behavior)

- Always available, **independent of any Kanban-side GitHub auth**. Paste a git URL (or pick a local path) and clone.
- This is the path for public repos and for non-GitHub hosts (Gitee, GitLab, self-hosted). It is a **first-class method, not a degraded fallback** — it stays exactly as it works today.

## What success looks like

- Both methods are offered from 'add project'. Method A appears only when GitHub auth is set up; Method B is always present.
- Method A: shows authorized orgs/repos, selecting one clones over HTTPS (reusing the existing github.com credential injection at `runGit`).
- Method B: behaves exactly as today — paste-URL / manual clone, no auth needed.

## Notes / open questions for delivery (not requirements)

- Listing repos needs GitHub REST API calls (`/user/orgs`, `/user/repos`, `/orgs/{org}/repos`) using the machine-local token; verify the device-flow OAuth scope is sufficient to list **private** repos (`repo` scope) — the current client id is the GitHub CLI's well-known one.
- Method A is GitHub-specific; everything else stays on Method B.
