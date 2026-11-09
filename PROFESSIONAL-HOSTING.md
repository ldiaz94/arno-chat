# Professional hosting plan

## What is already hosted

The application is deployed on Cloudflare Workers. Durable Objects use persistent SQLite-backed storage for conversations, account preferences, opaque authentication records, usage counters, and session coordination. Coding runs in disposable Cloudflare Containers with filesystem checkpoints.

There is already a database. A separate traditional application server or PostgreSQL instance is not required merely to make persistence real.

The current deployment is a private product for the owner's use, with a login allowlist. Provider keys and MCP tokens have application-level envelope encryption in addition to platform storage protection.

## What a public commercial launch needs

1. A D1 account/control-plane database for users, organizations, plans, entitlements, billing references, connection metadata, and aggregate usage events.
2. Per-account budgets and concurrency limits enforced before model calls, web tools, and VM allocation.
3. Billing-provider checkout/webhooks and reconciliation. Store billing references, never card data.
4. Explicit retention, export, account deletion, and privacy policies.
5. R2-backed workspace backups for retention beyond the platform snapshot window and portability across runner images.
6. Provider health monitoring, alerts, structured operational logs, and tested restore procedures.
7. A selected-repository GitHub App for narrower coding permissions, while retaining independent identity login.
8. Abuse controls, rate limits, and an audited enrollment policy before removing the owner allowlist.

Keep live conversation coordination in per-session Durable Objects. Use D1 for cross-account queries and reporting; moving the entire interactive state machine into a central database would add contention without solving the account/billing work.

No unused D1 database or billing integration was provisioned as part of the UI work. Those services should be introduced with concrete migrations and operational ownership, not as a placeholder described as production-ready.
