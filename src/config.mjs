/**
 * Config — configuration loading, environment variables, agent model overrides.
 *
 * Security: API keys are never stored in config.json directly.
 * Use `api_key` for plaintext (deprecated, will warn) or `api_key_env` for
 * env var references. Both support ${VAR} interpolation.
 */

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.env.HOME, 'Router', 'config.json');
const AGENT_MODELS_PATH = path.join(process.env.HOME, 'Router', 'agent_models.json');

// ── Env var resolution ──────────────────────────────────────────────

function resolveEnvVars(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
}

/**
 * Resolve an API key from a provider endpoint config.
 * Priority: api_key (direct value, may contain ${VAR}) > api_key_env (env var name)
 */
function resolveApiKey(endpoint) {
  if (!endpoint) return null;
  if (endpoint.api_key) return resolveEnvVars(endpoint.api_key);
  if (endpoint.api_key_env) return process.env[endpoint.api_key_env] || null;
  return null;
}

// ── Main config ─────────────────────────────────────────────────────

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    // Resolve API keys
    for (const p of cfg.providers || []) {
      for (const proto of ['anthropic', 'openai']) {
        if (p[proto]) {
          p[proto].api_key = resolveApiKey(p[proto]);
        }
      }
    }
    return cfg;
  } catch (e) {
    console.error('[FATAL] Failed to load config:', e.message);
    process.exit(1);
  }
}

const CONFIG = loadConfig();

// ── Per-agent model overrides ───────────────────────────────────────

let _agentModelCache = null;
let _agentModelWatched = false;

function loadAgentModels() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_MODELS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function getAgentModels() {
  if (!_agentModelCache) {
    _agentModelCache = loadAgentModels();
    // Set up fs.watch for auto-reload (one-time setup)
    if (!_agentModelWatched) {
      _agentModelWatched = true;
      try {
        fs.watch(AGENT_MODELS_PATH, () => {
          _agentModelCache = null; // invalidate cache
        });
      } catch { /* file may not exist yet */ }
    }
  }
  return _agentModelCache;
}

/**
 * Get the effective model override for an agent.
 * Returns null for "default"/unset, "auto" for load-balanced routing, or a model name.
 */
function getAgentModel(agent) {
  const cfg = getAgentModels();
  const val = cfg[agent];
  if (!val || val === 'default') return null;
  return val;
}

/**
 * Atomic write for agent_models.json: write to tmp file then rename.
 */
function saveAgentModels(config) {
  const tmp = AGENT_MODELS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, AGENT_MODELS_PATH);
  _agentModelCache = config; // update cache
}

export {
  CONFIG,
  CONFIG_PATH,
  AGENT_MODELS_PATH,
  loadConfig,
  getAgentModel,
  getAgentModels,
  saveAgentModels,
  resolveEnvVars,
};

export const PORT = parseInt(process.env.PROXY_PORT || '9997', 10);
export const LOG_DIR = process.env.LOG_DIR || path.join(process.env.HOME, 'Router', 'logs', 'router');
export const OBJECTS_DIR = path.join(LOG_DIR, 'objects');
export const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '3', 10);
