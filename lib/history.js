'use strict';
// Long-term token history: daily totals per model, kept in a small JSON file so the numbers
// survive Claude Code deleting old session logs. Plus an estimate of what it would cost on the API.
const fs = require('fs');
const path = require('path');
const { summarizeUsage, dayKey, emptyTotals } = require('./usage');

// API list prices in $ per million tokens (input, output, cache read). A cache write
// (5-minute) costs 1.25× input. First match by model id prefix wins.
const PRICES = [
  ['claude-fable-5', 10, 50, 0.25],
  ['claude-mythos-5', 10, 50, 0.25],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4', 1, 5, 0.1],
  ['claude-3-5-haiku', 0.8, 4, 0.08],
];

// null when the model has no known price (e.g. "<synthetic>" entries).
function costOf(model, t) {
  const p = PRICES.find(([prefix]) => String(model).startsWith(prefix));
  if (!p) return null;
  const [, input, output, cacheRead] = p;
  return (t.input * input + t.cacheWrite * input * 1.25 + t.output * output + t.cacheRead * cacheRead) / 1e6;
}

function readHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Scans the logs and folds the result into the history file. The first scan of a folder reads
// all its logs; later ones re-read only the last 8 days (whole days, so they replace stored ones).
async function updateHistory(file, projectsDir, now = Date.now()) {
  const known = !!readHistory(file)[projectsDir];
  const start = new Date(now - 8 * 864e5);
  start.setHours(0, 0, 0, 0);
  const usage = await summarizeUsage(projectsDir, now, known ? start.getTime() : 0);
  // Re-read right before writing: another window may have written in the meantime.
  const all = readHistory(file);
  const days = { ...(all[projectsDir] || {}), ...usage.days };
  all[projectsDir] = days;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all));
  } catch { /* history is a bonus; keep going without it */ }
  return { ...usage, days };
}

// Totals and cost over days >= fromDay (YYYY-MM-DD, or '' for everything).
function sumDays(days, fromDay = '') {
  const t = emptyTotals();
  let cost = 0, unpriced = false;
  for (const [day, models] of Object.entries(days || {})) {
    if (day < fromDay) continue;
    for (const [model, m] of Object.entries(models)) {
      for (const k of Object.keys(t)) t[k] += m[k] || 0;
      const c = costOf(model, m);
      if (c == null) unpriced = unpriced || m.input + m.output > 0;
      else cost += c;
    }
  }
  return { totals: t, cost, unpriced };
}

const firstDay = (days) => Object.keys(days || {}).sort()[0];
const daysAgo = (n, now = Date.now()) => dayKey(now - n * 864e5);

module.exports = { costOf, updateHistory, sumDays, firstDay, daysAgo };
