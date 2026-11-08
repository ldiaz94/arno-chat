# Arno Chat

Mobile web interface for Arno on Cloudflare Containers with Ollama Cloud and GitHub OAuth.

The Worker preserves GitHub and Ollama credentials outside coding containers. The existing production endpoint is https://arno-compat-probe.lucelad.workers.dev.

## Session recovery

Repository metadata and the last 20 turns live in Durable Object storage. Full filesystem checkpoints are saved after initialization and each completed turn. A stopped container restarts from its last checkpoint. Sessions can be reopened from the recent-session list after reload or sign-in.

Cloudflare snapshots expire after 30 days without restoration. An interrupted turn may require retrying; only completed, checkpointed turns guarantee saved filesystem changes. Earlier prototype sessions without checkpoints cannot be recovered after their container has stopped.

## Mobile and repositories

The layout tracks the browser visual viewport for keyboard changes. Text wraps within the viewport, and the composer shares its height with a scrollable transcript. Repository listing supports pagination; search runs at the server over successive authenticated repository pages, including organization and collaborator repositories.

## Development

Run `npm test`. Required Worker secrets: `OLLAMA_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Never commit secret values. GitHub callback: `/auth/callback`.

`node browser-test.cjs` tests the served HTML with mocked API responses in Chromium. It covers search beyond page 1, session reopening after reload, and overflow at portrait, landscape, and keyboard-sized viewports. Install Playwright and set `CHROMIUM_PATH` if Chromium is elsewhere. This does not replace an authenticated GitHub/Ollama recovery test or physical iPhone keyboard testing.

Deployment keeps the existing `ArnoProbe` Durable Object class and `PROBE` binding for compatibility. Configure its container with the pinned runner image and the `durable_object` scheduling policy. See `deployment.json`.
