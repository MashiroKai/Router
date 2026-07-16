# Nebflow LLM Log Reader

A read-only web dashboard for inspecting LLM requests and responses produced by [Nebflow](https://github.com/MashiroKai/Nebflow).

Nebflow writes structured JSONL logs for every LLM call (request body, streamed response, token usage, tool calls). Log Reader parses these files and presents them in a searchable, navigable interface — with session grouping, markdown rendering, token tracking, and request diffing.

**Zero dependencies.** Pure Node.js ESM. No proxy, no API keys, no LLM calls.

## Architecture

```
Nebflow ──direct──→ LLM Provider
  │
  └─ LlmLogWriter ──→ ~/.nebflow/logs/router/
                          │
                     ┌────┴─────┐
                     │ Log Reader │  ← port 9997
                     │ (this app) │
                     └──────────┘
```

Nebflow's `LlmLogWriter` writes three JSONL files per day plus a content-addressed object store. Log Reader watches this directory and serves the data through a web UI.

## Quick Start

```bash
bash start.sh
```

Dashboard opens at http://127.0.0.1:9997/

That's it. No configuration, no API keys, no environment variables. As long as Nebflow is running and producing logs at `~/.nebflow/logs/router/`, the dashboard will show them.

To stop: `bash stop.sh` or Ctrl+C.

## Log Format

Log Reader expects this directory structure at `~/.nebflow/logs/router/`:

```
2026-07-09_summary.jsonl   # Lightweight entries for list view
2026-07-09_full.jsonl      # Entries with object refs for detail view
2026-07-09_sse.jsonl       # SSE-style events for streaming reconstruction
objects/                   # Content-addressed store (SHA-256, deduplicated)
├── a1b2c3d4e5f6a7b8.json
└── ...
```

Retention is a hard 3-day limit. Files older than 3 calendar days and orphaned objects are pruned automatically (checked hourly).

## Features

### Session hierarchy

Sidebar mirrors Nebflow's organization:

```
📁 Nebflow                        ← project root (basename)
  📝 Fix CSS bug    Nebula  3 req   ← session name + agent + request count
    IN   glm-5.1  200  3.2s  12:34
    SUB  glm-5.1  200  1.1s  12:35  ← sub-agent calls indented
  📝 Add feature    Nebula  5 req
📁 paper-review
  📝 NIMA revision  Nebula  12 req
```

### Three-tab detail view

Each request has three tabs:

- **INPUT** — system prompt (markdown-rendered), tools (individual expandable cards), full message history with cached/new tags
- **OUTPUT** — response text (markdown-rendered), thinking, tool calls, SSE event timeline
- **DIFF** — token usage delta vs. previous request, system prompt line-level diff, added/removed tools

### Token tracking

Per-request token breakdown: input, cache read, cache write, output. Context window progress bar with model-specific limits. Click any token group to highlight corresponding messages.

### Markdown rendering

System prompts, message content, and thinking are rendered as formatted markdown — headers, lists, code blocks, bold/italic, inline code. Tool input schemas remain as formatted JSON for precision.

## File Layout

```
src/
└── server.mjs            # HTTP server: static files + 6 read-only API endpoints
web/
├── index.html            # Dashboard HTML
├── css/viewer.css        # Theme-aware CSS (light/dark)
└── js/viewer.mjs         # Dashboard application (sidebar, detail view, markdown)
start.sh                  # Launcher
stop.sh                   # Stop script
```

## API

All endpoints are read-only GET:

| Endpoint | Returns |
|---|---|
| `/_viewer/api/dates` | Available log dates |
| `/_viewer/api/logs?date=YYYY-MM-DD` | Paired request+response entries |
| `/_viewer/api/detail?date=YYYY-MM-DD&index=N` | Full request with resolved objects + SSE reconstruction |
| `/_viewer/api/sse-events?date=YYYY-MM-DD&request_id=UUID` | SSE events for a specific request |
| `/_viewer/api/usage?date=YYYY-MM-DD` | Aggregated token usage by agent |
| `/_viewer/api/stats` | Request counts by date and agent |

## Requirements

- Node.js 18+
- A running Nebflow instance producing logs

## License

MIT
