/**
 * Fallback FSM — provider failover with silent error handling.
 *
 * Key principles:
 *   1. Callers NEVER see raw upstream errors — only success or 502.
 *   2. 400 semantic errors (invalid JSON, bad params) do NOT trigger fallback.
 *   3. Provider-specific "fake 400" errors DO trigger fallback (configurable).
 *   4. Exponential backoff with jitter for retries.
 */

import { CONFIG } from '../config.mjs';
import { SSEParser, createAnthropicToOpenAISSETranslator, convertAnthropicToOpenAI } from '../protocol/translator.mjs';
import { buildUpstreamOptions, requestWithTimeout, sleep } from './manager.mjs';
import { isCircuitOpen, recordFailure, recordSuccess } from './circuit.mjs';
import { updateAffinityOnSuccess } from './manager.mjs';
import { logResponse, logSSEEvent, logNonStreamingUsage } from '../logging/logger.mjs';

// ── Fallback Decision ───────────────────────────────────────────────
// NOTE: Callers never see raw upstream errors. Even non-fallback errors
// are wrapped in a generic Router error before being sent to the client.

const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']);

function isNetworkError(error) {
  return error && (NETWORK_ERRORS.has(error.code) ||
    (CONFIG.fallback_triggers?.timeout_ms && error.message?.includes('timeout')));
}

/**
 * Extract error code from an upstream response body.
 */
function extractErrorCode(respBody) {
  try {
    const parsed = JSON.parse(respBody);
    return parsed.error?.code || parsed.error?.type || null;
  } catch {
    return null;
  }
}

/**
 * Get provider-specific error codes that should trigger fallback.
 */
function getFallbackCodes(providerId) {
  const provider = CONFIG.providers?.find(p => p.id === providerId);
  return provider?.fallback_error_codes || [];
}

/**
 * Determine if a failed response should trigger fallback to the next provider.
 *
 * Layers:
 *   1. Network errors → always retry
 *   2. Server errors (5xx) → retry
 *   3. Rate limits (429) → retry
 *   4. Provider-specific "fake 400" → retry (by error code)
 *   5. Semantic 400 (invalid JSON, bad params) → DO NOT retry
 *   6. Auth errors (401/403) → DO NOT retry (config issue)
 *   7. Empty stream → retry
 */
function shouldFallback(statusCode, isEmptyStream, error, respBody, providerId) {
  // Layer 1: Network errors
  if (error && isNetworkError(error)) return true;

  // Layer 2: Server errors
  if (statusCode >= 500 && CONFIG.fallback_triggers?.server_errors !== false) return true;

  // Layer 3: Rate limits
  if (statusCode === 429 && CONFIG.fallback_triggers?.rate_limit !== false) return true;

  // Layer 4: Timeout
  if (statusCode === 408) return true;

  // Layer 5: Provider-specific fake 400 errors
  if (statusCode === 400 && respBody) {
    const errorCode = extractErrorCode(respBody);
    const fallbackCodes = getFallbackCodes(providerId);
    if (errorCode && fallbackCodes.length > 0 && fallbackCodes.includes(errorCode)) {
      return true;
    }
    // Generic 400 without specific config → NOT a fallback trigger
    return false;
  }

  // Layer 6: Empty stream
  if (isEmptyStream && CONFIG.fallback_triggers?.empty_stream !== false) return true;

  return false;
}

// ── Error Cache ─────────────────────────────────────────────────────
// Short-circuit repeated failures for the same provider+error pattern.

const errorCache = new Map(); // `${providerId}:${errorCode}` -> { count, expiresAt }
const ERROR_CACHE_TTL_MS = 60000; // 1 minute

function checkErrorCache(providerId, model) {
  const key = `${providerId}:${model}`;
  const entry = errorCache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    errorCache.delete(key);
    return false;
  }
  return true; // cached error — skip this provider
}

