'use strict';
// Finds artifacts published from local files by reading Claude Code's session logs (the Artifact
// tool call and its result), so they can be previewed locally whichever account published them.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TailReader, listJsonl } = require('./usage');

// Cheap pre-filter: only lines that can hold an Artifact call or its result are parsed.
const mayMatter = (line) => line.includes('rtifact');

const artifactId = (url) => (String(url).match(/\/artifact\/([A-Za-z0-9-]+)/) || [])[1];

// Folder to serve and the entry file, by the rules of the publish call: `root` if given,
// otherwise the file's folder, or its parent when that folder is `project/` (Artifact types).
function resolveRoot(input, cwd, resultPath) {
  const base = cwd || process.cwd();
  const file = input.file_path || resultPath;
  const absFile = file ? path.resolve(base, file) : '';
  let root;
  if (input.root) root = path.resolve(base, input.root);
  else if (absFile) {
    const dir = path.dirname(absFile);
    root = path.basename(dir).toLowerCase() === 'project' ? path.dirname(dir) : dir;
  } else return null;
  let entry = '';
  if (absFile) {
    entry = path.relative(root, absFile).split(path.sep).join('/');
    if (entry.startsWith('..')) entry = path.basename(absFile);
  }
  return { root, entry };
}

// Keeps the open Artifact calls of one log file between reads: the call and its result are on
// different lines and can arrive in different reads.
class LogParser {
  constructor() { this.pending = new Map(); }

  // Returns the artifact records completed by this log entry.
  feed(o, account) {
    const out = [];
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.name === 'Artifact') {
        this.pending.set(b.id, { input: b.input || {}, cwd: o.cwd });
      } else if (b.type === 'tool_result' && this.pending.has(b.tool_use_id)) {
        const call = this.pending.get(b.tool_use_id);
        this.pending.delete(b.tool_use_id);
        const r = o.toolUseResult;
        if (b.is_error || !r || typeof r !== 'object' || !r.url) continue; // refused or failed
        const { input } = call;
        if (input.action && input.action !== 'publish') continue;
        if (input.asset) continue;
        const id = artifactId(r.url);
        const where = resolveRoot(input, call.cwd, r.path);
        if (!id || !where) continue; // e.g. created from a type with no files yet
        out.push({
          id, url: r.url, title: r.title || input.title || '', ...where,
          cwd: call.cwd || '', account, updatedAt: o.timestamp || new Date().toISOString(),
        });
      }
    }
    return out;
  }
}

// Reads the logs of several account folders: once in full (recent files), then only appended lines.
class ArtifactScanner {
  constructor(sources) {
    this.sources = sources; // () => [{ dir: projects folder, account: name }]
    this.tail = new TailReader(64 * 1024 * 1024);
    this.parsers = new Map();
    this.lastPoll = 0;
  }

  parser(file) {
    let p = this.parsers.get(file);
    if (!p) this.parsers.set(file, (p = new LogParser()));
    return p;
  }

  // Full read of logs modified in the last `days` days.
  async init(days = 30) {
    const found = [];
    const now = Date.now();
    for (const { dir, account } of this.sources()) {
      for (const file of await listJsonl(dir, now - days * 864e5)) {
        let size;
        try { size = (await fs.promises.stat(file)).size; } catch { continue; }
        const stream = fs.createReadStream(file, { encoding: 'utf8', end: Math.max(0, size - 1) });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            if (!mayMatter(line)) continue;
            let o;
            try { o = JSON.parse(line); } catch { continue; }
            found.push(...this.parser(file).feed(o, account));
          }
        } catch { /* removed while reading */ } finally { stream.destroy(); }
        this.tail.offsets.set(file, size);
      }
    }
    this.lastPoll = now;
    return found;
  }

  // Lines appended since the last call, in files touched since then.
  async poll() {
    const found = [];
    const since = this.lastPoll - 60e3;
    this.lastPoll = Date.now();
    for (const { dir, account } of this.sources()) {
      for (const file of await listJsonl(dir, since)) {
        if (!this.tail.offsets.has(file)) this.tail.offsets.set(file, 0); // new session file
        for (const o of await this.tail.readNew(file, mayMatter)) found.push(...this.parser(file).feed(o, account));
      }
    }
    return found;
  }
}

// Registry shared by all VS Code windows: { items: [...] }, newest first, by artifact id.
function readRegistry(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

function addToRegistry(file, records, max = 200) {
  if (!records.length) return readRegistry(file);
  const byId = new Map(readRegistry(file).map((i) => [i.id, i]));
  for (const r of records) {
    const prev = byId.get(r.id);
    if (!prev || String(r.updatedAt) >= String(prev.updatedAt)) byId.set(r.id, { ...prev, ...r, title: r.title || prev?.title || '' });
  }
  const items = [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, max);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }));
  fs.renameSync(tmp, file);
  return items;
}

module.exports = { LogParser, ArtifactScanner, resolveRoot, artifactId, readRegistry, addToRegistry };
