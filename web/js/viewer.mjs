// ═══════════════════════════════════════════════════════════════════
// Nebflow LLM Log Reader — Viewer
// ═══════════════════════════════════════════════════════════════════

const API_BASE = '/_viewer/api';
let allEntries = [];
let sidebarTree = [];       // [{projectRoot, name, sessions: [{sessionId, sessionName, agent, entries: []}]}]
let activeAgent = null;
let selectedKey = null;
let currentTab = 'input';
let expandedSessions = new Set();
let expandedFolders = new Set();

const CONTEXT_WINDOWS = {
  'glm-5': 202800, 'glm-5.1': 204800, 'glm-5-turbo': 202800,
  'glm-4.7': 204800, 'glm-4.7-flash': 200000, 'glm-4.7-flashx': 200000,
  'glm-4.6': 204800, 'glm-4.6v': 128000,
  'glm-4.5': 131072, 'glm-4.5-air': 131072, 'glm-4.5-flash': 131072, 'glm-4.5v': 64000,
  'gpt-5.4': 200000, 'gpt-5.3-codex': 200000, 'gpt-5.2-codex': 200000,
  'gpt-5.2': 200000, 'gpt-5.1-codex-max': 200000, 'gpt-5.1-codex-mini': 200000,
  'gpt-5.1-codex': 200000, 'gpt-5.1': 200000, 'gpt-5-codex-mini': 200000,
  'o3': 200000, 'o4-mini': 200000,
  'claude-opus-4-6': 200000, 'claude-sonnet-4-6': 200000,
  'claude-opus-4-5': 200000, 'claude-sonnet-4-5': 200000, 'claude-haiku-4-5': 200000,
  'claude-opus-4-20250514': 200000, 'claude-sonnet-4-20250514': 200000,
  'deepseek-v4-pro': 131072, 'deepseek-v3': 131072,
};

// ── API ─────────────────────────────────────────────────────────
async function apiFetch(p) { const r = await fetch(API_BASE + p); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }

