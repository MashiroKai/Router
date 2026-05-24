# Router

Unified AI API Gateway with transparent fallback, protocol translation, and a built-in request inspector.

Router sits between your AI agents (Claude Code, Codex, Nebflow, any OpenAI/Anthropic-compatible client) and upstream LLM providers. It handles API key injection, model mapping, automatic failover, and provides a web dashboard to inspect every request/response in real time.

**Zero dependencies.** Pure Node.js ESM.

---

## Features

- **Multi-protocol** — Anthropic Messages, OpenAI Chat Completions, OpenAI Responses API, auto-detected
- **Transparent fallback** — primary provider fails (429, 5xx, empty stream, network error), router silently retries on the next provider; callers never see upstream errors
- **Circuit breaker** — per-provider, prevents hammering a dead endpoint
- **Protocol translation** — Anthropic ↔ OpenAI bidirectional, including SSE streaming
- **Request deduplication** — identical requests within a configurable window are deduplicated
- **Sticky load balancing** — session-affinity based routing across multiple providers
- **Built-in inspector** — web dashboard at `/_viewer/` with session grouping, token usage tracking, context window visualization, and request diffing
- **Hot reload** — zero-downtime restart via SIGHUP
- **Security** — API keys referenced via environment variables, never stored in config files

## Architecture

```
Agent (Claude Code / Codex / Nebflow / ...)
  │
  │  HTTP (any supported protocol)
  ▼
┌──────────────────────────────┐
│  Router Gateway  (port 9997) │
│                              │
│  ┌ detect → translate → route│
│  │  ↓         ↓         ↓   │
│  │ log     fallback   circuit│
│  └──────────────────────────┘
└──────────┬───────────────────┘
           │ HTTPS (inject API key)
           ▼
     Primary Provider
           │  (on failure)
           ▼
     Fallback Provider
```

### Module Layout

```
src/
├── gateway.mjs            # HTTP server, dedup, hot reload, graceful shutdown
├── config.mjs             # Config loading, env var resolution, agent model cache
├── protocol/
│   ├── detect.mjs         # Protocol detection, client agent identification
│   └── translator.mjs     # Anthropic ↔ OpenAI conversion, SSE parser
├── provider/
│   ├── manager.mjs        # Provider selection, model rewrite, sticky LB
│   ├── fallback.mjs       # FallbackFSM — core retry/fallback/circuit logic
│   └── circuit.mjs        # Circuit breaker
├── logging/
│   ├── logger.mjs         # Async write queue, content-addressed object store
│   └── retention.mjs      # Log rotation/cleanup
└── viewer/
    └── api.mjs            # REST API + static file serving for the dashboard
web/
├── index.html             # Dashboard HTML
├── css/viewer.css         # Theme-aware CSS (light/dark)
└── js/viewer.mjs          # Dashboard application
```

## Quick Start

### 1. Configure

```bash
cp config.example.json config.json
```

Edit `config.json` to add your providers. API keys are referenced by environment variable name:

```json
{
  "providers": [
    {
      "id": "my-provider",
      "anthropic": {
        "base_url": "https://api.example.com/anthropic",
        "api_key_env": "MY_PROVIDER_API_KEY"
      }
    }
  ]
}
```

### 2. Set environment variables

```bash
export MY_PROVIDER_API_KEY="sk-..."
```

### 3. Start

```bash
bash start.sh
```

Router starts on port 9997. Dashboard at http://127.0.0.1:9997/_viewer/

### 4. Point your agents

| Agent Protocol | Base URL |
|---|---|
| Anthropic | `http://127.0.0.1:9997/api/anthropic` |
| OpenAI | `http://127.0.0.1:9997/v1` |

Example — Claude Code:

```json
{
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:9997/api/anthropic"
}
```

Example — OpenAI-compatible client:

```bash
OPENAI_API_BASE=http://127.0.0.1:9997/v1
```

## Configuration

See `config.example.json` for the full schema. Key sections:

### Providers

Providers are tried in order. The first is primary, subsequent are fallbacks.

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "fallback_error_codes": [],
  "anthropic": {
    "base_url": "https://api.deepseek.com/anthropic",
    "api_key_env": "DEEPSEEK_API_KEY"
  },
  "models": {
    "default": "deepseek-v4-pro",
    "anthropic_mapping": {
      "claude-3-opus-20240229": "deepseek-v4-pro"
    }
  }
}
```

- `api_key_env` — environment variable name holding the API key (never the key itself)
- `models.default` — model used when client sends `Router-Auto` or no model
- `models.anthropic_mapping` — maps Anthropic model names to provider models
- `fallback_error_codes` — provider-specific error codes that trigger fallback

### Fallback Behavior

| Trigger | Default |
|---|---|
| Network error (ECONNREFUSED, ETIMEDOUT, ...) | Always |
| HTTP 429 (rate limit) | Enabled, with exponential backoff (3 retries) |
| HTTP 5xx | Enabled |
| Empty SSE stream | Enabled |
| Provider-specific 400 | Via `fallback_error_codes` |
| Semantic 400 (invalid_request_error) | **Never** fallback — caller error |

### Circuit Breaker

```json
{
  "circuit_breaker": {
    "threshold": 3,
    "cooldown_ms": 60000
  }
}
```

After `threshold` consecutive failures, the provider is tripped for `cooldown_ms`. One probe request is allowed after cooldown.

### Load Balancing

```json
{
  "load_balancing": {
    "enabled": true,
    "affinity_ttl_ms": 1800000,
    "rebalance_on_failure": true
  }
}
```

When enabled, `Router-Auto` requests are distributed across providers based on active session count, with sticky affinity per agent+session.

## Operations

```bash
# Start (foreground, Ctrl+C to stop)
bash start.sh

# Stop
bash stop.sh

# Hot reload (zero-downtime, picks up code/config changes)
bash reload.sh
```

## Dashboard

The built-in web dashboard provides:

- **Session grouping** — requests grouped by agent session
- **Token tracking** — input/output/cache tokens per request with context window visualization
- **Request inspector** — full message content, tool calls, SSE streaming reconstruction
- **Diff view** — compare consecutive requests to see what changed (system prompt, tools, messages)
- **Provider stats** — aggregated token usage by provider
- **Theming** — automatic light/dark mode via `prefers-color-scheme`

## Development

```bash
# Syntax check all modules
for f in src/**/*.mjs; do node --check "$f"; done

# Run CI checks (if GitHub Actions is configured)
# Push to a PR to trigger
```

No build step. No bundler. Pure ESM with Node.js built-in modules only.

## Requirements

- Node.js 18+ (ESM support)
- No npm dependencies

## License

MIT
