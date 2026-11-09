# Trust boundaries

The browser, repository content, model output, and all container output are untrusted inputs. The Worker is the credential and publication boundary. A container is disposable execution infrastructure, not a safe place to store account credentials.

## Credentials and authentication

GitHub access tokens live in Durable Object authentication records, and a copy sealed (AES-GCM) in each coding session's object so the git gateway can use it while a turn runs. The private Ollama fallback lives in an encrypted Worker binding. Personal provider keys and MCP bearer tokens use user/field-bound AES-GCM envelopes in per-account storage, with the master key in an encrypted Worker binding (never rotate it casually; see [ARCHITECTURE.md](ARCHITECTURE.md)). Public account responses carry saved flags only, and key inputs are never kept in browser storage. None enters the repository container. The browser receives an opaque Secure, HttpOnly, SameSite=Lax cookie. OAuth state is random, cookie-bound, origin-checked, expiring, and consumed once.

Each public session route derives its Durable Object name from the authenticated GitHub user ID and the supplied session UUID. A user's session ID does not route into another user's namespace. Cross-origin API requests are rejected.

## Model and rendering boundary

The model gateway accepts only the selected provider's internal chat-completions or messages path, the session-selected model, bounded messages/tools, and a bounded body. It rebuilds the payload and sends credentials only to fixed HTTPS origins of Ollama, OpenAI, Anthropic, Google Gemini, DeepSeek, Kimi (api.moonshot.ai), Mistral or Meta (api.meta.ai). Redirects are not followed with credentials. Provider error bodies are not relayed.

The Markdown renderer escapes raw HTML and supports only HTTP(S) links. Code and diff output is escaped. Citation links are created only for host-recorded source IDs. Markdown images (`![alt](https://…)`) are never fetched by the browser from their host: they load through the signed-in `GET /api/image` proxy, which accepts only public HTTP(S) hosts, follows at most three redirects with each target re-checked, passes only PNG, JPEG, GIF, WebP and AVIF (never SVG), caps the body at 8 MB and 10 s, and sends no cookies or credentials, so third parties never see the viewer's IP or session. Responses carry `nosniff` and a sandboxing CSP. The app loads no third-party scripts or fonts; upstream artwork is served from the same origin. The page's CSP (web/_headers) allows only same-origin scripts, with no inline script or event handlers, and restricts other resources to the application and same-origin API.

The authenticated event stream uses the same owner-scoped session routing as polling. Only provider-designated answer and thinking text is displayed; tool arguments, opaque/redacted thinking and reasoning signatures are excluded. Thinking is escaped, stored with its private conversation, and never added to subsequent model context. Provider and token values never appear in API errors. Streams are bounded to eight concurrent viewers per session, disconnect slow readers, and do not control the job lifetime.

## Push notifications

Pushes are empty: no conversation text passes through Google, Mozilla, Apple or Microsoft. The service worker fetches the notice from the same origin with the user's cookie. A subscription endpoint must be an HTTPS URL of at most 1000 characters on a known push service (fcm.googleapis.com, push.services.mozilla.com, push.apple.com, notify.windows.com, or their subdomains), without credentials or port, so the Worker cannot be made to POST elsewhere; redirects are not followed. The VAPID private key is an encrypted Worker secret; only its public half is served.

## Offline copy on the device

To read offline, the service worker keeps the user's API replies in the browser's Cache Storage (`arno-data`): conversations, artifacts, image attachments, the profile with masked settings (never keys), the usage log. It is readable by anyone with the unlocked device and browser profile, like any site data. It is deleted on sign-out (the Exit link), after account deletion, and on any online visit where the session is no longer signed in; a conversation deleted elsewhere is dropped on the next warming pass. Only same-origin GETs to a fixed list of read routes are kept, and only 2xx replies; writes, live events, notices and the image proxy are never stored. The privacy notice in the app states this.

## Execution boundary

