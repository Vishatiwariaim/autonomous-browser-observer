# Autonomous Browser Observer

Local AI-assisted browser observation → issue detection → Cursor ACP investigation.

> **Current status: Phase 4 — Autopilot (agent checks + fix until verify)**

## Quick start

```bash
cp .env.example .env
npm install
npm run build
npm start                 # Observer :3847
npm run start:demo        # Login demo :3000
```

Dashboard: http://127.0.0.1:3847/ — use **Start Autopilot** after issues exist.

### Deploy backend (users only need extension)

See **[DEPLOY.md](DEPLOY.md)**. Short version:

```powershell
.\scripts\deploy-lan.ps1
```

Server pe Observer chalta hai (`0.0.0.0:3847`); dusre PC pe sirf `extension/dist` load + Options me server URL/token.

Docker: `docker compose up -d --build`

### Load the extension (Chrome / Edge)

```bash
npm run build:extension
```

1. Open `chrome://extensions` → Load unpacked → `extension/dist`
2. Popup → **Connected**
3. Agent/MCP can call `request_browser_check`; extension polls and fulfills live checks

```bash
npm run verify:extension
npm run test:extension
npm run demo:phase4
```

Env:
- `ABO_AUTOPILOT=1` — auto-start loop when new agent tasks appear
- `ABO_AUTOPILOT_MAX=3` — max fix attempts

## Phase 3 / 4 E2E

```bash
npm run demo:phase3
npm run demo:phase4
```

## Packages

| Path | Role |
| --- | --- |
| `extension/` | MV3 observer + agent check fulfillment |
| `observer/` | Ingest, checks bus, autopilot, dashboard |
| `controller/` | Grouping + issue detection + task generation |
| `ai/` | Local heuristic analyzer |
| `cursor-bridge/` | ACP client + permission policy |
| `mcp-observer/` | MCP tools incl. request_browser_check / start_autopilot |
| `demo-app/` | Deliberate login bug for E2E |

## Security

- Secrets redacted before storage/AI/MCP
- Extension observation-only (no auto click/type); fulfills read checks only
- Destructive shell auto-rejected
- Autopilot stops on VERIFY PASS or max attempts
