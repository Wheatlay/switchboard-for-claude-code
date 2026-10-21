'use strict';
// Plan limits (5h / 7d) per account. Claude Code doesn't store them locally, so a 1-token
// request reads them from the anthropic-ratelimit-unified-* response headers.
const fs = require('fs');
const path = require('path');

class LoggedOut extends Error {}

async function fetchLimits(configDir) {
  let oauth;
  try {
    oauth = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth;
  } catch {
    oauth = null;
  }
  if (!oauth?.accessToken) throw new LoggedOut('not logged in');
  // Claude Code refreshes the token itself; an expired one would only cost a 401.
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new TokenExpired('token expired');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
    signal: AbortSignal.timeout(15000),
  });
  // A 429 at 100% still carries the headers, so read them before looking at the status.
  const h = (k) => res.headers.get(`anthropic-ratelimit-unified-${k}`);
  if (h('5h-utilization') === null) {
    if (res.status === 401) throw new TokenExpired('token expired');
    throw new Error(`HTTP ${res.status}`);
  }
  const pct = (k) => Math.round(parseFloat(h(k) ?? '0') * 100);
  const at = (k) => (h(k) ? parseInt(h(k), 10) * 1000 : null);
  return { u5: pct('5h-utilization'), u7: pct('7d-utilization'), r5: at('5h-reset'), r7: at('7d-reset'), at: Date.now() };
}

function fmtIn(ms) {
  if (ms == null) return '?';
  const s = Math.max(0, (ms - Date.now()) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
}

const fmtClock = (ms) => (ms == null ? '?' : new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }));


// Old numbers stay true for an unused account, except that a window whose reset time has
// passed is empty again.
function project(u) {
  const now = Date.now();
  const p = { ...u };
  if (p.r5 && p.r5 <= now) { p.u5 = 0; p.r5 = null; }
  if (p.r7 && p.r7 <= now) { p.u7 = 0; p.r7 = null; }
  return p;
}

// Short status-bar suffix: the number that matters now.
function limitsText(u) {
  if (u.u5 >= 100) return `$(circle-slash) ${fmtIn(u.r5)}`;
  if (u.u7 >= 100) return `$(circle-slash) ${fmtIn(u.r7)}`;
  let s = `${u.u5}%`;
  if (u.u7 >= 50 && u.u7 > u.u5) s += ` · 7d ${u.u7}%`;
  else if (u.u5 >= 50) s += ` ↻${fmtIn(u.r5)}`;
  return s;
}

function limitsTable(u) {
  return '| limit | used | resets |\n|---|---:|---|\n' +
    `| 5 hours | ${u.u5}% | in ${fmtIn(u.r5)} (${fmtClock(u.r5)}) |\n` +
    `| 7 days | ${u.u7}% | in ${fmtIn(u.r7)} (${fmtClock(u.r7)}) |`;
}

class TokenExpired extends Error {}

module.exports = { fetchLimits, limitsText, limitsTable, fmtClock, project, LoggedOut, TokenExpired };
