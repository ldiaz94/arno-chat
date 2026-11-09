# Arno Chat

A responsive chat and remote coding workspace built around [Arno](https://github.com/ldiaz94/arno), Cloudflare Workers/Durable Objects/Containers, and hosted language models.

**Private deployment:** https://arno-compat-probe.lucelad.workers.dev

## Use it

1. Sign in with GitHub. Basic sign-in does not require repository permission.
2. Choose **New chat** for a regular conversation with web research and persistent context; no coding container starts.
3. Choose **New session** for coding. Connect GitHub repository access, search your visible repositories, or paste an exact GitHub repository URL.
4. Ask Arno to inspect, edit, or test. The activity indicator separates workspace preparation, execution, and checkpointing.

Answers stream as they arrive in both chat modes. Expand **Thinking** to view provider-exposed reasoning when available; it stays collapsed by default. Coding previews identify the current model pass and remain provisional until the workspace checkpoint is saved. Closing the page does not cancel a turn.
5. Browse **Code & changes** to navigate files or inspect highlighted diffs. Use **Session actions → Review & publish** to create a new branch/commit and pull request.
6. Open your **avatar/name** for provider keys, system instructions, skills, MCP, and connection settings.

Conversation-row menus support rename/delete without opening a conversation. The interface includes dark/light themes, safe Markdown, copy/export, persistent drafts, editable chat messages, usage/timings with per-turn and per-session cost at current list prices, resizable tables, source previews, and distinct chat/coding loading states. The code pane docks on ultrawide screens and becomes a dialog on smaller displays.

## Providers and research

Ollama Cloud is available through the private deployment fallback or a personal key. Bring your own OpenAI, Anthropic or Google Gemini API key to use their models in regular chats and coding sessions. Keys are encrypted, masked on read, and kept outside coding containers.

Regular and coding conversations can search several web results and read original pages through host-mediated tools. Numbered citations link only to recorded sources and open a preview with title, domain, excerpt, and original link.

If GitHub shows only 17 repositories, check the connection permissions rather than assuming the account has only 17. Reconnect with repo scope, approve organization SSO/access, and, for a GitHub App, expand its installation's selected repositories.

## Documentation

| Guide | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module map, state ownership, session/turn lifecycle, retention, limits |
| [API.md](API.md) | Authenticated routes, task states, stored records |
| [ACCOUNTS.md](ACCOUNTS.md) | BYOK encryption, providers, account prompts, skills, MCP, GitHub access |
| [WEB-RESEARCH.md](WEB-RESEARCH.md) | Search/retrieval, citation provenance, budgets, real validation |
| [DESIGN.md](DESIGN.md) | Responsive layout, typography, accessibility, interaction choices |
| [SECURITY.md](SECURITY.md) | Credential boundaries, untrusted code/content, publication controls |
| [OPERATIONS.md](OPERATIONS.md) | Development, deployment, troubleshooting, secret handling |
| [UI-VALIDATION.md](UI-VALIDATION.md) | Automated browser checks and measured live coding/provider tests |
| [PROFESSIONAL-HOSTING.md](PROFESSIONAL-HOSTING.md) | Current database hosting and commercial-launch requirements |
| [brand/UPSTREAM.md](brand/UPSTREAM.md) | Original logo/mascot provenance and license |

## Development and verification

Run npm test for backend, protocol, encryption, rendering, context, and publication regression tests.

Run node design-test.cjs (Playwright is a dev dependency; it drives the system Chromium) for the local web/ files. Run node browser-test.cjs for the same suite against the deployed files. Set CHROMIUM_PATH if Chromium is not /usr/bin/chromium.

Browser API fixtures test interaction contracts; they are not evidence of real OAuth or GitHub publication. Real Ollama, multi-turn context, warm/restored containers, regular chat, MCP, and research were tested separately and documented.

## Important boundaries

This is a private deployment restricted to ldiaz94 while it uses shared provider credentials. It is not a publicly enrolled commercial service.

Coding workspaces use the pinned runner image in wrangler.jsonc. Completed turns checkpoint files and retain up to 20 recent turns, with bounded model context. Snapshot retention follows Cloudflare's 30-day window. Arbitrary dependency downloads, a live terminal, MCP OAuth/stdio installation, and unlimited context are not implemented.

OpenAI/Anthropic/Gemini adapters and key handling have protocol tests; Gemini's chat tool loop and coding gateway were also exercised against the real API locally. Real calls to those providers require the user's keys. No blanket claim of perfect security or complete Claude Code feature parity is made.
