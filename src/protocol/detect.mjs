/**
 * Protocol Detection — API format detection, client agent identification,
 * path normalization.
 */

// ── API Format Detection ────────────────────────────────────────────

export function detectApiFormat(urlPath) {
  if (urlPath.includes('/responses')) return 'codex_responses';
  if (urlPath.includes('/messages') ||
      urlPath.includes('/api/anthropic') ||
      urlPath.includes('/api/nebflow') ||
      urlPath.includes('/api/openclaw') ||
      urlPath.includes('/api/codex') ||
      urlPath.includes('/api/claude-code')) return 'anthropic_messages';
  return 'chat_completions';
}

// ── Client Agent Detection ──────────────────────────────────────────

const CLIENT_AGENT_PATH_MAP = {
  '/api/nebflow': 'nebflow',
  '/api/openclaw': 'openclaw',
  '/api/codex': 'codex',
  '/api/claude-code': 'claude-code',
};

export { CLIENT_AGENT_PATH_MAP };

/**
 * Detect which client application is making the request.
 * Priority: X-Agent header > path prefix > User-Agent heuristics
 */
export function detectClientAgent(req) {
  // 1. Explicit X-Agent header
  const xAgent = req.headers['x-agent'];
  if (xAgent) return xAgent.toLowerCase().trim();

  // 2. Path prefix: /api/<agent-name>/v1/messages
  for (const [prefix, agent] of Object.entries(CLIENT_AGENT_PATH_MAP)) {
    if (req.url.startsWith(prefix)) return agent;
  }

  // 3. User-Agent heuristics
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('nebflow')) return 'nebflow';
  if (ua.includes('openclaw')) return 'openclaw';
  if (ua.includes('codex')) return 'codex';
  if (ua.includes('claude-code') || ua.includes('claudecode')) return 'claude-code';

  return null;
}

/**
 * Normalize URL: strip agent-specific path prefix so routing works correctly.
 * /api/nebflow/v1/messages -> /api/anthropic/v1/messages
 */
export function normalizeAgentPath(url) {
  for (const prefix of Object.keys(CLIENT_AGENT_PATH_MAP)) {
    if (url.startsWith(prefix)) {
      return url.replace(prefix, '/api/anthropic');
    }
  }
  return url;
}

// ── Model Name Helpers ──────────────────────────────────────────────

/**
 * Strip provider/ prefix from model names (e.g. "router/glm-5.1" -> "glm-5.1")
 */
export function stripModelPrefix(model) {
  if (!model) return model;
  const slashIdx = model.indexOf('/');
  if (slashIdx >= 0) return model.slice(slashIdx + 1);
  return model;
}
