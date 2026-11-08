# Mobile request recovery validation

2026-11-08:

- Browser testing aborts the submission response after saving the request body, then returns the saved task result from the status endpoint. The conversation displays the result successfully.
- Backend tests cover durable enqueue, submission deduplication, concurrent-turn rejection, and alarm-driven completion without the original HTTP request.
- A separate temporary Worker submitted a real fixture task through the production Durable Object and Ollama gateway, selecting kimi-k3.1-pro.
- The submit response returned queued immediately; subsequent status requests returned running, then completed.
- The model read the README and answered: “This repository is a disposable example fixture for testing an Arno coding task.”
- Exit code: 0. Duration from queued to checkpointed completion: approximately 35 seconds.

The original Safari screenshot alone does not establish the exact cause of its network failure. The implementation removes dependence on a long-lived phone request and resumes status polling after connection loss. Physical Safari validation remains necessary.
