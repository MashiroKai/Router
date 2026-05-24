/**
 * Async Logger — JSONL logging with content-addressed object storage.
 *
 * NOTE: writeLog uses an async write queue to avoid blocking the event loop.
 * Viewer API reads remain synchronous (off the hot path).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { CONFIG, LOG_DIR, OBJECTS_DIR } from '../config.mjs';
import { stripModelPrefix } from '../protocol/detect.mjs';

// ── Log File Paths ──────────────────────────────────────────────────

export function getLogFilePath(type, date) {
  const d = date || new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${d}_${type}.jsonl`);
}

// ── Async Write Queue ───────────────────────────────────────────────
// Serializes all log writes to avoid interleaving and event-loop blocking.

const writeQueue = [];
let writeInProgress = false;

async function drainWriteQueue() {
  if (writeInProgress || writeQueue.length === 0) return;
  writeInProgress = true;
  while (writeQueue.length > 0) {
    const { filepath, line } = writeQueue.shift();
    try {
      await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
      await fs.promises.appendFile(filepath, line);
    } catch (e) {
      console.error('[ERROR] writeLog:', e.message);
    }
  }
  writeInProgress = false;
}

function writeLog(filepath, data) {
  writeQueue.push({ filepath, line: JSON.stringify(data) + '\n' });
  drainWriteQueue(); // fire-and-forget — queue handles serialization
}

// ── Content-Addressed Object Store ──────────────────────────────────

function hashContent(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

/**
 * Async storeObject — uses O_EXCL|O_CREAT for atomic create-if-not-exists.
 */
const storeQueue = [];
let storeInProgress = false;

async function drainStoreQueue() {
  if (storeInProgress || storeQueue.length === 0) return;
  storeInProgress = true;
  while (storeQueue.length > 0) {
    const { objPath, data, resolve } = storeQueue.shift();
    try {
      await fs.promises.mkdir(OBJECTS_DIR, { recursive: true });
      try {
        const fd = await fs.promises.open(objPath, 'wx'); // O_EXCL | O_CREAT
        await fd.writeFile(JSON.stringify(data));
        await fd.close();
      } catch (e) {
        if (e.code !== 'EEXIST') throw e; // already exists is fine
      }
    } catch (e) {
      console.error('[ERROR] storeObject:', path.basename(objPath), e.message);
    }
    resolve();
  }
  storeInProgress = false;
}

/**
 * Store an object and return its hash. Async but returns hash synchronously
 * (hash is deterministic — no need to wait for disk).
 */
function storeObject(data) {
  const hash = hashContent(data);
  const objPath = path.join(OBJECTS_DIR, hash + '.json');
  let resolve;
  const p = new Promise(r => { resolve = r; });
  storeQueue.push({ objPath, data, resolve });
  drainStoreQueue();
  return hash; // return immediately, write happens in background
}

/**
 * Synchronous read for Viewer API (off hot path).
 */
export function getObject(hash) {
  try {
    return JSON.parse(fs.readFileSync(path.join(OBJECTS_DIR, hash + '.json'), 'utf-8'));
  } catch { return null; }
}

// ── Agent Info Extraction ───────────────────────────────────────────

function extractAgentInfo(parsed, apiFormat) {
  const info = { agent: 'router', channel: 'cli', resolved_model: null };

  if (apiFormat === 'anthropic_messages') {
    const system = parsed.system;
    const systemText = typeof system === 'string' ? system :
      Array.isArray(system) ? system.map(s => s.text || '').join('\n') : '';
    if (systemText) {
      const m = systemText.match(/\bagent=(\w[\w-]*)/);
      if (m) info.agent = m[1];
      const c = systemText.match(/\bchannel=(\w[\w-]*)/);
      if (c) info.channel = c[1];
    }
  } else {
    const messages = parsed.messages || [];
    for (const msg of messages) {
      if (msg.role !== 'system') continue;
      const content = typeof msg.content === 'string' ? msg.content : '';
      const m = content.match(/\bagent=(\w[\w-]*)/);
      if (m) info.agent = m[1];
      const c = content.match(/\bchannel=(\w[\w-]*)/);
      if (c) info.channel = c[1];
      const mod = content.match(/\bmodel=(zai\/[\w.-]+)/);
      if (mod) info.resolved_model = mod[1];
      if (info.agent !== 'router') break;
    }
  }
  return info;
}

// ── Request Logging ─────────────────────────────────────────────────

