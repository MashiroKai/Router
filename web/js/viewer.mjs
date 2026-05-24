let API_BASE = '/_viewer/api';
let allEntries = [];     // all request entries (with paired response data)
let allSessions = [];    // [{agent, sessionIdx, entries:[...], startTime, endTime}]
let filteredSessions = [];
let activeAgent = null;
let selectedKey = null;
let currentTab = 'input';
let usageData = null;
let expandedSessions = new Set(); // track expanded session state

// Context window sizes per model (combined from all agents)
const CONTEXT_WINDOWS = {
  'glm-5': 202800,
  'glm-5.1': 204800,
  'glm-5-turbo': 202800,
  'glm-4.7': 204800,
  'glm-4.7-flash': 200000,
  'glm-4.7-flashx': 200000,
  'glm-4.6': 204800,
  'glm-4.6v': 128000,
  'glm-4.5': 131072,
  'glm-4.5-air': 131072,
  'glm-4.5-flash': 131072,
  'glm-4.5v': 64000,
  // Codex / OpenAI models
  'gpt-5.4': 200000,
  'gpt-5.3-codex': 200000,
  'gpt-5.2-codex': 200000,
  'gpt-5.2': 200000,
  'gpt-5.1-codex-max': 200000,
  'gpt-5.1-codex-mini': 200000,
  'gpt-5.1-codex': 200000,
  'gpt-5.1': 200000,
  'gpt-5-codex-mini': 200000,
  'o3': 200000,
  'o4-mini': 200000,
  // Anthropic models
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-sonnet-4-20250514': 200000,
  // Router / Nous models
  'xiaomi/mimo-v2-pro': 131072,
  'deepseek-ai/DeepSeek-R1': 131072,
  'deepseek-ai/DeepSeek-V3': 131072,
  'meta-llama/Llama-3.1-405B': 131072,
  // Nebflow models
  'glm-4.7': 204800,
  'glm-5': 202800,
  'glm-5.1': 204800,
};

// ---- API ----
async function apiFetch(path) {
  const r = await fetch(API_BASE + path);
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  return r.json();
}

// ---- Local time formatting ----
function localTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function localDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

// ---- Session detection ----
// Use session_id from request metadata (unique per terminal instance)
// Fall back to thread-tracking for old data without session_id
function detectSessions(entries) {
  if (entries.length === 0) return [];

  // 1. Group by session_id (each terminal = one session)
  const bySession = {};
  const noSession = [];
  for (const e of entries) {
    const sid = e.session_id;
    if (sid) {
      bySession[sid] = bySession[sid] || [];
      bySession[sid].push(e);
    } else {
      noSession.push(e);
    }
  }

  // 2. Build sessions from session_id groups
  const sessions = [];
  for (const [sid, reqs] of Object.entries(bySession)) {
    reqs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const mainReqs = reqs.filter(r => !r.is_subagent);
    const subReqs = reqs.filter(r => r.is_subagent);
    const first = mainReqs[0] || reqs[0];
    const last = mainReqs[mainReqs.length - 1] || reqs[reqs.length - 1];
    sessions.push({
      id: sid,
      agent: first.agent || 'unknown',
      model: first.model || '',
      entries: reqs,
      mainEntries: mainReqs,
      subEntries: subReqs,
      startTime: reqs[0].timestamp,
      endTime: reqs[reqs.length - 1].timestamp,
      firstMsgs: first.messages_count,
      lastMsgs: last.messages_count,
    });
  }

  // 3. Group noSession entries by agent first, then merge or create sessions
  if (noSession.length > 0 && sessions.length > 0) {
    // Group by agent to avoid merging different agents into the same session
    const byAgent = {};
    for (const e of noSession) {
      const a = e.agent || 'unknown';
      byAgent[a] = byAgent[a] || [];
      byAgent[a].push(e);
    }
    for (const [agent, entries] of Object.entries(byAgent)) {
      // Find matching session of same agent
      const agentSessions = sessions.filter(s => s.agent === agent);
      if (agentSessions.length > 0) {
        // Merge into nearest session of same agent
        for (const e of entries) {
          const eTime = new Date(e.timestamp).getTime();
          let bestSession = null;
          let bestDist = Infinity;
          for (const s of agentSessions) {
            const sStart = new Date(s.startTime).getTime();
            const sEnd = new Date(s.endTime).getTime();
            if (eTime >= sStart - 300000 && eTime <= sEnd + 300000) {
              const dist = Math.min(Math.abs(eTime - sStart), Math.abs(eTime - sEnd));
              if (dist < bestDist) {
                bestDist = dist;
                bestSession = s;
              }
            }
          }
          if (bestSession) {
            bestSession.entries.push(e);
            if (!e.is_subagent) bestSession.mainEntries.push(e);
            else bestSession.subEntries.push(e);
            if (e.timestamp < bestSession.startTime) bestSession.startTime = e.timestamp;
            if (e.timestamp > bestSession.endTime) bestSession.endTime = e.timestamp;
            bestSession.entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          } else {
            sessions.push({
              id: null,
              agent: e.agent || 'unknown',
              model: e.model || '',
              entries: [e],
              mainEntries: [e],
              subEntries: [],
              startTime: e.timestamp,
              endTime: e.timestamp,
              firstMsgs: e.messages_count,
              lastMsgs: e.messages_count,
            });
          }
        }
      } else {
        // No session of this agent — create a new grouped session
        entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        sessions.push({
          id: null,
          agent: agent,
          model: entries[0].model || '',
          entries: [...entries],
          mainEntries: entries.filter(e => !e.is_subagent),
          subEntries: entries.filter(e => e.is_subagent),
          startTime: entries[0].timestamp,
          endTime: entries[entries.length - 1].timestamp,
          firstMsgs: entries[0].messages_count,
          lastMsgs: entries[entries.length - 1].messages_count,
        });
      }
    }
  } else if (noSession.length > 0 && sessions.length === 0) {
    // No sessions at all — use fallback
    const fallback = detectSessionsFallback(noSession);
    sessions.push(...fallback);
  }

  return sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

// Fallback for old data without session_id
function detectSessionsFallback(entries) {
  const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const threads = [];

  for (const req of sorted) {
    const msgs = req.messages_count || 0;
    const reqTime = new Date(req.timestamp).getTime();
    let bestThread = null;
    let bestScore = -1;

    for (const thread of threads) {
      const timeSinceLast = reqTime - thread.lastTime;
      if (timeSinceLast > 600000) continue;
      let score = -1;
      if (msgs >= thread.lastMsgs) {
        score = 3000 - (msgs - thread.lastMsgs);
      } else if (msgs >= thread.lastMsgs - 2) {
        score = 2000 - (thread.lastMsgs - msgs);
      } else if (thread.lastMsgs > 10 && msgs > 5 && thread.lastMsgs > msgs * 1.5) {
        score = 1000 - (thread.lastMsgs - msgs);
      }
      score -= timeSinceLast / 1000;
      if (score > bestScore) {
        bestScore = score;
        bestThread = thread;
      }
    }

    if (bestThread && bestScore > 0) {
      bestThread.entries.push(req);
      bestThread.lastMsgs = msgs;
      bestThread.lastTime = reqTime;
    } else {
      threads.push({ lastMsgs: msgs, lastTime: reqTime, entries: [req] });
    }
  }

  return threads.map(t => {
    const ents = t.entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      id: null,
      agent: ents[0].agent || 'unknown',
      model: ents[0].model || '',
      entries: ents,
      mainEntries: ents,
      subEntries: [],
      startTime: ents[0].timestamp,
      endTime: ents[ents.length - 1].timestamp,
      firstMsgs: ents[0].messages_count,
      lastMsgs: ents[ents.length - 1].messages_count,
    };
  });
}

// ---- Date selector ----
async function loadDates() {
  const { dates } = await apiFetch('/dates');
  const sel = document.getElementById('dateSelector');
  sel.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  for (const d of dates) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d + (d === today ? ' (today)' : '');
    sel.appendChild(opt);
  }
  if (dates.length > 0) await loadLogs(dates[0]);
}

