# Local stdio performance baseline

The adapter remains a client-side stdio MCP server. Initialization and tool discovery perform no ContentTraker network request or interactive login.

## Windows baseline

Recorded on 2026-07-25 (America/Vancouver) with the 0.5.0 candidate:

| Measurement | Samples | Median | p95 | Budget |
| --- | ---: | ---: | ---: | ---: |
| Process start through `initialize` + `tools/list` | 9 | 163.72 ms | 342.30 ms | 2,500 ms |
| Process start through first local `inspect_runtime_capabilities` result | 9 | 165.68 ms | 344.08 ms | 3,000 ms |

Host evidence: Windows x64, Node v24.15.0. The first sample was the slowest in both series and is included in p95.

Run:

```bash
cd plugins/contenttraker
npm run stdio-performance
```

The test starts a fresh bundled adapter for every sample, checks that structured tool schemas are discoverable, and fails when p95 exceeds either budget. The budgets intentionally leave substantial room for supported Node and workstation variance while remaining comfortably below the adapter's existing 10-second startup test timeout.

API latency is measured separately from MCP startup. Business calls may perform secure credential restoration, `/me`, `/workspaces`, project authorization, and the requested API operation; increasing the API timeout is not an acceptable fix for server-side latency.
