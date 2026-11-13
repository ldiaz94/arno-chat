# Architecture

Arno Chat turns a GitHub repository clone into a resumable remote coding workspace. The browser owns presentation; a Cloudflare Worker owns authentication, credentials and GitHub access; one Durable Object per session owns coordination, transcript, task state, and the container.

## Source map

| File | Responsibility |
| --- | --- |
| server/worker.js | Entry: /auth/ sign-in, /api/ guard (same origin, sign-in, allowlist), route dispatch; re-exports the classes below |
| server/http.mjs | Shared response helpers: JSON, cookies, security headers, bounded request bodies |
| server/auth.mjs | GitHub OAuth, session cookies, GitHub API calls |
| server/api.mjs | The signed-in account /api/ routes as a table (the ordered /api/sessions/:id/… paths are in sessions-api.mjs) |
| server/sessions-api.mjs | The /api/sessions/:id/… routes: a forwarding table to the session object, plus the handlers that do more |
| server/account.mjs | Masked account settings, profile and the composer instructions |
| server/providers.mjs | `PROVIDERS`, request fields, model IDs and provider model discovery |
| server/secrets.mjs | AES-GCM sealing and unsealing of keys and tokens |
| server/models.mjs | Live tool-capable cloud catalog and explicit fallback |
| server/prices.mjs | Daily-cached list prices (Ollama, Gemini, DeepSeek, Mistral and Meta pricing pages, OpenRouter for Anthropic/OpenAI/Kimi), turn cost by part, and web search/read rates derived from the account's Ollama usage data |
| server/push.mjs | Payload-less Web Push: VAPID signing, push-service allowlist, subscriptions and latest notice, its /api/ and index routes |
| server/probe/probe.mjs | ArnoProbe Durable Object: fetch dispatch to the route tables, alarm (runs the turn); mixes in the groups below |
| server/probe/live.mjs | Live view: broadcast, progress, activity, events |
| server/probe/records.mjs | Saving turns (the newest 1,000 kept), request logs, failures, history and the turns the model sees, phase, notify, touch |
| server/probe/session-routes.mjs | Internal /session/* routes of a coding or chat session object |
| server/probe/store-routes.mjs | Internal routes of the per-user index/profile and auth/OAuth store objects |
| server/probe/gateway-routes.mjs | Internal callbacks from the model and MCP gateways (permits, progress, usage, research state) |
| server/probe/attachments.mjs | Attachment storage and reading for a session |
| server/probe/artifacts.mjs | Artifacts of a session: five kinds (Markdown, HTML, SVG, Mermaid, code; images from coding), each version whole under its own key, edits, restore, summaries kept on the session for the gallery, and the sandboxed page an HTML page or diagram is shown from |
| server/chat/review.mjs | The review of a page a chat turn wrote: one call, without tools, to the review model with the request, source, check and screenshots; its defects, or none |
| server/probe/render.mjs | An HTML or SVG artifact opened in Browser Rendering at phone size (or wide, for the review) under the page policy: page and console errors, failed loads, policy violations, a JPEG screenshot |
| server/chat/images.mjs | find_image: freely licensed images from Wikimedia Commons, with licence and author |
| server/chat/memory.mjs | Chat memory: remember/recall/forget tools; titles and the `memory` setting (asked, auto, off) in every chat's instructions, facts read on demand; changes through POST /profile/memory |
| server/code/collect.mjs | After a coding turn, the files arno wrote in its artifacts directory, new or changed, kept as the session's artifacts |
| server/chat/turn.mjs | plainTurn, the chat turn, and `approve` (waits for Allow) |
| server/chat/chat.mjs | Container-free conversation and research loop for every provider |
| server/chat/plan.mjs | What a turn's composer options change: web tools, effort, instructions, output, rounds, research budgets; for coding, Arno's settings (`codeSettings`) and request and time limits (`codeLimits`) |
| server/chat/research.mjs | Multi-result search, page reading, host-assigned citations, built-in research MCP |
| server/chat/chat-mcp.mjs | MCP tools in regular chats: tool lists kept 10 minutes, <connection>__<tool> names, calls through the proxy; chat/turn.mjs `approve` waits for Allow |
| server/code/turn.mjs | codeTurn, the coding turn: runs `arno --serve` through serve.mjs |
| server/code/workspace.mjs | Container lifecycle: start, exec, writeConfig, gitSetup, followPush, wake, keepGithub, sandbox |
| server/code/code-routes.mjs | Internal coding routes: init, files, history, commit, changes, `hostCommand` |
| server/code/serve.mjs | Drives `arno --serve` for one turn: hello, /load, the line, streamed entries, reply and transcript |
| server/code/git.mjs | Git over HTTP for the container: smart-HTTP request matching, push-command check, forwarding to GitHub with the owner's token |
| server/code/sandbox.mjs | Coding sessions' network: read-only npm and PyPI proxies, the Cloudflare API gateway (owner's token), full-internet setting, the turn's environment |
| server/code/publish.mjs | The changes GitHub does not have yet: base = merge-base of HEAD with its upstream (or origin/<session branch>; else the starting commit), diff to the work tree (WORKTREE_DIFF), files for review (EXPORT_FILES), changesDigest, publishChanges (a branch and pull request on the base commit) |
| server/code/files.mjs | Read-only directory and UTF-8 code navigation |
| server/code/context.mjs | Repository provenance and bounded conversation context for every Arno invocation |
| server/gateways/gateways.mjs | ModelGateway, McpGateway and GitGateway entrypoints the container's traffic is routed through |
| server/gateways/model.mjs | Fixed-destination Ollama gateway, bounded payloads, streaming usage observation |
| server/gateways/mcp.mjs | Account-approved HTTPS MCP proxy and initialization test |
| server/gateways/mcp-oauth.mjs | MCP OAuth sign-in: discovery (RFC 9728, RFC 8414), registration (RFC 7591), PKCE, /auth/mcp/callback, refresh |
| web/index.html | The page's static markup; DOM IDs form the contract with the web/*.js modules |
| web/app.js | Entry: event wiring, icon setup and boot |
| web/core.js | DOM references, `state`, formatting helpers, API client, toast |
| web/layout.js | Viewport fit, drawer, busy flag, title bar, sidebar (Chat \| Code switch, the mode's conversations by last activity, `bump`), theme |
| web/models.js | Model catalog and picker |
| web/thread.js | Message rendering, follow-the-stream scroll, sources, suggestions |
| web/sessions.js | Switch mode, open, create, search, export, rename and delete sessions; the Chat and Code home pages |
| web/home.js | The home pages' greeting and Today card (quote, fact, moon, weather), the Open-Meteo forecast and geocoder calls |
| web/home-content.js | The curated quotes and facts the Today card picks from |
| web/search.js | The sidebar's search across every conversation: reads the kept copies of /api/sessions/:id, indexes them in the page, shows results as you type and opens one at the turn it quotes |
| web/fuzzy.mjs | DOM-free fuzzy matching, tested in Node: accent and case folding, word scores (in order, runs, word start, one typo), the index, ranked results with snippets and their highlight ranges |
| web/today.mjs | DOM-free home arithmetic, tested in Node: daily pick, moon phase and its SVG path, WMO weather codes, conversation order and relative times |
| web/info.js | Conversation details panel (title or usage button): context, usage, sources, links, images, repository |
| web/usage.js | Usage view: per-request report, spend summaries, by-model totals and the Ollama account card |
| web/artifacts.js | Artifact viewer (docked beside the chat on a wide screen; Preview, Source, Changes; versions with restore; Copy, Download, CSV, Open in a tab, Print), turn cards, detail rows, /open, and the gallery of every conversation's artifacts |
| web/linediff.mjs | Line diff (Myers) between two versions, as a unified diff for diffHtml |
| web/code.js | Code dialog: file browser (numbered, highlighted lines; Wrap; Copy), changes, commit history (unpushed commits marked; a commit opens with its patch), review and publish |
| web/attach.js | Composer attachments: upload on pick/paste/drop, chips, attachment rendering for messages and details |
| web/turns.js | Sending, editing, job polling and live output |
| web/options.js | Composer options: the sliders button, its popover, chips, per-conversation storage |
| web/commands.mjs | The slash commands a coding session suggests (arno's, less those the host refuses, and /mode, /budget, /workers, which set the conversation's options) |
| web/complete.js | Slash-command suggestions above the composer: arrows, Tab or Enter, Escape, tap |
| web/options.mjs | The options' choices and defaults, the strict check (also used by the server) and footer tags |
| web/settings.js | Account settings dialog |
| web/profile.js | The dialog's You tab: about text, profile picture (resize and upload), privacy notice, account deletion |
| web/marks.js | `providerMark(provider, size)`: original inline-SVG badges for the eight providers, shown in the model picker, composer, home button and provider cards |
| web/push.js | Turn notifications on or off: permission, push subscription on the shared service worker |
| web/offline.js | Offline reading: registers sw.js, the offline banner (with the outbox count), disables what needs the network, warms the saved-data cache, clears it and the outbox on sign-out |
| web/outbox.js | The outbox: keeps offline messages, new chats, renames and preferences in IndexedDB, shows them in the thread, sends them in order once online, asks on conflicts |
| web/queue.mjs | The outbox's rules (order per conversation, merging edits, conflict test, local → real id), with injected storage, tested in Node |
| web/sw.js | Service worker (registered at boot): app-shell precache, saved API reads for offline use, push notices and their clicks |
| web/update.js | The "Update available" bar: shows a waiting worker, posts SKIP_WAITING on Update, reloads on controllerchange; checks for updates on visibility and every 30 minutes |
| web/manifest.webmanifest | Installable web app manifest (standalone, maskable icon; needed for push on iPhone and iPad) |
| web/style.css | Responsive dark/light design tokens, layout, typography, reduced-motion rules |
| web/render.mjs | Escaping Markdown renderer (answers and user messages), the composer's colouring backdrop (`composerHtml`), table sizing, CLI-banner cleanup, safe diff rendering (shared by browser and tests) |
| web/compose-md.js | The composer's Markdown colouring: a backdrop behind the transparent-text textarea, same font and wrapping, kept in step on input, scroll, resize and value set from code |
| web/highlight.mjs | Syntax highlighting: `highlight(lang, code)`, `detect({ path, fence, code })` and `diffLines(diff)`, a table-driven scanner per language (shared by browser and tests) |
| web/_headers | Security headers for the static files, including the page's CSP |
| wrangler.jsonc | Worker config, durable namespace, digest-pinned container image, observability; `npx wrangler deploy` |
| runner/ | The container image (Dockerfile, prepare.cn builds and copies in the arno binary); rebuilding is in [OPERATIONS.md](OPERATIONS.md) |
| test/test.mjs | Backend and rendering regression tests; test/hooks.mjs stubs cloudflare:workers for Node |
| test/serve-test.mjs | Runs the real `arno --serve` against Arno's stub model through server/code/serve.mjs |
| test/design-test.cjs | Playwright browser workflow and viewport tests against the local web/ files; test/browser-test.cjs runs it against the deployed ones |
| test/offline-test.cjs | Playwright offline test: a local server for web/ and mocked /api/, warm, cut the network, reload and read |
| test/screenshots.cjs | Copies the design test's screenshots into doc/img |

Everything in web/ is served by Cloudflare as static files, before the worker runs; the worker handles /api/ and /auth/ only.

Syntax highlighting follows the design of our own [ladle](https://github.com/ldiaz94/ladle) (its Colour module), ported from raz to JavaScript: six classes (k keyword, t type, s string, n number or constant, c comment, b built-in) in ladle's default theme's WCAG-checked colours, light and dark; spans that never cross a line break, so the file view and diffs can split highlighted code by line; and a highlighter that never fails, giving escaped plain text for an unknown language, odd input or a file past 200 KB or 5,000 lines. As in ladle, the lines of a diff hunk are coloured by the language of their file, each hunk's old and new sides as small files of their own. Languages: raz, concha, JavaScript/TypeScript (JSX/TSX loosely), Python, shell, JSON, CSS, HTML/XML, Go, Rust, C/C++, Java, Kotlin, SQL, YAML, TOML/INI, Markdown and diff, told by a file's extension, its `#!` line or a code fence's word.

Security boundaries are in [SECURITY.md](SECURITY.md); testing and deployment in [OPERATIONS.md](OPERATIONS.md).

## A session's lifecycle

1. The browser authenticates with GitHub using an opaque HttpOnly session cookie.
2. The user selects a repository and model. The Worker resolves the selected branch to an exact GitHub commit and sends the session's container the owner's GitHub token with the request. The session object keeps it sealed (AES-GCM, server/secrets.mjs `seal`) under `github`; every later message refreshes it (`/session/owner`).
3. The container runs `git clone --filter=blob:none --branch REF http://git.internal/OWNER/REPO.git`. The container has no network of its own: it intercepts `git.internal` and hands the request to GitGateway (server/code/git.mjs), which forwards git's smart-HTTP requests (info/refs, git-upload-pack, git-receive-pack) to `https://github.com/OWNER/REPO.git` with Basic `x-access-token:<token>`. The gateway reads the token through `/git-account` only while a clone or a turn runs, so the token never enters the container. It reaches only the session's repository, and a push whose commands delete a ref (read from the pkt-lines before forwarding) is refused. Force pushes cannot be told apart; protect branches on GitHub.
4. The container records the source commit as `arno.sourceCommit` and sets the committer to the user's GitHub login with `id+login@users.noreply.github.com`. The Durable Object checkpoints the filesystem and atomically saves its session metadata with the checkpoint handle.
5. The recent-session index stores the session ID under the authenticated GitHub user ID.
6. Completed turns reuse the same running container. If it has stopped, start restores the saved checkpoint.

The clone has real history, so Arno can branch, commit, pull and push. Review and Publish still diff against `arno.sourceCommit` and publish on that commit. Sessions made before clones started from an archive with a synthetic baseline commit; the next turn migrates them: fetch the source commit (depth 1) and `git reset --soft` onto it, which keeps the work tree. After a turn, `followPush` checks whether a branch pushed during the turn has a tree equal to the project's; if so the checkout moves onto it and `session.ref` records it, so the next turn starts clean on that branch.

## A turn's lifecycle

Submission stores a job and schedules an alarm, then immediately responds with HTTP 202. A repeated submission with the same ID returns the same job. An active session rejects a different concurrent job.

Extra repositories (server/code/extras.mjs): a coding session may hold up to six more clones beside the project, at /workspace/<name> (<owner>-<name> when taken), kept in the session as `extras` [{repo, ref, path}] and so in every snapshot. ⋯ → Add a repository asks GitHub for the repository with the owner's token (its default branch), clones it through the git gateway (which serves the session's whole set: `/git-account` lists them, `gitProxy` picks the one a path names) and remembers it for the project's repository in the owner's index (`companions`); a new session on that repository clones the remembered ones (one GitHub no longer has is left out). arno is told where they are (`sessionPrompt`, `alsoCheckedOut` in each turn's context) and may edit, commit and push them when asked; the changes view, /pull and pull requests cover the project only.

The alarm changes the job from queued to running and runs Arno for the turn, within the time limit from `codeLimits` (10 minutes; 4 in Fast; 13 with the Build approach), after which the turn is cancelled. The job records phases:

- preparing: reuse of a running workspace;
- restoring: restart from the saved filesystem;
- thinking: Arno/model/tool execution;
- checkpointing: preserve the resulting filesystem and conversation.

Stop is an explicit user action. It cancels the job, revokes its model quota, and destroys the container so child processes cannot continue. The next turn restores the last completed checkpoint. The UI warns that uncheckpointed work will be discarded. Stopping is rejected once checkpointing has begun.

Coding turns run `arno --serve` (arno-serve(5)) once per turn, driven by server/code/serve.mjs, on the same container and repository:

- hello carries a host prompt (server/code/context.mjs `sessionPrompt`: repository identity and the pushing rules);
- the session's Arno conversation (`session.arnoConversation`) is `/load`ed when Arno still has it. Otherwise the older prompt is used: the most recent 20 turns, bounded to 32,000 characters, inlined before the request. Arno's own history is therefore the memory, with the inlined transcript as a fallback;
- every approval is answered `y`: the container is the sandbox;
- entries Arno streams show in the live view as an "activity" line; the reply is the lead's last assistant text; the tool and worker transcript goes to "Execution details" (`result.diagnostics`); Arno's own statistics are kept as `result.arno`;
- a line that starts with `/` is sent to Arno as a command. `hostCommand` (server/code/code-routes.mjs) refuses `/model`, `/models`, `/provider` (use the model button), `/budget` and `/workers` (set in the options panel; web/options.js `optionCommand` also handles a typed `/budget 2.50` or `/workers 2` in the browser), and `/safety`, `/quit`, `/exit`, `/attach`, `/paste`, `/stage`.

writeConfig writes Arno's config for the turn: the gateway URLs, `safety = auto` (edits are staged in a copy and applied at the turn's end), `context_files = yes`, `jail = no` (containers may mask /proc, so Arno's namespace jail cannot mount it; the container is the sandbox), a `price` line from prices.mjs so Arno's budget works, and the coding options from `codeSettings`. This is bounded conversational continuity, not an unlimited context window or a persistent interactive Arno process.

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
| GET/POST | /api/account | Masked preferences, system prompt, about-you text, skills, MCP, custom models |
| GET/PUT/DELETE | /api/account/avatar | The profile picture (PNG, JPEG or WebP, at most 256 KB; GET answers 404 without one) |
| POST | /api/account/delete | Wipes the account; body `{confirm: <GitHub login>}`, case-insensitive |
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
| GET | /api/sessions/:id/history | The checkout's newest 100 commits, which are not on GitHub yet, how many files are uncommitted, and how many commits GitHub has that it does not (fetched now) |
| GET | /api/sessions/:id/diff | The changes GitHub does not have yet, read from the workspace now (the Changes tab) |
| POST | /api/sessions/:id/pull | Fetch and merge the branch from GitHub into the checkout; a conflict is backed out and its files named (409); then a snapshot |
| GET | /api/sessions/:id/commit?sha=... | One commit's message and patch (up to 120 KB); a partial clone may fetch its files through the git gateway |
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

- Create session: `repo` is owner/name, `ref` the selected branch, `model` an approved model ID. The host resolves `ref` to a 40-character source commit and the container clones that branch. The response has id, repo, ref, model, sourceSha, remoteUrl, createdAt.
- Submit task: `id` is a client-generated UUID, `prompt` is 1-100,000 characters. Reusing an ID deduplicates an uncertain submission; a different ID gets 409 while a turn is queued or running. Never retry an uncertain request with a new UUID. In a regular chat, optional `editAt` (a saved turn's `at`) replaces that turn: it and every later turn are left out of the context and deleted once the new answer is saved. Optional `options` are the composer options (see Composer options); anything unknown, out of range, or deep research in a coding session gets 400.
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

Internal /session, /model, /auth and /index paths are binding-only; no public router reaches them. The model gateway can request a quota permit and report usage but has no GitHub authority. The git gateway reads the sealed token and may forward only git requests for the session's repository.

Keys in a session object:

- `session`: repository provenance (`ref`, which follows a branch the model pushed; `sourceSha`), selected model and `arnoConversation`.
- `github`: the owner's login, noreply address and GitHub token, sealed; read only by the git gateway.
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
- DeepSeek, Kimi (Moonshot AI), Mistral and Meta Model API through their OpenAI-compatible endpoints: api.deepseek.com, api.moonshot.ai/v1 (international; api.moonshot.cn is mainland China), api.mistral.ai/v1 and api.meta.ai/v1 (the successor of the Llama API at api.llama.com). Their quirks live in `PROVIDERS` (server/providers.mjs) and are applied by both chat.mjs and the coding gateway: Kimi and Meta take `max_completion_tokens`, DeepSeek and Mistral `max_tokens`; Mistral rejects `stream_options` (its last chunk carries usage anyway) and streams thinking as lists of `thinking`/`text` content chunks, which `mistralDeltas` rewrites into `content` and `reasoning_content` strings for the runner and the display. DeepSeek returns HTTP 400 when a request with tools lacks earlier thinking, and Kimi asks for it (Preserved Thinking), so both get `reasoning_content` back on assistant messages, past turns included (as saved, up to 12,000 characters); Mistral and Meta are not sent thinking (Meta keeps its reasoning private). Usage: DeepSeek's and Meta's cache reads are `cached_tokens` inside `prompt_tokens` (DeepSeek also names them `prompt_cache_hit_tokens`); Kimi also reports `cache_write_tokens` inside `prompt_tokens`. Model lists: Mistral's keeps models with the `completion_chat` capability and drops a `-latest` alias whose model is listed; Meta's drops image, voice and segmentation models. Prices: DeepSeek's page (peak and off-peak, weekday windows; Chinese holidays priced at peak), Mistral's and Meta's pages (Meta's `-contributor` models at Contributor rates), Kimi through OpenRouter's `moonshotai/` entries; their price keys keep the provider prefix, so Ollama's price for the same open model never stands in.

Custom model IDs are `openai/`, `anthropic/`, `gemini/`, `deepseek/`, `kimi/`, `mistral/` or `meta/` plus the model ID (Ollama's have no prefix). Connected providers' models join the shared model dialog (Gemini's, Mistral's and Meta's lists are filtered to chat models). Coding sessions run Arno with its `openai` provider for these four; the gateway behind model.internal chooses the real upstream. Responses-only, realtime, image and audio APIs are not implemented. API billing is separate from ChatGPT/Claude consumer subscriptions.

Keys are AES-GCM encrypted with a random IV and authenticated data bound to user ID and credential field; the master key is the encrypted Worker secret ACCOUNT_ENCRYPTION_KEY (see [SECURITY.md](SECURITY.md)). Public account responses carry saved/available flags, never values or ciphertext. Rotating the secret needs a decrypt/re-encrypt migration, so never rotate it casually. Keys save separately from other preferences. Test connection checks authenticated access and reports a model count; Ollama's catalog is public, so its test also sends a one-token inference request. Saved does not mean tested. Key inputs are cleared after saving and when the dialog closes, and never go to localStorage.

You tab (web/profile.js): `about` (at most 8,000 characters, validated beside the system prompt and returned by GET /api/account) is added by `instructions()` as an "About the user:" paragraph ahead of the system prompt, so every model sees it. The picture is cropped to a square and shrunk to 256 × 256 WebP in the browser (quality lowered until it is under 256 KB), sent with its Content-Type, and kept on the index object; the sidebar and the user's message headers show it, falling back to initials, with a timestamp query to bypass the cache. The tab also carries the privacy notice (what is kept, what leaves the app, what survives deletion) and Delete account: the button stays disabled until the typed text matches the GitHub login, then posts `{confirm}`; on success the page returns to the signed-out home.

Account system prompt and skills: the prompt applies to later chat and coding requests; enabled skills are named instruction snippets appended to it. They are not shell startup scripts or a plugin installer. Limits: 40,000 characters of prompt, 20 skills of 40,000 characters, 1.5 MB per account update.

Remote MCP: coding sessions support up to six public HTTPS Streamable HTTP servers, with or without a saved bearer token, disabled until enabled in account preferences. Test performs a real initialize exchange and reports protocol and server identity. Arno sees them through an internal `mcp.internal` gateway that resolves only enabled connections, fixes the endpoint, injects the token outside the container, refuses redirects, limits methods and task requests, and forwards only required session/protocol headers. The host writes an internal alias URL into Arno's configuration, never the token. MCP IDs are lowercase slugs; `web` is reserved for built-in research. Regular chat has the built-in web tools but not custom MCP. MCP OAuth, stdio installation, resources/prompts and third-party connector OAuth are not implemented.

Regular conversations: New chat allocates no VM and imports no repository. It opens a draft that lives only in the page, on no list and not on the server, until its first message or file makes it (web/sessions.js `persist`; offline, in the outbox); leaving it before then leaves nothing behind. The host runs a bounded provider tool loop with persistent history, research, usage and cancellation. Any conversation can be renamed or deleted from its list row; deletion needs confirmation, rejects active work, and removes application records and the workspace handle (Cloudflare's snapshot retention still follows its TTL).

The private deployment is restricted to ldiaz94 by ALLOWED_GITHUB_LOGINS so arbitrary sign-ins cannot spend the owner's subscriptions. Removing that needs entitlements, budgets, billing, abuse controls and retention policies ([OPERATIONS.md](OPERATIONS.md)).

## Model selection, gateway and telemetry

The model dialog loads the catalog and includes completion models with tool support. Selecting a model saves metadata only: no container wakes and no checkpoint is made. The next turn updates the CLI configuration and gateway policy.

The gateway rebuilds allowed inference requests, fixes the upstream to the selected provider's origin, and adds credentials outside the container. A streaming observer reads provider SSE usage chunks while forwarding the original bytes unchanged. Each usage report carries a turn ID, so a stale response cannot touch a later turn's counters.

Statistics are cumulative from when measurement was added. A chat turn that fails or is stopped is charged for what it had spent (its model calls and web calls carried on the error as `spent`, priced by records.mjs `chargeFailed`, logged as `failed_turn_cost`), into the totals and the request log; it does not count as a turn. Missing provider usage shows as unavailable. Requests, tokens and wall time are separate measurements. Cost is each turn's tokens at the model's list price, computed when the turn is saved (prices.mjs); a model absent from the price tables is counted as unpriced, never guessed. Web searches and page reads are priced at the per-request rates Ollama billed the account, read daily from ollama.com/api/usage?group_by=model (undocumented; fallback $0.011 and $0.001). Each turn stores its cost by part (input, cached input, cache writes, output, searches, reads) and the session sums them for the breakdown in the details panel.

## Composer options

Every message carries `options` = `{search, effort, mode, style, mcp, superSearch}`, and in coding sessions also `{approach, workers, budget}` (web/options.mjs; defaults `true`, `'auto'`, `'standard'`, `'normal'`, `'auto'`, `'off'`, `'auto'`; missing ones take their defaults). enqueue checks them strictly and keeps them on the job; the saved turn keeps them as `options`, and its footer tags the non-default ones ("Deep research", "Caveman", "Thinking: high", "No search"). Outbox entries keep the body, so queued sends, retries and edits carry them too. The browser keeps them per conversation in localStorage (`options:<id>`, moved with an offline chat's id); a conversation without any has the defaults, so a choice made in one never changes another. A draft chat keeps its choices on itself and hands them to the chat once it is made (`keepOptions`).

server/chat/plan.mjs turns them into a plan both kinds of turn follow:

| Option | Regular chat | Coding |
| --- | --- | --- |
| search off | no web tools, no WEB_INSTRUCTIONS | writeConfig leaves the `web` MCP server out of Arno's config; the gateway leaves out WEB_INSTRUCTIONS |
| effort | `requestFields` adds the provider's fields | the model gateway adds them when it rebuilds the payload |
| fast | effort `off` unless chosen, "Answer briefly and directly.", 4,096 output tokens; the browser also turns search off (it can be turned back on) | the same, through the gateway |
| deep (chats only) | 10 searches, 20 reads, 60 kept sources (instead of 6, 12, 30), 16 model rounds, effort at least medium, and instructions to plan sub-questions, read primary sources, compare and save a cited report with create_artifact ("Research: …") before a short reply | refused |
| superSearch (chats only) | search on, 25 searches, 50 reads, 80 kept sources, 32 model rounds, in any mode (over deep research's) | kept off |
| approach (coding only) | refused | `auto`, `pair`, `build` or `review`: Arno's `mode`; build also raises the limits (`codeLimits`) |
| workers (coding only) | refused | `off` or 1 to 4: Arno gets `workers = <lead model>` and `max_workers = N`, so workers run side by side on the same model |
| budget (coding only) | refused | `auto` or $0.1 to $100: Arno's `turn_budget` and `build_budget` |
| style | concise: be brief; caveman: few words, no articles or filler, facts, numbers and code exact | added to the gateway's instructions for every request of the turn |

The gateway reads the running turn's options from `modelQuota` (via /model-account). Effort `auto` sends nothing (the provider's default). Each provider declares in `PROVIDERS` (server/providers.mjs) which models take an effort and its fields; `/api/models` marks each model `effort: true|false` (Ollama's from /api/tags capabilities), and the popover disables Thinking with "Not available for this model" when false.

| Provider | Field | off / low / medium / high | Models |
| --- | --- | --- | --- |
| OpenAI | `reasoning_effort` | minimal / low / medium / high | o-series and gpt-5 ids (others refuse the field) |
| Anthropic, before 4.6 | `thinking: {type: 'enabled', budget_tokens}` | none / 2,048 / 8,192 / 24,000; `max_tokens` raised to budget + 8,000 | claude-3-7, 4 to 4.5 |
| Anthropic, 4.6 and later | `thinking: {type: 'adaptive'}` + `output_config.effort` | none / low / medium / high; Claude 5 also asks `display: 'summarized'` | 4.6+, 5.x (`enabled` is refused from 4.7) |
| Gemini | `extra_body.google.thinking_config` (`reasoning_effort` is refused beside `include_thoughts`) | 2.5: budget 0 (Pro 128) / 1,024 / 8,192 / 24,576; 3.x+: level minimal (Pro low) / low / medium / high | gemini-2.5, 3+ |
| Mistral | `reasoning_effort` | Large 4: low / low / medium / high; Small 2603, Medium 3.5: none / none / high / high | those three |
| Ollama Cloud | `reasoning_effort` on /v1 | none / low / medium / high (gpt-oss can't stop and ignores none) | /api/show lists `thinking` |
| DeepSeek | `thinking: {type: 'disabled'}` or `reasoning_effort` | disabled / low / high / high | deepseek-v4, deepseek-flash |
| Kimi | `reasoning_effort` | low / low / high / high | kimi-k3 (can't stop thinking) |
| Meta | — | not offered (no documented values) | — |

Claude's thinking blocks (with their signatures, and redacted ones) must come back unchanged before the tool_use blocks of the next request. server/chat/chat.mjs `readReply` keeps them from `content_block_start`, `thinking_delta` and `signature_delta` and replays them; only the thinking text reaches the Thinking panel. In coding the runner drops them, so the gateway keeps the latest reply's blocks (`thinking` key, by tool_use id) and puts them back; when it has none for the call, that request goes without thinking.

## Web research and citations

Regular and coding conversations both have search and page-reading tools. The host calls Ollama's POST /api/web_search and /api/web_fetch at fixed URLs, so source sites never see the Ollama key. A personal Ollama key is used when configured, otherwise the deployment fallback.

Bring-your-own search: an account can save its own SearXNG (Settings › Providers › Web search) as `{url, auth: none|access|bearer, clientId, secret}`. The URL must be public HTTPS (at most 500 characters, no credentials, query or fragment); the Cloudflare Access client secret or bearer token is sealed like provider keys (field `search:secret`), and reads return only url, auth, clientId and `hasSecret`. `POST /api/account/search` saves (`{remove: true}` removes); `POST /api/account/search-test` runs one query and reports the result count and latency. With a connection saved, web_search sends `GET <url>/search?q=…&format=json&language=auto&safesearch=0` with `CF-Access-Client-Id`/`CF-Access-Client-Secret` or `Authorization: Bearer`, no redirects, 10 s timeout and the bounded JSON reader, and maps the top six `results[]` into the same source records. On an error, timeout, non-JSON answer (403 usually means `format=json` is disabled) or no results, it falls back to Ollama search. Per turn `webUsage.searxng` counts SearXNG searches (free) and `webUsage.searches` only Ollama's (billed); the three-search limit counts both. web_read always uses Ollama.

- Search returns up to six results. The model is told to compare them, prefer primary documentation, read original pages, and read at least two credible pages for a comparison.
- No time limit: a chat turn runs as a chain of Durable Object alarms (an alarm may run 15 minutes). Before each round the loop's state (messages, counts, logs, round) is saved as `chat-resume:<n>` parts; after 9 minutes of rounds the turn yields and the next alarm carries on from it, and a model call still running at 12 minutes is stopped and its round asked again there. Tools are never cut off, so no action runs twice. A running chat job found by an alarm (yielded, or its alarm ended by the platform) goes on from the saved state, up to 20 alarms (`MAX_RUNS`, probe.mjs).
- Per turn: up to six searches and twelve page reads (deep research 10 and 20, super search 25 and 50, passed to `research()` as `limits`). Regular chat allows up to twelve model rounds (deep research 16, super search 32). The last one offers no tools and asks for the answer from what was found; if the model still gives none, the latest text it wrote is the answer, marked as stopped at the limit (`plainChat`). A reply that spent all its output on thinking, with no text or tool calls, is asked again once with thinking off (`rethink` in the log; DeepSeek v4.1 flash via Ollama does this at its default effort, and at low). An empty reply is logged as `empty_reply` (provider, model, round, reasoning length, output tokens) and asked once for the answer; if it is empty again after tools did work, the turn is kept with a note that the model finished without a reply, else it fails. Coding uses Arno's MCP tool loop within the turn's time and request limits (Limits and retention).
- Web content is evidence, not instructions. Tool failures are reported as failures.
- Regular chat uses OpenAI/Ollama function calls or Anthropic tool-use blocks, answering in the provider's own protocol. Coding gets the same read-only tools (web_web_search, web_web_read) from an internal MCP server, trusted in Arno's configuration so reading several sources does not use up its interactive approval input.
- The host numbers actual results. A source record holds URL, title, excerpt and retrieval time; the recent registry holds 30 records, and retained turns keep their own. The model cites as [1], [2]; the renderer makes a button only for IDs in the answer's saved records, so invented numbers stay plain text. A button or source card opens a preview with domain, title, excerpt, retrieval time and original link. This makes citations inspectable, not correct.

## Publishing

The review action exports changed regular text files from the worktree, new files included. The export script and the host both validate paths, file count, modes, encoding and size; container output is untrusted even from a fixed script.

The review includes a SHA-256 digest of the files and the source revision. Publishing exports again and rejects a changed digest. The Worker creates a Git tree and a commit whose parent is the pinned source commit on a new `arno/` branch, then opens a pull request against the selected base. Existing branches are never overwritten. If PR creation fails after the branch exists, the UI links the branch and reports the partial result. Sessions without a recorded source revision must be reopened as new ones before publishing.

## Notifications

When a turn ends completed or failed (not stopped), `alarm()` calls `notify()`, which hands the owner a notice: the conversation title, the first 120 characters of the answer or the error as plain text, and `/?session=<id>`. push.mjs stores it as the user's latest notice in `index:<user>` and sends each saved subscription an empty push signed with VAPID (RFC 8292; `TTL: 3600`). A push service answering 404 or 410 deletes that subscription. Without VAPID_KEY or subscriptions nothing is sent; errors are logged and never fail the turn; each push is bounded to 5 s.

The push carries no payload, so there is no RFC 8291 encryption. web/sw.js wakes on it, fetches `GET /api/notifications/latest` with the user's cookie and shows it, unless an app window is visible. A click focuses an app window and navigates it to the link, or opens one; app.js opens the `?session=` conversation and removes the query. The settings Connections tab turns notifications on (permission, subscribe on the worker offline.js registered) or off (unsubscribe both sides; the worker stays for offline use). On iPhone and iPad push works only from the Home Screen app, so the page has a manifest and the toggle says so.

## Offline

The app is an installable PWA that reads every conversation with no network, and keeps what the user does offline in an outbox, sent once the network is back. Changing the model, API keys, connections (web search, MCP), the profile picture, coding sessions and account deletion need the network.

- Shell: web/sw.js precaches every static file in its `SHELL` list into `arno-shell-<VERSION>` on install (test/test.mjs fails when a file in web/ is missing from it). Pages are network-first with a 3 s timeout, then the cached `/`; other static files are stale-while-revalidate. Bump `VERSION` in sw.js whenever a shell file changes: the new worker waits (skipWaiting only on a first install). web/update.js shows an "Update available" bar; its Update button posts SKIP_WAITING, the page reloads on controllerchange, and the new worker deletes the old shell. update.js checks for a new worker when the page becomes visible and every 30 minutes.
- Saved reads: GETs of /api/me, /api/models, /api/account, /api/account/avatar, /api/sessions, /api/sessions/:id, its artifacts list and artifacts, its attachments, and /api/usage/requests are network-first with a 6 s timeout. Each 2xx reply is kept in the `arno-data` cache (the avatar under one key, without its stamp); a 404 drops the kept copy. When the network fails or times out, the kept copy is served with `X-Arno-Offline: 1`, or a 503 JSON error if there is none. Never kept: anything but GET, non-2xx replies, /job, /events, /api/notifications/latest, /api/image, /api/usage/ollama and every other route.
- Warming: two seconds after an online boot, offline.js refetches the boot reads (on a first visit the page loaded before the worker took over), then walks the session list three at a time with low-priority fetches through the worker. A conversation is refetched, with its artifacts, when it is not kept or its kept `updatedAt` or `title` differs from the list entry; `alarm()` stamps `updatedAt` on the session and its list entry after each turn (`touch()`), so a turn on another device marks the copy stale. Image attachments are kept while a 50 MB budget per pass lasts, most recent conversations first. A finished turn refetches its conversation; coming back online starts a pass; a pass drops kept replies of conversations no longer listed.
- Offline state: `navigator.onLine` false, or an api() reply marked `X-Arno-Offline` (core.js dispatches `arno:reply`), shows the banner "Offline · showing saved conversations" (or "Offline · N waiting to send") and disables the model buttons and every control marked `data-online="Reconnect to …"`, whose text becomes its tooltip; job polling does not start. The `online` event, or the next reply from the network, restores them. api() throws errors marked `network` when the fetch fails, and, with `fresh`, when the worker answered from the device.
- Outbox: web/outbox.js keeps entries in IndexedDB (database `arno`, store `outbox`); web/queue.mjs holds its rules with an injected storage, so test/test.mjs runs them in Node. An entry is `{key, kind, sessionId, createdAt, body, base?, attachments?, state: queued|sending|failed, error?}`, of kind `message` (body `{id, prompt}`, the client UUID the server de-duplicates by, so a repeated send never doubles a turn; files picked offline are kept as blobs, within the server's limits: images 5 MB, text 1 MB, 8 per message), `chat` (a chat made offline, `local-<uuid>`, shown in the sidebar marked Queued), `rename` or `profile` (the Save preferences body). A send goes to the outbox when offline, when the POST fails and the device has gone offline (not on an HTTP error; still online, a lost reply is found by polling the job, as before), when the conversation is a local one, when earlier messages of it still wait, or when its files are not uploaded; edits and retries of saved turns need the network. Waiting messages show at the end of their thread with a "Queued · sends when online" badge, Edit and Cancel, and survive reloads (resume shows them again).
- Sending: on `online`, at boot, and when the page becomes visible while online. Each conversation's entries are a line sent strictly in order, oldest first; the lines (and the profile's own) run in parallel. A local chat is made first (POST /api/chats with its model), and its line, sessionStorage and draft move to the real id. A message uploads its files (keeping each id, so a retry won't upload again), POSTs, then waits for the conversation's job to finish (watchJob when the conversation is on screen, a plain /job poll otherwise) before the next; a 409 "A turn is already running" waits and retries. A 4xx refusal (say, a model that takes no images) marks the entry failed and shows the failure card with Retry, Edit and Cancel, pausing that conversation only; no network or a 5xx leaves it queued for the next trigger. While sending the banner reads "Sending 2 of 3…"; a toast reports the end.
- Conflicts (last write wins per item, with a warning): repeated renames of a conversation, or saves of the preferences, merge into one entry with the latest body, keeping the server value the first edit was based on (the title, or the profile's `updatedAt`, stamped by server/account.mjs on each save). Before sending, the current value is fetched fresh; if another device changed it (a rename by hand, not the name the server gives a new chat), a dialog asks "Keep yours" or "Keep theirs"; dismissing it asks again next time. MCP tokens are never queued.
- No Background Sync: the outbox sends only while the app is open. iOS has no Background Sync at all, so on iPhone and iPad the app must be opened to send what waits.
- Clearing: the Exit link deletes `arno-data` and the outbox before going to /auth/logout, account deletion does the same, and so does a boot where /api/me answers with no user while online.
- Install: the page has the apple-mobile-web-app-* tags (status bar black-translucent; the top bar, sidebar and full-screen artifact dialog pad by `env(safe-area-inset-top)`), `theme-color` follows the app's own theme (layout.js), and the manifest has `id`, `scope`, `display: standalone`, `orientation: any` and a maskable 512 px icon (web/brand/logo.svg on full bleed, scaled 0.72 into the safe zone with rsvg-convert).
- Search: web/search.js searches every conversation, chats and coding sessions, with no server index and no network. On focus of the sidebar field it prepares each listed conversation from its kept /api/sessions/:id reply in `arno-data` (the open one from memory; one not kept yet by its title alone), reusing a prepared one while its `updatedAt` and title are unchanged, and builds the index (web/fuzzy.mjs): the title (and a coding session's repository), artifact titles, and each turn's message and answer (the first 8,000 characters of each), folded to lowercase without accents, split into words. Each query word is scored once against the distinct words (exact 1, start 0.9, inside 0.7, letters in order 0.2–0.6 by runs and word start, one Damerau typo 0.5 for words of five or more letters; one-letter words match word starts only), weighted by where the word is (title 2, artifact 1.5, message 1.2, answer 1); a conversation must match every query word, and ranks by the sum of each word's best, then by recency. The snippet is about 120 characters of the turn where the words score most together; tapping a result opens it (resume) and scrolls to that turn's message. Results show 120 ms after typing stops; `/` or Ctrl/Cmd+Shift+F focuses the field, Escape clears it, Enter opens the first result.
- Safari: WebKit deletes a site's script-writable storage (Cache API included) after seven days of Safari use without interaction; a Home Screen app has its own day counter that its use resets, so the installed app keeps its copy while it is used.

## Interface

Remote coding is presented as a workspace, not a terminal transcript.

- Look: dark slate surfaces with mint accents (the Arno palette), each in dark and light, via CSS variables (colors, surfaces) in web/style.css. The theme menu (◐ in the sidebar foot) sets brightness and palette: Arno, Duck, Catppuccin, Cyberpunk, Phosphor (from tinta's palettes) or Gruvbox, each generated into variables with every colour moved to WCAG AA on its background, kept per device (localStorage `theme`, `palette`; `body.light`, `body[data-palette]`). A palette's selectors match any element, so the menu's swatches show each in its own colours; system font stack (no network fonts), cards and borders for hierarchy, transitions that respect prefers-reduced-motion.
- Layout: a 252px sidebar that becomes an off-canvas drawer on phones; transcript capped at a readable width and the only scrolling element, with the composer in the surrounding flex layout. The shell follows visualViewport height and offset so the mobile keyboard shrinks the transcript. Inputs use 16px text to avoid Safari focus zoom. Code, tables and diffs scroll in their own containers. The code browser docks beside chat on ultrawide screens and opens as a dialog on smaller ones. Provider marks (web/marks.js) are drawn for the provider that bills: ids prefixed `openai/`, `anthropic/`, `gemini/`, `deepseek/`, `kimi/`, `mistral/` or `meta/` get theirs, every other id (Ollama Cloud models of any vendor included) gets Ollama's. Account settings open from the avatar/name, as a full-height sheet with a persistent save area on mobile.
- Images: Markdown `![alt](https://…)` renders as an `<img>` pointing at `/api/image?url=…` (proxyImage in server/api.mjs), wrapped in a link to the original; the page CSP's `img-src 'self'` is enough, and a GET without an Origin header passes sameOrigin. - Reading: safe Markdown; CLI setup banners collapse into execution details; code blocks have language labels and copy buttons; tables size to content (short cells on one line, long ones wrap near 40 characters, wide ones scroll, column edges drag, double-click resets).
- Modes: a Chat | Code switch tops the sidebar (the phone drawer too). Each mode has its own home page, list (plain chats vs coding sessions, most recently active first by `updatedAt`, else `createdAt`, with times like "2m", "3h", "Yesterday"), New button (New chat; New session, disabled offline) and last open conversation (sessionStorage `session:chat` / `session:code`); the mode is kept in localStorage `mode`. Opening a conversation, from the list or a `?session=` link, switches to its mode. A finished turn, or a sent queued message, stamps the row's `updatedAt` on the client so it moves to the top at once; the server's list (`/index/list`) uses the same order, as `touch()` stamps the index entry after each turn.
- Refresh: the list's ↻, and coming back to the app after 30 s away (an installed app has no reload), fetch the conversations again and reopen the open one if its `updatedAt` moved (`refresh`, web/sessions.js). From a chat, ⋯ → Continue in a coding session keeps the chat's latest turns (up to 7,000 characters, `HANDOFF`) in `state.handoff`; the Code home says which chat comes along, and the session opened from a repository starts with it in the composer.
- Home pages: a greeting by time of day and the Today card. Chat home adds a "What's on your mind?" box that starts a chat with its text, and starter chips that fill it; Code home has a compact card, recent coding sessions and repository search. Opening a repository card always makes a new session; the session actions (⋯) dialog has "New session on this repository", which starts another on the same repo from the session's branch. The card's widgets are set in the profile's `home` (`{quote, fact, moon, weather, place, lat?, lon?}`, checked by `homeSettings` in server/account.mjs): quote and fact of the day (web/home-content.js, the same all day, "Another" steps on), the moon (mean synodic month from the 2000-01-06 new moon: phase name, % lit, days to full, an SVG), and, off by default, weather. The browser asks Open-Meteo directly (forecast, and the geocoder for a typed place; both in the page CSP's connect-src, geolocation allowed for the page itself and asked only on "Use my location", rounded to 0.1°). The last forecast is kept in localStorage and shown with its time when older than 30 minutes or offline; tiles keep their size while it loads.
- Input: send button always sends; Cmd/Ctrl+Enter sends; Enter alone sends unless the profile's `enterSends` is false (Settings → You → Composer & defaults), then it adds a newline. Shift+Enter always adds a newline. The composer, the chat home's box and the message edit box follow the same rule (`sendKey` in core.js), and the hints say which applies. New chats and coding sessions start with the model picked on the home page, else the profile's `defaultModel` (checked with modelAllowed), else Mistral Large 4. The profile's `reviewModel` (checked the same way) reviews the pages chats build; GET /api/models marks each model's `vision`. Drafts persist per session in the tab. The model dialog searches names and IDs, and opens with Cmd/Ctrl+K. Regular-chat messages have an Edit button: sending an edit replaces that message and the turns after it.
- Memory: the profile keeps the titles, `memories` (`[{id, title, at}]`, at most 1,000, oldest dropped with their facts; ids are the time in base 36), and the setting `memory` (`asked`, the default: saved only when the user asks; `auto`: the model may save on its own; `off`: no tools and nothing shown). Each fact (at most 1,000 characters; titles 100) is its own key, `memory:<id>`, in the profile object (SQLite-backed), so the profile stays small. In a chat turn, memoryInstructions lists every id and title after the profile's instructions, and MEMORY_TOOLS are offered unless off: `remember {title, fact}`, `recall {ids}` (up to 10 facts), `forget {id}`; all go through `POST /profile/memory` on the profile object (`{add}` and `{remove}` in one transaction, `{recall}` a read). Settings → You → Memory sets the mode (saved with preferences), reads a fact when its title is opened (`POST /api/account/memory {recall}`) and forgets one at once (`{remove}`). Coding sessions do not see them: arno keeps its own memory.
- Display: the profile's `display` (server/account.mjs `DISPLAY`, checked by `displaySettings`; web/core.js `display()` and `applyDisplay`, Settings → You → Display) sets the composer's meters (context fill and the conversation's `stats.cost`: `alternate`, taking turns every 4 s under 640px, `both`, `context`, `cost` or `off`), model thinking (`folded`, `open`, `hidden`), the time, tokens and cost under answers (`stats`), the transcript's `width` (`readable`, `wide`) and whether the view `follow`s a streaming answer; body classes `no-stats`, `no-thinking` and `wide-thread` carry the ones style.css applies.
- Footers and usage: each turn footer shows completion, wall time, measured tokens and list-price cost when available. The Usage & workspace dialog separates provider counters, phase timings and repository identity; unknown values show a dash with an explanation.
- Honest state: search reports progress until every page is scanned; task activity distinguishes restoring, preparing, execution and checkpointing; a warm workspace is labeled apart from a saved sleeping one. No account balances, live tool traces or completion percentages are invented.
- Artifacts: a chat's model makes them with create_artifact (kind markdown, html, svg, mermaid or code) reads one with read_artifact and revises it with update_artifact (whole content, edits that each replace text found exactly once, or append; optionally a new kind); a whole HTML page sent as markdown or code is kept as html (`kindFor`). After create_artifact or update_artifact writes an html page, turn.mjs renders it (render.mjs `renderPage`: Browser Rendering through @cloudflare/puppeteer, binding `BROWSER`; the page served by request interception at https://artifact.invalid/ under PAGE_POLICY, other loads from the network; 390×844, networkidle up to 8 s, 1.5 s more, JPEG at quality 55, at most 15 s; logs `artifact_check`) and adds `check: {ok, errors, failedLoads}` to the result; check_artifact renders any html or svg artifact on demand, optionally after `steps` (at most 12, in order, before the screenshot: set a field's value with input and change, click a selector, tap or drag at viewport coordinates, press a key, wait up to 3 s (5 s in all), scroll; then 0.8 s more, at most 20 s in all), so the model sees another state without changing the page's defaults; a step that fails is reported in `check.stepErrors` and the rest still run, and the alarm's cache of checks is keyed by the steps too. With no binding or on failure the write goes on unchecked. For a model that surely reads images (models.mjs `seesScreenshots`: Anthropic, Gemini, OpenAI but its text-only models, Ollama models listing vision) the screenshot rides on the tool result as `images`, which chat.mjs keeps out of the JSON and sends after the round's results as an image with a caption, in the provider's own format (Anthropic's inside the tool results' user turn); only the latest two screenshots stay in the conversation, so the saved resume state stays small. Before an answer is kept, plainChat's `review` hook (turn.mjs) may send it back while a round is left: once, an answer that claims an artifact changed (`CLAIMS_CHANGE`) in a turn about artifacts when nothing was written; once (again if it changed the page after that), the html page last written this turn goes to a reviewer (review.mjs `reviewPage`): one plainChat call with no tools and one round (at most 1,500 output tokens, effort low where supported, 2 minutes) to the profile's `reviewModel` (Settings → You; only models that see images are offered; '' is the chat's own model), with this message and the one before, the page's title and source (first 40,000 characters), the check, and screenshots at phone size (the cached check) and 1280×800 (render.mjs `WIDE`), sent only to a model that `seesScreenshots`. The reviewer answers with a numbered list of defects or "No defects."; a list goes back to the chat model (`fixRequest`, with the screenshots if it sees images), and none, or a failed review, lets the answer stand. Each review logs `artifact_review` (model, ms, defects, cost); its usage and cost, priced at the review model, ride in `guard.spent` and on the result as `reviews`, which records.mjs adds to the turn's calls and cost (the `review` cost part) and to the request log, failed turns included. Its counters (`guard`) are saved with the resume state. A reply the provider cuts off while writing a tool call or a long text is asked again once, with advice to work in smaller steps (edits, or a skeleton and append). find_image (images.mjs) searches Wikimedia Commons (file namespace, up to 8 images: web-sized URL, size, description, licence, artist); it is offered whenever artifacts are and is not billed. Browser Rendering costs: Workers Paid includes 10 browser hours a month, then $0.09 an hour. each turn's instructions list the conversation's artifacts with their ids (artifactList), so later turns find earlier ones, and a tool given a title instead of an id finds it by title (a miss lists the ones there are). An HTML artifact's page is served with a one-line reporter after its doctype and <head> (`withReporter`): uncaught errors, failed loads, rejected promises, console.error and what the page policy blocked go to the viewer by postMessage. The viewer shows them above the page ("N problems on this page"; in the artifact's own conversation "Fix with Arno" puts a request to fix them in the composer) and posts them to `/api/sessions/<id>/artifact-errors/<artifact>`, which keeps them as `artifact-errors:<id>` (that version's; read_artifact returns them as `pageErrors`) and logs `artifact_error`. Each finished chat turn logs `turn_done`: model, options, time, calls, tokens, cost, web calls, tools by name (calls, failures, time), artifacts made or changed, answer size and whether it was cut short. Tool errors are logged as `tool_error`; a coding session's arno writes files in its artifacts directory, which collect.mjs brings in after the turn. A turn's `artifacts` show as cards under the answer (an SVG's card shows it), `[Title](artifact:<uuid>)` renders as a button, and the details panel lists them; all open web/artifacts.js's viewer, docked beside the chat at 1100px and wider, a full-screen sheet on a phone. Markdown and code are drawn in the app; HTML pages and Mermaid diagrams are framed from `GET /api/sessions/<id>/artifacts/<artifact>?v=<n>&view`, which serves them under a CSP sandbox (scripts from three CDNs, no network, no same-origin), SVGs and images shown from the same address as images. Changes diffs a version against the one before; an earlier version can be restored as the newest (`POST …/artifacts/<artifact>`). The sidebar's **Artifacts** opens the gallery (`GET /api/artifacts`, from the summaries each session keeps in the owner's index), searchable and filtered by kind, pages and diagrams previewed small. `/open [name]` opens one from the composer.
- Accessibility: descriptive button names, decorative SVGs hidden, native modal focus management, named dialog headings, visible focus outlines, role=status toasts, explicit form buttons.

Client state: drafts and each mode's last open session ID live in sessionStorage, the mode, theme and last forecast in localStorage; repository and conversation state stay server-owned. Navigation (resume in web/sessions.js) increments a generation when navigation changes, and async results and job polls check it before repainting. Repository search has its own generation so an old query cannot overwrite a new one.

## Limits and retention

- Cloudflare checkpoints are kept 30 days, refreshed by restoration.
- Up to 1,000 turns are retained per conversation (`KEPT_TURNS`, server/probe/records.mjs), each its own storage value of about 115 kB at most, so in effect whole conversations are kept and /api/sessions/:id returns them all; very large diffs and logs are truncated for display. The model sees at most the 20 turns before a message (`CONTEXT_TURNS`, `contextTurns`; chat.mjs and context.mjs also cut them to 32,000 characters).
- A coding turn allows up to 150 model requests (40 in Fast, 400 with Build; workers' included) and runs 10 minutes (4, 13), then is cancelled (`codeLimits`). Output is 16,384 tokens per inference request (regular chat too; 4,096 in fast mode; Gemini keeps its own default, since thinking counts against it). A regular chat turn has four minutes, twelve for deep research. Gateway bodies are capped at 1 MB.
- Container Internet access is off. Model inference, built-in research, enabled remote MCP and git (git.internal, to the session's repository only) are host-mediated exceptions. Arbitrary dependency downloads are unavailable.
- Publishing takes up to 50 regular UTF-8 changed files totaling 1 MB; binary files and symlinks are rejected.
- Answer text and provider-exposed thinking stream live over SSE; coding previews show the current model pass and an activity line from Arno's entries. Raw tool arguments are not streamed; the tool and worker transcript appears in Execution details after the turn, and the final coding result after its checkpoint.
- Regular chat uses no VM, with a bounded host-side research loop and a quiet loading state.
- Not available: account balance, unlimited context, a live terminal, MCP OAuth/stdio.

Do not describe these as feature parity with another coding product.