// ---- Load logs ----
async function loadLogs(date) {
  const { entries } = await apiFetch('/logs?date=' + date);
  allEntries = entries;
  activeAgent = null;
  expandedSessions.clear();
  allSessions = detectSessions(allEntries);
  renderAgentFilters();
  clearDetail();
  // Usage is now embedded in log entries, no separate API needed
}

// ---- Agent filters ----
function renderAgentFilters() {
  const container = document.getElementById('agentFilters');
  const agents = [...new Set(allEntries.map(e => e.agent || 'unknown'))];
  container.innerHTML = '';

  const allChip = document.createElement('span');
  allChip.className = 'agent-chip active';
  allChip.textContent = 'All';
  allChip.onclick = () => { activeAgent = null; filterAndRender(); };
  container.appendChild(allChip);

  for (const agent of agents.sort()) {
    const chip = document.createElement('span');
    chip.className = 'agent-chip';
    chip.textContent = agent;
    chip.onclick = () => { activeAgent = agent; filterAndRender(); };
    container.appendChild(chip);
  }

  filterAndRender();
}

function filterAndRender() {
  filteredSessions = activeAgent
    ? allSessions.filter(s => s.agent === activeAgent)
    : [...allSessions];

  document.querySelectorAll('.agent-chip').forEach(chip => {
    chip.classList.toggle('active',
      (activeAgent === null && chip.textContent === 'All') ||
      chip.textContent === activeAgent
    );
  });

  renderRequestList();
  updateStatsBar();
}

// ---- Request list with session groups ----
function renderRequestList() {
  const container = document.getElementById('requestList');
  container.innerHTML = '';

  if (filteredSessions.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:40px">No requests found</div>';
    return;
  }

  for (let si = 0; si < filteredSessions.length; si++) {
    const session = filteredSessions[si];
    const sessionKey = (session.id || session.agent) + '@' + session.startTime;
    const group = document.createElement('div');
    group.className = 'session-group';

    // Separate main and subagent entries
    const mainEntries = session.entries.filter(e => !e.is_subagent);
    const subEntries = session.entries.filter(e => e.is_subagent);

    // Session header with name
    const sessionLabel = 'Session ' + String(si + 1).padStart(2, '0');
    const mainCount = mainEntries.length;
    const subCount = subEntries.length;
    const okCount = session.entries.filter(e => e.response_status === 200).length;
    const errCount = session.entries.length - okCount;
    const summaryParts = [
      `${mainCount} requests`,
      subCount > 0 ? `${subCount} subagent` : null,
      okCount < session.entries.length ? `${errCount} errors` : null,
    ].filter(Boolean).join(', ');

    const header = document.createElement('div');
    header.className = 'session-header';
    header.innerHTML = `
      <span class="sh-left">
        <span class="sh-toggle">&#9660;</span>
        <span class="session-name">${esc(sessionLabel)}</span>
        <span class="sh-time">${localTime(session.startTime)}${session.endTime !== session.startTime ? ' — ' + localTime(session.endTime) : ''}</span>
        <span class="sh-count">${summaryParts}</span>
      </span>
      <span style="font-variant-numeric:tabular-nums;color:var(--text-muted)">
        msgs ${session.firstMsgs}${session.firstMsgs !== session.lastMsgs ? ' → ' + session.lastMsgs : ''}
      </span>
    `;
    header.onclick = () => {
      const toggle = header.querySelector('.sh-toggle');
      const reqs = group.querySelector('.session-requests');
      toggle.classList.toggle('collapsed');
      reqs.classList.toggle('collapsed');
      if (!reqs.classList.contains('collapsed')) {
        expandedSessions.add(sessionKey);
      } else {
        expandedSessions.delete(sessionKey);
      }
    };
    group.appendChild(header);

    // Requests container
    const reqsDiv = document.createElement('div');
    reqsDiv.className = 'session-requests collapsed';

    // Render main requests
    for (const entry of mainEntries) {
      renderRequestItem(reqsDiv, entry, session, si);
    }

    // Render subagent subsection
    if (subEntries.length > 0) {
      const saSection = document.createElement('div');
      saSection.className = 'subagent-section';

      const saHeader = document.createElement('div');
      saHeader.className = 'subagent-header';
      const saKey = sessionKey + ':sub';
      const saExpanded = expandedSessions.has(saKey);
      saHeader.innerHTML = `
        <span class="sa-toggle ${saExpanded ? '' : 'collapsed'}">&#9660;</span>
        Subagent calls (${subEntries.length})
      `;
      const saItems = document.createElement('div');
      saItems.className = 'subagent-items' + (saExpanded ? '' : ' collapsed');

      saHeader.onclick = (ev) => {
        ev.stopPropagation();
        const toggle = saHeader.querySelector('.sa-toggle');
        toggle.classList.toggle('collapsed');
        saItems.classList.toggle('collapsed');
        if (!saItems.classList.contains('collapsed')) {
          expandedSessions.add(saKey);
        } else {
          expandedSessions.delete(saKey);
        }
      };

      for (const entry of subEntries) {
        renderRequestItem(saItems, entry, session, si);
      }

      saSection.appendChild(saHeader);
      saSection.appendChild(saItems);
      reqsDiv.appendChild(saSection);
    }

    group.appendChild(reqsDiv);
    container.appendChild(group);

    // Restore expanded state
    if (expandedSessions.has(sessionKey)) {
      group.querySelector('.sh-toggle').classList.remove('collapsed');
      group.querySelector('.session-requests').classList.remove('collapsed');
    }
  }
}

function renderRequestItem(container, entry, session, sessionIdx) {
  const ri = session.entries.indexOf(entry);
  const key = `${sessionIdx}:${ri}`;
  const item = document.createElement('div');
  item.className = 'request-item' + (selectedKey === key ? ' selected' : '') + (entry.is_subagent ? ' subagent-item' : '');

  const isCountTokens = entry.api_type === 'count_tokens';
  const status = entry.response_status;
  const statusClass = status == null ? 'status-none' :
    status === 200 ? 'status-ok' :
    status >= 400 && status < 500 ? 'status-warn' : 'status-err';
  const statusText = status != null ? status : '?';
  const duration = entry.response_time_ms != null ? formatDuration(entry.response_time_ms) : '';

  // Diff badges: total token delta vs previous entry
  const sameCategory = session.entries.filter(e => e.is_subagent === entry.is_subagent && e.api_type !== 'count_tokens');
  const catIdx = sameCategory.indexOf(entry);
  const prevEntry = catIdx > 0 ? sameCategory[catIdx - 1] : null;
  let diffBadges = '';
  if (prevEntry && entry.usage && prevEntry.usage) {
    const currTotal = (entry.usage.input_tokens || 0) + (entry.usage.cache_read_input_tokens || 0) + (entry.usage.cache_creation_input_tokens || 0) + (entry.usage.output_tokens || 0);
    const prevTotal = (prevEntry.usage.input_tokens || 0) + (prevEntry.usage.cache_read_input_tokens || 0) + (prevEntry.usage.cache_creation_input_tokens || 0) + (prevEntry.usage.output_tokens || 0);
    const tokenDelta = currTotal - prevTotal;
    if (tokenDelta !== 0) diffBadges = `<span class="ri-diff ri-diff-tokens">${tokenDelta > 0 ? '+' : ''}${formatTokens(tokenDelta)}</span>`;
  }

  item.innerHTML = `
    <div class="ri-row">
      <div class="ri-left">
        ${isCountTokens
          ? `<span class="ri-io" style="background:var(--bg-tertiary);color:var(--text-muted)">CNT</span>
             <span style="color:var(--text-muted)">count_tokens</span>
             <span class="ri-badge ${statusClass}">${statusText}</span>
             ${duration ? `<span style="color:var(--text-muted)">${duration}</span>` : ''}`
          : `<span class="ri-io in">IN</span>
             <span>${esc(entry.model)}</span>
             <span class="ri-badge ${statusClass}">${statusText}</span>
             ${duration ? `<span style="color:var(--text-muted)">${duration}</span>` : ''}`
        }
      </div>
      <span class="ri-time">${localTime(entry.timestamp)}</span>
    </div>
    <div class="ri-detail">
      ${isCountTokens
        ? `<span style="color:var(--text-muted)">${entry.messages_count || 0} msgs</span>`
        : `<span>${entry.messages_count || 0} msgs</span>
           ${entry.tool_calls_count ? `<span class="ri-tool-badge">${entry.tool_calls_count} calls</span>` : ''}
           ${entry.stream ? '<span>stream</span>' : ''}
           ${entry.channel && entry.channel !== 'unknown' ? `<span>${esc(entry.channel)}</span>` : ''}
           ${entry.metadata_agent_id ? `<span style="color:#e8a862">${esc(entry.metadata_agent_id)}</span>` : ''}
           ${diffBadges}`
      }
    </div>
  `;
  item.onclick = (ev) => { ev.stopPropagation(); selectRequest(key, entry, sessionIdx, ri); };
  container.appendChild(item);

  // Compaction marker
  if (entry.is_compaction) {
    const nextEntry = ri < session.entries.length - 1 ? session.entries[ri + 1] : null;
    const nextMsgs = nextEntry ? (nextEntry.messages_count || 0) : '?';
    const marker = document.createElement('div');
    marker.className = 'compaction-marker';
    marker.innerHTML = `<span class="cm-arrow">&#8693;</span> Compaction ${entry.messages_count || 0} &rarr; ${nextMsgs} msgs`;
    container.appendChild(marker);
  }
}

