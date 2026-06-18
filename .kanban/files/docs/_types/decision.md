---
name: decision
label: Decision
description: An ADR-flavored record of a decision and its standing over time.
icon: GitBranch
slug_field: title
status_enum:
  - proposed
  - accepted
  - superseded
  - rejected
default_frontmatter:
  status: proposed
---
# How to author a Decision

A decision is crystallized out of a discussion and then ratified, so its status
describes the decision's *standing* over time (ADR-flavored).

- **title**: the decision, stated as a resolution (e.g. "Shard the board per task").
- **body**: the context that forced a choice, the options weighed, the decision,
  and its consequences.
- **status**: `proposed` (under discussion), `accepted` (in force),
  `superseded` (replaced by a later decision — link it), `rejected` (declined).

When a decision replaces an earlier one, mark the old one `superseded` and
`[[wikilink]]` between them rather than editing history.
