# HTTP API and stored state

All API routes require the opaque GitHub-authenticated session cookie except GET /api/me. Cross-origin requests are rejected. JSON errors have an error field; provider and token values are never included.

## Public routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | / | Self-contained application HTML |
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
| POST | /api/sessions/:id/model | Save model selection for the next turn |
| POST | /api/sessions/:id/cancel | Stop an active task and preserve the last completed checkpoint |
| GET | /api/sessions/:id/changes | Export exact changed text files and a review digest |
| POST | /api/sessions/:id/publish | Validate digest, create a new arno/ branch and commit, open a PR |

## Important payloads

Create session: repo is owner/name, ref is the selected branch, model is an approved cloud model ID. The host resolves ref to a 40-character source commit and downloads that exact archive. The response includes id, repo, ref, model, sourceSha, remoteUrl, createdAt.

Submit task: id is a client-generated UUID and prompt is 1–8,000 characters. In a regular chat, optional editAt (a saved turn's at) replaces that turn: it and every later turn are left out of the context and deleted once the new answer is saved. Reusing the same ID deduplicates an uncertain submission. A different ID is rejected with 409 while a turn is queued or running. Do not automatically retry an uncertain request with a new UUID.

Publish: digest must match the reviewed changed files and source revision. branch must use arno/ followed by an alphanumeric, underscore, or hyphen name. title is the commit/PR title, at most 200 characters. The result includes branch, commit, url, and an optional warning if the branch was created but the PR could not be opened.

## Task state

A job includes id, prompt, status, createdAt, stage, and optional timing fields while active. Terminal states include result and finishedAt.

| Status | Meaning |
| --- | --- |
| queued | Durable input exists; alarm scheduled |
| running | Alarm owns Arno execution |
| completed | Output and resulting checkpoint saved |
| failed | Execution, provider, or persistence failed; error available |
| cancelled | Explicitly stopped; resume from previous checkpoint |

Stage values are preparing, restoring, thinking, and checkpointing. They represent work phases, not percent complete.

A completed result includes summary, model, exitCode, diff, diagnostics, timing, and usage. Timing records preparation, agent execution, checkpoint, total wall time, and workspace mode. Usage includes calls, measuredCalls, inputTokens, and outputTokens. Token values may be null.

## Durable Object routing

The same implementation class has separate named instances:

- auth:opaque-cookie-id — encrypted-at-rest GitHub token and user identity;
- random OAuth state instances — short-lived one-time state;
- index:github-user-id — that user's recent-session entries;
- code:github-user-id:session-id — repository metadata, checkpoint, transcript, task, statistics.

Internal /session, /model, /auth, and /index paths are binding-only and have no public router. The model gateway can request a quota permit and report token usage, but has no GitHub publication authority.

GET /api/sessions/:id/events returns an authenticated text/event-stream view of that user's session. Preview events contain jobId, round, text, reasoning, and updatedAt. Events are complete bounded snapshots, so reconnecting never duplicates answer tokens. The current preview is replayed on connection and included in GET /api/sessions/:id/job as a polling fallback. Closing a stream does not cancel its job. Clients must use durable job completion as the final saved result.

## Persistence keys

session holds repository provenance and selected model. snapshot holds the opaque Cloudflare checkpoint handle. turn:timestamp:uuid keys hold individual retained transcript turns; history is the legacy key migrated after a successful turn. stats holds measured cumulative counters. job holds the latest task state. modelQuota holds the current turn ID, deadline, used calls, and measured usage.

live holds the latest bounded preview, persisted at most once a second plus model-pass completion. In-memory previews may be newer; a reconnect can briefly replay the persisted snapshot after an object restart. Preview state is scoped to a job ID. Thinking comes only from provider-designated display fields, is optional and collapsed in the UI, and is excluded from subsequent conversational prompts. Encrypted/redacted reasoning and signatures are never exposed.

The checkpoint, current transcript record, and statistics are written together after successful persistence. Snapshot failure never replaces the last known good checkpoint.
