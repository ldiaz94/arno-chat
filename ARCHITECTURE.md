# Architecture and implementation guide

Arno Chat turns a GitHub repository snapshot into a resumable remote coding workspace. The browser owns presentation; a Cloudflare Worker owns authentication and GitHub publication; one Durable Object per session owns coordination, transcript, task state, and the container.

## Source map

| File | Responsibility |
| --- | --- |
| worker.js | Public authenticated routes, OAuth, session coordination, task alarms, repository import, GitHub publication |
| gateway.mjs | Fixed-destination Ollama gateway, bounded payloads, streaming usage observation |
| context.mjs | Repository provenance and bounded conversation context for every Arno invocation |
| models.mjs | Live tool-capable cloud catalog and explicit fallback |
| account.mjs | Masked account settings, AES-GCM key envelopes, provider discovery |
| chat.mjs | Container-free OpenAI/Ollama/Anthropic conversation and research loop |
| web.mjs | Multi-result search, page reading, host-assigned citations, built-in research MCP |
| mcp.mjs | Account-approved HTTPS MCP proxy and initialization test |
| files.mjs | Read-only directory and UTF-8 code navigation |
| settings-client.mjs | Provider, instruction, skill, and connection settings interface |
| publish.mjs | Worktree export, host-side validation, cumulative diff including new files |
| ui-v2.mjs | Self-contained HTML document assembly |
| client.mjs | Browser state machine, responsive workspace, search, dialogs, task polling |
| theme.mjs | Responsive dark/light design tokens, layout, typography, reduced-motion rules |
| render.mjs | Escaping Markdown renderer, CLI-banner cleanup, safe diff rendering |
| deployment.json | Worker modules, durable namespace, pinned container image, observability |
| test.mjs | Backend and rendering regression tests |
| design-test.cjs | Browser workflow and viewport tests against current local HTML |

The legacy ui-v2 filename is retained to avoid unnecessary deployment/import churn. It now assembles the redesigned interface from separate presentation modules.

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

## Frontend state and navigation

The browser stores drafts and the last selected session ID in sessionStorage. Repository and conversation state remain server-owned.

client.mjs increments a generation when navigation changes. Async results and job polls check that generation before repainting. Repository search has a separate generation so a response for an old query cannot overwrite a new query.

The desktop sidebar becomes an off-canvas drawer on phones. The main transcript is the scrolling element; the composer stays in the surrounding flex layout. The shell follows visualViewport height/offset so mobile keyboard changes reduce available transcript height. Inputs use a 16px font to avoid Safari focus zoom. Code, tables, and diffs scroll within their own containers.

Account settings open from the avatar/name. On mobile they use a full-height sheet with a compact header and a persistent save area. Conversation-row menus support rename/delete without opening the conversation. The code browser docks alongside chat on ultrawide displays and opens as a dialog on smaller screens.

## Repository discovery

GitHub's authenticated user/repositories endpoint is read page by page. The server filters each page by repository name or description. Search automatically continues through every page and shows checked/matched counts until completion. A blank query uses explicit Load more buttons.

The server uses both GitHub's Link header and a full-page fallback for continuation, so a missing Link header cannot silently hide repositories after the first 100. Archived repositories remain discoverable and are labeled.

## Model selection and telemetry

The model dialog loads the cloud catalog and includes completion models with tool support. Selecting a different model saves metadata only; it does not wake a container or create a checkpoint. The next turn updates the CLI configuration and gateway policy.

The gateway rebuilds allowed inference requests, fixes the upstream destination for Ollama, OpenAI, or Anthropic, and adds credentials outside the container. Personal keys are encrypted in per-account storage; the private deployment can supply an Ollama fallback. A streaming observer watches provider SSE usage chunks while forwarding the original bytes unchanged. Each usage report is associated with a turn ID so a stale response cannot affect a later turn's counters.

Statistics are cumulative from deployment of measurement support onward. Missing provider usage is shown as unavailable. Model requests, token counts, and elapsed wall time are different measurements; none is presented as account balance or monetary cost.

## Publishing

The explicit review action exports changed regular text files from the worktree, including newly created files. Both the export script and the host validate paths, file count, modes, encoding, and size. Container output is untrusted even when produced by a fixed script.

The review response includes a SHA-256 digest of the files and original source revision. The publish action exports again and rejects a changed digest. The Worker creates a Git tree, commit whose parent is the pinned source commit, and a new arno/ branch. It then opens a pull request against the selected base branch.

Existing branches are never overwritten. If pull-request creation fails after branch creation, the UI links to the branch and reports the partial result. Older sessions without recorded source revisions must be reopened as new sessions before publication.

## Limits

- Cloudflare checkpoints have a 30-day retention window refreshed by restoration.
- The UI retains up to 20 turns. Very large diffs/logs are truncated for display.
- Each task permits up to 16 model calls, a four-minute CLI deadline, and 4,096 maximum output tokens per inference request.
- General container Internet access is disabled. Model inference, built-in web research, and enabled remote MCP are host-mediated exceptions. Arbitrary dependency downloads remain unavailable.
- Publishing supports up to 50 regular UTF-8 changed files totaling 1 MB. Binary files and symlinks are rejected.
- Answer text and provider-exposed thinking stream live through authenticated SSE; coding previews show the current model pass. Tool arguments and raw tool events are not streamed. The final coding result appears after its checkpoint completes.
- Regular chat uses no VM. It supports a bounded host-side research loop and a quiet chat-specific loading state.
- Physical iPhone keyboard testing remains necessary alongside automated viewport tests.
- Account balance, pricing-based cost, and unlimited context are not available.

These limits should remain visible in product documentation and must not be described as complete feature parity with another coding product.