// ── Helpers ─────────────────────────────────────────────────────
function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function localTime(ts) { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''; }
function localDateTime(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''; }
function fmtDur(ms) { if (ms == null || ms < 0) return ''; return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'; }
function fmtTok(n) { if (n == null) return '?'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(n); }
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
function basename(p) { if (!p) return ''; const parts = p.replace(/\/+$/, '').split('/'); return parts[parts.length - 1] || p; }

// ── Markdown Renderer ───────────────────────────────────────────
function inlineMd(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
}

function renderMd(text) {
  if (!text) return '';
  const lines = esc(text).split('\n');
  const out = [];
  let inCode = false, codeBuf = [];
  let inUl = false, inOl = false;

  const closeList = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };

  for (const line of lines) {
    // Code block toggle
    if (line.trim().startsWith('---') && line.trim().length >= 3 && !inCode && codeBuf.length === 0) {
      // Could be horizontal rule or YAML frontmatter delimiter; treat as HR
      closeList(); out.push('<hr class="md-hr">'); continue;
    }
    if (line.trim().startsWith('```')) {
      if (!inCode) { closeList(); inCode = true; codeBuf = []; }
      else { out.push('<pre class="md-pre"><code>' + codeBuf.join('\n') + '</code></pre>'); inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    let m;
    // Headers
    if (m = line.match(/^(#{1,4})\s+(.+)$/)) { closeList(); out.push(`<h${m[1].length} class="md-h">${inlineMd(m[2])}</h${m[1].length}>`); continue; }
    // Unordered list
    if (m = line.match(/^\s*[-*]\s+(.+)$/)) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul class="md-ul">'); inUl = true; }
      out.push('<li>' + inlineMd(m[1]) + '</li>'); continue;
    }
    // Ordered list
    if (m = line.match(/^\s*\d+\.\s+(.+)$/)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol class="md-ol">'); inOl = true; }
      out.push('<li>' + inlineMd(m[1]) + '</li>'); continue;
    }
    // Empty line
    if (line.trim() === '') { closeList(); continue; }
    // Regular paragraph
    closeList();
    out.push('<p class="md-p">' + inlineMd(line) + '</p>');
  }
  if (inCode) out.push('<pre class="md-pre"><code>' + codeBuf.join('\n') + '</code></pre>');
  closeList();
  return out.join('\n');
}

// ── Agent Icon System ────────────────────────────────────────────

const AGENT_ICONS = {
  'nebflow': { color: '#8B5CF6', label: 'N',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="5" r="1.5" opacity=".6"/><circle cx="12" cy="19" r="1.5" opacity=".6"/><circle cx="5" cy="12" r="1.5" opacity=".6"/><circle cx="19" cy="12" r="1.5" opacity=".6"/><circle cx="7.8" cy="7.8" r="1" opacity=".4"/><circle cx="16.2" cy="16.2" r="1" opacity=".4"/><circle cx="7.8" cy="16.2" r="1" opacity=".4"/><circle cx="16.2" cy="7.8" r="1" opacity=".4"/></svg>` },
  'router': { color: '#5B9AFF', label: 'R',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2.5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>` },
};

const FALLBACK_COLORS = ['#5B9AFF', '#4CAF7D', '#E8B339', '#E5554E', '#B388FF', '#FF7EB3', '#FFA270', '#14B8A6', '#6366F1', '#EC4899'];

function hashString(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }

function getAgentIcon(name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(AGENT_ICONS)) { if (lower === key || lower.startsWith(key) || key.startsWith(lower)) return AGENT_ICONS[key]; }
  const color = FALLBACK_COLORS[hashString(name) % FALLBACK_COLORS.length];
  return { color, label: (name[0] || '?').toUpperCase(), svg: null };
}

function renderAgentIcon(name, size = 24) {
  const icon = getAgentIcon(name);
  if (icon.svg) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="color:${icon.color};border-radius:${size < 28 ? 4 : 6}px">${icon.svg}</svg>`;
  const fs = Math.round(size * 0.5);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="${icon.color}"/><text x="${size/2}" y="${size/2 + fs * 0.35}" text-anchor="middle" fill="#fff" font-size="${fs}" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${esc(icon.label)}</text></svg>`;
}

// ── ActivityBar ─────────────────────────────────────────────────
function renderActivityBar() {
  const bar = document.getElementById('agentBar');
  if (!bar) return;
  bar.innerHTML = '';
  const byAgent = {};
  for (const e of allEntries) { const a = e.agent_display_name || e.agent || 'unknown'; (byAgent[a] = byAgent[a] || []).push(e); }
  for (const name of [...new Set(Object.keys(byAgent))].sort()) {
    const btn = document.createElement('button');
    btn.className = 'ab-btn' + (activeAgent === name ? ' active' : '');
    btn.dataset.agent = name;
    btn.title = name;
    btn.innerHTML = renderAgentIcon(name, 22);
    btn.onclick = () => {
      activeAgent = activeAgent === name ? null : name;
      document.getElementById('sidebar').classList.remove('collapsed');
      bar.querySelectorAll('.ab-btn').forEach(b => b.classList.remove('active'));
      if (activeAgent) btn.classList.add('active');
      rebuildTree();
      renderSidebar();
    };
    bar.appendChild(btn);
  }
}

// ── Tree Builder: project → session → requests ──────────────────
function rebuildTree() {
  // Filter by active agent if selected
  const entries = activeAgent
    ? allEntries.filter(e => (e.agent_display_name || e.agent || 'unknown') === activeAgent)
    : allEntries;

  // Group by session_id
  const bySession = {};
  for (const e of entries) {
    const sid = e.session_id || '_none';
    if (!bySession[sid]) {
      bySession[sid] = {
        sessionId: sid,
        sessionName: e.session_name || (sid === '_none' ? 'Unknown' : sid.slice(0, 8)),
        projectRoot: e.project_root || null,
        agent: e.agent_display_name || e.agent || 'unknown',
        entries: [],
      };
    }
    bySession[sid].entries.push(e);
  }

  // Attach session-level metadata to each entry for diff lookups
  for (const s of Object.values(bySession)) {
    s.entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    s.entries.forEach((e, i) => { e._si = i; e._sessionEntries = s.entries; });
  }

  // Group sessions by project root
  const byProject = {};
  for (const s of Object.values(bySession)) {
    const key = s.projectRoot || '_none';
    if (!byProject[key]) byProject[key] = { projectRoot: s.projectRoot, name: s.projectRoot ? basename(s.projectRoot) : null, path: s.projectRoot, sessions: [] };
    byProject[key].sessions.push(s);
  }

  // Sort: projects alphabetically, "no project" last
  sidebarTree = Object.values(byProject).sort((a, b) => {
    if (!a.name && b.name) return 1;
    if (a.name && !b.name) return -1;
    return (a.name || '~').localeCompare(b.name || '~');
  });
  // Sort sessions within each project by start time
  for (const f of sidebarTree) f.sessions.sort((a, b) => a.entries[0].timestamp.localeCompare(b.entries[0].timestamp));
}

// ── Sidebar: Folder → Session → Request ─────────────────────────
function renderSidebar() {
  const el = document.getElementById('sessionList');
  if (!el) return;
  el.innerHTML = '';
  const title = document.getElementById('sessionsTitle');
  if (title) title.textContent = activeAgent || 'All Sessions';
  if (!sidebarTree.length) {
    el.innerHTML = '<div style="min-height:60px;color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:12px">No sessions</div>';
    return;
  }

  for (let fi = 0; fi < sidebarTree.length; fi++) {
    const folder = sidebarTree[fi];
    const fk = folder.path || '_none';
    const fExp = expandedFolders.has(fk);
    const totalReqs = folder.sessions.reduce((n, s) => n + s.entries.length, 0);

    // Folder header
    if (folder.name) {
      const fhdr = document.createElement('div');
      fhdr.className = 'folder-hdr';
      fhdr.title = folder.path || '';
      fhdr.innerHTML = `<span class="tog ${fExp ? '' : 'collapsed'}">&#9660;</span><span class="folder-icon">&#128193;</span><span class="folder-name">${esc(folder.name)}</span><span class="folder-meta">${folder.sessions.length} sess · ${totalReqs} req</span>`;
      fhdr.onclick = () => { expandedFolders.has(fk) ? expandedFolders.delete(fk) : expandedFolders.add(fk); renderSidebar(); };
      el.appendChild(fhdr);
    }

    if (!folder.name || fExp) {
      for (const session of folder.sessions) {
        const sk = session.sessionId;
        const sExp = expandedSessions.has(sk);
        const errs = session.entries.filter(e => e.response_status !== 200).length;
        const mainE = session.entries.filter(e => !e.is_subagent);
        const subE = session.entries.filter(e => e.is_subagent);

        const shdr = document.createElement('div');
        shdr.className = 'sess-hdr' + (folder.name ? ' nested' : '');
        shdr.innerHTML = `<span class="tog ${sExp ? '' : 'collapsed'}">&#9660;</span><span class="sdot"></span><span class="sess-name">${esc(session.sessionName)}</span><span class="sess-agent">${esc(session.agent)}</span><span class="sess-meta">${session.entries.length} req${errs > 0 ? `, ${errs} err` : ''}</span>`;
        shdr.onclick = () => { expandedSessions.has(sk) ? expandedSessions.delete(sk) : expandedSessions.add(sk); renderSidebar(); };
        el.appendChild(shdr);

        if (sExp) {
          const list = document.createElement('div');
          list.className = 'req-list';
          for (const e of mainE) list.appendChild(makeReqRow(e));
          if (subE.length > 0) {
            const sak = sk + ':sub';
            const saExp = expandedSessions.has(sak);
            const subHdr = document.createElement('div');
            subHdr.className = 'sub-hdr';
            subHdr.innerHTML = `<span class="tog${saExp ? '' : ' collapsed'}">&#9660;</span> Sub-agents (${subE.length})`;
            subHdr.onclick = (ev) => { ev.stopPropagation(); expandedSessions.has(sak) ? expandedSessions.delete(sak) : expandedSessions.add(sak); renderSidebar(); };
            list.appendChild(subHdr);
            if (saExp) {
              const subList = document.createElement('div');
              subList.className = 'req-list';
              for (const e of subE) subList.appendChild(makeReqRow(e));
              list.appendChild(subList);
            }
          }
          el.appendChild(list);
        }
      }
    }
  }
}

function updateStatsBar() {
  const bar = document.getElementById('statsBar');
  if (!bar) return;
  let tin = 0, tout = 0, tcache = 0, n = 0;
  for (const e of allEntries) if (e.usage) { tin += e.usage.input_tokens || 0; tout += e.usage.output_tokens || 0; tcache += e.usage.cache_read_input_tokens || 0; n++; }
  bar.innerHTML = n > 0
    ? `<span class="si">in <span class="sv">${fmtTok(tin)}</span></span><span class="sc">c <span class="sv">${fmtTok(tcache)}</span></span><span class="so">out <span class="sv">${fmtTok(tout)}</span></span>`
    : `<span>${allEntries.length} reqs</span>`;
}

function makeReqRow(entry) {
  const gIdx = allEntries.indexOf(entry);
  const key = `g${gIdx}`;
  const status = entry.response_status;
  const bc = status == null ? 'badge-none' : status === 200 ? 'badge-ok' : status >= 400 && status < 500 ? 'badge-warn' : 'badge-err';
  const dur = entry.response_time_ms != null ? fmtDur(entry.response_time_ms) : '';

  const row = document.createElement('div');
  row.className = 'req-row' + (selectedKey === key ? ' sel' : '');
  row.innerHTML = `<span class="io">${entry.is_subagent ? 'SUB' : 'IN'}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry.model || '?')}</span><span class="badge ${bc}">${status ?? '?'}</span>${dur ? `<span class="time">${dur}</span>` : ''}<span class="time">${localTime(entry.timestamp)}</span>`;
  row.onclick = () => selectRequest(gIdx);
  return row;
}

// ── Data Loading ────────────────────────────────────────────────
async function loadDates() {
  const { dates } = await apiFetch('/dates');
  const sel = document.getElementById('dateSelector');
  sel.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  for (const d of dates) { const o = document.createElement('option'); o.value = d; o.textContent = d + (d === today ? ' (today)' : ''); sel.appendChild(o); }
  if (dates.length) await loadLogs(dates[0]);
}

async function loadLogs(date) {
  const { entries } = await apiFetch('/logs?date=' + date);
  allEntries = entries;
  expandedSessions.clear();
  rebuildTree();
  renderActivityBar();
  renderSidebar();
  updateStatsBar();
  clearDetail();
}

// ── Select Request ──────────────────────────────────────────────
async function selectRequest(gIdx) {
  const entry = allEntries[gIdx];
  if (!entry) return;
  selectedKey = `g${gIdx}`;
  const sEntries = entry._sessionEntries || [];
  const si = entry._si || 0;
  const prevMsgCount = si > 0 ? (sEntries[si - 1].messages_count || 0) : 0;
  try {
    const date = document.getElementById('dateSelector').value;
    const detail = await apiFetch(`/detail?date=${date}&index=${gIdx}`);
    renderDetail(entry, detail, prevMsgCount, selectedKey, date, gIdx, sEntries, si);
  } catch (e) {
    document.getElementById('messagesArea').innerHTML = `<div class="empty-state">Error: ${esc(e.message)}</div>`;
  }
  renderSidebar(); // update sel highlight
}

// ── Tab Switching ───────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.io-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.dataset.panel === tab));
  if (tab === 'diff') { const e = document.getElementById('diff-first-change'); if (e) e.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

// ── Clear ───────────────────────────────────────────────────────
function clearDetail() {
  selectedKey = null;
  document.getElementById('detailHeader').style.display = 'none';
  document.getElementById('tokenBar').style.display = 'none';
  document.getElementById('ctxBar').classList.remove('vis');
  document.getElementById('helpPanel').classList.remove('vis');
  document.getElementById('ioTabs').style.display = 'none';
  document.getElementById('messagesArea').innerHTML = '<div class="empty-state">Select a request to view details</div>';
}

// ── Render Detail ───────────────────────────────────────────────
const detailCache = new Map();

function renderDetail(summary, detail, prevMsgCount, key, date, gIdx, sEntries, si) {
  const header = document.getElementById('detailHeader');
  const tokenBar = document.getElementById('tokenBar');
  const tabs = document.getElementById('ioTabs');
  header.style.display = 'flex'; tabs.style.display = 'flex';

  const status = summary.response_status;
  const sc = status == null ? 'badge-none' : status === 200 ? 'badge-ok' : status >= 400 && status < 500 ? 'badge-warn' : 'badge-err';
  const sl = status === 200 ? 'OK' : status === 429 ? 'Rate Limited' : status >= 500 ? 'Server Error' : status != null ? `HTTP ${status}` : '?';

  // Header: session name + agent + model + status
  const sessName = summary.session_name || summary.session_id?.slice(0, 8) || 'Unknown';
  const agentDn = summary.agent_display_name || summary.agent || 'unknown';
  header.innerHTML = `
    <span class="tag tag-model">${esc(summary.model)}</span>
    <span class="tag tag-agent">${esc(agentDn)}</span>
    ${summary.session_name ? `<span class="tag" style="background:rgba(139,92,246,.15);color:#a78bfa">${esc(sessName)}</span>` : ''}
    ${summary.is_subagent ? `<span class="tag" style="background:rgba(249,226,175,.12);color:var(--warning)">subagent</span>` : ''}
    <span class="dh-info">${summary.messages_count || 0} msgs${summary.tool_calls_count ? ` · ${summary.tool_calls_count} calls` : ''}${summary.stream ? ' · stream' : ''}</span>
    ${summary.response_time_ms != null ? `<span class="dh-info">${fmtDur(summary.response_time_ms)}</span>` : ''}
    ${status != null ? `<span class="badge ${sc}" style="font-size:12px;padding:2px 8px">${status} ${sl}</span>` : ''}
    <span class="dh-info" style="margin-left:auto">${localDateTime(summary.timestamp)}</span>`;

  const usage = summary.usage || detail.response?.sse_usage;
  if (usage) {
    const inp = usage.input_tokens || 0, out = usage.output_tokens || 0, cr = usage.cache_read_input_tokens || 0, cw = usage.cache_creation_input_tokens || 0;
    tokenBar.style.display = 'flex';
    tokenBar.innerHTML = `
      <span class="tk-group ti" data-tab="input" data-highlight="user"><span class="tk-label">Input</span> <span class="tk-val">${fmtTok(inp)}</span></span>
      ${cr > 0 ? `<span class="tk-group tc" data-tab="input" data-highlight="cache"><span class="tk-label">Cache</span> <span class="tk-val">${fmtTok(cr)}</span></span>` : ''}
      ${cw > 0 ? `<span class="tk-group"><span class="tk-label">Write</span> <span class="tk-val" style="color:var(--warning)">${fmtTok(cw)}</span></span>` : ''}
      <span class="tk-group to" data-tab="output"><span class="tk-label">Output</span> <span class="tk-val">${fmtTok(out)}</span></span>
      <span class="tk-group" style="margin-left:auto"><span class="tk-label">Total</span> <span class="tk-val" style="color:var(--text)">${fmtTok(inp + cr + cw + out)}</span></span>
      <span class="tk-help" onclick="toggleHelp()">?</span>`;
    setTimeout(() => bindTkClicks(tokenBar), 0);
  } else tokenBar.style.display = 'none';

  const ctxBar = document.getElementById('ctxBar');
  const ctxW = CONTEXT_WINDOWS[summary.model || ''];
  if (usage && ctxW) {
    const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    const pct = Math.min(prompt / ctxW * 100, 100);
    ctxBar.classList.add('vis');
    document.getElementById('ctxFill').className = 'ctx-fill ' + (pct > 90 ? 'ctx-danger' : pct > 70 ? 'ctx-warn' : 'ctx-ok');
    document.getElementById('ctxFill').style.width = pct + '%';
    document.getElementById('ctxPct').textContent = pct.toFixed(1) + '%';
    document.getElementById('ctxPct').style.color = pct > 90 ? 'var(--error)' : pct > 70 ? 'var(--warning)' : 'var(--text)';
    document.getElementById('ctxDetail').textContent = `${fmtTok(prompt)} / ${fmtTok(ctxW)}`;
  } else ctxBar.classList.remove('vis');

  const req = detail.request, resp = detail.response;
  const msgs = req?.full?.messages || [], tools = req?.full?.tools || [];
  document.getElementById('inputBadge').textContent = `${msgs.filter(m => m.role !== 'system').length} msgs`;
  const respContent = resp?.reconstructed_content || (!resp?.is_streaming && resp?.full ? fmtRespContent(resp.full) : null);
  document.getElementById('outputBadge').textContent = respContent ? fmtSize(respContent.length) : 'no data';

  // ── INPUT tab ──
  let ih = '';
  const sys = req?.full?.system;
  if (sys) {
    const sc2 = typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map(s => s.text || '').join('\n') : JSON.stringify(sys);
    ih += msgBubble('system', 'System Prompt', fmtSize(sc2.length), esc(sc2.slice(0, 120).replace(/\n/g, ' ')), renderMd(sc2), prevMsgCount > 0, true, null, true);
  }
  if (tools.length) {
    ih += `<div class="msg-bubble msg-system" data-is-cached="${prevMsgCount > 0}">
      <div class="msg-header" onclick="toggleMsg(this)">
        <span class="role-badge"><span class="role-dot"></span>Tools (${tools.length}) · ${fmtSize(JSON.stringify(tools).length)} ${prevMsgCount > 0 ? '<span class="msg-tag msg-tag-c">cached</span>' : '<span class="msg-tag msg-tag-n">new</span>'}</span>
        <span class="msg-summary">${esc(tools.map(t => t.name).join(', '))}</span>
        <span class="toggle-icon collapsed">&#9660;</span>
      </div>
      <div class="msg-body collapsed" style="white-space:normal">
        ${tools.map(t => renderToolCard(t)).join('')}
      </div>
    </div>`;
  }

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i], role = m.role || 'unknown', cached = i < prevMsgCount;
    let ch = '', th = '', tuc = 0, trc = 0;
    if (typeof m.content === 'string') ch = renderMd(m.content);
    else if (Array.isArray(m.content)) {
      const tp = [], cb = [];
      for (const c of m.content) { if (c?.type === 'thinking') tp.push(c.thinking || ''); else cb.push(c); }
      if (tp.length) th = msgBubble('system', 'Thinking', fmtSize(tp.join('\n').length), '', renderMd(tp.join('\n')), false, true, 'var(--peach)', true);
      const r = renderBlocks(cb); ch = r.html; tuc = r.tuc; trc = r.trc;
    } else if (m.content != null) ch = esc(JSON.stringify(m.content));
    ih += th + msgBubble(role, roleLabel(role, tuc, trc), fmtSize(contentLen(m)), summaryText(m), ch, cached, false, null, typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every(c => typeof c === 'string' || c?.type === 'text')));
  }
  ih += `<div class="raw-json-section"><span class="raw-toggle" onclick="toggleRaw(this)">&#9654; Raw JSON</span><div class="raw-json-content">${esc(JSON.stringify(req?.full, null, 2))}</div></div>`;

  // ── OUTPUT tab ──
  let oh = '';
  if (resp) {
    oh += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;display:flex;gap:8px;align-items:center"><span class="badge ${sc}" style="font-size:12px;padding:2px 8px">${resp.status_code} ${sl}</span>${summary.response_time_ms != null ? `<span>${fmtDur(summary.response_time_ms)}</span>` : ''}<span>${resp.is_streaming ? 'streaming' : 'non-streaming'}</span></div>`;
    if (resp.reconstructed_reasoning?.length) oh += msgBubble('system', 'Thinking', fmtSize(resp.reconstructed_reasoning.length), '', renderMd(resp.reconstructed_reasoning), false, true, 'var(--peach)', true);
    if (respContent) {
      const tc = resp.reconstructed_tool_calls;
      if (tc?.length) {
        const txt = respContent.replace(/\[Tool Use\][^\n]*\n[\s\S]*?(?=\[Tool Use\]|$)/g, '').trim();
        if (txt) oh += msgBubble('assistant', 'Response', fmtSize(txt.length), '', renderMd(txt), false, false, null, true);
        const rr = renderBlocks(tc.map(t => ({ ...t })));
        if (rr.html) oh += `<div class="msg-bubble msg-assistant" style="border-color:rgba(166,227,161,.3)"><div class="msg-header" style="background:rgba(166,227,161,.06)"><span class="role-badge"><span class="role-dot"></span>Tool Calls · ${tc.length}</span></div><div class="msg-body" style="white-space:normal">${rr.html}</div></div>`;
      } else oh += msgBubble('assistant', 'Response', fmtSize(respContent.length), '', renderMd(respContent), false, false, null, true);
    } else if (resp.is_streaming) oh += '<div style="color:var(--text-muted)">[streaming...]</div>';
    if (resp.is_streaming && req?.request_id) oh += `<div class="raw-json-section"><span class="raw-toggle" onclick="loadSSE(this,'${esc(req.request_id)}','${esc(date || '')}')">&#9654; SSE</span><div class="raw-json-content" id="sse-area"></div></div>`;
  } else oh += '<div style="color:var(--text-muted)">No response</div>';

  document.getElementById('messagesArea').innerHTML = `<div class="tab-panel active" data-panel="input">${ih}</div><div class="tab-panel" data-panel="output">${oh}</div><div class="tab-panel" data-panel="diff"><div class="empty-state">Loading...</div></div>`;

  // Diff badge
  const prev = si > 0 ? sEntries[si - 1] : null;
  if (prev && summary.usage && prev.usage) { const c = tokTotal(summary.usage), p = tokTotal(prev.usage); document.getElementById('diffBadge').textContent = (c - p) >= 0 ? `+${fmtTok(c - p)}` : fmtTok(c - p); } else document.getElementById('diffBadge').textContent = '—';

  currentTab = 'input';
  document.querySelectorAll('.io-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === 'input'));

  if (prev) {
    const pg = allEntries.indexOf(prev);
    if (pg >= 0) {
      const pk = `${date}:${pg}`;
      if (detailCache.has(pk)) renderDiff(detailCache.get(pk), summary, detail, prev, prevMsgCount);
      else apiFetch(`/detail?date=${date}&index=${pg}`).then(pd => { detailCache.set(pk, pd); if (selectedKey === key) renderDiff(pd, summary, detail, prev, prevMsgCount); }).catch(() => {});
      detailCache.set(`${date}:${gIdx}`, detail);
    } else renderDiff(null, summary, detail, null, 0);
  } else renderDiff(null, summary, detail, null, 0);
}

// Detail helpers
function tokTotal(u) { return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0); }
function contentLen(m) { return typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? JSON.stringify(m.content).length : 0; }
function summaryText(m) { if (Array.isArray(m.content)) { const tn = m.content.filter(c => c?.type === 'tool_use').map(c => c.name); return esc(tn.length ? tn.join(', ') : m.content.filter(c => c?.type === 'text').map(c => c.text || '').join(' ').slice(0, 80)); } return typeof m.content === 'string' ? esc(m.content.slice(0, 80)) : ''; }
function roleLabel(role, tuc, trc) { const p = []; if (tuc) p.push(`${tuc} call${tuc > 1 ? 's' : ''}`); if (trc) p.push(`${trc} result${trc > 1 ? 's' : ''}`); return esc(role) + (p.length ? ` <span style="font-weight:400;color:var(--pink)">${p.join(' / ')}</span>` : ''); }

function msgBubble(cls, label, size, summ, body, cached, collapsed, borderColor, isMarkdown) {
  const bodyAttr = isMarkdown ? ' class="md-body"' : ' style="white-space:normal"';
  return `<div class="msg-bubble msg-${cls}" data-is-cached="${cached}"${borderColor ? ` style="border-color:${borderColor}"` : ''}>
    <div class="msg-header" onclick="toggleMsg(this)">
      <span class="role-badge"><span class="role-dot"></span>${label} · ${size} ${cached ? '<span class="msg-tag msg-tag-c">cached</span>' : '<span class="msg-tag msg-tag-n">new</span>'}</span>
      <span class="msg-summary">${summ}</span>
      <span class="toggle-icon${collapsed ? ' collapsed' : ''}">&#9660;</span>
    </div>
    <div class="msg-body${collapsed ? ' collapsed' : ''}"${bodyAttr}>${body}</div>
  </div>`;
}

function renderToolCard(tool) {
  const name = tool.name || '?';
  const desc = tool.description || '';
  const schema = tool.input_schema || tool.parameters || {};
  const schemaStr = JSON.stringify(schema, null, 2);
  return `<div class="tool-card tool-use">
    <div class="tool-card-header" onclick="toggleTC(this)">
      <span class="tool-name">${esc(name)}</span>
      <span style="color:var(--text-muted);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:8px">${esc(desc.slice(0, 80))}</span>
      <span style="color:var(--text-muted);font-size:10px">${fmtSize(schemaStr.length)}</span>
      <span class="tool-toggle collapsed">&#9660;</span>
    </div>
    <div class="tool-card-body collapsed">${esc(schemaStr)}</div>
  </div>`;
}

function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return { html: '', tuc: 0, trc: 0 };
  let tuc = 0, trc = 0; const parts = [];
  for (const c of blocks) {
    if (typeof c === 'string') { parts.push(renderMd(c)); continue; }
    if (!c?.type) { parts.push(esc(JSON.stringify(c))); continue; }
    if (c.type === 'text') parts.push(renderMd(c.text || ''));
    else if (c.type === 'thinking') parts.push(`<span style="color:var(--text-muted);font-style:italic">[thinking: ${fmtSize((c.thinking || '').length)}]</span>`);
    else if (c.type === 'tool_use') { tuc++; const ij = JSON.stringify(c.input, null, 2); const long = ij.length > 500; parts.push(`<div class="tool-card tool-use"><div class="tool-card-header" onclick="toggleTC(this)"><span class="tool-name">${esc(c.name || '?')}</span><span style="color:var(--text-muted)">${fmtSize(ij.length)}</span><span class="tool-toggle${long ? ' collapsed' : ''}">&#9660;</span></div><div class="tool-card-body${long ? ' collapsed' : ''}">${esc(ij)}</div></div>`); }
    else if (c.type === 'tool_result') { trc++; const rc = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(x => x.text || JSON.stringify(x)).join('\n') : JSON.stringify(c.content); const long = rc.length > 800; parts.push(`<div class="tool-card tool-result ${c.is_error ? 'tool-error' : ''}"><div class="tool-card-header" onclick="toggleTC(this)"><span class="tool-name">${c.is_error ? 'Error' : 'Result'}</span><span style="color:var(--text-muted)">${fmtSize(rc.length)}</span><span class="tool-toggle${long ? ' collapsed' : ''}">&#9660;</span></div><div class="tool-card-body${long ? ' collapsed' : ''}">${esc(rc)}</div></div>`); }
    else parts.push(esc(JSON.stringify(c)));
  }
  return { html: parts.join('\n'), tuc, trc };
}

