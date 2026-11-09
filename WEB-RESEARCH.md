# Web research and verifiable citations

All regular and coding conversations have search and page-reading tools.

The host uses Ollama's documented POST /api/web_search and POST /api/web_fetch endpoints. These are fixed provider URLs; source websites never receive the Ollama key. A personal Ollama key is used when configured, otherwise the private deployment's fallback key supplies web access.

## Research behavior

Search returns up to six results, not just the first hit. The model is instructed to compare results, prefer primary documentation, read original pages, and use independent articles when relevant. A researched comparison should read at least two credible pages.

Each turn permits up to three search queries and six page reads. Plain chat supports up to eight model rounds, including a final answer round without tools. Coding uses Arno's MCP tool loop with its existing model-call and process limits.

Web content is explicitly treated as evidence rather than instructions. Tool failures are returned as failures; the model must not pretend a search succeeded.

## Source identity

The host assigns stable numeric IDs to actual search/fetch results. Source records include the original URL, title, excerpt, and retrieval timestamp. The recent source registry is bounded to 30 records; retained conversation turns preserve their own cited source records.

The model cites claims as [1], [2], and so on. The renderer turns a number into a citation button only when that ID exists in the answer's saved source records. Fabricated numbers remain plain text. Citation buttons and source cards open a preview with publisher/domain, title, excerpt, retrieval time, and original link.

This makes citations inspectable; it does not guarantee that every generated claim is supported correctly. Users can open the original evidence to verify the claim.

## Provider integration

Regular chat uses OpenAI/Ollama function calls or Anthropic native tool-use blocks. Tool responses are returned in the correct provider protocol before the model writes its answer.

Coding sessions receive the same read-only tools as web_web_search and web_web_read through an internal MCP server. These two read-only research tools are trusted in the Arno configuration so reading several sources does not consume the limited interactive approval input.

General network access in the coding VM remains disabled. The host mediates model inference, enabled remote MCP, and built-in research separately.

## Live validation

The real Mistral Large 4 regular-chat test compared Cloudflare Durable Objects and D1 for chat state. It performed three searches, read six pages, cited six sources across official documentation and independent technical articles, and completed in approximately 31 seconds without starting a container.

The sources included developers.cloudflare.com, oscargabriel.dev, and setkernel.com. This validation checked actual tool execution and saved source records, not only a mock citation UI.

The real coding-mode test used Arno's built-in research MCP server. It performed three searches, read three original documentation/blog pages, enforced the three-search cap on a fourth attempt, and produced three recorded numbered citations. Model execution took approximately 57 seconds, preparation 267 ms, and checkpointing 2.6 seconds.
