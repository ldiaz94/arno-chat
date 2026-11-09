# Arno Chat

A responsive chat and remote coding workspace built around [Arno](https://github.com/ldiaz94/arno), Cloudflare Workers/Durable Objects/Containers, and hosted language models.

**Private deployment:** https://arno-compat-probe.lucelad.workers.dev

## Use it

1. Sign in with GitHub. Basic sign-in does not require repository permission.
2. Choose **New chat** for a regular conversation with web research and persistent context; no coding container starts.
3. Choose **New session** for coding. Connect GitHub repository access, search your visible repositories, or paste an exact GitHub repository URL.
4. Ask Arno to inspect, edit, or test. The activity indicator separates workspace preparation, execution, and checkpointing.
5. Browse **Code & changes** to navigate files or inspect highlighted diffs. Use **Session actions → Review & publish** to create a new branch/commit and pull request.
6. Open your **avatar/name** for provider keys, system instructions, skills, MCP, and connection settings.

Answers stream as they arrive in both chat modes. Expand **Thinking** to view provider-exposed reasoning when available; it stays collapsed by default. Coding previews identify the current model pass and remain provisional until the workspace checkpoint is saved. Closing the page does not cancel a turn.

Conversation-row menus support rename/delete without opening a conversation. The interface includes dark/light themes, safe Markdown, copy/export, persistent drafts, editable chat messages, usage/timings with per-turn and per-session cost at current list prices, resizable tables, source previews, and distinct chat/coding loading states. The code pane docks on ultrawide screens and becomes a dialog on smaller displays.

## Providers and research

Ollama Cloud is available through the private deployment fallback or a personal key. Bring your own OpenAI, Anthropic, Google Gemini, DeepSeek, Kimi (Moonshot AI), Mistral or Meta Model API key to use their models in regular chats and coding sessions. Keys are encrypted, masked on read, and kept outside coding containers. Details: [ARCHITECTURE.md](ARCHITECTURE.md).

Regular and coding conversations can search several web results and read original pages through host-mediated tools. Numbered citations link only to recorded sources and open a preview with title, domain, excerpt, and original link.

If GitHub shows only 17 repositories, check the connection permissions rather than assuming the account has only 17. Reconnect with repo scope, approve organization SSO/access, and, for a GitHub App, expand its installation's selected repositories.

## Documentation

| Guide | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modules, state, lifecycles, routes, accounts and providers, research, interface, limits |
| [OPERATIONS.md](OPERATIONS.md) | Testing, deployment, secrets, hosting, troubleshooting, validation record |
| [SECURITY.md](SECURITY.md) | Credential boundaries, untrusted code and content, publication controls |
| [brand/UPSTREAM.md](brand/UPSTREAM.md) | Original logo/mascot provenance and license |

## Development and verification

- `npm test`: ESLint, Prettier check, and unit tests (including a wrangler bundle build).
- `node design-test.cjs`: Playwright against the local web/ files in the system Chromium (set CHROMIUM_PATH if it is not /usr/bin/chromium). `node browser-test.cjs` runs it against the deployed files.
- Deploy with `npx wrangler deploy`.

Browser fixtures are not evidence of real OAuth or GitHub publication. Real provider, container, MCP and research runs are in the validation record in [OPERATIONS.md](OPERATIONS.md).

## Important boundaries

This is a private deployment restricted to ldiaz94 while it uses shared provider credentials. It is not a publicly enrolled commercial service.

Coding workspaces use the pinned runner image in wrangler.jsonc. Completed turns checkpoint files and retain up to 20 recent turns, with bounded model context. Snapshot retention follows Cloudflare's 30-day window. Arbitrary dependency downloads, a live terminal, MCP OAuth/stdio installation, account balance, and unlimited context are not implemented. See limits in [ARCHITECTURE.md](ARCHITECTURE.md).

OpenAI/Anthropic/Gemini adapters and key handling have protocol tests; Gemini's chat tool loop and coding gateway were also exercised locally against the real API, not yet through the deployed app. DeepSeek, Kimi, Mistral and Meta are tested only against recorded-shape streams from their API references; no real call has been made. Real calls to OpenAI and Anthropic require the user's keys. No blanket claim of perfect security or complete Claude Code feature parity is made.