export function logRequest(reqBody, reqUrl, apiFormat, clientAgent) {
  try {
    const parsed = JSON.parse(reqBody);
    const agentInfo = extractAgentInfo(parsed, apiFormat);

    let sessionId = null;
    if (parsed.metadata?.session_id) {
      sessionId = parsed.metadata.session_id;
    } else if (parsed.metadata?.user_id) {
      try { sessionId = JSON.parse(parsed.metadata.user_id).session_id || null; } catch {}
    }

    const isSubagent = (() => {
      if (apiFormat === 'anthropic_messages') {
        const sys = typeof parsed.system === 'string' ? parsed.system :
          Array.isArray(parsed.system) ? parsed.system.map(s => s.text || '').join('\n') : '';
        return sys.includes('READ-ONLY MODE');
      }
      return false;
    })();

    const isCompaction = (() => {
      const msgs = parsed.messages || parsed.input || [];
      const last = msgs[msgs.length - 1];
      if (!last) return false;
      const content = typeof last.content === 'string' ? last.content :
        Array.isArray(last.content) ? last.content.map(c => c.text || c.type === 'text' ? c.text || '' : '').join('') :
        typeof last === 'string' ? last : '';
      return content.includes('CRITICAL: Respond with TEXT ONLY') && content.includes('create a detailed summary');
    })();

    const messages = parsed.messages || parsed.input || [];
    const systemLength = (() => {
      if (apiFormat === 'anthropic_messages') {
        const s = parsed.system;
        return typeof s === 'string' ? s.length : Array.isArray(s) ? JSON.stringify(s).length : 0;
      }
      const sysMsg = messages.find(m => m.role === 'system' || m.role === 'developer');
      return sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content.length : JSON.stringify(sysMsg.content).length) : 0;
    })();

    const summary = {
      timestamp: new Date().toISOString(),
      type: 'request',
      request_id: crypto.randomUUID(),
      url: reqUrl,
      api_type: apiFormat,
      model: stripModelPrefix(parsed.model) || 'unknown',
      agent: clientAgent || agentInfo.agent,
      channel: agentInfo.channel,
      session_id: sessionId,
      metadata_agent_id: parsed.metadata?.agent_id || null,
      messages_count: messages.length,
      system_length: systemLength,
      tools_count: (parsed.tools || []).length,
      tool_calls_count: (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === 'assistant' && Array.isArray(m.content)) {
            let count = 0;
            for (const c of m.content) { if (c?.type === 'tool_use') count++; }
            return count;
          }
        }
        return 0;
      })(),
      tool_results_count: (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === 'user' && Array.isArray(m.content)) {
            let count = 0;
            for (const c of m.content) { if (c?.type === 'tool_result') count++; }
            return count;
          }
          if (m.role === 'tool') return 1;
        }
        return 0;
      })(),
      max_tokens: parsed.max_tokens || parsed.max_output_tokens || null,
      stream: parsed.stream || false,
      thinking_enabled: !!(parsed.thinking),
      is_compaction: isCompaction,
      is_subagent: isSubagent,
    };

    const fullEntry = {
      ...summary,
      system_ref: (() => {
        if (apiFormat === 'anthropic_messages' && parsed.system) return storeObject(parsed.system);
        const sysMsg = messages.find(m => m.role === 'system' || m.role === 'developer');
        return sysMsg ? storeObject(sysMsg) : null;
      })(),
      tools_ref: parsed.tools?.length ? storeObject(parsed.tools) : null,
      message_refs: (() => {
        if (apiFormat !== 'anthropic_messages') {
          return messages
            .filter(m => m.role !== 'system' && m.role !== 'developer')
            .map(m => storeObject(m));
        }
        return messages.map(m => storeObject(m));
      })(),
      max_tokens: summary.max_tokens,
      stream: summary.stream,
      thinking: parsed.thinking || null,
    };

    writeLog(getLogFilePath('full'), fullEntry);
    writeLog(getLogFilePath('summary'), summary);

    console.log(`[REQ] ${summary.timestamp} | agent=${summary.agent} | model=${summary.model} | msgs=${summary.messages_count} | tools=${summary.tools_count} | format=${apiFormat}`);
    return summary;
  } catch (e) {
    console.error('[ERROR] logRequest:', e.message);
    return null;
  }
}

// ── Response Logging ────────────────────────────────────────────────

