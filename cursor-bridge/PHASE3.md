# Phase 3 — Cursor ACP Integration

## What was built

- `cursor-bridge` — official ACP client (`agent acp`, JSON-RPC over stdio)
- Permission policy — auto-allow read-only; require approval for writes; reject destructive
- Mock ACP server — used when Cursor CLI is not logged in (same protocol)
- `mcp-observer` + `.cursor/mcp.json` — read-only Observer tools + `report_cursor_result`
- `demo-app` — intentional login HTTP 500 fixed by agent during E2E
- Dashboard CURSOR AGENT section + workflow strip

## Auth for real Cursor

```powershell
irm 'https://cursor.com/install?win32=true' | iex
agent login
$env:ABO_FORCE_REAL_ACP=1
$env:ABO_ACP_MODE="real"
npm start
```

## E2E

```bash
npm run demo:phase3
```

## Out of scope (Phase 4+)

- Full Playwright browser-runner service package
- Autonomous multi-iteration repair loops without approval
- Cloud Cursor agents
