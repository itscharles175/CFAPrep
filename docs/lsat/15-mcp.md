# MCP server (Jarvis integration)

LSAT Lab exposes a read-only **Model Context Protocol** server so external agents
(e.g. Jarvis) can query study stats without a hosted backend.

## Entry point

- Module: `backend/app/mcp_server.py`
- Transport: stdio (MCP SDK)

## Running locally

From the repo root with the backend environment synced:

```powershell
cd backend
uv run python -m app.mcp_server
```

Point your MCP client at that command. The server uses the same SQLite database
as the desktop app (`LSATLAB_DATA_DIR` / default app-data path).

## What it can answer

Tools wrap existing analytics and session APIs, for example:

- Recent study sessions and scores
- Performance by question type
- Coach snapshot summary (when available)

## Settings UI

Open **Settings → Diagnostics** for worker/queue health. MCP status is local-only;
no network endpoint is opened beyond loopback FastAPI when the app is running.

## Security

- Read-only tools only; no writes through MCP in v1.
- Same machine trust boundary as the desktop app (single-user local).
