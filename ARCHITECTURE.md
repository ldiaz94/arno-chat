# Architecture

Arno Chat turns a GitHub repository snapshot into a resumable remote coding workspace. The browser owns presentation; a Cloudflare Worker owns authentication and GitHub publication; one Durable Object per session owns coordination, transcript, task state, and the container.

## Source map

| File | Responsibility |
| --- | --- |
| worker.js | Entry: /auth/ sign-in, /api/ guard (same origin, sign-in, allowlist), route dispatch; re-exports the classes below |
| http.mjs | Shared response helpers: JSON, cookies, security headers, bounded request bodies |
| auth.mjs | GitHub OAuth, session cookies, GitHub API calls |
| api.mjs | The signed-in /api/ routes as a table, plus the ordered /api/sessions/:id/… paths |
| session.mjs | ArnoProbe Durable Object: turn lifecycle, workspace container, alarms; dispatches its internal routes |
| session-routes.mjs | Internal /session/* routes of a coding or chat session object |
| store-routes.mjs | Internal routes of the per-user index/profile and auth/OAuth store objects |
| gateway-routes.mjs | Internal callbacks from the model and MCP gateways (permits, progress, usage, research state) |
| gateways.mjs | ModelGateway and McpGateway entrypoints the container's traffic is routed through |
| prices.mjs | Daily-cached list prices (Ollama, Gemini, DeepSeek, Mistral and Meta pricing pages, OpenRouter for Anthropic/OpenAI/Kimi), turn cost by part, and web search/read rates derived from the account's Ollama usage data |
| gateway.mjs | Fixed-destination Ollama gateway, bounded payloads, streaming usage observation |
| context.mjs | Repository provenance and bounded conversation context for every Arno invocation |
| models.mjs | Live tool-capable cloud catalog and explicit fallback |
| account.mjs | Masked account settings, AES-GCM key envelopes, provider discovery |
| chat.mjs | Container-free conversation and research loop for every provider |
| web.mjs | Multi-result search, page reading, host-assigned citations, built-in research MCP |
| mcp.mjs | Account-approved HTTPS MCP proxy and initialization test |
| files.mjs | Read-only directory and UTF-8 code navigation |
| publish.mjs | Worktree export, host-side validation, cumulative diff including new files |
| push.mjs | Payload-less Web Push: VAPID signing, push-service allowlist, subscriptions and latest notice, its /api/ and index routes |
| web/index.html | The page's static markup; DOM IDs form the contract with the web/*.js modules |
| web/app.js | Entry: event wiring, icon setup and boot |
| web/core.js | DOM references, `state`, formatting helpers, API client, toast |
| web/layout.js | Viewport fit, drawer, busy flag, title bar, sidebar, theme |
| web/models.js | Model catalog and picker |
| web/thread.js | Message rendering, follow-the-stream scroll, sources, suggestions |
| web/sessions.js | Open, create, search, export, rename and delete sessions; home |
| web/info.js | Conversation details panel (title or usage button): context, usage, sources, links, images, repository |
| web/usage.js | Usage view: per-request report, spend summaries, by-model totals and the Ollama account card |
| web/artifacts.js | Artifact dialog (versions, Copy, .md and first-table .csv download, Print), turn cards, click handler |
| web/code.js | Code dialog: file browser, diff, review and publish |
| web/attach.js | Composer attachments: upload on pick/paste/drop, chips, attachment rendering for messages and details |
| web/turns.js | Sending, editing, job polling and live output |
| web/settings.js | Account settings dialog |
| web/push.js | Turn notifications on or off: permission, service worker, push subscription |
| web/sw.js | Service worker (registered only while notifications are on): shows the latest notice on a push, opens its conversation on a click |
| web/manifest.webmanifest | Installable web app manifest (needed for push on iPhone and iPad) |
| web/style.css | Responsive dark/light design tokens, layout, typography, reduced-motion rules |
| web/render.mjs | Escaping Markdown renderer, table sizing, CLI-banner cleanup, safe diff rendering (shared by browser and tests) |
| web/_headers | Security headers for the static files, including the page's CSP |
| wrangler.jsonc | Worker config, durable namespace, pinned container image, observability; `npx wrangler deploy` |
| test.mjs | Backend and rendering regression tests; test-hooks.mjs stubs cloudflare:workers for Node |
| design-test.cjs | Playwright browser workflow and viewport tests against the local web/ files; browser-test.cjs runs it against the deployed ones |

Everything in web/ is served by Cloudflare as static files, before the worker runs; the worker handles /api/ and /auth/ only.

Security boundaries are in [SECURITY.md](SECURITY.md); testing and deployment in [OPERATIONS.md](OPERATIONS.md).

## A session's lifecycle

1. The browser authenticates with GitHub using an opaque HttpOnly session cookie.
2. The user selects a repository and model. The Worker resolves the selected branch to an exact GitHub commit before downloading its archive.
3. The session's container imports the archive, creates a synthetic local baseline, configures the credential-free GitHub origin, records the source commit, and names the local branch.
4. The Durable Object checkpoints the filesystem and atomically saves its session metadata with the checkpoint handle.
5. The recent-session index stores the session ID under the authenticated GitHub user ID.
6. Completed turns reuse the same running container. If it has stopped, start restores the saved checkpoint.

The imported archive does not contain the original Git object database. The synthetic local baseline is used for review; GitHub publication uses the original remote commit as its parent. This distinction is deliberate and is included in the model context.

## A turn's lifecycle

Submission stores a job and schedules an alarm, then immediately responds with HTTP 202. A repeated submission with the same ID returns the same job. An active session rejects a different concurrent job.

The alarm changes the job from queued to running and invokes Arno with a four-minute process deadline. The job records phases:

- preparing: reuse of a running workspace;
- restoring: restart from the saved filesystem;
- thinking: Arno/model/tool execution;
- checkpointing: preserve the resulting filesystem and conversation.

Stop is an explicit user action. It cancels the job, revokes its model quota, and destroys the container so child processes cannot continue. The next turn restores the last completed checkpoint. The UI warns that uncheckpointed work will be discarded. Stopping is rejected once checkpointing has begun.

Arno is a fresh CLI process per turn. The container and repository remain the same. To preserve conversation semantics, context.mjs supplies host-owned repository identity and the most recent 20 turns, bounded to 32,000 characters, before the current request. This is bounded conversational continuity, not an unlimited context window or a persistent interactive Arno process.

After execution, the host collects the cumulative diff, model request count, provider-reported usage, phase timings, and raw diagnostics. It saves the filesystem checkpoint, transcript, and cumulative statistics before returning a completed job. Each turn is stored as an individual bounded record, with lazy migration from the original single history value. The browser polls saved status and may leave/reopen without replaying work.

## Routes

All API routes require the GitHub-authenticated session cookie except GET /api/me. Cross-origin requests are rejected. JSON errors have an `error` field; provider and token values are never included.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | / and static files | web/ served as static assets (not the worker) |
| GET | /auth/github | Begin GitHub OAuth |
| GET | /auth/callback | Consume state and exchange code |
| GET | /auth/logout | Delete the authentication record and clear cookie |
| GET | /api/me | User profile and GitHub configuration status |
| GET | /api/models | Live tool-capable catalog or labeled fallback |
| GET/POST | /api/account | Masked preferences, system prompt, skills, MCP, custom models |
| POST | /api/account/key | Encrypt/save or remove a personal provider key |
| POST | /api/account/test | Verify provider model-API access |
| POST | /api/account/mcp-test | Verify configured MCP initialization |
| POST | /api/chats | Create an ordinary conversation without a container or repository |
| GET | /api/repos?page=N&q=text | Search one authenticated repository page; returns repos, scanned, nextPage |
| GET | /api/sessions | Recent sessions owned by the user |
| POST | /api/sessions | Create a workspace from repo, ref, model |
| GET | /api/sessions/:id | Repository identity, transcript, workspace state, cumulative statistics |
| PATCH | /api/sessions/:id | Rename a conversation |
| DELETE | /api/sessions/:id | Delete an idle conversation and its saved workspace reference |
| GET | /api/sessions/:id/files?path=... | Browse directories or preview a regular UTF-8 file |
| POST | /api/sessions/:id/messages | Save a task from id and prompt; returns HTTP 202 |
| GET | /api/sessions/:id/job | Latest durable task state and completed result |
| GET | /api/sessions/:id/events | Server-sent events: live preview of the running task |
| POST | /api/sessions/:id/model | Save model selection for the next turn |
| POST | /api/sessions/:id/cancel | Stop an active task and preserve the last completed checkpoint |
| GET | /api/sessions/:id/changes | Export exact changed text files and a review digest |
| POST | /api/sessions/:id/publish | Validate digest, create a new arno/ branch and commit, open a PR |
| GET | /api/push/key | VAPID public key for the browser; 404 when VAPID_KEY is not set |
| POST | /api/push/subscribe | Save `endpoint` (a known push service only) for the user, at most 10 |
| POST | /api/push/unsubscribe | Forget `endpoint` |
| GET | /api/notifications/latest | The latest notice {title, body, url, at}, fetched by the service worker |

Payloads worth knowing:

- Create session: `repo` is owner/name, `ref` the selected branch, `model` an approved model ID. The host resolves `ref` to a 40-character source commit and downloads that exact archive. The response has id, repo, ref, model, sourceSha, remoteUrl, createdAt.
- Submit task: `id` is a client-generated UUID, `prompt` is 1-8,000 characters. Reusing an ID deduplicates an uncertain submission; a different ID gets 409 while a turn is queued or running. Never retry an uncertain request with a new UUID. In a regular chat, optional `editAt` (a saved turn's `at`) replaces that turn: it and every later turn are left out of the context and deleted once the new answer is saved.
- Publish: `digest` must match the reviewed files and source revision. `branch` is `arno/` plus an alphanumeric, underscore or hyphen name. `title` is the commit/PR title, at most 200 characters. The result has branch, commit, url, and a `warning` if the branch exists but the PR could not be opened.

### Task state

A job has id, prompt, status, createdAt, stage, and optional timing fields while active; terminal states add result and finishedAt.

| Status | Meaning |
| --- | --- |
| queued | Durable input exists; alarm scheduled |
| running | Alarm owns Arno execution |
| completed | Output and resulting checkpoint saved |
| failed | Execution, provider, or persistence failed; error available |
| cancelled | Explicitly stopped; resume from previous checkpoint |

Stage is preparing, restoring, thinking, or checkpointing: work phases, not percent complete. A completed result has summary, model, exitCode, diff, diagnostics, timing (preparation, agent execution, checkpoint, total, workspace mode) and usage (calls, measuredCalls, inputTokens, outputTokens, cost; token values may be null).

### Live events

GET .../events is an authenticated text/event-stream with the same owner-scoped routing as polling. Preview events carry jobId, round, text, reasoning, updatedAt. Each event is a complete bounded snapshot, so a reconnect never duplicates tokens; the current preview is replayed on connect and also returned by GET .../job as a polling fallback. Closing a stream does not cancel its job; the durable job completion is the final saved result. Thinking comes only from provider-designated display fields, is collapsed in the UI and excluded from later prompts (except for DeepSeek and Kimi, see Providers); encrypted or redacted reasoning and signatures are never exposed.

## State ownership

One Durable Object class (ArnoProbe) has separate named instances:

- `auth:<cookie id>`: encrypted-at-rest GitHub token and user identity;
- random OAuth state instances: short-lived, one-time;
- `index:<github user id>`: that user's recent-session entries;
- `code:<github user id>:<session id>`: repository metadata, checkpoint, transcript, task, statistics.

Internal /session, /model, /auth and /index paths are binding-only; no public router reaches them. The model gateway can request a quota permit and report usage but has no GitHub publication authority.

Keys in a session object:

- `session`: repository provenance and selected model.
- `snapshot`: the opaque Cloudflare checkpoint handle.
- `turn:<timestamp>:<uuid>`: one retained transcript turn each; `history` is the legacy key, migrated after a successful turn.
- `stats`: measured cumulative counters.
- `job`: latest task state.
- `modelQuota`: current turn ID, deadline, used calls, measured usage.
- `live`: latest bounded preview, persisted at most once a second plus at model-pass completion. In-memory previews may be newer, so a reconnect after an object restart can briefly replay the persisted one. Previews are scoped to a job ID.

The checkpoint, current transcript record and statistics are written together after successful persistence. A snapshot failure never replaces the last good checkpoint.

## Accounts, providers and BYOK

Sign-in is separate from repository access. GitHub OAuth is the identity provider. A fresh sign-in requests `read:user`, enough for ordinary conversations. Connecting GitHub from the repository browser or account connections requests `repo` scope for private coding workspaces. Accounts that already granted `repo` may keep it; the app cannot revoke a scope by requesting less later.

The app does not bypass GitHub permissions. If a connection sees few repositories (say 17), that is a visibility result: the API reports scopes and SSO hints. A GitHub App user token is identified separately; expand its selected repositories at https://github.com/settings/installations. Organizations may need approval or SSO authorization.

Repository discovery reads GitHub's user/repositories endpoint page by page and filters each page by name or description. A search continues through every page and shows checked/matched counts; a blank query uses Load more. Continuation uses both the Link header and a full-page fallback, so a missing header cannot hide repositories after the first 100. Archived repositories are listed and labeled. Pasting an exact owner/repo or GitHub URL also tries a direct authorized lookup.

Providers:

- Ollama Cloud, with a personal key or the private deployment's fallback.
- OpenAI Chat Completions-compatible models.
- Anthropic's native Messages API.
- Google Gemini through its OpenAI-compatible endpoint. Each tool call carries a thought signature that is sent back on the next round; thoughts arrive in the text as `<thought>...</thought>` and move to the Thinking panel; thinking tokens, missing from completion_tokens, are counted from total_tokens.
- DeepSeek, Kimi (Moonshot AI), Mistral and Meta Model API through their OpenAI-compatible endpoints: api.deepseek.com, api.moonshot.ai/v1 (international; api.moonshot.cn is mainland China), api.mistral.ai/v1 and api.meta.ai/v1 (the successor of the Llama API at api.llama.com). Their quirks live in `PROVIDERS` (account.mjs) and are applied by both chat.mjs and the coding gateway: Kimi and Meta take `max_completion_tokens`, DeepSeek and Mistral `max_tokens`; Mistral rejects `stream_options` (its last chunk carries usage anyway) and streams thinking as lists of `thinking`/`text` content chunks, which `mistralDeltas` rewrites into `content` and `reasoning_content` strings for the runner and the display. DeepSeek returns HTTP 400 when a request with tools lacks earlier thinking, and Kimi asks for it (Preserved Thinking), so both get `reasoning_content` back on assistant messages, past turns included (as saved, up to 12,000 characters); Mistral and Meta are not sent thinking (Meta keeps its reasoning private). Usage: DeepSeek's and Meta's cache reads are `cached_tokens` inside `prompt_tokens` (DeepSeek also names them `prompt_cache_hit_tokens`); Kimi also reports `cache_write_tokens` inside `prompt_tokens`. Model lists: Mistral's keeps models with the `completion_chat` capability and drops a `-latest` alias whose model is listed; Meta's drops image, voice and segmentation models. Prices: DeepSeek's page (peak and off-peak, weekday windows; Chinese holidays priced at peak), Mistral's and Meta's pages (Meta's `-contributor` models at Contributor rates), Kimi through OpenRouter's `moonshotai/` entries; their price keys keep the provider prefix, so Ollama's price for the same open model never stands in.

Custom model IDs are `openai/`, `anthropic/`, `gemini/`, `deepseek/`, `kimi/`, `mistral/` or `meta/` plus the model ID (Ollama's have no prefix). Connected providers' models join the shared model dialog (Gemini's, Mistral's and Meta's lists are filtered to chat models). Coding sessions run Arno with its `openai` provider for these four; the gateway behind model.internal chooses the real upstream. Responses-only, realtime, image and audio APIs are not implemented. API billing is separate from ChatGPT/Claude consumer subscriptions.

Keys are AES-GCM encrypted with a random IV and authenticated data bound to user ID and credential field; the master key is the encrypted Worker secret ACCOUNT_ENCRYPTION_KEY (see [SECURITY.md](SECURITY.md)). Public account responses carry saved/available flags, never values or ciphertext. Rotating the secret needs a decrypt/re-encrypt migration, so never rotate it casually. Keys save separately from other preferences. Test connection checks authenticated access and reports a model count; Ollama's catalog is public, so its test also sends a one-token inference request. Saved does not mean tested. Key inputs are cleared after saving and when the dialog closes, and never go to localStorage.

Account system prompt and skills: the prompt applies to later chat and coding requests; enabled skills are named instruction snippets appended to it. They are not shell startup scripts or a plugin installer. Limits: 12,000 characters of prompt, 10 skills of 4,000 characters, 64 KB per account update.

Remote MCP: coding sessions support up to six public HTTPS Streamable HTTP servers, with or without a saved bearer token, disabled until enabled in account preferences. Test performs a real initialize exchange and reports protocol and server identity. Arno sees them through an internal `mcp.internal` gateway that resolves only enabled connections, fixes the endpoint, injects the token outside the container, refuses redirects, limits methods and task requests, and forwards only required session/protocol headers. The host writes an internal alias URL into Arno's configuration, never the token. MCP IDs are lowercase slugs; `web` is reserved for built-in research. Regular chat has the built-in web tools but not custom MCP. MCP OAuth, stdio installation, resources/prompts and third-party connector OAuth are not implemented.

Regular conversations: New chat allocates no VM and imports no repository. The host runs a bounded provider tool loop with persistent history, research, usage and cancellation. Any conversation can be renamed or deleted from its list row; deletion needs confirmation, rejects active work, and removes application records and the workspace handle (Cloudflare's snapshot retention still follows its TTL).

The private deployment is restricted to ldiaz94 by ALLOWED_GITHUB_LOGINS so arbitrary sign-ins cannot spend the owner's subscriptions. Removing that needs entitlements, budgets, billing, abuse controls and retention policies ([OPERATIONS.md](OPERATIONS.md)).

## Model selection, gateway and telemetry

The model dialog loads the catalog and includes completion models with tool support. Selecting a model saves metadata only: no container wakes and no checkpoint is made. The next turn updates the CLI configuration and gateway policy.

The gateway rebuilds allowed inference requests, fixes the upstream to the selected provider's origin, and adds credentials outside the container. A streaming observer reads provider SSE usage chunks while forwarding the original bytes unchanged. Each usage report carries a turn ID, so a stale response cannot touch a later turn's counters.

Statistics are cumulative from when measurement was added. Missing provider usage shows as unavailable. Requests, tokens and wall time are separate measurements. Cost is each turn's tokens at the model's list price, computed when the turn is saved (prices.mjs); a model absent from the price tables is counted as unpriced, never guessed. Web searches and page reads are priced at the per-request rates Ollama billed the account, read daily from ollama.com/api/usage?group_by=model (undocumented; fallback $0.011 and $0.001). Each turn stores its cost by part (input, cached input, cache writes, output, searches, reads) and the session sums them for the breakdown in the details panel.

## Web research and citations

Regular and coding conversations both have search and page-reading tools. The host calls Ollama's POST /api/web_search and /api/web_fetch at fixed URLs, so source sites never see the Ollama key. A personal Ollama key is used when configured, otherwise the deployment fallback.

Bring-your-own search: an account can save its own SearXNG (Settings › Providers › Web search) as `{url, auth: none|access|bearer, clientId, secret}`. The URL must be public HTTPS (at most 500 characters, no credentials, query or fragment); the Cloudflare Access client secret or bearer token is sealed like provider keys (field `search:secret`), and reads return only url, auth, clientId and `hasSecret`. `POST /api/account/search` saves (`{remove: true}` removes); `POST /api/account/search-test` runs one query and reports the result count and latency. With a connection saved, web_search sends `GET <url>/search?q=…&format=json&language=auto&safesearch=0` with `CF-Access-Client-Id`/`CF-Access-Client-Secret` or `Authorization: Bearer`, no redirects, 10 s timeout and the bounded JSON reader, and maps the top six `results[]` into the same source records. On an error, timeout, non-JSON answer (403 usually means `format=json` is disabled) or no results, it falls back to Ollama search. Per turn `webUsage.searxng` counts SearXNG searches (free) and `webUsage.searches` only Ollama's (billed); the three-search limit counts both. web_read always uses Ollama.

- Search returns up to six results. The model is told to compare them, prefer primary documentation, read original pages, and read at least two credible pages for a comparison.
- Per turn: up to three searches and six page reads. Regular chat allows up to eight model rounds, the last one without tools. Coding uses Arno's MCP tool loop with its usual call and process limits.
- Web content is evidence, not instructions. Tool failures are reported as failures.
- Regular chat uses OpenAI/Ollama function calls or Anthropic tool-use blocks, answering in the provider's own protocol. Coding gets the same read-only tools (web_web_search, web_web_read) from an internal MCP server, trusted in Arno's configuration so reading several sources does not use up its interactive approval input.
- The host numbers actual results. A source record holds URL, title, excerpt and retrieval time; the recent registry holds 30 records, and retained turns keep their own. The model cites as [1], [2]; the renderer makes a button only for IDs in the answer's saved records, so invented numbers stay plain text. A button or source card opens a preview with domain, title, excerpt, retrieval time and original link. This makes citations inspectable, not correct.

## Publishing

The review action exports changed regular text files from the worktree, new files included. The export script and the host both validate paths, file count, modes, encoding and size; container output is untrusted even from a fixed script.

The review includes a SHA-256 digest of the files and the source revision. Publishing exports again and rejects a changed digest. The Worker creates a Git tree and a commit whose parent is the pinned source commit on a new `arno/` branch, then opens a pull request against the selected base. Existing branches are never overwritten. If PR creation fails after the branch exists, the UI links the branch and reports the partial result. Sessions without a recorded source revision must be reopened as new ones before publishing.

## Notifications

When a turn ends completed or failed (not stopped), `alarm()` calls `notify()`, which hands the owner a notice: the conversation title, the first 120 characters of the answer or the error as plain text, and `/?session=<id>`. push.mjs stores it as the user's latest notice in `index:<user>` and sends each saved subscription an empty push signed with VAPID (RFC 8292; `TTL: 3600`). A push service answering 404 or 410 deletes that subscription. Without VAPID_KEY or subscriptions nothing is sent; errors are logged and never fail the turn; each push is bounded to 5 s.

The push carries no payload, so there is no RFC 8291 encryption. web/sw.js wakes on it, fetches `GET /api/notifications/latest` with the user's cookie and shows it, unless an app window is visible. A click focuses an app window and navigates it to the link, or opens one; app.js opens the `?session=` conversation and removes the query. The settings Connections tab turns notifications on (permission, register sw.js, subscribe) or off (unsubscribe both sides, unregister sw.js). On iPhone and iPad push works only from the Home Screen app, so the page has a manifest and the toggle says so.

## Interface

Remote coding is presented as a workspace, not a terminal transcript.

- Look: dark slate surfaces with mint accents, light theme via CSS variables (colors, surfaces) in web/style.css, system font stack (no network fonts), cards and borders for hierarchy, transitions that respect prefers-reduced-motion.
- Layout: a 252px sidebar that becomes an off-canvas drawer on phones; transcript capped at a readable width and the only scrolling element, with the composer in the surrounding flex layout. The shell follows visualViewport height and offset so the mobile keyboard shrinks the transcript. Inputs use 16px text to avoid Safari focus zoom. Code, tables and diffs scroll in their own containers. The code browser docks beside chat on ultrawide screens and opens as a dialog on smaller ones. Account settings open from the avatar/name, as a full-height sheet with a persistent save area on mobile.
- Images: Markdown `![alt](https://…)` renders as an `<img>` pointing at `/api/image?url=…` (proxyImage in api.mjs), wrapped in a link to the original; the page CSP's `img-src 'self'` is enough, and a GET without an Origin header passes sameOrigin. - Reading: safe Markdown; CLI setup banners collapse into execution details; code blocks have language labels and copy buttons; tables size to content (short cells on one line, long ones wrap near 40 characters, wide ones scroll, column edges drag, double-click resets).
- Input: send button and Cmd/Ctrl+Enter; Enter alone adds a newline, which suits mobile. Drafts persist per session in the tab. The model dialog searches names and IDs, and opens with Cmd/Ctrl+K. Regular-chat messages have an Edit button: sending an edit replaces that message and the turns after it.
- Footers and usage: each turn footer shows completion, wall time, measured tokens and list-price cost when available. The Usage & workspace dialog separates provider counters, phase timings and repository identity; unknown values show a dash with an explanation.
- Honest state: search reports progress until every page is scanned; task activity distinguishes restoring, preparing, execution and checkpointing; a warm workspace is labeled apart from a saved sleeping one. No account balances, live tool traces or completion percentages are invented.
- Artifacts: a turn's `artifacts` show as cards under the answer, `[Title](artifact:<uuid>)` renders as a button, and the details panel lists them; all open web/artifacts.js's dialog, which fetches the document, offers its earlier versions, and prints alone through a print stylesheet.
- Accessibility: descriptive button names, decorative SVGs hidden, native modal focus management, named dialog headings, visible focus outlines, role=status toasts, explicit form buttons.

Client state: drafts and the last selected session ID live in sessionStorage; repository and conversation state stay server-owned. Navigation (resume in web/sessions.js) increments a generation when navigation changes, and async results and job polls check it before repainting. Repository search has its own generation so an old query cannot overwrite a new one.

## Limits and retention

- Cloudflare checkpoints are kept 30 days, refreshed by restoration.
- Up to 20 turns are retained; very large diffs and logs are truncated for display.
- Each task allows up to 16 model calls, a four-minute CLI deadline and 16,384 output tokens per inference request (regular chat too; Gemini keeps its own default, since thinking counts against it). Gateway bodies are capped at 1 MB; repository archives at 50 MB.
- Container Internet access is off. Model inference, built-in research and enabled remote MCP are host-mediated exceptions. Arbitrary dependency downloads are unavailable.
- Publishing takes up to 50 regular UTF-8 changed files totaling 1 MB; binary files and symlinks are rejected.
- Answer text and provider-exposed thinking stream live over SSE; coding previews show the current model pass. Tool arguments and raw tool events are not streamed; the final coding result appears after its checkpoint.
- Regular chat uses no VM, with a bounded host-side research loop and a quiet loading state.
- Not available: account balance, unlimited context, a live terminal, MCP OAuth/stdio.

Do not describe these as feature parity with another coding product.
