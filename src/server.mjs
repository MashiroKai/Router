/**
 * Nebflow LLM Log Reader — pure viewer server.
 *
 * Reads JSONL logs produced by Nebflow's LlmLogWriter at
 * ~/.nebflow/logs/router/ and serves them via a web dashboard.
 *
 * No proxy, no LLM calls, no multi-agent. Just reads.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');
const LOG_DIR = path.join(process.env.HOME, '.nebflow', 'logs', 'router');
const OBJECTS_DIR = path.join(LOG_DIR, 'objects');
const PORT = parseInt(process.env.PORT || '9997', 10);
const RETENTION_DAYS = 3;

// ── Helpers ──────────────────────────────────────────────────────────

function sendJSON(res, data, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, message, statusCode = 400) {
  sendJSON(res, { error: message }, statusCode);
}

function readJsonlLines(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getLogFilePath(suffix, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${d}_${suffix}.jsonl`);
}

function getObject(hash) {
  try { return JSON.parse(fs.readFileSync(path.join(OBJECTS_DIR, hash + '.json'), 'utf-8')); }
  catch { return null; }
}

function getAvailableDates() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const dates = new Set();
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})_summary\.jsonl$/);
      if (m) dates.add(m[1]);
    }
    return [...dates].sort().reverse();
  } catch { return []; }
}

// ── API: Dates ───────────────────────────────────────────────────────

function handleDates(_req, res) {
  return sendJSON(res, { dates: getAvailableDates() });
}

// ── API: Logs (paired request+response list) ─────────────────────────

function handleLogs(_req, res, query) {
  const date = query.get('date') || new Date().toISOString().slice(0, 10);
  const entries = readJsonlLines(getLogFilePath('summary', date));
  const sseEntries = readJsonlLines(getLogFilePath('sse', date));

  // Build SSE usage lookup by request_id and by agent
  const sseByRid = {};
  const sseByAgent = {};
  for (const sse of sseEntries) {
    if (!sse.usage) continue;
    if (sse.request_id) {
      sseByRid[sse.request_id] = sseByRid[sse.request_id] || [];
      sseByRid[sse.request_id].push({ ts: new Date(sse.timestamp).getTime(), usage: sse.usage });
    }
    const a = sse.agent || 'nebflow';
    sseByAgent[a] = sseByAgent[a] || [];
    sseByAgent[a].push({ ts: new Date(sse.timestamp).getTime(), usage: sse.usage });
  }
  for (const arr of Object.values(sseByRid)) arr.sort((a, b) => a.ts - b.ts);
  for (const arr of Object.values(sseByAgent)) arr.sort((a, b) => a.ts - b.ts);

  const paired = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'request') continue;
    const item = { ...e };
    let respTime = null;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j];
      if (next.type === 'response' && (next.agent || 'nebflow') === (e.agent || 'nebflow')) {
        item.response_status = next.status_code;
        item.response_time_ms = new Date(next.timestamp) - new Date(e.timestamp);
        respTime = new Date(next.timestamp).getTime();
        if (next.resolved_model) item.model = next.resolved_model;
        if (next.usage) item.usage = next.usage;
        continue;
      }
      if (next.type === 'request') break;
    }
    if (!item.usage) {
      let mergedUsage = null;
      const mergeOne = (u) => {
        if (!mergedUsage) mergedUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        if (u.input_tokens) mergedUsage.input_tokens = Math.max(mergedUsage.input_tokens, u.input_tokens);
        if (u.output_tokens) mergedUsage.output_tokens += u.output_tokens;
        if (u.prompt_tokens) mergedUsage.input_tokens = Math.max(mergedUsage.input_tokens, u.prompt_tokens);
        if (u.completion_tokens) mergedUsage.output_tokens += u.completion_tokens;
        if (u.cache_read_input_tokens) mergedUsage.cache_read_input_tokens = Math.max(mergedUsage.cache_read_input_tokens, u.cache_read_input_tokens);
        if (u.cache_creation_input_tokens) mergedUsage.cache_creation_input_tokens = Math.max(mergedUsage.cache_creation_input_tokens, u.cache_creation_input_tokens);
      };
      const rid = e.request_id;
      if (rid && sseByRid[rid]) {
        for (const sse of sseByRid[rid]) mergeOne(sse.usage);
      } else {
        const agentKey = e.agent || 'nebflow';
        const agentSse = sseByAgent[agentKey] || [];
        const reqTime = new Date(e.timestamp).getTime();
        const boundTime = respTime || reqTime + 300000;
        for (const sse of agentSse) {
          if (sse.ts >= reqTime - 2000 && sse.ts <= boundTime + 2000) mergeOne(sse.usage);
        }
      }
      if (mergedUsage) item.usage = mergedUsage;
    }
    paired.push(item);
  }
  return sendJSON(res, { date, entries: paired });
}

// ── API: Detail (full request+response with object resolution) ───────

function handleDetail(_req, res, query) {
  const date = query.get('date');
  const index = parseInt(query.get('index') || '0', 10);
  if (!date) return sendError(res, 'Missing date parameter');
  const fullPath = getLogFilePath('full', date);
  const entries = readJsonlLines(fullPath);
  let reqCount = 0, targetIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === 'request') { if (reqCount === index) { targetIdx = i; break; } reqCount++; }
  }
  if (targetIdx === -1) return sendError(res, 'Entry not found', 404);

  const requestEntry = entries[targetIdx];

  // Resolve object refs
  if (requestEntry.message_refs && !requestEntry.full) {
    requestEntry.full = {
      system: requestEntry.system_ref ? getObject(requestEntry.system_ref) : undefined,
      tools: requestEntry.tools_ref ? getObject(requestEntry.tools_ref) : [],
      messages: requestEntry.message_refs.map(ref => getObject(ref)).filter(Boolean),
      max_tokens: requestEntry.max_tokens,
      stream: requestEntry.stream,
      thinking: requestEntry.thinking,
    };
  }

  // Find response entry
  let responseEntry = null;
  for (let i = targetIdx + 1; i < entries.length; i++) {
    if (entries[i].type === 'response' && entries[i].agent === requestEntry.agent) { responseEntry = entries[i]; break; }
    if (entries[i].type === 'request') break;
  }

  // Reconstruct streaming response from SSE events
  if (responseEntry?.is_streaming) {
    const sseEntries = readJsonlLines(getLogFilePath('sse', date));
    const rid = requestEntry.request_id;
    const reqTime = new Date(requestEntry.timestamp).getTime();
    const resTime = responseEntry ? new Date(responseEntry.timestamp).getTime() : reqTime + 300000;
    let contentParts = [], reasoningParts = [], sseUsage = null;
    const toolJsonBuffers = {};
    const toolBlockMap = {};
    for (const sse of sseEntries) {
      if (rid && sse.request_id) { if (sse.request_id !== rid) continue; }
      else {
        const sseTime = new Date(sse.timestamp).getTime();
        if (sseTime < reqTime - 1000 || sseTime > resTime + 1000) continue;
        if (sse.agent && requestEntry.agent && sse.agent !== requestEntry.agent) continue;
      }
      if (sse.delta_content) contentParts.push(sse.delta_content);
      if (sse.delta_reasoning) reasoningParts.push(sse.delta_reasoning);
      if (sse.usage) sseUsage = sse.usage;
      if (sse.delta_tool_json && sse.sse_content_block_index != null) {
        const idx = sse.sse_content_block_index;
        if (!toolJsonBuffers[idx]) toolJsonBuffers[idx] = '';
        toolJsonBuffers[idx] += sse.delta_tool_json;
      }
      if (sse.sse_event_type === 'content_block_start' && sse.sse_content_block) {
        const blk = sse.sse_content_block;
        if (blk.type === 'tool_use') {
          toolBlockMap[sse.sse_content_block_index] = { id: blk.id, name: blk.name, type: 'tool_use' };
        }
      }
    }
    responseEntry.reconstructed_content = contentParts.join('');
    responseEntry.reconstructed_reasoning = reasoningParts.join('');
    responseEntry.sse_usage = sseUsage;
    const toolCalls = [];
    for (const [idx, json] of Object.entries(toolJsonBuffers)) {
      const meta = toolBlockMap[idx] || {};
      let input;
      try { input = JSON.parse(json); } catch { input = json; }
      toolCalls.push({ type: 'tool_use', id: meta.id, name: meta.name, input });
    }
    if (toolCalls.length > 0) responseEntry.reconstructed_tool_calls = toolCalls;
  }

  // Fallback: try to find assistant message in next request
  if (!responseEntry?.reconstructed_content && responseEntry?.status_code === 200 && responseEntry?.is_streaming) {
    const currentMsgsCount = requestEntry.full?.messages?.length || requestEntry.message_refs?.length || 0;
    for (let i = targetIdx + 1; i < entries.length; i++) {
      if (entries[i].type === 'request') {
        if (entries[i].message_refs && !entries[i].full) {
          entries[i].full = {
            system: entries[i].system_ref ? getObject(entries[i].system_ref) : undefined,
            tools: entries[i].tools_ref ? getObject(entries[i].tools_ref) : [],
            messages: entries[i].message_refs.map(ref => getObject(ref)).filter(Boolean),
          };
        }
        const nextMsgs = entries[i].full?.messages || [];
        const assistantMsg = nextMsgs[currentMsgsCount];
        if (assistantMsg?.role === 'assistant') {
          const c = assistantMsg.content;
          if (typeof c === 'string' && c) responseEntry.reconstructed_content = c;
          else if (Array.isArray(c)) {
            const textParts = [];
            const toolCalls = [];
            for (const x of c) {
              if (typeof x === 'string') { textParts.push(x); continue; }
              if (x.type === 'text') textParts.push(x.text);
              else if (x.type === 'tool_use') {
                toolCalls.push(x);
                textParts.push(`[Tool Use] ${x.name}\n${JSON.stringify(x.input, null, 2)}`);
              }
              else textParts.push(JSON.stringify(x));
            }
            responseEntry.reconstructed_content = textParts.join('\n');
            if (toolCalls.length > 0) responseEntry.reconstructed_tool_calls = toolCalls;
          }
        }
        break;
      }
    }
  }

  return sendJSON(res, { request: requestEntry, response: responseEntry });
}

// ── API: SSE Events ──────────────────────────────────────────────────

function handleSSEEvents(_req, res, query) {
  const date = query.get('date');
  const requestId = query.get('request_id');
  if (!date || !requestId) return sendError(res, 'Missing date or request_id');
  const sseEntries = readJsonlLines(getLogFilePath('sse', date));
  const events = sseEntries.filter(e => e.request_id === requestId);
  return sendJSON(res, { events });
}

// ── API: Usage ───────────────────────────────────────────────────────

function handleUsage(_req, res, query) {
  const date = query.get('date') || new Date().toISOString().slice(0, 10);
  const sseEntries = readJsonlLines(getLogFilePath('sse', date));
  const byAgent = {};
  for (const sse of sseEntries) {
    if (!sse.usage) continue;
    const a = sse.agent || 'nebflow';
    if (!byAgent[a]) byAgent[a] = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 };
    const u = sse.usage;
    byAgent[a].input_tokens += u.input_tokens || u.prompt_tokens || 0;
    byAgent[a].output_tokens += u.output_tokens || u.completion_tokens || 0;
    byAgent[a].cache_read_input_tokens += u.cache_read_input_tokens || 0;
    byAgent[a].cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    byAgent[a].request_count += 1;
  }
  const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 };
  for (const v of Object.values(byAgent)) {
    total.input_tokens += v.input_tokens;
    total.output_tokens += v.output_tokens;
    total.cache_read_input_tokens += v.cache_read_input_tokens;
    total.cache_creation_input_tokens += v.cache_creation_input_tokens;
    total.request_count += v.request_count;
  }
  return sendJSON(res, { date, total, byAgent });
}

// ── API: Stats ───────────────────────────────────────────────────────

function handleStats(_req, res) {
  const dates = getAvailableDates();
  const stats = {};
  for (const date of dates) {
    const entries = readJsonlLines(getLogFilePath('summary', date));
    const requests = entries.filter(e => e.type === 'request');
    const byAgent = {};
    for (const r of requests) { const a = r.agent || 'nebflow'; byAgent[a] = (byAgent[a] || 0) + 1; }
    stats[date] = { total: requests.length, byAgent };
  }
  return sendJSON(res, { stats });
}

// ── Static File Serving ──────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStaticFile(res, pathname) {
  const relPath = pathname.slice('/_viewer/'.length);
  const filePath = path.resolve(WEB_ROOT, relPath);
  const rootWithSep = WEB_ROOT + path.sep;
  if (filePath !== WEB_ROOT && !filePath.startsWith(rootWithSep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const content = fs.readFileSync(filePath);
    const ct = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + pathname);
  }
}

// ── Retention: hard 3-day limit ──────────────────────────────────────

function pruneOldLogs() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
    const usedHashes = new Set();

    if (fs.existsSync(LOG_DIR)) {
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (!f.endsWith('.jsonl')) continue;
        const dateStr = f.slice(0, 10);
        const fullPath = path.join(LOG_DIR, f);
        if (dateStr < cutoff) {
          fs.unlinkSync(fullPath);
        } else {
          // Collect referenced hashes
          for (const line of fs.readFileSync(fullPath, 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.system_ref) usedHashes.add(entry.system_ref);
              if (entry.tools_ref) usedHashes.add(entry.tools_ref);
              if (Array.isArray(entry.message_refs)) for (const h of entry.message_refs) usedHashes.add(h);
            } catch {}
          }
        }
      }
    }

    // Delete orphaned objects
    if (fs.existsSync(OBJECTS_DIR)) {
      for (const f of fs.readdirSync(OBJECTS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const hash = f.slice(0, -5);
        if (!usedHashes.has(hash)) fs.unlinkSync(path.join(OBJECTS_DIR, f));
      }
    }
  } catch (e) {
    console.error('[Retention] Error:', e.message);
  }
}

// ── Request Router ───────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.searchParams;

  // Root → redirect to viewer
  if (pathname === '/' || pathname === '/_viewer' || pathname === '/_viewer/') {
    parsedUrl.pathname = '/_viewer/index.html';
    return serveStaticFile(res, '/_viewer/index.html');
  }

  // API endpoints
  if (pathname.startsWith('/_viewer/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (pathname === '/_viewer/api/dates') return handleDates(req, res);
    if (pathname === '/_viewer/api/logs') return handleLogs(req, res, query);
    if (pathname === '/_viewer/api/detail') return handleDetail(req, res, query);
    if (pathname === '/_viewer/api/sse-events') return handleSSEEvents(req, res, query);
    if (pathname === '/_viewer/api/usage') return handleUsage(req, res, query);
    if (pathname === '/_viewer/api/stats') return handleStats(req, res);

    return sendError(res, 'Unknown API endpoint', 404);
  }

  // Static files
  if (pathname.startsWith('/_viewer/')) {
    return serveStaticFile(res, pathname);
  }

  sendError(res, 'Not found', 404);
});

server.listen(PORT, () => {
  console.log(`Nebflow LLM Log Reader → http://127.0.0.1:${PORT}/`);
  console.log(`  Log source: ${LOG_DIR}`);
  pruneOldLogs();
  setInterval(pruneOldLogs, 3600_000); // hourly
});
