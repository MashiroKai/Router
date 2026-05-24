#!/usr/bin/env node
/**
 * Router — Unified AI API Gateway
 *
 * Accepts all local AI agent traffic and routes it to configured upstream
 * providers with automatic fallback, API key injection, and unified logging.
 *
 * Supported protocols:
 *   - Anthropic Messages API (/v1/messages, /api/anthropic/*)
 *   - OpenAI Chat Completions (/v1/chat/completions)
 *   - OpenAI Responses API (/v1/responses)
 *
 * Usage: node src/gateway.mjs
 * Logs:  ~/Router/logs/router/
 * Viewer: http://127.0.0.1:9997/_viewer/
 */

import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';

import { CONFIG, PORT } from './config.mjs';
import { detectApiFormat, detectClientAgent, normalizeAgentPath } from './protocol/detect.mjs';
import { logRequest } from './logging/logger.mjs';
import { pruneOldLogs } from './logging/retention.mjs';
import { resolveProviderForAgent } from './provider/manager.mjs';
import { tryProvider } from './provider/fallback.mjs';
import { handleViewerRequest } from './viewer/api.mjs';

// ═══════════════════════════════════════════════════════════════════
// Request Deduplication
// ═══════════════════════════════════════════════════════════════════

const recentRequests = new Map();
const DEDUP_WINDOW_MS = CONFIG.dedup_window_ms || 5000;

function hashBody(bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    const normalized = {
      model: parsed.model,
      messages: parsed.messages,
      system: parsed.system,
      tools: parsed.tools,
      max_tokens: parsed.max_tokens,
      temperature: parsed.temperature,
      top_p: parsed.top_p,
      stream: parsed.stream,
      thinking: parsed.thinking,
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha256').update(bodyStr).digest('hex').slice(0, 16);
  }
}

function isDuplicate(agent, bodyStr) {
  const hash = `${agent}:${hashBody(bodyStr)}`;
  const now = Date.now();
  for (const [k, t] of recentRequests) {
    if (now - t > DEDUP_WINDOW_MS) recentRequests.delete(k);
  }
  if (recentRequests.has(hash)) return true;
  recentRequests.set(hash, now);
  return false;
}

// Periodic dedup cleanup
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, t] of recentRequests) {
    if (now - t > DEDUP_WINDOW_MS) { recentRequests.delete(k); cleaned++; }
  }
  if (cleaned > 0) console.log(`[DEDUP] Cleaned ${cleaned} expired entries`);
}, 60000);

// ═══════════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  req.on('error', (err) => {
    console.error(`[CLIENT ERROR] Request stream error: ${err.code || err.message}`);
  });
  res.on('error', (err) => {
    console.error(`[CLIENT ERROR] Response stream error: ${err.code || err.message}`);
  });

  // Viewer routes
  if (req.url.startsWith('/_viewer')) {
    return handleViewerRequest(req, res);
  }

  // API proxy routes
  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    let bodyStr = Buffer.concat(body).toString('utf-8');

    const clientAgent = detectClientAgent(req);
    req.url = normalizeAgentPath(req.url);

    const apiFormat = detectApiFormat(req.url);

    if (bodyStr && isDuplicate(clientAgent || 'unknown', bodyStr)) {
      console.log(`[DEDUP] Blocked duplicate request to ${req.url}`);
      try {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Duplicate request detected' } }));
      } catch {}
      return;
    }

    const reqSummary = bodyStr ? logRequest(bodyStr, req.url, apiFormat, clientAgent) : null;
    if (reqSummary && clientAgent) {
      reqSummary.client_agent = clientAgent;
    }

    const startIdx = resolveProviderForAgent(
      reqSummary?.agent || 'router',
      reqSummary?.session_id || null,
      reqSummary?.model || ''
    );

    tryProvider(req, res, bodyStr, apiFormat, reqSummary, startIdx).catch(err => {
      console.error(`[UNHANDLED] tryProvider error for ${reqSummary?.agent}:`, err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: 'Request failed' } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Server Lifecycle
// ═══════════════════════════════════════════════════════════════════

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (!server._retryCount) server._retryCount = 0;
    server._retryCount++;
    if (server._retryCount <= 20) {
      console.log(`[STARTUP] Port ${PORT} in use, retrying in 300ms... (${server._retryCount}/20)`);
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 300);
    } else {
      console.error(`[STARTUP] Port ${PORT} still in use after 20 retries, giving up`);
      process.exit(1);
    }
  } else {
    console.error('[SERVER ERROR]', err.message);
  }
});

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.error('[UNCAUGHT] Client connection error:', err.code);
    return;
  }
  console.error('[UNCAUGHT]', err);
  process.exit(1);
});

// ── Graceful Shutdown ───────────────────────────────────────────────

const activeRequests = new Set();

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close(); // stop accepting new connections
  const deadline = Date.now() + 10000;
  const check = () => {
    if (activeRequests.size === 0 || Date.now() > deadline) {
      console.log('Router gateway closed');
      process.exit(0);
    }
    setTimeout(check, 500);
  };
  check();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Hot Reload ──────────────────────────────────────────────────────

process.on('SIGHUP', () => {
  console.log('[HOT RELOAD] Received SIGHUP, gracefully restarting...');
  const child = spawn(
    process.argv[0],
    [process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: process.env, detached: true }
  );
  child.unref();
  console.log(`[HOT RELOAD] Replacement spawned (PID ${child.pid}), closing old server...`);
  server.close(() => {
    console.log('[HOT RELOAD] Old server closed gracefully');
    process.exit(0);
  });
  setTimeout(() => { console.error('[HOT RELOAD] Force exit after timeout'); process.exit(0); }, 5000);
});

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

// Run log cleanup on startup and daily
pruneOldLogs();
setInterval(pruneOldLogs, 24 * 60 * 60 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nRouter Unified AI Gateway`);
  console.log(`   Listen:  http://127.0.0.1:${PORT}`);
  console.log(`   Viewer:  http://127.0.0.1:${PORT}/_viewer/`);
  console.log(`   Providers: ${CONFIG.providers.map(p => p.name).join(' -> ')}`);
  console.log(`\nConfigure agents:`);
  console.log(`   Claude Code: ANTHROPIC_BASE_URL = http://127.0.0.1:${PORT}/api/anthropic`);
  console.log(`   OpenAI-compatible: base_url = http://127.0.0.1:${PORT}/v1`);
  console.log(`\nPress Ctrl+C to stop\n`);
});
