# Live recovery validation

2026-11-08, isolated Cloudflare Worker and container using the production runner image and ArnoProbe implementation.

1. Created a marker file and model configuration in the container.
2. Stored session metadata and transcript in Durable Object storage.
3. Saved a full filesystem checkpoint.
4. Destroyed the running container.
5. Restored through the application's start method and verified the marker and transcript.
6. Changed the model through the application's session/model handler to gpt-oss:120b.
7. Destroyed and restored the container again; verified the changed model configuration.

Result:

```json
{"stopped":true,"fileRestored":true,"historyRestored":true,"switchStatus":200,"switchedModelRestored":true,"passed":true,"containerStopped":true}
```

The test used a disposable fixture; it did not access user repositories or call Ollama inference. Browser tests separately exercise model selection, session reopening, paginated search, and mobile viewport sizes with mocked API responses. Physical iPhone keyboard testing and inference compatibility across the expanded model catalog remain user validation tasks.
