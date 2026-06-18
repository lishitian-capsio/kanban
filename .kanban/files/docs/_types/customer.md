---
name: customer
label: Customer
description: The physical anchor of requirements — a person or organization with needs.
icon: Building2
slug_field: title
---
# How to author a Customer

A customer is the physical anchor of the chain 客户 → 需求 → 任务. It has no
status lifecycle — it simply exists and accumulates context.

- **title**: the customer's name (person or organization).
- **body**: who they are, their domain, how we reach them, and any standing
  context that helps interpret their requirements.
- **materials**: an array of file-library ids pinning supporting material
  (decks, transcripts, contracts).

Requirements point *here* via a `customer` wikilink; you do not list
requirements on the customer.
