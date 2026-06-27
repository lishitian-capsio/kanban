---
_id: 81a8d
type: requirement
_created: 1782554714914
_updated: 1782558719777
priority: high
status: proposed
title: 'Add GitHub project by picking from authorized repos, not pasting a URL'
---
## Who is affected

The Kanban operator adding a project that lives on GitHub.

## What hurts today

Adding a project via clone is a blind "paste a git URL" action. Whether the runtime's GitHub credentials are actually usable for that repo is only discovered **after** the clone fails — there is no up-front signal that auth works, and no way to discover which repos the logged-in account can even reach. The operator has to know the exact URL and hope the token has access.

## What the customer needs

When adding a project the GitHub way, the operator wants to **pick a repo from the ones they're authorized to access**, instead of typing a URL:

- **Auth gates visibility — show it only when authenticated**: the GitHub repo-picker entry is **shown only when GitHub auth is set up** (the existing device-flow login in Settings). When **not** authenticated, the picker entry is simply **not displayed at all** — no disabled control, no inline 'log in first' prompt on this path. Authentication lives in Settings; once logged in, the picker appears.
- **Auth as the data source**: when shown, the picker lists the organizations and repositories reachable under that authenticated account as candidates.
- **Pick, don't type**: the operator selects an org → repo from the candidate list, and Kanban clones that one.
- **Auth validity is confirmed early**: the fact that the candidate list populates proves the credentials are usable — surfacing auth problems at add-project time, not at clone-failure time.

## What success looks like

- When GitHub auth is set up, 'add project' offers a GitHub path that shows authorized orgs/repos (searchable for large accounts); selecting one clones it over HTTPS (reusing the existing github.com credential injection at `runGit`).
- When GitHub auth is NOT set up, the GitHub repo-picker path is absent from the add-project surface.
- Pasting a raw URL remains available as a fallback for non-GitHub hosts / edge cases, regardless of GitHub auth state.

## Notes / open questions for delivery (not requirements)

- Listing repos needs GitHub REST API calls (`/user/orgs`, `/user/repos`, `/orgs/{org}/repos`) using the machine-local token; verify the device-flow OAuth scope is sufficient to list **private** repos (`repo` scope) — the current client id is the GitHub CLI's well-known one.
- This is GitHub-specific; other hosts (Gitee, GitLab, self-hosted) stay on the manual-URL path.
