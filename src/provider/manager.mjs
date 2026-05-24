/**
 * Provider Manager — provider selection, model rewriting, upstream request building,
 * sticky load balancing.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

import { CONFIG, getAgentModel } from '../config.mjs';
import { stripModelPrefix } from '../protocol/detect.mjs';
import { convertOpenAIToAnthropic } from '../protocol/translator.mjs';
import { isCircuitOpen, recordSuccess } from './circuit.mjs';

// ── Header Filtering ────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-connection',
  'accept-encoding',
  'content-length',
]);

function filterHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// ── Provider Endpoint Helpers ───────────────────────────────────────

export function getProviderEndpoint(provider, apiFormat) {
  if (apiFormat === 'anthropic_messages') return provider.anthropic || null;
  return provider.openai || null;
}

export function parseUpstreamUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      pathPrefix: u.pathname.replace(/\/$/, ''),
    };
  } catch {
    return null;
  }
}

function providerSupportsModel(provider, model) {
  if (!model) return false;
  model = stripModelPrefix(model);
  const validModels = new Set(Object.values(provider.models?.anthropic_mapping || {}));
  if (provider.models?.default) validModels.add(provider.models.default);
  return validModels.has(model);
}

// ── Model Rewriting ─────────────────────────────────────────────────

export function rewriteModel(bodyStr, provider, apiFormat, agentName) {
  try {
    const parsed = JSON.parse(bodyStr);
    let changed = false;
    const mapping = provider.models?.anthropic_mapping || {};
    const providerDefault = provider.models?.default;

    if (parsed.model) {
      const stripped = stripModelPrefix(parsed.model);
      if (stripped !== parsed.model) {
        parsed.model = stripped;
        changed = true;
      }
    }

    const agentOverride = getAgentModel(agentName);
    const overrideValid = agentOverride && agentOverride !== 'auto' && providerSupportsModel(provider, agentOverride);
    const targetModel = overrideValid ? agentOverride : providerDefault;

    if (!parsed.max_tokens && !parsed.max_output_tokens) {
      parsed.max_tokens = 16384;
      changed = true;
    }

    if (overrideValid && parsed.model !== targetModel) {
      parsed.model = targetModel;
      changed = true;
      return JSON.stringify(parsed);
    }

    if (parsed.model === 'Router-Auto') {
      if (targetModel) {
        parsed.model = targetModel;
        changed = true;
      }
      return changed ? JSON.stringify(parsed) : bodyStr;
    }

    if (parsed.model && mapping[parsed.model]) {
      parsed.model = mapping[parsed.model];
      changed = true;
    }
    if (parsed.model && targetModel && parsed.model !== targetModel) {
      const validModels = new Set(Object.values(mapping));
      validModels.add(targetModel);
      if (providerDefault) validModels.add(providerDefault);
      if (!validModels.has(parsed.model)) {
        parsed.model = targetModel;
        changed = true;
      }
    }
    if (!parsed.model && targetModel) {
      parsed.model = targetModel;
      changed = true;
    }
    return changed ? JSON.stringify(parsed) : bodyStr;
  } catch {
    return bodyStr;
  }
}

// ── Upstream Request Building ───────────────────────────────────────

export function buildUpstreamOptions(req, bodyStr, apiFormat, provider, preferAltProtocol = false, agentName = null) {
  let endpoint = null;
  let targetApiFormat = apiFormat;
  let needsTranslation = false;

  if (preferAltProtocol) {
    if (apiFormat === 'chat_completions' && provider.anthropic) {
      endpoint = provider.anthropic; targetApiFormat = 'anthropic_messages'; needsTranslation = true;
    } else if (apiFormat === 'anthropic_messages' && provider.openai) {
      endpoint = provider.openai; targetApiFormat = 'chat_completions'; needsTranslation = true;
    } else if (apiFormat === 'codex_responses' && provider.anthropic) {
      endpoint = provider.anthropic; targetApiFormat = 'anthropic_messages'; needsTranslation = true;
    }
  } else {
    endpoint = getProviderEndpoint(provider, apiFormat);
    if (!endpoint) {
      if (apiFormat === 'chat_completions' && provider.anthropic) {
        endpoint = provider.anthropic; targetApiFormat = 'anthropic_messages'; needsTranslation = true;
      } else if (apiFormat === 'anthropic_messages' && provider.openai) {
        endpoint = provider.openai; targetApiFormat = 'chat_completions'; needsTranslation = true;
      } else if (apiFormat === 'codex_responses' && provider.openai) {
        endpoint = provider.openai; targetApiFormat = 'chat_completions'; needsTranslation = true;
      } else if (apiFormat === 'codex_responses' && provider.anthropic) {
        endpoint = provider.anthropic; targetApiFormat = 'anthropic_messages'; needsTranslation = true;
      }
    }
  }

  if (!endpoint) return null;

  const upstream = parseUpstreamUrl(endpoint.base_url);
  if (!upstream) return null;

  let rewrittenBody = rewriteModel(bodyStr, provider, apiFormat, agentName);

  if (needsTranslation) {
    if (apiFormat === 'chat_completions' && targetApiFormat === 'anthropic_messages') {
      rewrittenBody = convertOpenAIToAnthropic(rewrittenBody, provider);
    }
  }

  const routerPrefix = apiFormat === 'anthropic_messages' ? '/api/anthropic' : '/v1';
  let targetPath = req.url;
  if (targetPath.startsWith(routerPrefix)) {
    targetPath = targetPath.slice(routerPrefix.length);
  } else if (targetPath.startsWith(upstream.pathPrefix)) {
    targetPath = targetPath.slice(upstream.pathPrefix.length);
  }
  if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;

  const queryIdx = req.url.indexOf('?');
  const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';

  if (targetApiFormat === 'anthropic_messages') {
    targetPath = upstream.pathPrefix + '/v1/messages' + queryString;
  } else {
    targetPath = upstream.pathPrefix + targetPath;
  }

  const forwardHeaders = filterHeaders(req.headers);
  const isDefaultPort = (upstream.port === 443 && upstream.protocol === 'https:') || (upstream.port === 80 && upstream.protocol === 'http:');
  forwardHeaders.host = isDefaultPort ? upstream.hostname : `${upstream.hostname}:${upstream.port}`;
  if (endpoint.api_key) {
    forwardHeaders.authorization = `Bearer ${endpoint.api_key}`;
  }
  delete forwardHeaders['x-api-key'];

  if (targetApiFormat === 'anthropic_messages') {
    forwardHeaders['anthropic-version'] = '2023-06-01';
    delete forwardHeaders['openai-beta'];
    delete forwardHeaders['x-stainless-lang'];
    delete forwardHeaders['x-stainless-os'];
    delete forwardHeaders['x-stainless-package-version'];
    delete forwardHeaders['x-stainless-arch'];
    delete forwardHeaders['x-stainless-retry-count'];
  }

  forwardHeaders['content-length'] = Buffer.byteLength(rewrittenBody);

  let targetModel = provider.models?.default || '';
  try {
    const parsedBody = JSON.parse(rewrittenBody);
    if (parsedBody.model) targetModel = parsedBody.model;
  } catch {}

  const isHttps = upstream.protocol === 'https:';

  return {
    module: isHttps ? https : http,
    options: {
      hostname: upstream.hostname,
      port: upstream.port,
      path: targetPath,
      method: req.method,
      headers: forwardHeaders,
    },
    body: rewrittenBody,
    needsTranslation,
    targetApiFormat,
    targetModel,
  };
}

// ── Sticky Load Balancing ───────────────────────────────────────────

const agentAffinity = new Map();
const providerLoad = new Map();
const AFFINITY_TTL_MS = CONFIG.load_balancing?.affinity_ttl_ms || 30 * 60 * 1000;

function affinityKey(agent, sessionId) {
  return `${agent}|${sessionId || ''}`;
}

export function resolveProviderForAgent(agentName, sessionId, requestedModel) {
  if (!CONFIG.load_balancing?.enabled) return 0;

  const agentOverride = getAgentModel(agentName);
  const effectiveModel = (agentOverride && agentOverride !== 'auto') ? agentOverride : requestedModel;

  if (effectiveModel !== 'Router-Auto') {
    for (let i = 0; i < CONFIG.providers.length; i++) {
      if (isCircuitOpen(CONFIG.providers[i].id)) continue;
      if (providerSupportsModel(CONFIG.providers[i], effectiveModel)) return i;
    }
    return 0;
  }

  const key = affinityKey(agentName, sessionId);
  const now = Date.now();

  for (const [k, entry] of agentAffinity) {
    if (now - entry.lastSeen > AFFINITY_TTL_MS) {
      agentAffinity.delete(k);
      for (const agents of providerLoad.values()) agents.delete(k);
    }
  }

  const existing = agentAffinity.get(key);
  if (existing && now - existing.lastSeen <= AFFINITY_TTL_MS) {
    existing.lastSeen = now;
    return existing.providerIndex;
  }

  let bestIndex = 0, bestCount = Infinity;
  for (let i = 0; i < CONFIG.providers.length; i++) {
    if (isCircuitOpen(CONFIG.providers[i].id)) continue;
    const count = providerLoad.get(i)?.size || 0;
    if (count < bestCount) { bestCount = count; bestIndex = i; }
  }

  agentAffinity.set(key, { providerIndex: bestIndex, lastSeen: now });
  if (!providerLoad.has(bestIndex)) providerLoad.set(bestIndex, new Set());
  providerLoad.get(bestIndex).add(key);

  console.log(`[LB] "${key}" -> ${CONFIG.providers[bestIndex].name} (load: ${bestCount})`);
  return bestIndex;
}

export function updateAffinityOnSuccess(agentName, sessionId, requestedModel, providerIndex) {
  if (requestedModel !== 'Router-Auto' || !agentName) return;
  if (!CONFIG.load_balancing?.rebalance_on_failure) return;
  const key = affinityKey(agentName, sessionId);
  const entry = agentAffinity.get(key);
  if (!entry || entry.providerIndex === providerIndex) return;

  const oldAgents = providerLoad.get(entry.providerIndex);
  if (oldAgents) oldAgents.delete(key);
  entry.providerIndex = providerIndex;
  if (!providerLoad.has(providerIndex)) providerLoad.set(providerIndex, new Set());
  providerLoad.get(providerIndex).add(key);
  console.log(`[LB] "${key}" affinity updated -> ${CONFIG.providers[providerIndex].name}`);
}

// ── Upstream Request with Timeout ───────────────────────────────────

export function requestWithTimeout(module, options, bodyStr, timeoutMs, onRequestCreated) {
  return new Promise((resolve, reject) => {
    let proxyReq;
    const timer = setTimeout(() => {
      if (proxyReq) proxyReq.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);

    proxyReq = module.request(options, (proxyRes) => {
      clearTimeout(timer);
      resolve(proxyRes);
    });
    proxyReq.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (onRequestCreated) onRequestCreated(proxyReq);
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Sleep Helper ────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
