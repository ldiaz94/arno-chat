# Operations

## Development and testing

- `npm install`, then `npm test`: ESLint, `prettier --check`, and the unit tests (`node --test test.mjs`, with test-hooks.mjs stubbing cloudflare:workers), which cover the backend, protocols, encryption, rendering, context, streaming usage, publication, and a wrangler bundle build. `npm run fmt` formats with Prettier.
- `node design-test.cjs` drives the local web/ files in the system Chromium through Playwright (a dev dependency) with mocked API responses. Set CHROMIUM_PATH if Chromium is not /usr/bin/chromium. Screenshots go to /tmp/arno-*.png.
- `node offline-test.cjs` serves web/ and mocked /api/ replies from a local server, lets the service worker warm its cache, cuts the network, reloads and checks a conversation, its image and artifact, the usage page, the offline banner and the disabled composer, then goes back online.
- `node browser-test.cjs` runs the same suite against the files served by the deployed endpoint (`ARNO_TEST_LIVE=1`).

The design test covers search through page three, the session drawer, Markdown/code/tables, model selection, usage, reviewed publishing, a dropped submission response, theme switching, citations and source previews, the docked code pane, account settings, row-level rename/delete, and horizontal overflow at widths from 360 to 3440 px, including keyboard-height viewports.

Browser fixtures test interaction contracts. They are not evidence of real OAuth or GitHub publication; host publishing tests mock GitHub to check validation, exact parent revision, branch creation and PR target. Real provider, container and research runs are recorded below.

Keep UI, protocol and provider changes testable separately. Add security tests for Markdown, path and publication changes. Update [ARCHITECTURE.md](ARCHITECTURE.md) when state ownership, retention or trust boundaries change. Never add a fallback that starts an empty workspace when a saved checkpoint is missing.

## Deployment

`npx wrangler deploy` (log in first with `npx wrangler login`). wrangler.jsonc names the Worker, the PROBE Durable Object binding and its ArnoProbe sqlite export (keep both to preserve session routing and storage), the pinned container image digest, the web/ assets directory and the login allowlist. Secrets persist across deploys. When a deploy changes any file in web/, bump `VERSION` in web/sw.js so installed apps take the new shell at once.

Encrypted Worker secrets:

- OLLAMA_API_KEY
- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- ACCOUNT_ENCRYPTION_KEY: 32 random bytes as base64; keep it, existing encrypted records need it
- VAPID_KEY (optional; turns on push notifications): a P-256 private key as JWK JSON. Generate and store it without printing or saving it: `node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>process.stdout.write(JSON.stringify(j)))" | npx wrangler secret put VAPID_KEY`. Never commit it. Replacing it invalidates every subscription; users turn notifications off and on again.

ALLOWED_GITHUB_LOGINS is a non-secret, comma-separated allowlist, currently `ldiaz94`. Do not remove it for a public launch without entitlements and budgets. Never retrieve, print or commit a secret value.

Production: https://arno-compat-probe.lucelad.workers.dev, OAuth callback at /auth/callback on the same host.

## Hosting

Hosted on Cloudflare Workers. SQLite-backed Durable Objects hold conversations, account preferences, opaque authentication records, usage counters and session coordination; coding runs in disposable Cloudflare Containers with filesystem checkpoints. That is already a database: no separate application server or PostgreSQL is needed for persistence. Provider keys and MCP tokens get application-level envelope encryption on top of platform storage protection.

A public commercial launch would need:

1. A D1 control-plane database for users, organizations, plans, entitlements, billing references, connection metadata and aggregate usage.
2. Per-account budgets and concurrency limits before model calls, web tools and VM allocation.
3. Billing checkout, webhooks and reconciliation, storing references and never card data.
4. Retention, export, account deletion and privacy policies.
5. R2 workspace backups, for retention beyond the platform snapshot window and portability across runner images.
6. Provider health monitoring, alerts, structured logs and tested restores.
7. A selected-repository GitHub App for narrower coding permissions, keeping independent identity login.
8. Abuse controls, rate limits and an audited enrollment policy before the allowlist goes.

Keep live conversation coordination in per-session Durable Objects; use D1 for cross-account queries and reporting. Moving the interactive state machine into a central database adds contention and does not solve the account and billing work. No D1 database or billing integration is provisioned; add them with real migrations and an owner.

## Troubleshooting

