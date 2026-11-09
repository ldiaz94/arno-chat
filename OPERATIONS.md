# Development, deployment, and validation

## Local checks

Run npm test for backend, renderer, context, publishing, and streaming-usage tests. Run node design-test.cjs with Playwright installed and Chromium available. Set CHROMIUM_PATH if it is not /usr/bin/chromium.

The design test uses the local web/ files and mocked API responses. It exercises search through page three, the session drawer, Markdown/code/tables, model selection, usage, reviewed publishing, a dropped submission response, theme switching, and viewport overflow. It writes screenshots to /tmp/arno-*.png.

browser-test.cjs runs the same design suite against HTML downloaded from the deployed endpoint. design-test.cjs runs against current local modules. Both keep API responses mocked; real provider validation is recorded separately.

No browser fixture test is evidence of real OAuth authorization or GitHub publication. Host publishing tests mock GitHub to verify validation, exact parent revision, branch creation, and PR target. Real provider/context validation is recorded separately.

## Deployment

Deploy with `npx wrangler deploy` (wrangler is a dev dependency; run `npm install` first). wrangler.jsonc names the Worker, the PROBE Durable Object binding and its ArnoProbe sqlite export (keep both to preserve session routing and storage), the container's pinned runner image digest, and the login allowlist. Secrets are kept across deploys.

Required encrypted Worker secrets:

- OLLAMA_API_KEY
- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- ACCOUNT_ENCRYPTION_KEY (32 random bytes encoded as base64; retain it for existing encrypted records)

ALLOWED_GITHUB_LOGINS is a non-secret comma-separated login allowlist. The current private configuration allows ldiaz94. Do not remove it for a public launch without account entitlements and budgets.

Production: https://arno-compat-probe.lucelad.workers.dev

OAuth callback: https://arno-compat-probe.lucelad.workers.dev/auth/callback

Wrangler must be logged in (`npx wrangler login`); no provider secret value should be retrieved, printed, or placed in the repository.

## Troubleshooting

### Long delays

Open Usage & workspace after a measured turn. Preparation, agent execution, checkpointing, and total time are recorded separately. The task activity panel shows its current phase while it runs. A warm workspace should skip restoration; the CLI process still starts for each turn.

### Forgotten conversation

Check that the session ID has not changed. The host passes its retained transcript on every turn. The context is bounded; old turns beyond retention or the prompt bound may no longer be included. Switching models preserves the same session history.

### Missing repositories

Wait for Search complete, not just the first visible cards. Search scans all accessible pages. If GitHub denies access to an organization, review OAuth authorization/SSO access. A repository outside that authorization cannot be found by pagination.

### Task interrupted

The job status persists outside the container. Reopen the session to resume polling. Do not automatically resend an uncertain request with a new task ID. Failed or interrupted work should be reviewed before retrying; the last completed checkpoint remains the restore point.

### Publish failure

If the review is stale, reopen it. If GitHub rejects branch creation, check whether the branch already exists before retrying. If the branch exists but PR creation failed, open the branch link and create the PR on GitHub. Never force-update a user branch to work around a conflict.

## Change review

Keep UI, protocol, and provider changes testable separately. Add security tests for Markdown, paths, and publication changes. Update ARCHITECTURE.md when state ownership, retention, or trust boundaries change. Do not silently introduce a fallback that starts an empty workspace when a saved checkpoint is missing.