// ── Diff ────────────────────────────────────────────────────────
function renderDiff(pd, summary, detail, prev, pmc) {
  const panel = document.querySelector('.tab-panel[data-panel="diff"]');
  if (!panel) return;
  let h = '<div class="diff-section"><div class="diff-section-title">Token Usage</div>';
  const cu = summary.usage || detail.response?.sse_usage, pu = prev?.usage;
  if (cu || pu) {
    h += '<table class="diff-table"><tr><th>Metric</th><th>Prev</th><th>Cur</th><th>Delta</th></tr>';
    for (const [l, k] of [['Input', 'input_tokens'], ['Cache Read', 'cache_read_input_tokens'], ['Cache Write', 'cache_creation_input_tokens'], ['Output', 'output_tokens']]) {
      const cv = cu?.[k] || 0, pv = pu?.[k] || 0, d = cv - pv;
      h += `<tr><td>${l}</td><td>${fmtTok(pv)}</td><td>${fmtTok(cv)}</td><td class="${d > 0 ? 'du' : d < 0 ? 'dd' : 'ds'}">${d >= 0 ? '+' : ''}${fmtTok(d)}</td></tr>`;
    }
    const ct = tokTotal(cu || {}), pt = tokTotal(pu || {}), td = ct - pt;
    h += `<tr style="font-weight:600"><td>Total</td><td>${fmtTok(pt)}</td><td>${fmtTok(ct)}</td><td class="${td > 0 ? 'du' : td < 0 ? 'dd' : 'ds'}">${td >= 0 ? '+' : ''}${fmtTok(td)}</td></tr></table>`;
  } else h += '<div class="diff-empty">No data</div>';
  h += '</div>';

  h += '<div class="diff-section"><div class="diff-section-title">System Prompt';
  const cst = extText(detail.request?.full?.system), pst = pd ? extText(pd.request?.full?.system) : '';
  h += cst === pst ? '<span class="diff-badge diff-unchanged">same</span>' : '<span class="diff-badge diff-changed">changed</span></div>';
  if (pd && cst !== pst) h += `<div style="padding:8px;max-height:300px;overflow-y:auto">${diffHtml(lineDiff(pst, cst))}</div>`;
  else h += pd ? '<div class="diff-empty">No changes</div>' : '<div class="diff-empty">First request</div>';
  h += '</div>';

  h += '<div class="diff-section"><div class="diff-section-title">Tools';
  const cTools = detail.request?.full?.tools || [], pTools = pd?.request?.full?.tools || [];
  const cn = new Set(cTools.map(t => t.name)), pn = new Set(pTools.map(t => t.name));
  const added = [...cn].filter(n => !pn.has(n)), removed = [...pn].filter(n => !cn.has(n));
  h += !added.length && !removed.length ? `<span class="diff-badge diff-unchanged">${cn.size}</span>` : `<span class="diff-badge diff-changed">${added.length}+ ${removed.length}-</span></div>`;
  if (added.length || removed.length) { h += '<div class="diff-tool-list">'; for (const t of added) h += `<span class="diff-tool-chip diff-tool-added">+${esc(t)}</span>`; for (const t of removed) h += `<span class="diff-tool-chip diff-tool-removed">-${esc(t)}</span>`; h += '</div>'; }
  h += '</div>';

  panel.innerHTML = h;
}

