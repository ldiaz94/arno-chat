# Arno Chat

A responsive chat and remote coding workspace built around [Arno](https://github.com/ldiaz94/arno), Cloudflare Workers/Durable Objects/Containers, and hosted language models.

**Private deployment:** https://arno-compat-probe.lucelad.workers.dev

## Use it

1. Sign in with GitHub. Basic sign-in does not require repository permission.
2. The **Chat | Code** switch at the top of the sidebar picks a mode; each has its own home page, conversation list (most recently active first) and last open conversation. In **Chat**, type into the home page's box or choose **New chat** for a regular conversation with web research and persistent context; no coding container starts.
3. In **Code**, choose **New session**. Connect GitHub repository access, search your visible repositories, or paste an exact GitHub repository URL. Opening a repository card always starts a new session; **Session actions → New session on this repository** starts another one from the current session's branch.
4. Ask Arno to inspect, edit, or test. The activity indicator separates workspace preparation, execution, and checkpointing, and shows what Arno is doing as it goes. A line starting with `/` goes to Arno as a command (`/clear`, `/compact`, `/notes`, `/usage`, `/help`). `/model`, `/budget` and `/workers` are not sent: pick the model with the model button, and set budget and workers in the options panel (or type `/budget 2.50`, `/workers 2`). `/safety`, `/quit`, `/exit`, `/attach`, `/paste` and `/stage` are refused.
5. Browse **Code & changes** to navigate files or inspect highlighted diffs. Use **Session actions → Review & publish** to create a new branch/commit and pull request, or ask Arno to commit and push: the session's repository is a real clone, and pushes go to GitHub through the Worker as you.
6. Open your **avatar/name** for provider keys, system instructions, skills, MCP, and connection settings. Under **You**: whether Enter sends or adds a new line, the default model for new conversations, and the home page's Today card (quote and fact of the day, moon phase, and optional weather from Open-Meteo).

The composer's **options** button (sliders) sets, per conversation, web search on or off, the mode (**Standard**, **Fast** for short answers without thinking or search, or **Deep research**, in chats only, which searches and reads more and saves a cited report as an artifact), the thinking effort (Auto, Off, Low, Medium, High, where the model's provider supports it) and the answer style (Normal, Concise, or Caveman). In coding sessions the panel also offers an approach (Auto, Pair, Build or Review: Arno's mode), workers (off, or 1 to 4 working side by side) and a budget (Auto, or $0.1 to $100 per turn). New conversations start from the last choice; each answer's footer tags the options it ran with.

Answers stream as they arrive in both chat modes. Expand **Thinking** to view provider-exposed reasoning when available; it stays collapsed by default. Coding previews identify the current model pass and remain provisional until the workspace checkpoint is saved. Closing the page does not cancel a turn.

It installs as an app and works offline: every conversation reads from the device, and messages (with attachments), new chats, renames and saved preferences wait in an outbox, sent in order once the network is back (on iPhone and iPad the app must be open for that). When a new version is deployed, an **Update available** bar appears with an Update button; the app checks when it is reopened and every 30 minutes.

Conversation-row menus support rename/delete without opening a conversation. The interface includes dark/light themes, safe Markdown, syntax highlighting after [ladle](https://github.com/ldiaz94/ladle)'s design (raz, concha, JS/TS, Python, shell and a dozen more, in chat code blocks, artifacts, the file browser and diffs) with phone-sized code and a remembered Wrap toggle, copy/export, persistent drafts, editable chat messages, usage/timings with per-turn and per-session cost at current list prices, resizable tables, source previews, and distinct chat/coding loading states. The code pane docks on ultrawide screens and becomes a dialog on smaller displays.

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
- `node serve-test.mjs`: drives the real `arno --serve` against Arno's stub model (see OPERATIONS.md).
- `node offline-test.cjs`: Playwright offline reading against a local server (warm, go offline, reload, open a conversation and artifact; queue messages, a rename and a new chat, then check they reach the server in order once back online).
- Deploy with `npm run deploy`; the You tab's About card shows the version and build.

Browser fixtures are not evidence of real OAuth or GitHub publication. Real provider, container, MCP and research runs are in the validation record in [OPERATIONS.md](OPERATIONS.md).

## Important boundaries

This is a private deployment restricted to ldiaz94 while it uses shared provider credentials. It is not a publicly enrolled commercial service.

Coding workspaces use the pinned runner image in wrangler.jsonc (Arch Linux with a C toolchain, git, Node, Python, ripgrep, fd and w3m; no Go or Rust). Completed turns checkpoint files and retain up to 20 recent turns, with bounded model context. Snapshot retention follows Cloudflare's 30-day window. Arbitrary dependency downloads, a live terminal, MCP OAuth/stdio installation, account balance, and unlimited context are not implemented. See limits in [ARCHITECTURE.md](ARCHITECTURE.md).

OpenAI/Anthropic/Gemini adapters and key handling have protocol tests; Gemini's chat tool loop and coding gateway were also exercised locally against the real API, not yet through the deployed app. DeepSeek, Kimi, Mistral and Meta are tested only against recorded-shape streams from their API references; no real call has been made. Real calls to OpenAI and Anthropic require the user's keys. No blanket claim of perfect security or complete Claude Code feature parity is made.