function cacheError(providerId, model) {
  const key = `${providerId}:${model}`;
  errorCache.set(key, { expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
}

// ── Generic Client Error ────────────────────────────────────────────
// What the client sees when something goes wrong (but we don't expose internals).

const GENERIC_ERROR_RESPONSE = JSON.stringify({
  error: { type: 'api_error', message: 'Request failed' },
});

// ── FallbackFSM ─────────────────────────────────────────────────────

export class FallbackFSM {
  constructor(req, res, bodyStr, apiFormat, reqSummary, startProviderIdx) {
    this.req = req;
    this.res = res;
    this.bodyStr = bodyStr;
    this.apiFormat = apiFormat;
    this.reqSummary = reqSummary;
    this.currentProviderIdx = startProviderIdx;
    this.state = 'IDLE';
    this.triedAltProtocol = false;
    this.retryCount = 0;
    this.headersSent = false;
    this.clientDisconnected = false;
    this.finalUsage = null;

    res.on('close', () => {
      if (!res.writableEnded) this.clientDisconnected = true;
    });
  }

  logTransition(to, detail = '') {
    console.log(`[FSM] ${this.state} -> ${to}${detail ? ' | ' + detail : ''}`);
    this.state = to;
  }

  async start() {
    this.logTransition('TRYING');
    await this.doTryProvider();
  }

  async doTryProvider() {
    if (this.clientDisconnected) return;

    const provider = CONFIG.providers[this.currentProviderIdx];
    if (!provider) return this.doAllFailed();

    // Check circuit breaker (skip when trying alternate protocol for same provider)
    if (!this.triedAltProtocol && isCircuitOpen(provider.id)) {
      console.log(`[CIRCUIT] Provider ${provider.name} circuit is OPEN, skipping...`);
      this.currentProviderIdx++;
      this.triedAltProtocol = false;
      return this.doTryProvider();
    }

    // Check error cache — skip providers we know are failing for this model
    const model = this.reqSummary?.model || '';
    if (checkErrorCache(provider.id, model)) {
      console.log(`[CACHE] Provider ${provider.name} cached error for ${model}, skipping...`);
      this.currentProviderIdx++;
      this.triedAltProtocol = false;
      return this.doTryProvider();
    }

    const upstream = buildUpstreamOptions(this.req, this.bodyStr, this.apiFormat, provider, this.triedAltProtocol, this.reqSummary?.agent);
    if (!upstream) {
      console.error(`[FALLBACK] Provider ${provider.name} has no endpoint for ${this.apiFormat}`);
      this.currentProviderIdx++;
      return this.doTryProvider();
    }

    console.log(`[UPSTREAM] Trying ${provider.name} at ${upstream.options.hostname}:${upstream.options.port}${upstream.options.path}`);

    let activeProxyReq = null;

    try {
      const timeoutMs = CONFIG.fallback_triggers?.timeout_ms || 120000;
      const proxyRes = await requestWithTimeout(upstream.module, upstream.options, upstream.body, timeoutMs, (req) => { activeProxyReq = req; });
      const contentType = proxyRes.headers['content-type'] || '';
      const isStreaming = contentType.includes('text/event-stream');
      const translateSSE = upstream.needsTranslation && this.apiFormat === 'chat_completions' && upstream.targetApiFormat === 'anthropic_messages';

      if (isStreaming) {
        this.logTransition('STREAMING', `provider=${provider.name}`);
        await this.handleStreaming(proxyRes, upstream, provider, translateSSE, activeProxyReq);
      } else {
        this.logTransition('AWAITING_RESPONSE', `provider=${provider.name}`);
        await this.handleNonStreaming(proxyRes, upstream, provider, translateSSE);
      }
    } catch (err) {
      console.error(`[UPSTREAM ERROR] ${provider.name}:`, err.message);
      cacheError(provider.id, model);
      return this.doFallback(`network error: ${err.message}`, provider, upstream);
    }
  }

  async handleStreaming(proxyRes, upstream, provider, translateSSE, activeProxyReq) {
    let totalDataBytes = 0;
    let localHeadersSent = false;
    let sseHasError = false;
    let resolvedModel = upstream.targetModel || '';
    const translator = translateSSE ? createAnthropicToOpenAISSETranslator(upstream.targetModel) : null;

    // Single SSE parser for both logging and translation
    const loggingParser = new SSEParser({
      onEvent: (eventType, dataStr, parsed) => {
        // Logging
        logSSEEvent(eventType, dataStr, this.reqSummary, resolvedModel, provider.id);

        if (eventType === 'error') sseHasError = true;

        if (parsed) {
          if (eventType === 'message_start' && parsed.message?.model) {
            resolvedModel = parsed.message.model;
          }
          const u = parsed.usage || parsed.message?.usage;
          if (u) this.finalUsage = u;
        }
      },
    });

    // Error status buffering
    const isErrorStatus = proxyRes.statusCode >= 400;
    let errorBodyBuffer = '';

    return new Promise((resolve) => {
      const cleanupListeners = () => {
        proxyRes.removeAllListeners('data');
        proxyRes.removeAllListeners('end');
        proxyRes.removeAllListeners('error');
        if (activeProxyReq) activeProxyReq.destroy();
        proxyRes.destroy();
      };

      const sendHeaders = () => {
        if (localHeadersSent) return;
        localHeadersSent = true;
        this.headersSent = true;
        delete proxyRes.headers['content-length'];
        this.res.writeHead(proxyRes.statusCode, proxyRes.headers);
      };

      // Translation parser (separate from logging parser for clean separation)
      const translationParser = translateSSE ? new SSEParser({
        onEvent: (eventType, dataStr, parsed) => {
          if (!parsed) return;
          const translatedLines = translator.emit(eventType, parsed);
          sendHeaders();
          for (const l of translatedLines) this.res.write(l);
        },
      }) : null;

      const onData = (chunk) => {
        if (this.clientDisconnected) {
          cleanupListeners();
          resolve();
          return;
        }

        totalDataBytes += chunk.length;

        // Always parse for logging
        loggingParser.feed(chunk);

        // Error status: buffer, don't forward
        if (isErrorStatus) {
          errorBodyBuffer += chunk.toString('utf-8');
          return;
        }

        // Forward to client
        if (translationParser) {
          translationParser.feed(chunk);
        } else {
          sendHeaders();
          this.res.write(chunk);
        }
      };

      const onEnd = () => {
        // Flush parsers
        loggingParser.flush();
        if (translationParser) translationParser.flush();

        cleanupListeners();
        const contentType = proxyRes.headers['content-type'] || '';

        // Error status: try fallback
        if (isErrorStatus) {
          logResponse(errorBodyBuffer, this.reqSummary, true, proxyRes.statusCode, contentType, resolvedModel, null, provider.id);
          if (shouldFallback(proxyRes.statusCode, false, null, errorBodyBuffer, provider.id)) {
            console.log(`[FALLBACK] Provider ${provider.name} failed (HTTP ${proxyRes.statusCode}), trying next...`);
            if (errorBodyBuffer.length < 2000) console.log(`[FALLBACK BODY] ${errorBodyBuffer}`);
            recordFailure(provider.id);
            cacheError(provider.id, this.reqSummary?.model || '');
            return this.doFallback(`HTTP ${proxyRes.statusCode}`, provider, upstream).then(resolve);
          }
          // Non-fallback error — send generic error to client (not raw upstream error!)
          if (!this.res.headersSent) {
            this.res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            this.res.end(GENERIC_ERROR_RESPONSE);
          }
          resolve();
          return;
        }

        const emptyStream = totalDataBytes === 0 || !localHeadersSent || sseHasError;

        if (emptyStream) {
          logResponse(sseHasError ? '[SSE_ERROR]' : '[EMPTY_STREAM]', this.reqSummary, true, proxyRes.statusCode, contentType, resolvedModel, null, provider.id);
        } else {
          logResponse('', this.reqSummary, true, proxyRes.statusCode, contentType, resolvedModel, this.finalUsage, provider.id);
        }

        if (shouldFallback(proxyRes.statusCode, emptyStream, null, null, provider.id)) {
          console.log(`[FALLBACK] Provider ${provider.name} failed (empty stream or error status), trying next...`);
          recordFailure(provider.id);
          if (!localHeadersSent) {
            return this.doFallback(sseHasError ? 'SSE error event' : 'empty stream', provider, upstream).then(resolve);
          }
          if (!this.res.writableEnded) this.res.end();
          resolve();
          return;
        }

        recordSuccess(provider.id);
        updateAffinityOnSuccess(this.reqSummary?.agent, this.reqSummary?.session_id, this.reqSummary?.model, this.currentProviderIdx);
        if (!this.res.writableEnded) this.res.end();
        this.logTransition('SUCCESS');
        resolve();
      };

      const onError = (err) => {
        cleanupListeners();
        this.doFallback(`SSE stream error: ${err.message}`, provider, upstream).then(resolve);
      };

      proxyRes.on('data', onData);
      proxyRes.on('end', onEnd);
      proxyRes.on('error', onError);
    });
  }

  async handleNonStreaming(proxyRes, upstream, provider, translateSSE) {
    const chunks = [];

    return new Promise((resolve) => {
      const onData = (chunk) => { chunks.push(chunk); };

      const onEnd = async () => {
        proxyRes.removeAllListeners('data');
        proxyRes.removeAllListeners('end');
        proxyRes.removeAllListeners('error');

        let respBody = Buffer.concat(chunks).toString('utf-8');
        const htmlError = respBody.startsWith('<!DOCTYPE') || respBody.startsWith('<html');
        const contentType = proxyRes.headers['content-type'] || '';

        if (shouldFallback(proxyRes.statusCode, false, null, respBody, provider.id) || htmlError || (this.triedAltProtocol && proxyRes.statusCode >= 400)) {
          // 429 Retry with exponential backoff
          if (proxyRes.statusCode === 429 && this.retryCount < 2) {
            const baseDelay = Math.pow(2, this.retryCount) * 1000;
            const delay = baseDelay + Math.random() * 500;
            console.log(`[RETRY] Provider ${provider.name} rate limited, retrying in ${Math.round(delay)}ms (attempt ${this.retryCount + 1}/3)...`);
            await sleep(delay);
            this.retryCount++;
            this.logTransition('RETRY_WAIT', `provider=${provider.name}, delay=${Math.round(delay)}ms`);
            return this.doTryProvider().then(resolve);
          }

          const reason = htmlError ? 'HTML error page' : `HTTP ${proxyRes.statusCode}`;
          console.log(`[FALLBACK] Provider ${provider.name} failed (${reason}), trying next...`);
          if (proxyRes.statusCode >= 400 && respBody.length < 2000) {
            console.log(`[FALLBACK BODY] ${respBody}`);
          }
          recordFailure(provider.id);
          cacheError(provider.id, this.reqSummary?.model || '');
          return this.doFallback(reason, provider, upstream).then(resolve);
        }

        recordSuccess(provider.id);
        updateAffinityOnSuccess(this.reqSummary?.agent, this.reqSummary?.session_id, this.reqSummary?.model, this.currentProviderIdx);

        let resolvedModel = upstream.targetModel || '';
        try {
          const parsed = JSON.parse(respBody);
          if (parsed.model) resolvedModel = parsed.model;
        } catch {}

        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          if (translateSSE) {
            respBody = convertAnthropicToOpenAI(respBody, upstream.targetModel);
            delete proxyRes.headers['transfer-encoding'];
            proxyRes.headers['content-length'] = Buffer.byteLength(respBody);
            try {
              const parsed = JSON.parse(respBody);
              if (parsed.model) resolvedModel = parsed.model;
            } catch {}
          } else if (this.apiFormat === 'anthropic_messages' && upstream.targetModel) {
            try {
              const parsed = JSON.parse(respBody);
              if (parsed.model) {
                parsed.model = upstream.targetModel;
                respBody = JSON.stringify(parsed);
                delete proxyRes.headers['transfer-encoding'];
                proxyRes.headers['content-length'] = Buffer.byteLength(respBody);
              }
            } catch {}
          }
        }

        this.res.writeHead(proxyRes.statusCode, proxyRes.headers);
        this.res.write(respBody);
        let nonStreamingUsage = null;
        try {
          const parsed = JSON.parse(respBody);
          if (parsed.usage) nonStreamingUsage = parsed.usage;
        } catch {}
        logResponse(respBody, this.reqSummary, false, proxyRes.statusCode, contentType, resolvedModel, nonStreamingUsage, provider.id);
        logNonStreamingUsage(respBody, this.reqSummary, resolvedModel, provider.id);
        this.res.end();
        this.logTransition('SUCCESS');
        resolve();
      };

      const onError = (err) => {
        proxyRes.removeAllListeners('data');
        proxyRes.removeAllListeners('end');
        proxyRes.removeAllListeners('error');
        this.doFallback(`non-streaming error: ${err.message}`, provider, upstream).then(resolve);
      };

      proxyRes.on('data', onData);
      proxyRes.on('end', onEnd);
      proxyRes.on('error', onError);
    });
  }

  async doFallback(reason, provider, upstream) {
    this.logTransition('FALLBACK', reason);
    recordFailure(provider.id);

    if (!this.triedAltProtocol && !upstream.needsTranslation) {
      const hasAlt = (this.apiFormat === 'chat_completions' && provider.anthropic) ||
                     (this.apiFormat === 'anthropic_messages' && provider.openai) ||
                     (this.apiFormat === 'codex_responses' && (provider.openai || provider.anthropic));
      if (hasAlt) {
        console.log(`[FALLBACK] Trying alternate protocol for ${provider.name}...`);
        this.triedAltProtocol = true;
        this.logTransition('ALT_PROTOCOL', `provider=${provider.name}`);
        return this.doTryProvider();
      }
    }

    this.triedAltProtocol = false;
    this.retryCount = 0;
    this.currentProviderIdx++;
    this.logTransition('TRYING', `next provider idx=${this.currentProviderIdx}`);
    return this.doTryProvider();
  }

  async doAllFailed() {
    this.logTransition('ALL_FAILED');
    console.error('[FALLBACK] All providers exhausted');
    if (!this.res.headersSent) {
      try {
        this.res.writeHead(502, { 'Content-Type': 'application/json' });
        this.res.end(JSON.stringify({ error: { type: 'api_error', message: 'All providers failed' } }));
      } catch {}
    }
  }
}

export async function tryProvider(req, res, bodyStr, apiFormat, reqSummary, providerIndex) {
  const fsm = new FallbackFSM(req, res, bodyStr, apiFormat, reqSummary, providerIndex);
  await fsm.start();
}