function extText(s) { return typeof s === 'string' ? s : Array.isArray(s) ? s.map(x => x.text || '').join('\n') : ''; }
function lineDiff(o, n) { const ol = (o || '').split('\n'), nl = (n || '').split('\n'); const m = ol.length, nn = nl.length; const dp = Array.from({ length: m + 1 }, () => new Uint16Array(nn + 1)); for (let i = 1; i <= m; i++) for (let j = 1; j <= nn; j++) dp[i][j] = ol[i - 1] === nl[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]); const r = []; let i = m, j = nn; while (i > 0 || j > 0) { if (i > 0 && j > 0 && ol[i - 1] === nl[j - 1]) { r.push({ t: 's', x: ol[i-- - 1] }); j--; } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) r.push({ t: 'a', x: nl[j-- - 1] }); else r.push({ t: 'd', x: ol[i-- - 1] }); } return r.reverse(); }
function diffHtml(d) { let f = true; return d.map(x => { const p = x.t === 'a' ? '+' : x.t === 'd' ? '-' : ' '; const c = x.t === 'a' ? 'add' : x.t === 'd' ? 'del' : 'same'; const id = x.t !== 's' && f ? (f = false, ' id="diff-first-change"') : ''; return `<div${id} class="diff-line dl-${c}"><span class="diff-line-prefix">${p}</span>${esc(x.x)}</div>`; }).join(''); }

