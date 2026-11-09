# Accounts, providers, skills, and connections

## Sign-in is separate from repository access

GitHub OAuth is the identity provider. A fresh sign-in requests read:user, which is enough to create ordinary conversations. It does not request repository access. Connect/refresh GitHub from the repository browser or account connections to request repo scope for private coding workspaces.

Older accounts that already authorized repo scope may retain that grant under GitHub's OAuth rules. The app cannot revoke a previously granted scope simply by requesting less on a later sign-in.

If a connection sees only 17 repositories, that is a visibility result, not a statement about the user's entire account. The API reports scopes and SSO hints. A GitHub App user token is identified separately: selected installation repositories must be expanded at https://github.com/settings/installations. Organizations may also require approval or SSO authorization. The app does not bypass GitHub permissions.

Search paginates through all visible repositories. Pasting an exact owner/repo or GitHub URL also tries a direct authorized lookup, which can locate a known repository absent from a listing.

## Regular conversations

New chat does not allocate a VM or import a repository. The host runs a bounded provider tool loop with persistent history, web research, usage, and cancellation. The loading state is a quiet typing/research indicator, without coding checkpoint phases.

Both regular and coding conversations can be renamed or deleted. Every row in the conversation list has an action menu; the currently open conversation also has a session-actions menu. Deletion requires confirmation and rejects active work. Application records and the workspace handle are removed; Cloudflare's underlying snapshot retention still follows its platform TTL.

## Provider keys

Open account settings by clicking the avatar/name in the sidebar.

Supported inference providers:

- Ollama Cloud, using a personal key or the private deployment's configured fallback;
- OpenAI Chat Completions-compatible models;
- Anthropic's native Messages API.
- Google Gemini through its OpenAI-compatible endpoint. Gemini returns a thought signature with each tool call, which is sent back with the call on the next round; its thoughts arrive in the text as <thought>…</thought> and are moved to the Thinking panel; and its thinking tokens, missing from completion_tokens, are counted from total_tokens. Web research uses the same host-side tools as every other provider.

Keys use AES-GCM encryption with a random IV and authenticated data bound to user ID and credential field. ACCOUNT_ENCRYPTION_KEY is an encrypted Worker secret. Public account responses contain saved/available flags, never secret values or ciphertext.

Never rotate the encryption secret casually: existing records depend on it. Rotation requires decrypt/re-encrypt migration. Keep appropriate access to the Cloudflare secret and durable data as part of disaster recovery.

Provider keys save separately from other preferences. Test connection checks authenticated provider access and reports a model count. Ollama's catalog is public, so its test also makes a tiny one-token inference request to verify the key. Saved does not mean tested. Inputs are cleared after saving and when the dialog closes; they are not stored in browser localStorage.

OpenAI, Anthropic and Gemini model discovery adds connected models to the shared model dialog (Gemini's list is filtered to chat models). Custom model IDs use openai/, anthropic/ or gemini/ before the model id. Responses-only, realtime, image, and audio APIs are not implemented. A custom ID must be compatible with the supported provider protocol.

API billing is separate from ChatGPT/Claude consumer subscriptions.

## System prompt and skills

The account system prompt applies to subsequent regular-chat and coding-model requests. Enabled skills are named reusable instruction snippets appended to it. They are not arbitrary shell startup scripts or a filesystem plugin installer.

Limits: 12,000 system-prompt characters, 10 skills, 4,000 characters per skill. The complete account update is bounded to 64 KB.

## Remote MCP

Coding sessions support up to six configured public HTTPS Streamable HTTP MCP servers. Servers may be public or use a saved bearer token. The test action performs a real initialize exchange and reports the negotiated protocol and server identity.

Configured connections are exposed to Arno through an internal mcp.internal gateway. The gateway resolves only enabled account connections, fixes the remote endpoint, injects its token outside the container, refuses redirects, limits protocol methods and task requests, and forwards only required MCP session/protocol headers.

Arno 0.10.1 supports native remote HTTP MCP. The host writes only an internal alias URL into its configuration, not the service token. MCP IDs are lowercase slugs. web is reserved for built-in read-only research.

Custom MCP tools are currently available in coding sessions. Regular conversations have built-in web tools, but do not load arbitrary custom MCP tools. MCP OAuth login, stdio package installation, resources/prompts, and general third-party connector OAuth flows are not implemented.

MCP tools can perform remote actions. They are disabled until explicitly enabled in account preferences. Enable only trusted servers and tokens scoped to the intended operations.

## Private deployment policy

The current shared-key deployment is restricted to ldiaz94 through ALLOWED_GITHUB_LOGINS. This prevents an arbitrary GitHub sign-in from consuming the owner's subscriptions. Multi-user public signup needs explicit entitlements, budgets, billing, abuse controls, and retention policies before that restriction is removed.