// ---- Tab switching ----
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.io-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(el => {
    el.classList.toggle('active', el.dataset.panel === tab);
  });
  if (tab === 'diff') scrollToFirstDiff();
}

// ---- Select request ----
async function selectRequest(key, entry, sessionIdx, reqIdx) {
  selectedKey = key;
  // Update selection highlighting
  document.querySelectorAll('.request-item').forEach(el => el.classList.remove('selected'));
  // Find the clicked item — simple approach: re-render with selected state
  renderRequestList();

  // Compute prevMsgCount from previous entry in same session
  const prevMsgCount = reqIdx > 0
    ? filteredSessions[sessionIdx].entries[reqIdx - 1].messages_count || 0
    : 0;

  // Find global index in allEntries
  const globalIndex = allEntries.indexOf(entry);
  if (globalIndex === -1) {
    // Fallback: match by timestamp
    const idx = allEntries.findIndex(e => e.timestamp === entry.timestamp && e.agent === entry.agent);
    if (idx === -1) return;
    entry = allEntries[idx];
  }
  const gIdx = globalIndex !== -1 ? globalIndex : allEntries.indexOf(entry);

  try {
    const date = document.getElementById('dateSelector').value;
    const detail = await apiFetch(`/detail?date=${date}&index=${gIdx}`);
    renderDetail(entry, detail, prevMsgCount, key, date, gIdx, sessionIdx, reqIdx);
  } catch (e) {
    document.getElementById('messagesArea').innerHTML =
      `<div class="empty-state">Error loading detail: ${esc(e.message)}</div>`;
  }
}

