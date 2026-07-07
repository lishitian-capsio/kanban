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
relations:
  supersedes:
    label: Supersedes
    target: decision
    inverse: superseded_by
    inverse_label: Superseded by
  contradicts:
    label: Contradicts
    target: decision
    inverse: contradicts
    inverse_label: Contradicts
---
# How to author a Decision

A decision is crystallized out of a discussion and then ratified, so its status
describes the decision's *standing* over time (ADR-flavored).

- **title**: the decision, stated as a resolution (e.g. "Shard the board per task").
- **body**: the context that forced a choice, the options weighed, the decision,
  and its consequences.
- **status**: `proposed` (under discussion), `accepted` (in force),
  `superseded` (replaced by a later decision), `rejected` (declined).

## Typed relations (frontmatter fields, not prose links)

Record how decisions relate as `[[wikilink]]` values in these **frontmatter
fields**, so the links are queryable rather than buried in prose:

- **supersedes**: an earlier decision this one replaces. Also set the
  superseded decision's `status` to `superseded`; its reverse (`superseded_by`)
  is derived, so you do not author it there.
- **contradicts**: a decision that conflicts with this one. Symmetric — you
  need only record it on one side.
