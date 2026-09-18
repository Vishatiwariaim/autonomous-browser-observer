# Phase 2 — AI Observer + Controller

## Implemented

- Event aggregation (`controller` package)
- Issue detection with NORMAL / WARNING / POSSIBLE_ISSUE / CONFIRMED_ISSUE
- Local heuristic AI analyzer (`ai` package) — structured JSON only
- SQLite tables: `issues`, `ai_analysis`, `agent_tasks`, `event_groups`
- Controller orchestration wired into Observer ingest
- Dashboard sections for issues, AI analysis, agent tasks
- Phase 2 demo app at `/phase2-demo`

## Explicitly out of scope

- Cursor Agent communication
- Automatic code modification
- Autonomous fixing
- Playwright browser-runner (Phase 3)