// ---- Render detail ----
function renderDetail(summary, detail, prevMsgCount, key, date, gIdx, sessionIdx, reqIdx) {
  const header = document.getElementById('detailHeader');
  const tokenBar = document.getElementById('tokenBar');
  const tabs = document.getElementById('ioTabs');
  header.style.display = 'flex';
  tabs.style.display = 'flex';

  const status = summary.response_status;
  const statusClass = status == null ? 'status-none' :
    status === 200 ? 'status-ok' :
    status >= 400 && status < 500 ? 'status-warn' : 'status-err';
  const statusLabel = status === 200 ? 'OK' :
    status === 429 ? 'Rate Limited' :
    status >= 500 ? 'Server Error' :
    status != null ? `HTTP ${status}` : '?';

  header.innerHTML = `
    <span class="tag tag-model">${esc(summary.model)}</span>
    <span class="tag tag-agent">${esc(summary.agent || 'unknown')}</span>
    <span class="tag tag-channel">${esc(summary.channel || 'unknown')}</span>
    ${summary.metadata_agent_id ? `<span class="tag" style="background:#3d2a1f;color:#e8a862">${esc(summary.metadata_agent_id)}</span>` : ''}
    <span class="dh-info">${summary.messages_count || 0} msgs${summary.tool_calls_count ? ` &middot; ${summary.tool_calls_count} calls` : ''}${summary.stream ? ' &middot; stream' : ''}</span>
    ${summary.response_time_ms != null ? `<span class="dh-info">${formatDuration(summary.response_time_ms)}</span>` : ''}
    ${status != null ? `<span class="ri-badge ${statusClass}" style="font-size:12px;padding:2px 8px">${status} ${statusLabel}</span>` : ''}
    <span class="dh-info" style="margin-left:auto">${localDateTime(summary.timestamp)}</span>
  `;

  // Token bar — Anthropic format: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
  const usage = summary.usage || detail.response?.sse_usage;
  if (usage) {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    // Anthropic: input_tokens 已经是不含缓存的部分
    // 总输入 = input_tokens + cache_read + cache_write
    const totalInput = inputTokens + cacheRead + cacheWrite;
    tokenBar.style.display = 'flex';
    tokenBar.innerHTML = `
      <span class="tk-group tk-in" data-tab="input" data-highlight="user" data-tip="需要实际传输的输入 token（非缓存部分）\n\ninput_tokens = ${fmtNum(inputTokens)}（已排除缓存）"><span class="tk-label">Input</span> <span class="tk-val">${formatTokens(inputTokens)}</span></span>
      ${cacheRead > 0 ? `<span class="tk-group tk-cache" data-tab="input" data-highlight="cache" data-tip="缓存命中的输入 token（无需重新计算）\n速度更快、成本更低"><span class="tk-label">Cache Read</span> <span class="tk-val">${formatTokens(cacheRead)}</span></span>` : ''}
      ${cacheWrite > 0 ? `<span class="tk-group" style="color:var(--text-muted)" data-tip="首次写入缓存的输入 token\n后续请求可被缓存命中"><span class="tk-label">Cache Write</span> <span class="tk-val" style="color:var(--accent-yellow)">${formatTokens(cacheWrite)}</span></span>` : ''}
      <span class="tk-group tk-out" data-tab="output" data-tip="模型生成的输出 token\n\noutput_tokens = ${fmtNum(outputTokens)}\n包含文本输出和 tool_use 调用"><span class="tk-label">Output</span> <span class="tk-val">${formatTokens(outputTokens)}</span></span>
      <span class="tk-group tk-total" style="margin-left:auto;color:var(--text-muted)" data-tip="全部 token 用量\n\ninput = ${fmtNum(inputTokens)}\ncache_read = ${fmtNum(cacheRead)}\ncache_write = ${fmtNum(cacheWrite)}\noutput = ${fmtNum(outputTokens)}\nTotal = ${fmtNum(totalInput + outputTokens)}"><span class="tk-label">Total</span> <span class="tk-val" style="color:var(--text-primary)">${formatTokens(totalInput + outputTokens)}</span></span>
      <span class="tk-help" onclick="toggleHelp()" title="Token 计算原理">?</span>
    `;
    // 点击 token 标签：切换 tab + 高亮对应内容
    setTimeout(() => {
      tokenBar.querySelectorAll('.tk-group[data-tab]').forEach(el => {
        el.addEventListener('click', () => {
          const tab = el.dataset.tab;
          switchTab(tab);
          tokenBar.querySelectorAll('.tk-group').forEach(g => g.classList.remove('active-token'));
          el.classList.add('active-token');
          // 清除旧高亮
          document.querySelectorAll('.msg-bubble.token-highlight, .msg-bubble.token-highlight-cache').forEach(b => {
            b.classList.remove('token-highlight', 'token-highlight-cache');
          });
          const hl = el.dataset.highlight;
          if (hl === 'user') {
            // 高亮所有本次新增的消息（data-is-cached=false），滚动到最后一个
            const newBubbles = document.querySelectorAll('.msg-bubble[data-is-cached="false"]');
            newBubbles.forEach(b => b.classList.add('token-highlight'));
            const last = newBubbles[newBubbles.length - 1];
            if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          if (hl === 'cache') {
            // 高亮所有缓存消息（data-is-cached=true），滚动到 cache 说明
            document.querySelectorAll('.msg-bubble[data-is-cached="true"]').forEach(b => b.classList.add('token-highlight-cache'));
            const cEl = document.getElementById('cache-note');
            if (cEl) cEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          if (hl === 'reasoning') {
            const rEl = document.getElementById('reasoning-section');
            if (rEl) {
              rEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const body = rEl.querySelector('.msg-body');
              const icon = rEl.querySelector('.toggle-icon');
              if (body?.classList.contains('collapsed')) {
                body.classList.remove('collapsed');
                icon?.classList.remove('collapsed');
              }
            }
          }
          if (hl === 'thinking') {
            const tEl = document.getElementById('thinking-section');
            if (tEl) {
              tEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const body = tEl.querySelector('.msg-body');
              const icon = tEl.querySelector('.toggle-icon');
              if (body?.classList.contains('collapsed')) {
                body.classList.remove('collapsed');
                icon?.classList.remove('collapsed');
              }
            }
          }
        });
      });
    }, 0);
  } else {
    tokenBar.style.display = 'none';
  }

  // Context window bar
  const ctxBar = document.getElementById('ctxBar');
  const model = summary.model || summary.resolved_model || '';
  const ctxWindow = CONTEXT_WINDOWS[model];
  if (usage && ctxWindow) {
    const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    const completion = usage.output_tokens || 0;
    const used = prompt + completion;
    const pct = Math.min((used / ctxWindow) * 100, 100);
    const promptPct = (prompt / ctxWindow) * 100;
    const cls = pct > 90 ? 'ctx-danger' : pct > 70 ? 'ctx-warn' : 'ctx-ok';
    ctxBar.classList.add('visible');
    document.getElementById('ctxFill').className = 'ctx-fill ' + cls;
    document.getElementById('ctxFill').style.width = promptPct + '%';
    document.getElementById('ctxPct').textContent = promptPct.toFixed(1) + '%';
    document.getElementById('ctxPct').style.color = pct > 90 ? 'var(--accent-red)' : pct > 70 ? 'var(--accent-yellow)' : 'var(--text-primary)';
    document.getElementById('ctxDetail').textContent = `${formatTokens(prompt)} / ${formatTokens(ctxWindow)}`;
  } else {
    ctxBar.classList.remove('visible');
  }

  const request = detail.request;
  const response = detail.response;
  const messages = request?.full?.messages || [];
  const tools = request?.full?.tools || [];

  // Update tab badges
  const nonSystemCount = messages.filter(m => m.role !== 'system').length;
  document.getElementById('inputBadge').textContent = `${nonSystemCount} msgs`;

  const respContent = response?.reconstructed_content ||
    (!response?.is_streaming && response?.full ? formatResponseContent(response.full) : null);
  const outLabel = response?.is_streaming
    ? (respContent ? `${formatSize(respContent.length)}` : 'streaming')
    : respContent ? `${formatSize(respContent.length)}` : 'no data';
  document.getElementById('outputBadge').textContent = outLabel;

  // ---- INPUT panel ----
  let inputHtml = '';

  // System prompt (Anthropic: top-level field, not in messages)
  const systemPrompt = request?.full?.system;
  if (systemPrompt) {
    const sysContent = typeof systemPrompt === 'string' ? systemPrompt :
      Array.isArray(systemPrompt) ? systemPrompt.map(s => s.text || '').join('\n') : JSON.stringify(systemPrompt);
    inputHtml += `<div class="msg-bubble msg-system" data-msg-role="system" data-is-cached="${prevMsgCount > 0}">
      <div class="msg-header" onclick="toggleMsg(this)">
        <span class="role-badge"><span class="role-dot"></span>System <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(sysContent.length)}</span> ${prevMsgCount > 0 ? '<span class="msg-tag msg-tag-cached">cached</span>' : '<span class="msg-tag msg-tag-new">new</span>'}</span>
        <span class="msg-summary">${esc(sysContent.slice(0, 80).replace(/\n/g, ' '))}${sysContent.length > 80 ? '...' : ''}</span>
        <span class="toggle-icon collapsed">&#9660;</span>
      </div>
      <div class="msg-body collapsed">${esc(sysContent)}</div>
    </div>`;
  }

  if (tools.length > 0) {
    const toolsJson = JSON.stringify(tools, null, 2);
    const toolsSize = JSON.stringify(tools).length;
    inputHtml += `<div class="msg-bubble msg-system" data-is-cached="${prevMsgCount > 0}">
      <div class="msg-header" onclick="toggleMsg(this)">
        <span class="role-badge"><span class="role-dot" style="background:var(--accent-purple)"></span>Tools (${tools.length}) <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(toolsSize)}</span> ${prevMsgCount > 0 ? '<span class="msg-tag msg-tag-cached">cached</span>' : '<span class="msg-tag msg-tag-new">new</span>'}</span>
        <span class="msg-summary">${esc(tools.map(t => t.name).join(', '))}</span>
        <span class="toggle-icon collapsed">&#9660;</span>
      </div>
      <div class="msg-body collapsed">${esc(toolsJson)}</div>
    </div>`;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role || 'unknown';
    const isCached = i < prevMsgCount;

    // Render content with structured tool cards
    let contentHtml = '';
    let thinkingHtml = '';
    let toolUseCount = 0;
    let toolResultCount = 0;

    if (typeof msg.content === 'string') {
      contentHtml = esc(msg.content);
    } else if (Array.isArray(msg.content)) {
      // Separate thinking blocks from the rest
      const thinkingParts = [];
      const contentBlocks = [];
      for (const c of msg.content) {
        if (c && c.type === 'thinking') {
          thinkingParts.push(c.thinking || '');
        } else {
          contentBlocks.push(c);
        }
      }
      if (thinkingParts.length > 0) {
        const thinkingText = thinkingParts.join('\n');
        thinkingHtml = `<div class="msg-bubble msg-system" style="margin-bottom:4px;border-color:var(--accent-orange)">
          <div class="msg-header" onclick="toggleMsg(this)" style="background:rgba(210,153,34,0.08)">
            <span class="role-badge"><span class="role-dot" style="background:var(--accent-orange)"></span>Thinking <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(thinkingText.length)}</span></span>
            <span class="toggle-icon collapsed">&#9660;</span>
          </div>
          <div class="msg-body collapsed">${esc(thinkingText)}</div>
        </div>`;
      }
      const rendered = renderContentBlocks(contentBlocks);
      contentHtml = rendered.html;
      toolUseCount = rendered.toolUseCount;
      toolResultCount = rendered.toolResultCount;
    } else if (msg.content != null) {
      contentHtml = esc(JSON.stringify(msg.content));
    }

    // Build role label with tool counts
    let roleLabel = esc(role);
    const toolParts = [];
    if (toolUseCount > 0) toolParts.push(`${toolUseCount} call${toolUseCount > 1 ? 's' : ''}`);
    if (toolResultCount > 0) toolParts.push(`${toolResultCount} result${toolResultCount > 1 ? 's' : ''}`);
    if (toolParts.length > 0) roleLabel += ` <span style="font-weight:400;color:var(--role-tool)">${toolParts.join(' / ')}</span>`;

    // Summary text: show tool names for tool_use, or first 80 chars
    let summaryText = '';
    if (Array.isArray(msg.content)) {
      const toolNames = msg.content.filter(c => c?.type === 'tool_use').map(c => c.name);
      if (toolNames.length > 0) {
        summaryText = toolNames.join(', ');
      } else {
        const textPreview = msg.content.filter(c => c?.type === 'text').map(c => c.text || '').join(' ');
        summaryText = textPreview.slice(0, 80).replace(/\n/g, ' ');
      }
    } else if (typeof msg.content === 'string') {
      summaryText = msg.content.slice(0, 80).replace(/\n/g, ' ');
    }

    const contentLength = typeof msg.content === 'string' ? msg.content.length :
      Array.isArray(msg.content) ? JSON.stringify(msg.content).length : 0;
    const isLong = contentLength > 2000;

    inputHtml += `${thinkingHtml}<div class="msg-bubble msg-${role}" data-msg-role="${role}" data-msg-index="${i}" data-is-cached="${isCached}">
      <div class="msg-header" onclick="toggleMsg(this)">
        <span class="role-badge">
          <span class="role-dot"></span>
          ${roleLabel}
          <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(contentLength)}</span>
          ${isCached ? '<span class="msg-tag msg-tag-cached">cached</span>' : '<span class="msg-tag msg-tag-new">new</span>'}
        </span>
        <span class="msg-summary">${esc(summaryText)}${summaryText.length > 80 ? '...' : ''}</span>
        <span class="toggle-icon">&#9660;</span>
      </div>
      <div class="msg-body" style="white-space:normal">${contentHtml}</div>
    </div>`;
  }

  inputHtml += `<div class="raw-json-section">
    <span class="raw-toggle" onclick="toggleRaw(this)">&#9654; Raw JSON</span>
    <div class="raw-json-content">${esc(JSON.stringify(request?.full, null, 2))}</div>
  </div>`;

  // Cache 说明（点击 Cache 时定位到这里）
  if (usage) {
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    if (cacheRead > 0 || cacheWrite > 0) {
      inputHtml += `<div id="cache-note" style="margin-top:12px;padding:10px 14px;background:rgba(210,153,34,0.08);border:1px solid rgba(210,153,34,0.2);border-radius:6px;font-size:11px;line-height:1.7;color:var(--text-secondary)">
        <div style="font-weight:600;color:var(--accent-yellow);margin-bottom:4px">Cache (${fmtNum(cacheRead)} read + ${fmtNum(cacheWrite)} write tokens)</div>
        <div>以上所有标记为 <span class="msg-tag msg-tag-cached">cached</span> 的消息（包括 system prompt、工具定义、之前的对话回合）属于与前一次请求重复发送的内容，会被服务端缓存。标记为 <span class="msg-tag msg-tag-new">new</span> 的消息是本次请求新增的输入。</div>
        <div style="margin-top:4px;color:var(--text-muted)">本次请求中 input_tokens=${fmtNum(usage.input_tokens || 0)}（非缓存部分），cache_read=${fmtNum(cacheRead)}，cache_write=${fmtNum(cacheWrite)}，总输入=${fmtNum((usage.input_tokens || 0) + cacheRead + cacheWrite)}。</div>
      </div>`;
    }
  }

  // ---- OUTPUT panel ----
  let outputHtml = '';

  if (response) {
    outputHtml += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <span class="ri-badge ${statusClass}" style="font-size:12px;padding:2px 8px">${response.status_code} ${statusLabel}</span>
      ${summary.response_time_ms != null ? `<span>耗时 ${formatDuration(summary.response_time_ms)}</span>` : ''}
      <span>${response.is_streaming ? '流式响应' : '非流式响应'}</span>
      ${response.content_type ? `<span>${esc(response.content_type)}</span>` : ''}
    </div>`;

    const reasoning = response.reconstructed_reasoning;
    if (reasoning && reasoning.length > 0) {
      outputHtml += `<div class="msg-bubble msg-system" id="thinking-section">
        <div class="msg-header" onclick="toggleMsg(this)">
          <span class="role-badge"><span class="role-dot" style="background:var(--accent-orange)"></span>Thinking <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(reasoning.length)}</span></span>
          <span class="toggle-icon collapsed">&#9660;</span>
        </div>
        <div class="msg-body collapsed">${esc(reasoning)}</div>
      </div>`;
    }

    if (respContent) {
      // Check if response has structured tool calls
      const toolCalls = response.reconstructed_tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        // Split text content from tool calls
        const textParts = respContent.split(/\[Tool Use\][^\n]*\n/).filter(s => s.trim());
        if (textParts.length > 0 && !toolCalls.length) {
          // No tool calls, just text
          outputHtml += `<div class="msg-bubble msg-assistant">
            <div class="msg-header">
              <span class="role-badge"><span class="role-dot"></span>Response <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(respContent.length)}</span></span>
            </div>
            <div class="msg-body">${esc(respContent)}</div>
          </div>`;
        } else {
          // Render text + tool call cards
          const textContent = respContent.replace(/\[Tool Use\][^\n]*\n[\s\S]*?(?=\[Tool Use\]|$)/g, '').trim();
          if (textContent) {
            outputHtml += `<div class="msg-bubble msg-assistant">
              <div class="msg-header">
                <span class="role-badge"><span class="role-dot"></span>Response <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(textContent.length)}</span></span>
              </div>
              <div class="msg-body">${esc(textContent)}</div>
            </div>`;
          }
          const rendered = renderContentBlocks(toolCalls.map(tc => ({...tc})));
          if (rendered.html) {
            outputHtml += `<div class="msg-bubble msg-assistant" style="border-color:rgba(63,185,80,0.3)">
              <div class="msg-header" style="background:rgba(63,185,80,0.06)">
                <span class="role-badge"><span class="role-dot"></span>Tool Calls <span style="font-weight:400;color:var(--text-muted)">&middot; ${toolCalls.length}</span></span>
              </div>
              <div class="msg-body" style="white-space:normal">${rendered.html}</div>
            </div>`;
          }
        }
      } else {
        outputHtml += `<div class="msg-bubble msg-assistant">
          <div class="msg-header">
            <span class="role-badge"><span class="role-dot"></span>Response <span style="font-weight:400;color:var(--text-muted)">&middot; ${formatSize(respContent.length)}</span></span>
          </div>
          <div class="msg-body">${esc(respContent)}</div>
        </div>`;
      }
    } else if (response.is_streaming) {
      outputHtml += `<div class="response-body" style="color:var(--text-muted)">[流式响应 — 正在加载 SSE 事件...]</div>`;
    }

    // Raw SSE Events section for streaming responses
    if (response?.is_streaming && request?.request_id) {
      outputHtml += `<div class="raw-json-section">
        <span class="raw-toggle" onclick="loadSSEEvents(this, '${esc(request.request_id)}', '${esc(date || '')}')">&#9654; SSE 事件流（逐帧）</span>
        <div class="raw-json-content" id="sse-events-area"></div>
      </div>`;
    }
  } else {
    outputHtml += `<div style="color:var(--text-muted)">No response recorded</div>`;
  }

  // Raw JSON for output
  if (response) {
    let respRaw = null;
    if (response.full && (typeof response.full !== 'string' || response.full.length > 0)) {
      respRaw = typeof response.full === 'string' ? response.full : JSON.stringify(response.full, null, 2);
    } else if (response.is_streaming) {
      // Reconstruct structured output from SSE data
      const reconstructed = {};
      if (respContent) reconstructed.content = respContent;
      if (response.reconstructed_reasoning) reconstructed.reasoning = response.reconstructed_reasoning;
      if (response.reconstructed_tool_calls) reconstructed.tool_calls = response.reconstructed_tool_calls;
      if (response.sse_usage) reconstructed.usage = response.sse_usage;
      reconstructed.is_streaming = true;
      reconstructed.status_code = response.status_code;
      if (Object.keys(reconstructed).length > 2) {
        respRaw = JSON.stringify(reconstructed, null, 2);
      }
    }
    if (respRaw) {
      outputHtml += `<div class="raw-json-section">
        <span class="raw-toggle" onclick="toggleRaw(this)">&#9654; Raw JSON</span>
        <div class="raw-json-content">${esc(respRaw)}</div>
      </div>`;
    }
  }

  const area = document.getElementById('messagesArea');
  area.innerHTML = `
    <div class="tab-panel active" data-panel="input">${inputHtml}</div>
    <div class="tab-panel" data-panel="output">${outputHtml}</div>
    <div class="tab-panel" data-panel="diff"><div class="empty-state">Loading diff...</div></div>
  `;

  // Update diff badge (total token delta)
  const prevSummary = reqIdx > 0 ? filteredSessions[sessionIdx].entries[reqIdx - 1] : null;
  if (prevSummary && summary.usage && prevSummary.usage) {
    const cTotal = (summary.usage.input_tokens || 0) + (summary.usage.cache_read_input_tokens || 0) + (summary.usage.cache_creation_input_tokens || 0) + (summary.usage.output_tokens || 0);
    const pTotal = (prevSummary.usage.input_tokens || 0) + (prevSummary.usage.cache_read_input_tokens || 0) + (prevSummary.usage.cache_creation_input_tokens || 0) + (prevSummary.usage.output_tokens || 0);
    const delta = cTotal - pTotal;
    document.getElementById('diffBadge').textContent = delta >= 0 ? `+${formatTokens(delta)}` : formatTokens(delta);
  } else {
    document.getElementById('diffBadge').textContent = '—';
  }

  currentTab = 'input';
  document.querySelectorAll('.io-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === 'input');
  });

  // Async: load previous detail and render diff panel
  if (prevSummary) {
    // Find global index of prevSummary (session-scoped) to avoid cross-agent contamination
    const prevGIdx = allEntries.indexOf(prevSummary);
    if (prevGIdx >= 0) {
      const prevKey = `${date}:${prevGIdx}`;
      if (detailCache.has(prevKey)) {
        renderDiffPanel(detailCache.get(prevKey), summary, detail, prevSummary, prevMsgCount);
      } else {
        apiFetch(`/detail?date=${date}&index=${prevGIdx}`).then(prevDetail => {
          detailCache.set(prevKey, prevDetail);
          if (selectedKey === key) { // still viewing the same request
            renderDiffPanel(prevDetail, summary, detail, prevSummary, prevMsgCount);
          }
        }).catch(() => {});
      }
    } else {
      renderDiffPanel(null, summary, detail, null, 0);
    }
    // Cache current detail
    detailCache.set(`${date}:${gIdx}`, detail);
  } else {
    // First request in session — show only current data
    renderDiffPanel(null, summary, detail, null, 0);
  }
}

function renderDiffPanel(prevDetail, summary, detail, prevSummary, prevMsgCount) {
  const diffPanel = document.querySelector('.tab-panel[data-panel="diff"]');
  if (!diffPanel) return;

  let html = '';

  // ---- 1. Token Usage Diff ----
  html += '<div class="diff-section">';
  html += '<div class="diff-section-title">Token Usage</div>';
  const currUsage = summary.usage || detail.response?.sse_usage;
  const prevUsage = prevSummary?.usage;
  if (currUsage || prevUsage) {
    html += '<table class="diff-table"><tr><th>Metric</th><th>Previous</th><th>Current</th><th>Delta</th></tr>';
    const rows = [
      ['Input', 'input_tokens', 'input_tokens'],
      ['Cache Read', 'cache_read_input_tokens', 'cache_read_input_tokens'],
      ['Cache Write', 'cache_creation_input_tokens', 'cache_creation_input_tokens'],
      ['Output', 'output_tokens', 'output_tokens'],
    ];
    for (const [label, currKey, prevKey] of rows) {
      const cv = currUsage?.[currKey] || 0;
      const pv = prevUsage?.[prevKey] || 0;
      const delta = cv - pv;
      const cls = delta > 0 ? 'diff-val-up' : delta < 0 ? 'diff-val-down' : 'diff-val-same';
      html += `<tr><td>${label}</td><td>${formatTokens(pv)}</td><td>${formatTokens(cv)}</td><td class="${cls}">${delta >= 0 ? '+' : ''}${formatTokens(delta)}</td></tr>`;
    }
    // Total row
    const currTotal = (currUsage?.input_tokens || 0) + (currUsage?.output_tokens || 0) +
      (currUsage?.cache_read_input_tokens || 0) + (currUsage?.cache_creation_input_tokens || 0);
    const prevTotal = (prevUsage?.input_tokens || 0) + (prevUsage?.output_tokens || 0) +
      (prevUsage?.cache_read_input_tokens || 0) + (prevUsage?.cache_creation_input_tokens || 0);
    const totalDelta = currTotal - prevTotal;
    const totalCls = totalDelta > 0 ? 'diff-val-up' : totalDelta < 0 ? 'diff-val-down' : 'diff-val-same';
    html += `<tr style="font-weight:600"><td>Total</td><td>${formatTokens(prevTotal)}</td><td>${formatTokens(currTotal)}</td><td class="${totalCls}">${totalDelta >= 0 ? '+' : ''}${formatTokens(totalDelta)}</td></tr>`;
    html += '</table>';
  } else {
    html += '<div class="diff-empty">No usage data</div>';
  }
  html += '</div>';

  // ---- 2. System Prompt Diff ----
  html += '<div class="diff-section">';
  html += '<div class="diff-section-title">System Prompt';
  const currSystem = detail.request?.full?.system;
  const prevSystem = prevDetail?.request?.full?.system;
  const currSysText = typeof currSystem === 'string' ? currSystem :
    Array.isArray(currSystem) ? currSystem.map(s => s.text || '').join('\n') : '';
  const prevSysText = prevDetail ? (typeof prevSystem === 'string' ? prevSystem :
    Array.isArray(prevSystem) ? prevSystem.map(s => s.text || '').join('\n') : '') : '';
  if (currSysText === prevSysText) {
    html += ' <span class="diff-badge diff-badge-unchanged">unchanged</span>';
  } else {
    html += ' <span class="diff-badge diff-badge-changed">changed</span>';
  }
  html += '</div>';
  if (prevDetail && currSysText !== prevSysText) {
    html += `<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;max-height:300px;overflow-y:auto">${renderDiffHtml(lineDiff(prevSysText, currSysText))}</div>`;
  } else if (!prevDetail) {
    html += '<div class="diff-empty">First request in session</div>';
  } else {
    html += '<div class="diff-empty">No changes</div>';
  }
  html += '</div>';

  // ---- 3. Tools Diff ----
  html += '<div class="diff-section">';
  html += '<div class="diff-section-title">Tools';
  const currTools = (detail.request?.full?.tools || []);
  const prevTools = prevDetail ? (prevDetail.request?.full?.tools || []) : [];
  const currToolNames = new Set(currTools.map(t => t.name));
  const prevToolNames = new Set(prevTools.map(t => t.name));
  const addedTools = [...currToolNames].filter(n => !prevToolNames.has(n));
  const removedTools = [...prevToolNames].filter(n => !currToolNames.has(n));
  if (addedTools.length === 0 && removedTools.length === 0) {
    html += ` <span class="diff-badge diff-badge-unchanged">${currToolNames.size} tools, unchanged</span>`;
  } else {
    html += ` <span class="diff-badge diff-badge-changed">${addedTools.length} added, ${removedTools.length} removed</span>`;
  }
  html += '</div>';
  if (addedTools.length > 0 || removedTools.length > 0) {
    html += '<div class="diff-tool-list">';
    for (const t of addedTools) html += `<span class="diff-tool-chip diff-tool-added">+${esc(t)}</span>`;
    for (const t of removedTools) html += `<span class="diff-tool-chip diff-tool-removed">−${esc(t)}</span>`;
    html += '</div>';
  }
  html += '</div>';

  // ---- 4. Messages Diff (whole-text) ----
  html += '<div class="diff-section">';
  html += '<div class="diff-section-title">Messages';
  const currMsgs = detail.request?.full?.messages || [];
  const prevMsgs = prevDetail ? (prevDetail.request?.full?.messages || []) : [];
  const prevText = prevMsgs.map(m => `[${m.role || '?'}] ${msgContentText(m)}`).join('\n\n');
  const currText = currMsgs.map(m => `[${m.role || '?'}] ${msgContentText(m)}`).join('\n\n');
  if (prevDetail) {
    html += ` <span style="font-weight:400;color:var(--text-muted)">${prevMsgs.length} → ${currMsgs.length} msgs</span>`;
  }
  html += '</div>';

  if (!prevDetail) {
    html += `<div class="diff-empty">First request — ${currMsgs.length} messages total</div>`;
  } else if (prevText === currText) {
    html += '<div class="diff-empty">No message changes</div>';
  } else {
    const diff = lineDiff(prevText, currText);
    const addCount = diff.filter(d => d.type === 'add').length;
    const delCount = diff.filter(d => d.type === 'del').length;
    html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${addCount} added, ${delCount} removed lines</div>`;
    html += `<div style="max-height:600px;overflow-y:auto">${renderDiffHtml(diff)}</div>`;
  }
  html += '</div>';

  diffPanel.innerHTML = html;
  // Auto-scroll to first change if diff tab is active
  if (document.querySelector('.io-tab.tab-diff.active')) {
    scrollToFirstDiff();
  }
}

function scrollToFirstDiff() {
  const el = document.getElementById('diff-first-change');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearDetail() {
  selectedKey = null;
  document.getElementById('detailHeader').style.display = 'none';
  document.getElementById('tokenBar').style.display = 'none';
  document.getElementById('ctxBar').classList.remove('visible');
  document.getElementById('helpPanel').classList.remove('visible');
  document.getElementById('ioTabs').style.display = 'none';
  document.getElementById('messagesArea').innerHTML =
    '<div class="empty-state">Select a request to view details</div>';
}

// ---- Stats (dynamic, follows filter) ----
function updateStatsBar() {
  const bar = document.getElementById('statsBar');

  // Collect filtered entries
  const entries = filteredSessions.flatMap(s => s.entries);
  const agentCount = new Set(entries.map(e => e.agent || 'unknown')).size;
  const modelCount = new Set(entries.map(e => e.model || 'unknown')).size;

  // Count requests & aggregate usage
  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0, usageCount = 0;
  for (const e of entries) {
    if (e.usage) {
      totalIn += e.usage.input_tokens || 0;
      totalOut += e.usage.output_tokens || 0;
      totalCacheRead += e.usage.cache_read_input_tokens || 0;
      totalCacheWrite += e.usage.cache_creation_input_tokens || 0;
      usageCount++;
    }
  }

  bar.innerHTML = `
    <span>${entries.length} requests &middot; ${filteredSessions.length} sessions${modelCount > 1 ? ` &middot; ${modelCount} models` : agentCount > 1 ? ` &middot; ${agentCount} agents` : ''}</span>
    ${usageCount > 0 ? `<span>
      <span class="stat-item stat-in">in <span class="stat-val">${formatTokens(totalIn)}</span></span>
      <span class="stat-item stat-cache">cache <span class="stat-val">${formatTokens(totalCacheRead)}</span></span>
      <span class="stat-item stat-out">out <span class="stat-val">${formatTokens(totalOut)}</span></span>
    </span>` : ''}
  `;
  loadProviderUsage();
}

// ---- Provider Usage (computed locally from allEntries) ----
function loadProviderUsage() {
  const container = document.getElementById('providerUsageContent');
  const section = document.getElementById('providerUsageSection');

  // Map resolved_model → provider name
  const modelToProvider = {
    'glm-5': 'Zhipu', 'glm-5.1': 'Zhipu', 'glm-5-turbo': 'Zhipu',
    'glm-4.7': 'Zhipu', 'glm-4.7-flash': 'Zhipu', 'glm-4.7-flashx': 'Zhipu',
    'glm-4.6': 'Zhipu', 'glm-4.6v': 'Zhipu',
    'glm-4.5': 'Zhipu', 'glm-4.5-air': 'Zhipu', 'glm-4.5-flash': 'Zhipu', 'glm-4.5v': 'Zhipu',

  };

  const byProvider = {};
  for (const e of allEntries) {
    if (!e.usage) continue;
    const model = e.resolved_model || e.model || '';
    const pname = modelToProvider[model] || model || 'unknown';
    if (!byProvider[pname]) byProvider[pname] = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, request_count: 0 };
    const u = e.usage;
    byProvider[pname].input_tokens += u.input_tokens || 0;
    byProvider[pname].output_tokens += u.output_tokens || 0;
    byProvider[pname].cache_read_input_tokens += u.cache_read_input_tokens || 0;
    byProvider[pname].cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    byProvider[pname].request_count += 1;
  }

  const providers = Object.keys(byProvider);
  if (providers.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  let html = '<table class="pu-table"><tr><th>Provider</th><th>Input</th><th>Cache R</th><th>Output</th><th>Total</th><th>Reqs</th></tr>';
  let tIn = 0, tOut = 0, tCache = 0, tReqs = 0;
  for (const pname of providers.sort()) {
    const u = byProvider[pname];
    const rowTotal = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens;
    tIn += u.input_tokens; tOut += u.output_tokens; tCache += u.cache_read_input_tokens; tReqs += u.request_count;
    html += `<tr>
      <td>${esc(pname)}</td>
      <td class="pu-val-in">${formatTokens(u.input_tokens)}</td>
      <td class="pu-val-cache">${formatTokens(u.cache_read_input_tokens)}</td>
      <td class="pu-val-out">${formatTokens(u.output_tokens)}</td>
      <td class="pu-val-total">${formatTokens(rowTotal)}</td>
      <td style="color:var(--text-muted)">${u.request_count}</td>
    </tr>`;
  }
  const tTotal = tIn + tCache + tOut;
  html += `<tr class="pu-total">
    <td>Total</td>
    <td class="pu-val-in">${formatTokens(tIn)}</td>
    <td class="pu-val-cache">${formatTokens(tCache)}</td>
    <td class="pu-val-out">${formatTokens(tOut)}</td>
    <td class="pu-val-total">${formatTokens(tTotal)}</td>
    <td style="color:var(--text-muted)">${tReqs}</td>
  </tr>`;
  html += '</table>';
  container.innerHTML = html;
}

function formatTokens(n) {
  if (n == null) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtNum(n) {
  if (n == null) return '?';
  return n.toLocaleString('en-US');
}

// ---- Diff helpers ----
// Detail cache for diff comparisons
const detailCache = new Map();

// Simple LCS-based line diff
function lineDiff(oldStr, newStr) {
  const norm = s => (s || '').normalize('NFKC');
  const oldLines = norm(oldStr).split('\n');
  const newLines = norm(newStr).split('\n');
  const m = oldLines.length, n = newLines.length;

  // Build LCS table
  const dp = Array.from({length: m + 1}, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i-1] === newLines[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  // Backtrack
  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
      result.push({type: 'same', text: oldLines[i-1]});
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.push({type: 'add', text: newLines[j-1]});
      j--;
    } else {
      result.push({type: 'del', text: oldLines[i-1]});
      i--;
    }
  }
  result.reverse();
  return result;
}

function renderDiffHtml(diff) {
  let firstChange = true;
  return diff.map(d => {
    const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '−' : ' ';
    const cls = d.type === 'add' ? 'add' : d.type === 'del' ? 'del' : 'same';
    const id = (d.type !== 'same' && firstChange) ? (firstChange = false, ' id="diff-first-change"') : '';
    return `<div${id} class="diff-line diff-line-${cls}"><span class="diff-line-prefix">${prefix}</span>${esc(d.text)}</div>`;
  }).join('');
}

function formatTokenDelta(curr, prev) {
  if (curr == null && prev == null) return '<span class="diff-val-same">—</span>';
  const c = curr || 0, p = prev || 0;
  const delta = c - p;
  if (delta === 0) return `<span class="diff-val-same">${formatTokens(c)}</span>`;
  const cls = delta > 0 ? 'diff-val-up' : 'diff-val-down';
  const sign = delta > 0 ? '+' : '';
  return `<span class="${cls}">${formatTokens(c)} (${sign}${formatTokens(delta)})</span>`;
}

// Extract message content as text (Anthropic format)
function msgContentText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(c => {
      if (typeof c === 'string') return c;
      if (c.type === 'text') return c.text || '';
      if (c.type === 'thinking') return `[thinking] ${c.thinking || ''}`;
      if (c.type === 'tool_use') return `[tool_use] ${c.name || ''} ${JSON.stringify(c.input || {})}`;
      if (c.type === 'tool_result') {
        const rc = typeof c.content === 'string' ? c.content :
          Array.isArray(c.content) ? c.content.map(x => x.text || JSON.stringify(x)).join('\n') : JSON.stringify(c.content);
        return `[tool_result:${c.tool_use_id || ''}] ${rc}`;
      }
      return JSON.stringify(c);
    }).join('\n');
  }
  return msg.content != null ? JSON.stringify(msg.content) : '';
}

// ---- Helpers ----
function esc(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

/**
 * Render a content block array into HTML with structured tool cards.
 * Returns { html, toolUseCount, toolResultCount }
 */
function renderContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return { html: '', toolUseCount: 0, toolResultCount: 0 };
  let toolUseCount = 0, toolResultCount = 0;
  const parts = [];

  for (const c of blocks) {
    if (typeof c === 'string') { parts.push(esc(c)); continue; }
    if (!c || !c.type) { parts.push(esc(JSON.stringify(c))); continue; }

    if (c.type === 'text') {
      parts.push(esc(c.text || ''));
    } else if (c.type === 'thinking') {
      const t = c.thinking || '';
      parts.push(`<span style="color:var(--text-muted);font-style:italic">[thinking: ${formatSize(t.length)}]</span>`);
    } else if (c.type === 'tool_use') {
      toolUseCount++;
      const inputStr = JSON.stringify(c.input, null, 2);
      const inputSize = formatSize(inputStr.length);
      const isLongInput = inputStr.length > 500;
      parts.push(`<div class="tool-card tool-use">
        <div class="tool-card-header" onclick="toggleToolCard(this)">
          <span class="tool-icon"></span>
          <span class="tool-name">${esc(c.name || 'unknown')}</span>
          <span style="color:var(--text-muted);font-weight:400">${inputSize}</span>
          <span class="tool-toggle ${isLongInput ? 'collapsed' : ''}">&#9660;</span>
        </div>
        <div class="tool-card-body ${isLongInput ? 'collapsed' : ''}">${esc(inputStr)}</div>
      </div>`);
    } else if (c.type === 'tool_result') {
      toolResultCount++;
      const isError = c.is_error || false;
      const resultContent = typeof c.content === 'string' ? c.content :
        Array.isArray(c.content) ? c.content.map(rc => {
          if (rc.text) return rc.text;
          if (rc.type === 'image') return `[image: ${rc.source?.type || 'unknown'}]`;
          return JSON.stringify(rc);
        }).join('\n') : JSON.stringify(c.content);
      const resultSize = formatSize(resultContent.length);
      const isLongResult = resultContent.length > 800;
      parts.push(`<div class="tool-card tool-result ${isError ? 'tool-error' : ''}">
        <div class="tool-card-header" onclick="toggleToolCard(this)">
          <span class="tool-icon"></span>
          <span class="tool-name">${isError ? 'Error' : 'Result'}</span>
          <span style="color:var(--text-muted);font-weight:400">${resultSize}</span>
          <span class="tool-toggle ${isLongResult ? 'collapsed' : ''}">&#9660;</span>
        </div>
        <div class="tool-card-body ${isLongResult ? 'collapsed' : ''}">${esc(resultContent)}</div>
      </div>`);
    } else if (c.type === 'image') {
      parts.push(`<span style="color:var(--text-muted)">[image: ${c.source?.type || 'unknown'}]</span>`);
    } else {
      parts.push(esc(JSON.stringify(c)));
    }
  }
  return { html: parts.join('\n'), toolUseCount, toolResultCount };
}

function toggleToolCard(header) {
  const body = header.nextElementSibling;
  const toggle = header.querySelector('.tool-toggle');
  body.classList.toggle('collapsed');
  toggle.classList.toggle('collapsed');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatResponseContent(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed.choices?.[0]?.message?.content) {
      return parsed.choices[0].message.content;
    }
    return JSON.stringify(parsed, null, 2);
  } catch { return raw; }
}

function toggleMsg(header) {
  const body = header.nextElementSibling;
  const icon = header.querySelector('.toggle-icon');
  body.classList.toggle('collapsed');
  icon.classList.toggle('collapsed');
}

function toggleRaw(el) {
  const content = el.nextElementSibling;
  const visible = content.classList.toggle('visible');
  el.textContent = (visible ? '\u25BC' : '\u25B6') + ' Raw JSON';
}

async function loadSSEEvents(el, requestId, date) {
  const area = el.nextElementSibling;
  if (area.classList.contains('visible')) {
    area.classList.remove('visible');
    el.innerHTML = '&#9654; SSE 事件流（逐帧）';
    return;
  }
  el.innerHTML = '&#9660; SSE 事件流（加载中...）';
  try {
    const data = await apiFetch(`/sse-events?date=${encodeURIComponent(date)}&request_id=${encodeURIComponent(requestId)}`);
    const events = data.events || [];
    if (events.length === 0) {
      area.textContent = '无 SSE 事件记录';
    } else {
      let html = '';
      for (const ev of events) {
        const evType = ev.sse_event_type || 'unknown';
        let detail = '';
        if (ev.delta_content) detail += `text[${ev.delta_content.length}] `;
        if (ev.delta_reasoning) detail += `thinking[${ev.delta_reasoning.length}] `;
        if (ev.delta_tool_json) detail += `tool_json[${ev.delta_tool_json.length}] `;
        if (ev.usage) detail += `usage(in=${ev.usage.input_tokens||0} out=${ev.usage.output_tokens||0}) `;
        if (ev.stop_reason) detail += `stop=${ev.stop_reason} `;
        if (ev.model) detail += `model=${ev.model} `;
        if (ev.sse_content_block) detail += `block=${ev.sse_content_block.type||''}(${ev.sse_content_block.name||''}) `;
        html += `<div style="padding:4px 8px;border-bottom:1px solid var(--border);font-size:11px">
          <span style="color:var(--accent-blue)">${esc(localTime(ev.timestamp))}</span>
          <span style="color:var(--accent-purple);margin-left:8px">${esc(evType)}</span>
          ${detail ? `<span style="color:var(--text-muted);margin-left:8px">${esc(detail.trim())}</span>` : ''}
        </div>`;
      }
      html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${events.length} 个事件</div>` + html;
      // Full raw JSON of all events
      html += `<div class="raw-json-section" style="margin-top:8px">
        <span class="raw-toggle" onclick="toggleRaw(this)">&#9654; 完整 SSE 原始数据</span>
        <div class="raw-json-content">${esc(JSON.stringify(events, null, 2))}</div>
      </div>`;
      area.innerHTML = html;
    }
    area.classList.add('visible');
    el.innerHTML = '&#9660; SSE 事件流（逐帧）';
  } catch (e) {
    area.textContent = '加载失败: ' + e.message;
    area.classList.add('visible');
  }
}

