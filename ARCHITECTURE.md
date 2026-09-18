# Architecture — Autonomous Browser Observer

## Vision

A local system that observes a browser session, detects abnormal application behavior, reasons about likely bugs, and (in later phases, with explicit approval) asks Cursor Agent to inspect the repository, fix code, and verify with Playwright.

## Target components

| Path | Role | Phase |
| --- | --- | --- |
| `/observer` | Browser observation (extension + local ingest service) | **1–2** |
| `/controller` | Event grouping, issue detection, structured task generation | **2 (now)** |
| `/ai` | Local structured analysis (heuristic; no code execution) | **2 (now)** |
| `/storage` | SQLite: sessions, events, issues, ai_analysis, agent_tasks | **1–2** |
| `/cursor-bridge` | Cursor Agent ACP (JSON-RPC stdio) | **3 (now)** |
| `/mcp-observer` | Read-only Observer MCP tools | **3 (now)** |
| `/demo-app` | Broken login demo for ACP E2E | **3 (now)** |
| `/browser-runner` | Dedicated Playwright runner service | 4 |
| Wiring Observer → Controller → Cursor → Playwright | Integration loop | 5 |
| Learning / anomaly detection | History-based signals | 7 |
| Controlled autonomous fixing | Approval-gated repair loop | 8 |
| `/ui` | Dashboard (Phase 2 shows issues + AI + tasks) | 1–2 |

## Phase 1 design (implemented)

### Observer service

- Node.js + Express on `127.0.0.1`
- `POST /api/events` — ingest observation events
- `GET /api/events`, `/api/sessions`, `/api/status`, `/health`, `/api/extension/ping`
- **SQLite** at `OBSERVER_DATA_DIR/observer.sqlite` + screenshot files
- **WebSocket** `/ws` for live dashboard updates (`hello`, `events`, `status`)
- Server-side redaction before persist; form values never stored
- Mode locked to `observe-readonly`
- Demo pages at `/demo` and `/demo/page-b`

### Browser extension (MV3)

- **inject.js** (page world): console + fetch/XHR failures
- **content.js**: DOM snapshot, visible text, clicks, input change (redacted), bridges inject → background
- **background.js**: session id, HTTP ingest, screenshots, `webRequest` failures
- **popup**: enable/disable, endpoint, manual snapshot

### Event model

Types: `page_snapshot`, `console_error`, `network_failure`, `user_click`, `user_input`, `navigation`, `screenshot`, `session_start`, `session_end`.

Payloads are Zod-validated on ingest. Screenshots are decoded and written to disk; base64 is stripped from stored JSON.

### Security boundaries

```
Web page ──x──► host OS / shell / filesystem writes
Web page ──► extension (observe only) ──► local observer API
Observer API ──x──► arbitrary command execution
```

No passwords, cookies, tokens, or secrets are retained in clear text.

## Phase 2+ (not built yet)

1. **Controller** consumes observer events, creates `issues`, manages iterations
2. **SQLite** replaces flat JSON for sessions/events/issues/tasks/results
3. **browser-runner** verifies fixes with Playwright
4. **cursor-bridge** submits structured tasks to Cursor Agent
5. Closed loop with max iterations and approval gates for destructive actions

## Communication

Phase 1: REST over localhost HTTP.  
Later: WebSocket for live streams; MCP/ACP for agent sessions where appropriate.

## Configuration

All runtime knobs via environment variables (see `.env.example`). Secrets must never be logged.
