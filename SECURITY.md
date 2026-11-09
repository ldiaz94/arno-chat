# Trust boundaries

The browser, repository content, model output, and all container output are untrusted inputs. The Worker is the credential and publication boundary. A container is disposable execution infrastructure, not a safe place to store account credentials.

## Credentials and authentication

GitHub access tokens live in Durable Object authentication records. The private Ollama fallback lives in an encrypted Worker binding. Personal provider keys and MCP bearer tokens use user/field-bound AES-GCM envelopes in per-account storage, with the master key in an encrypted Worker binding (never rotate it casually; see [ARCHITECTURE.md](ARCHITECTURE.md)). Public account responses carry saved flags only, and key inputs are never kept in browser storage. None enters the repository container. The browser receives an opaque Secure, HttpOnly, SameSite=Lax cookie. OAuth state is random, cookie-bound, origin-checked, expiring, and consumed once.

Each public session route derives its Durable Object name from the authenticated GitHub user ID and the supplied session UUID. A user's session ID does not route into another user's namespace. Cross-origin API requests are rejected.

## Model and rendering boundary

The model gateway accepts only the selected provider's internal chat-completions or messages path, the session-selected model, bounded messages/tools, and a bounded body. It rebuilds the payload and sends credentials only to fixed HTTPS Ollama, OpenAI, Anthropic, or Google Gemini origins. Redirects are not followed with credentials. Provider error bodies are not relayed.

The Markdown renderer escapes raw HTML and supports only HTTP(S) links. Code and diff output is escaped. Citation links are created only for host-recorded source IDs. The app loads no third-party scripts or fonts; upstream artwork is served from the same origin. The page's CSP (web/_headers) allows only same-origin scripts, with no inline script or event handlers, and restricts other resources to the application and same-origin API.

The authenticated event stream uses the same owner-scoped session routing as polling. Only provider-designated answer and thinking text is displayed; tool arguments, opaque/redacted thinking and reasoning signatures are excluded. Thinking is escaped, stored with its private conversation, and never added to subsequent model context. Provider and token values never appear in API errors. Streams are bounded to eight concurrent viewers per session, disconnect slow readers, and do not control the job lifetime.

## Execution boundary

The container has no general Internet access and no GitHub or Ollama token. Repository code can read and modify all files inside that disposable container, including Arno configuration and other workspace files. The host must not trust results from programs inside it.

The outer container boundary is the isolation layer. Arno's internal jail is not used in this deployment. No claim of perfect security is made.

## Publication boundary

Only an explicit browser action can invoke publication. The host re-exports and validates the reviewed files and checks their digest. Paths cannot escape the repository; symlinks, unsupported modes, and binary files are rejected. Changes are committed onto the pinned remote revision and published to a new arno/ branch. The model has no direct push credentials.

Basic sign-in requests read:user. The separate repository connection requests repo scope because private repositories need it. A narrower managed GitHub App integration remains a future improvement. The shared-key deployment restricts sign-in and use to ALLOWED_GITHUB_LOGINS, so arbitrary GitHub users cannot spend the owner's subscriptions; see [OPERATIONS.md](OPERATIONS.md) for what removing that needs. Older accounts that already granted repo scope keep it.

## Remote tools

Enabled custom MCP connections use only account-approved public HTTPS endpoints. Private/loopback addresses, credential-bearing URLs, and redirects are rejected. Only selected protocol/session headers are forwarded, and tokens are injected outside the VM. Built-in web research uses fixed Ollama search/fetch endpoints, so source sites never see the key, and bounded source records; web content is treated as evidence, not instructions. MCP tools are off until enabled in account preferences: enable only trusted servers and narrowly scoped tokens.

Remote content and tool output remain untrusted. MCP services can perform remote actions; stopping a local task cannot undo an action already accepted by an external service.

## Reporting

Report a suspected vulnerability privately to the repository owner. Include reproduction steps and relevant task/session IDs, but never credentials or private source code that is not required for the report.
