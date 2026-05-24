/**
 * Log Retention — prune old JSONL files and orphaned objects.
 */

import fs from 'fs';
import path from 'path';

import { LOG_DIR, OBJECTS_DIR, LOG_RETENTION_DAYS } from '../config.mjs';

export function pruneOldLogs() {
  try {
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - LOG_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // 1. Delete old JSONL files
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
    let deletedFiles = 0;
    for (const f of files) {
      const dateStr = f.slice(0, 10);
      if (dateStr < cutoffStr) {
        fs.unlinkSync(path.join(LOG_DIR, f));
        deletedFiles++;
      }
    }
    if (deletedFiles > 0) {
      console.log(`[LOG CLEANUP] Deleted ${deletedFiles} JSONL files older than ${cutoffStr}`);
    }

    // 2. Collect hashes referenced by remaining JSONL files
    const remainingFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
    const usedHashes = new Set();
    for (const f of remainingFiles) {
      const content = fs.readFileSync(path.join(LOG_DIR, f), 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.system_ref) usedHashes.add(entry.system_ref);
          if (entry.tools_ref) usedHashes.add(entry.tools_ref);
          if (Array.isArray(entry.message_refs)) {
            for (const h of entry.message_refs) usedHashes.add(h);
          }
        } catch {}
      }
    }

    // 3. Delete orphaned objects
    if (fs.existsSync(OBJECTS_DIR)) {
      const objFiles = fs.readdirSync(OBJECTS_DIR).filter(f => f.endsWith('.json'));
      let deletedObjects = 0;
      for (const f of objFiles) {
        const hash = f.slice(0, -5);
        if (!usedHashes.has(hash)) {
          fs.unlinkSync(path.join(OBJECTS_DIR, f));
          deletedObjects++;
        }
      }
      if (deletedObjects > 0) {
        console.log(`[LOG CLEANUP] Deleted ${deletedObjects} orphaned objects (kept ${objFiles.length - deletedObjects}/${objFiles.length})`);
      }
    }
  } catch (e) {
    console.error('[LOG CLEANUP] Error:', e.message);
  }
}
