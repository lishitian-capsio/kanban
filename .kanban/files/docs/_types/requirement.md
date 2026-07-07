---
name: requirement
label: Requirement
description: >-
  A customer-facing problem statement — what the customer needs, not how to
  build it.
icon: ClipboardList
slug_field: title
status_enum:
  - proposed
  - clarified
  - parked
  - invalid
default_frontmatter:
  status: proposed
  priority: medium
relations:
  customer:
    label: Customer
    target: customer
    cardinality: one
    inverse: requirements
    inverse_label: Requirements
  depends_on:
    label: Depends on
    target: requirement
    inverse: blocks
    inverse_label: Blocks
---
# How to author a Requirement

A requirement faces the **customer**, so it describes the *problem*, not the
delivery. State the need from the customer's point of view; leave solutions,
tasks, and implementation detail out.

- **title**: a short problem statement, phrased as the customer's need.
- **body**: the context — who is affected, what hurts today, what success looks
  like. Capture the customer's own words where you can.
- **status**: the problem's lifecycle, not delivery —
  `proposed` (raised), `clarified` (understood), `parked` (deferred),
  `invalid` (not a real need).
- **priority**: how pressing the problem is for the customer.

## Typed relations (frontmatter fields, not prose links)

Declare relationships as `[[wikilink]]` values in these **frontmatter
fields** — that is what makes them queryable; do not bury them as prose
links in the body:

- **customer**: the one customer this problem anchors to (e.g.
  `[[Acme Corp]]`). Exactly one.
- **depends_on**: other requirements that must be resolved first (may be
  several). Its reverse — what this blocks — is derived, so do not author it.
- **related_tasks**: board task ids delivering against this problem — plain
  ids, not a vault relation (tasks live on the board, not in the vault).

Keep one problem per document. If a requirement names two needs, split it.