- Long delays: open Usage & workspace after a measured turn; preparation, agent execution, checkpointing and total are recorded separately, and the activity panel shows the current phase. A warm workspace skips restoration, but the CLI process still starts every turn.
- Forgotten conversation: check the session ID is unchanged. The host passes the retained transcript each turn, bounded by turn count and prompt size, so older turns may drop out. Switching models keeps history.
- Missing repositories: wait for Search complete, not the first cards. If GitHub denies an organization, review OAuth authorization and SSO. See "Accounts, providers and BYOK" in [ARCHITECTURE.md](ARCHITECTURE.md) for scope and GitHub App installation.
- Task interrupted: job status persists outside the container; reopen the session to resume polling. Do not resend an uncertain request with a new task ID. Review failed work before retrying; the last completed checkpoint is the restore point.
- Publish failure: if the review is stale, reopen it. If GitHub rejects branch creation, check whether the branch exists. If the branch exists but the PR failed, open the branch and create the PR on GitHub. Never force-update a user branch.

## Validation record

Real runs, with fixtures removed afterward. API fixtures in browser tests are not evidence of real GitHub publication, which the user should start after reviewing real work.

**2026-11-08, container recovery.** An isolated Worker and container (production runner image, ArnoProbe) created a marker file and model configuration, stored session metadata and transcript, saved a checkpoint, destroyed the container, restored through the application's start method and verified marker and transcript; then changed the model to gpt-oss:120b through the session handler, destroyed and restored again, and verified the model. Result: `passed: true` (file, history and switched model restored). It used no user repositories and no inference.

**2026-11-08, request recovery.** A browser test aborts the submission response after the body is saved and gets the result from the status endpoint. Backend tests cover durable enqueue, deduplication, concurrent-turn rejection and alarm completion without the original request. A temporary Worker ran a real fixture task through the production Durable Object and Ollama gateway with kimi-k3.1-pro: submit returned queued at once, status went running then completed, the model answered about the README, exit code 0, about 35 s queued to checkpointed. The original Safari failure's exact cause is not established; the design removes reliance on a long-lived phone request and resumes polling after a lost connection.

**2026-11-09, UI and live coding.** Chromium with API fixtures: a repository on page 3 of 300, mobile drawer and resuming a conversation, Markdown rendering, model dialog, usage and repository details, review and the branch/PR action against a mock API, recovery after an aborted response, portrait/landscape/keyboard/desktop overflow, light theme, and visual inspection of phone, desktop and usage screenshots. Host tests cover stale review rejection, pinned commit parent, new arno/ branch and PR base.

A fixture on the production Durable Object, runner image and Ollama Cloud Mistral Large 4:

| Turn | Task | Preparation | Agent | Checkpoint | Total | Ollama calls / tokens in / out |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Remember a phrase, read README.md, create note.txt, verify | 57 ms (warm) | 52,347 ms | 1,734 ms | 54,144 ms | 4 / 16,709 / 427 |
| 2 | Recall phrase, check remote and branch, confirm note.txt | 45 ms (warm) | 39,283 ms | 2,279 ms | 41,622 ms | 4 / 17,466 / 298 |
| 3 (after redeploy) | Recall phrase, create final.txt | 172 ms (restored) | 34,196 ms | 2,187 ms | n/a | 3 / 13,471 / 271 |

All exited 0; turn 2 recalled the phrase exactly and verified origin. Turn 3's review diff contained both new files and the exporter returned their exact contents; the transcript migrated to per-turn records and kept all three turns. A fresh Arno process still starts each turn.

Streaming: a real Mistral Large 4 chat call delivered its first preview in 1,256 ms, with three updates during the run. Reconnecting replayed the current preview, and the job finished after the second viewer left; the answer had 2,114 characters plus 1,572 of thinking, in 8,997 ms with no container. Automated tests cover unchanged coding-gateway SSE bytes, display-field filtering, stale round/turn rejection, replay after object recreation, viewer cancellation, escaped collapsed thinking and replacing the provisional response.

Other real calls: regular chat kept a phrase and applied account instructions with no container; a coding call used a remote MCP echo tool. Regular-chat research did three searches and six page reads with six citations in about 31 s (comparing Durable Objects and D1, from official docs and independent articles; no container). Coding research via the built-in MCP did three searches, three reads, refused a fourth search, and produced three citations (about 57 s model time, 267 ms preparation, 2.6 s checkpoint). Gemini's chat tool loop and coding gateway were exercised against the real API locally. OpenAI and Anthropic are covered by protocol tests; live calls need personal keys.

Still needing a person: keyboard behaviour on a physical iOS Safari, and a real GitHub publication.
