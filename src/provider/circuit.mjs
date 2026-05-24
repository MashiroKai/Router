/**
 * Circuit Breaker — per-provider failure tracking and circuit state.
 */

import { CONFIG } from '../config.mjs';

const circuitBreakers = new Map(); // providerId -> { failures, openedAt }

export function isCircuitOpen(providerId) {
  const cb = circuitBreakers.get(providerId);
  if (!cb) return false;
  if (cb.openedAt && Date.now() - cb.openedAt < (CONFIG.circuit_breaker?.cooldown_ms || 60000)) {
    return true;
  }
  return false; // cooldown expired -> half-open, allow one attempt
}

export function recordFailure(providerId) {
  let cb = circuitBreakers.get(providerId);
  if (!cb) { cb = { failures: 0, openedAt: null }; circuitBreakers.set(providerId, cb); }
  cb.failures++;
  const threshold = CONFIG.circuit_breaker?.threshold || 3;
  if (cb.failures >= threshold) {
    const verb = cb.openedAt ? 'RE-OPENED' : 'OPENED';
    console.log(`[CIRCUIT] Provider ${providerId} circuit ${verb} (${cb.failures} failures)`);
    cb.openedAt = Date.now();
  }
}

export function recordSuccess(providerId) {
  if (circuitBreakers.has(providerId)) {
    circuitBreakers.delete(providerId);
    console.log(`[CIRCUIT] Provider ${providerId} circuit CLOSED (success)`);
  }
}

/**
 * Get circuit state for display in the viewer.
 */
export function getCircuitStates() {
  const states = {};
  for (const [id, cb] of circuitBreakers) {
    states[id] = {
      failures: cb.failures,
      openedAt: cb.openedAt,
      isOpen: isCircuitOpen(id),
    };
  }
  return states;
}