// ── UI Helpers ──────────────────────────────────────────────────
function toggleMsg(h) { const b = h.nextElementSibling; const i = h.querySelector('.toggle-icon'); b.classList.toggle('collapsed'); i?.classList.toggle('collapsed'); }
function toggleTC(h) { const b = h.nextElementSibling; const t = h.querySelector('.tool-toggle'); b.classList.toggle('collapsed'); t?.classList.toggle('collapsed'); }
function toggleRaw(el) { const c = el.nextElementSibling; const v = c.classList.toggle('vis'); el.textContent = (v ? '\u25BC' : '\u25B6') + ' Raw JSON'; }
function toggleHelp() { document.getElementById('helpPanel').classList.toggle('vis'); }
function fmtRespContent(raw) { try { const p = typeof raw === 'string' ? JSON.parse(raw) : raw; return p.choices?.[0]?.message?.content || JSON.stringify(p, null, 2); } catch { return raw; } }

function bindTkClicks(bar) {
  bar.querySelectorAll('.tk-group[data-tab]').forEach(el => {
    el.addEventListener('click', () => {
      switchTab(el.dataset.tab);
      bar.querySelectorAll('.tk-group').forEach(g => g.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.msg-bubble.hl,.msg-bubble.hlc').forEach(b => b.classList.remove('hl', 'hlc'));
      if (el.dataset.highlight === 'user') { document.querySelectorAll('.msg-bubble[data-is-cached="false"]').forEach(b => b.classList.add('hl')); const l = document.querySelectorAll('.msg-bubble[data-is-cached="false"]'); if (l.length) l[l.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      if (el.dataset.highlight === 'cache') document.querySelectorAll('.msg-bubble[data-is-cached="true"]').forEach(b => b.classList.add('hlc'));
    });
  });
}

async function loadSSE(el, rid, date) {
  const a = el.nextElementSibling;
  if (a.classList.contains('vis')) { a.classList.remove('vis'); el.textContent = '\u25B6 SSE'; return; }
  el.textContent = '\u25BC SSE...';
  try {
    const data = await apiFetch(`/sse-events?date=${encodeURIComponent(date)}&request_id=${encodeURIComponent(rid)}`);
    const events = data.events || [];
    if (!events.length) { a.textContent = 'No events'; } else {
      let h = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:500">${events.length} SSE Events</div>`;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const type = ev.sse_event_type || 'unknown';
        const summary = sseEventSummary(ev);
        h += `<div class="msg-bubble sse-event" style="margin-bottom:3px">
          <div class="msg-header" onclick="toggleSSEEvent(this)" style="padding:4px 8px;font-size:11px">
            <span class="role-badge"><span class="role-dot" style="background:var(--pink)"></span>#${i + 1} <span style="color:var(--pink);font-family:var(--font-mono);font-size:10px">${esc(type)}</span></span>
            <span class="msg-summary" style="font-size:10px">${esc(summary)}</span>
            <span class="toggle-icon collapsed">&#9660;</span>
          </div>
          <div class="msg-body collapsed" style="padding:6px 8px;white-space:normal;max-height:60vh">
            <div style="font-size:11px;line-height:1.6">${sseEventDetailHtml(ev)}</div>
            <div style="margin-top:6px;border-top:1px solid var(--border);padding-top:4px">
              <span class="raw-toggle" onclick="event.stopPropagation();toggleRaw(this)">&#9654; Raw JSON</span>
              <div class="raw-json-content">${esc(JSON.stringify(ev, null, 2))}</div>
            </div>
          </div>
        </div>`;
      }
      a.innerHTML = h;
    }
    a.classList.add('vis'); el.textContent = '\u25BC SSE';
  } catch (e) { a.textContent = 'Error: ' + e.message; a.classList.add('vis'); }
}

function toggleSSEEvent(h) { const body = h.nextElementSibling; const icon = h.querySelector('.toggle-icon'); body.classList.toggle('collapsed'); icon.classList.toggle('collapsed'); }

function sseEventSummary(ev) {
  const parts = [];
  if (ev.delta_content) parts.push(`text ${ev.delta_content.length}B`);
  if (ev.delta_reasoning) parts.push(`think ${ev.delta_reasoning.length}B`);
  if (ev.delta_tool_json) parts.push(`tool_json ${ev.delta_tool_json.length}B`);
  if (ev.usage) parts.push(`in=${ev.usage.input_tokens || ev.usage.prompt_tokens || '?'} out=${ev.usage.output_tokens || ev.usage.completion_tokens || '?'}`);
  if (ev.stop_reason) parts.push(`stop=${ev.stop_reason}`);
  if (ev.sse_content_block_index != null) parts.push(`block#${ev.sse_content_block_index}`);
  return parts.length ? parts.join(' | ') : esc(localTime(ev.timestamp));
}

function sseEventDetailHtml(ev) {
  let h = `<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px">`;
  h += `<span style="color:var(--text-muted)">Time</span><span>${esc(localTime(ev.timestamp))}</span>`;
  h += `<span style="color:var(--text-muted)">Type</span><span style="color:var(--pink);font-family:var(--font-mono)">${esc(ev.sse_event_type)}</span>`;
  if (ev.stop_reason) h += `<span style="color:var(--text-muted)">Stop</span><span style="color:var(--peach)">${esc(ev.stop_reason)}</span>`;
  if (ev.sse_content_block_index != null) h += `<span style="color:var(--text-muted)">Block Index</span><span>${ev.sse_content_block_index}</span>`;
  h += `</div>`;
  if (ev.sse_content_block) h += `<div style="margin-top:6px"><div style="background:var(--surface-2);border-radius:4px;padding:4px 8px;margin-top:2px;font-family:var(--font-mono);font-size:10px;white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify(ev.sse_content_block, null, 2))}</div></div>`;
  if (ev.delta_content) h += `<div style="margin-top:6px"><div style="background:var(--surface-2);border-radius:4px;padding:4px 8px;margin-top:2px;font-family:var(--font-mono);font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;color:var(--success)">${esc(ev.delta_content)}</div></div>`;
  if (ev.delta_reasoning) h += `<div style="margin-top:6px"><div style="background:var(--surface-2);border-radius:4px;padding:4px 8px;margin-top:2px;font-family:var(--font-mono);font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;color:var(--peach)">${esc(ev.delta_reasoning)}</div></div>`;
  if (ev.delta_tool_json) h += `<div style="margin-top:6px"><div style="background:var(--surface-2);border-radius:4px;padding:4px 8px;margin-top:2px;font-family:var(--font-mono);font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;color:var(--pink)">${esc(ev.delta_tool_json)}</div></div>`;
  if (ev.usage) {
    const u = ev.usage;
    h += `<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">`;
    for (const [label, val, color] of [['Input', u.input_tokens || u.prompt_tokens, 'var(--accent)'], ['Output', u.output_tokens || u.completion_tokens, 'var(--success)'], ['Cache Read', u.cache_read_input_tokens, 'var(--warning)'], ['Cache Write', u.cache_creation_input_tokens, 'var(--peach)']]) {
      if (val != null) h += `<span style="background:var(--surface-2);padding:2px 8px;border-radius:4px"><span style="color:${color};font-weight:600">${fmtTok(val)}</span> <span style="color:var(--text-muted)">${label}</span></span>`;
    }
    h += `</div>`;
  }
  return h;
}

// ── Init ────────────────────────────────────────────────────────
document.getElementById('dateSelector').addEventListener('change', e => loadLogs(e.target.value));
document.getElementById('detailHeader').addEventListener('click', e => { if (e.target === document.getElementById('detailHeader') || e.target.classList.contains('dh-info')) clearDetail(); });

(async () => {
  await loadDates();
  // Auto-expand first folder
  if (sidebarTree.length) {
    const firstFolder = sidebarTree[0];
    if (firstFolder.name) expandedFolders.add(firstFolder.path || '_none');
    if (firstFolder.sessions.length) expandedSessions.add(firstFolder.sessions[0].sessionId);
    renderSidebar();
  }
})();