The container has no general Internet access and no GitHub or Ollama token. Repository code can read and modify all files inside that disposable container, including Arno configuration and other workspace files. The host must not trust results from programs inside it.

The container is the isolation layer. Arno runs with `jail = no` (containers may hide /proc, which its namespace jail needs) and answers every approval with yes, so anything the model runs is limited only by the container. Arno's `safety = auto` stages edits in a copy and applies them at the end of the turn; that is for tidiness, not security. No claim of perfect security is made.

## Git boundary

The container's git origin is `http://git.internal/OWNER/REPO.git`. The Worker's git gateway (git.mjs) forwards git's smart-HTTP requests (info/refs, git-upload-pack, git-receive-pack) to `https://github.com/OWNER/REPO.git` with the owner's GitHub token as Basic `x-access-token`. The token never enters the container, so the model can fetch and push but cannot read the token. The session object hands the gateway the token only while a turn or a clone runs.

The gateway reaches only the session's own repository. It reads a push's commands before forwarding and refuses any that delete a branch or tag. It cannot tell a force push from a normal one: protect branches on GitHub (branch protection or rulesets) to refuse them there. A push can still create a branch or add commits to any branch the token may write, so grant the connection only to accounts and repositories you accept that for. Commits are made as the user's GitHub login with its `id+login@users.noreply.github.com` address.

## Publication boundary

Only an explicit browser action can invoke the reviewed publication. The host re-exports and validates the reviewed files and checks their digest. Paths cannot escape the repository; symlinks, unsupported modes, and binary files are rejected. Changes are committed onto the pinned remote revision and published to a new arno/ branch. The reviewed route holds no credentials in the container; the git gateway above is the only other way to GitHub.

Basic sign-in requests read:user. The separate repository connection requests repo scope because private repositories need it. A narrower managed GitHub App integration remains a future improvement. The shared-key deployment restricts sign-in and use to ALLOWED_GITHUB_LOGINS, so arbitrary GitHub users cannot spend the owner's subscriptions; see [OPERATIONS.md](OPERATIONS.md) for what removing that needs. Older accounts that already granted repo scope keep it.

## Remote tools

Enabled custom MCP connections use only account-approved public HTTPS endpoints. Private/loopback addresses, credential-bearing URLs, and redirects are rejected. Only selected protocol/session headers are forwarded, and tokens are injected outside the VM. Built-in web research uses fixed Ollama search/fetch endpoints, so source sites never see the key, and bounded source records; web content is treated as evidence, not instructions. An account's own SearXNG must be a public HTTPS URL without credentials, query or fragment (private, loopback and plain-HTTP hosts are refused on save); its Access client secret or bearer token is sealed like provider keys, never returned, and sent only to that URL, with redirects refused so it cannot be forwarded elsewhere. MCP tools are off until enabled in account preferences: enable only trusted servers and narrowly scoped tokens.

Remote content and tool output remain untrusted. MCP services can perform remote actions; stopping a local task cannot undo an action already accepted by an external service.

## Reporting

Report a suspected vulnerability privately to the repository owner. Include reproduction steps and relevant task/session IDs, but never credentials or private source code that is not required for the report.

## Account deletion and pictures

`POST /api/account/delete` needs the caller's GitHub login typed back (case-insensitive), so a stray request or a hijacked tab cannot wipe an account by accident. It deletes the conversations (transcripts, attachments, artifacts, workspace handles), the profile with its sealed keys and tokens, the about text and picture, push subscriptions, the request log and every recorded sign-in, then clears the session cookie. What it cannot reach: Cloudflare keeps coding-workspace snapshots up to 30 days and error logs up to 7 days, and data already sent to a model provider, Ollama or a SearXNG follows that party's retention. GitHub authorization is revoked by the user at github.com/settings/applications. The in-app privacy notice states this.

The profile picture accepts only PNG, JPEG or WebP, at most 256 KB (the browser shrinks photos to 256 × 256 first; the server enforces type and size itself), is served only to its owner and is wiped with the account.