function toggleHelp() {
  document.getElementById('helpPanel').classList.toggle('visible');
}

// ---- Init ----
document.getElementById('dateSelector').addEventListener('change', (e) => {
  loadLogs(e.target.value);
});

// ---- Agent Model Selector ----
let agentModelsData = null;

async function loadAgentModels() {
  try {
    const r = await fetch(API_BASE + '/agents/models');
    agentModelsData = await r.json();
    renderAgentModelPanel();
  } catch (e) {
    console.error('Failed to load agent models:', e);
  }
}

function renderAgentModelPanel() {
  if (!agentModelsData) return;
  const container = document.getElementById('agentModelList');
  container.innerHTML = '';

  const { agents, available_models } = agentModelsData;
  // Sort: discovered agents first, then known agents
  const sortedAgents = Object.keys(agents).sort();

  for (const agent of sortedAgents) {
    const row = document.createElement('div');
    row.className = 'agent-model-row';

    const name = document.createElement('span');
    name.className = 'agent-model-name';
    name.textContent = agent;
    name.title = agent;

    const select = document.createElement('select');
    select.className = 'agent-model-select';
    select.dataset.agent = agent;

    // Default option
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'Default';
    select.appendChild(defOpt);

    // Auto option
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Auto (LB)';
    select.appendChild(autoOpt);

    // Available models
    for (const m of available_models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    }

    // Set current value
    const current = agents[agent]?.model;
    if (current && current !== 'auto') {
      // If not in options, add it
      if (!available_models.includes(current)) {
        const opt = document.createElement('option');
        opt.value = current;
        opt.textContent = current;
        select.appendChild(opt);
      }
    }
    select.value = current || '';

    const btn = document.createElement('button');
    btn.className = 'agent-model-apply';
    btn.textContent = 'Set';
    btn.onclick = () => applyAgentModel(agent, select.value);

    row.appendChild(name);
    row.appendChild(select);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

async function applyAgentModel(agent, model) {
  try {
    const r = await fetch(API_BASE + '/agents/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, model: model || null }),
    });
    const d = await r.json();
    const indicator = document.getElementById('modelIndicator');
    indicator.textContent = `${agent}: ${d.model || 'default'}`;
    setTimeout(() => { indicator.textContent = ''; }, 3000);
  } catch (e) {
    console.error('Failed to apply agent model:', e);
  }
}

loadAgentModels();
loadDates();
