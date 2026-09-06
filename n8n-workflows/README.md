# n8n workflows (optional)

Import these JSON files into n8n (**Workflows → Import from File**). Each exposes a POST webhook at `/webhook/<tool_name>` with the same contract as the local mock server.

For local hackathon demos without n8n cloud, prefer:

```bash
npm run tools
```

See `../tools/README.md` for curl examples and the `customer_id` dependency.

The Code nodes here use a small in-memory seed (same IDs as the mock). Behavior is simplified vs the Node mock (less random latency/rate-limit noise); use the mock server when you need imperfect responses for agent learning.
