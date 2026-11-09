# Trust boundaries

The browser, repository content, model output, and all container output are untrusted inputs. The Worker is the credential and publication boundary. A container is disposable execution infrastructure, not a safe place to store account credentials.

## Credentials and authentication

GitHub access tokens live in Durable Object authentication records. The private Ollama fallback lives in an encrypted Worker binding. Personal provider keys and MCP bearer tokens use user/field-bound AES-GCM envelopes in per-account storage, with the master key in an encrypted Worker binding. None enters the repository container. The browser receives an opaque Secure, HttpOnly, SameSite=Lax cookie. OAuth state is random, cookie-bound, origin-checked, expiring, and consumed once.

Each public session route derives its Durable Object name from the authenticated GitHub user ID and the supplied session UUID. A user's session ID does not route into another user's namespace. Cross-origin API requests are rejected.

## Model and rendering boundary

The model gateway accepts only the selected provider's internal chat-completions or messages path, the session-selected model, bounded messages/tools, and a bounded body. It rebuilds the payload and sends credentials only to fixed HTTPS Ollama, OpenAI, or Anthropic origins. Redirects are not followed with credentials. Provider error bodies are not relayed.

The Markdown renderer escapes raw HTML and supports only HTTP(S) links. Code and diff output is escaped. Citation links are created only for host-recorded source IDs. The app loads no third-party scripts or fonts; upstream artwork is served from the same origin. CSP restricts resources to the application and same-origin API.

## Execution boundary

The container has no general Internet access and no GitHub or Ollama token. Repository code can read and modify all files inside that disposable container, including Arno configuration and other workspace files. The host must not trust results from programs inside it.

The outer container boundary is the isolation layer. Arno's internal jail is not used in this deployment. No claim of perfect security is made.

## Publication boundary

Only an explicit browser action can invoke publication. The host re-exports and validates the reviewed files and checks their digest. Paths cannot escape the repository; symlinks, unsupported modes, and binary files are rejected. Changes are committed onto the pinned remote revision and published to a new arno/ branch. The model has no direct push credentials.

Basic sign-in requests read:user. The separate repository connection requests repo scope because private repositories need it. A narrower managed GitHub App integration remains a future improvement. The current shared-key deployment restricts sign-in/use to its configured owner.

## Remote tools

Enabled custom MCP connections use only account-approved public HTTPS endpoints. Private/loopback addresses, credential-bearing URLs, and redirects are rejected. Only selected protocol/session headers are forwarded, and tokens are injected outside the VM. Built-in web research uses fixed Ollama search/fetch endpoints and bounded source records.

Remote content and tool output remain untrusted. MCP services can perform remote actions; stopping a local task cannot undo an action already accepted by an external service.

## Reporting

Report a suspected vulnerability privately to the repository owner. Include reproduction steps and relevant task/session IDs, but never credentials or private source code that is not required for the report.