export function logResponse(respBody, reqSummary, isStreaming, statusCode, contentType, resolvedModel, usage, providerId) {
  const summary = {
    timestamp: new Date().toISOString(),
    type: 'response',
    request_model: reqSummary?.model || 'unknown',
    resolved_model: resolvedModel || reqSummary?.model || 'unknown',
    agent: reqSummary?.agent || 'router',
    response_length: respBody.length,
    is_streaming: isStreaming,
    status_code: statusCode,
    content_type: contentType,
  };
  if (usage) summary.usage = usage;
  if (providerId) summary.provider_id = providerId;

  writeLog(getLogFilePath('full'), { ...summary, full: respBody });
  writeLog(getLogFilePath('summary'), summary);

  const usageStr = usage ? ` | in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cache_r=${usage.cache_read_input_tokens || 0}` : '';
  console.log(`[RES] ${summary.timestamp} | agent=${summary.agent} | model=${summary.request_model} | resolved=${summary.resolved_model} | len=${summary.response_length} | stream=${isStreaming}${usageStr}`);
}

// ── SSE Event Logging ───────────────────────────────────────────────

export function logSSEEvent(eventType, eventData, reqSummary, resolvedModel, providerId) {
  try {
    const parsed = JSON.parse(eventData);
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'sse_event',
      request_id: reqSummary?.request_id || null,
      request_model: reqSummary?.model || 'unknown',
      resolved_model: resolvedModel || reqSummary?.model || 'unknown',
      agent: reqSummary?.agent || 'router',
      sse_event_type: eventType,
    };
    if (providerId) entry.provider_id = providerId;

    if (parsed.choices?.[0]?.delta) {
      const delta = parsed.choices[0].delta;
      entry.delta_content = delta.content || '';
      entry.delta_content_length = delta.content?.length || 0;
      entry.finish_reason = parsed.choices[0].finish_reason;
      entry.model = parsed.model;
      entry.id = parsed.id;
      if (parsed.usage) entry.usage = parsed.usage;
    }
    else if (eventType === 'message_start') {
      entry.usage = parsed.message?.usage;
      entry.model = parsed.message?.model;
      entry.id = parsed.message?.id;
    } else if (eventType === 'content_block_start') {
      entry.sse_content_block_index = parsed.index;
      if (parsed.content_block) entry.sse_content_block = parsed.content_block;
    } else if (eventType === 'content_block_delta') {
      entry.sse_content_block_index = parsed.index;
      const delta = parsed.delta;
      if (delta?.type === 'text_delta') {
        entry.delta_content = delta.text || '';
        entry.delta_content_length = delta.text?.length || 0;
      } else if (delta?.type === 'thinking_delta') {
        entry.delta_reasoning = delta.thinking || '';
        entry.delta_reasoning_length = delta.thinking?.length || 0;
      } else if (delta?.type === 'input_json_delta') {
        entry.delta_tool_json = delta.partial_json || '';
      }
    } else if (eventType === 'message_delta') {
      entry.usage = parsed.usage;
      entry.stop_reason = parsed.delta?.stop_reason;
    }
    else if (eventType === 'response.output_text.delta') {
      entry.delta_content = parsed.delta || '';
      entry.delta_content_length = (parsed.delta || '').length;
    } else if (eventType === 'response.completed') {
      if (parsed.response?.usage) {
        entry.usage = {
          input_tokens: parsed.response.usage.input_tokens || 0,
          output_tokens: parsed.response.usage.output_tokens || 0,
          total_tokens: parsed.response.usage.total_tokens || 0,
        };
      }
    }
    else if (parsed.usage) {
      entry.usage = parsed.usage;
    }

    writeLog(getLogFilePath('sse'), entry);
  } catch { /* ignore non-JSON */ }
}

export function logNonStreamingUsage(respBody, reqSummary, resolvedModel, providerId) {
  try {
    const parsed = JSON.parse(respBody);
    if (parsed.usage) {
      const entry = {
        timestamp: new Date().toISOString(),
        type: 'sse_event',
        request_id: reqSummary?.request_id || null,
        request_model: reqSummary?.model || 'unknown',
        resolved_model: resolvedModel || reqSummary?.model || 'unknown',
        agent: reqSummary?.agent || 'router',
        sse_event_type: 'non_streaming_usage',
        usage: parsed.usage,
        model: parsed.model,
      };
      if (providerId) entry.provider_id = providerId;
      writeLog(getLogFilePath('sse'), entry);
    }
  } catch {}
}
