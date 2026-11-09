# Redesigned workspace validation — 2026-11-09

## Automated browser checks

The current local HTML was exercised in Chromium using API fixtures:

- Found a repository on page 3 after scanning 300 fixture repositories.
- Opened the mobile session drawer and resumed a saved conversation.
- Rendered Markdown headings, bold text, links, lists, code fences, and tables.
- Changed model through the searchable dialog.
- Opened measured usage and repository details.
- Reviewed changes and invoked the explicit branch/PR action against a mock API.
- Recovered the result after deliberately aborting the submission response.
- Checked portrait, landscape, keyboard-height, and desktop layouts for overflow.
- Switched to the light theme.
- Captured phone, desktop, and usage screenshots and inspected them visually.

These fixtures are not a claim of real GitHub publication. Publishing is covered by host-side mocked API tests: stale review rejection, pinned commit parent, new arno/ branch, and PR base. A real publication should be initiated by the user after reviewing actual work.

## Real provider and container checks

A temporary fixture used the production Durable Object implementation, pinned runner image, and actual Ollama Cloud Mistral Large 4 gateway.

Turn 1 asked the agent to remember amber-plum-7341, read README.md, create note.txt containing hello, and verify it with a shell command.

- Result: exit code 0; file created and verified.
- Preparation: 57 ms; workspace mode warm.
- Agent execution: 52,347 ms.
- Checkpoint: 1,734 ms; total: 54,144 ms.
- Ollama usage: 4 measured calls, 16,709 input tokens, 427 output tokens.

Turn 2 asked for the earlier phrase, remote repository and branch, verification with git remote get-url origin, and confirmation that note.txt remained.

- Result: exit code 0; phrase recalled exactly, GitHub origin verified, main identified from host context, note.txt still contained hello.
- Preparation: 45 ms; same warm workspace.
- Agent execution: 39,283 ms.
- Checkpoint: 2,279 ms; total: 41,622 ms.
- Ollama usage: 4 measured calls, 17,466 input tokens, 298 output tokens.

This separates model latency from workspace setup. A fresh Arno process is still started for each turn; its prompt includes retained conversation and repository provenance. The container is reused while warm.

A third real turn ran after the next deployment. It restored the saved workspace in 172 ms, recalled the original phrase, created final.txt with that phrase, and verified it. Agent execution took 34,196 ms; checkpointing took 2,187 ms. Ollama reported 3 calls, 13,471 input tokens, and 271 output tokens. Its review diff correctly included both new files, and the change exporter returned their exact UTF-8 contents. The transcript migrated to separate turn records and retained all three turns.

## Remaining practical limits

Additional browser checks cover numbered citations and source previews, code navigation, wide-screen docking and resizing, quiet regular-chat loading, avatar-based account settings, provider keys, instructions, skills, MCP connection tests, conversation rename/delete from the list, and full-height mobile account layout. Widths from 360 to 3440 pixels were checked for horizontal overflow.

Real regular-chat calls retained a remembered phrase and applied account instructions without starting a container. A real coding call exercised a configured remote MCP echo tool. Real web research in regular chat performed three searches and six page reads with six citations; coding research performed three searches and three page reads with three citations. The temporary validation Worker and fixture records were removed afterward. OpenAI and Anthropic protocols are covered by automated tests; live calls require personal provider keys.

Physical iOS Safari keyboard interaction needs phone validation. The app does not expose a live terminal, unlimited chat history, arbitrary dependency downloads, token prices/account balance, or native Claude Code feature parity. See ARCHITECTURE.md for exact limits.
