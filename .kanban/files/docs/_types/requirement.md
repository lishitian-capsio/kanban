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
- **customer**: a `[[wikilink]]` to the customer this anchors to.
- **related_tasks**: ids of the tasks delivering against this problem.

Keep one problem per document. If a requirement names two needs, split it.
