'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { normalizeRemote, matchRule } = require('./lib/rules');
const { readIdentity, identityFiles, mtimeKey } = require('./lib/identity');
const { encodeProjectDir, isRateLimitEntry, formatTokens, totalTokens, TailReader } = require('./lib/usage');
const { updateHistory, sumDays, firstDay, daysAgo } = require('./lib/history');
const { ArtifactScanner, readRegistry, addToRegistry } = require('./lib/artifacts');
const { createPreviewServer } = require('./lib/preview');
const { fetchLimits, limitsText, limitsTable, fmtClock, project, LoggedOut, TokenExpired } = require('./lib/limits');

const t = (message, ...args) => vscode.l10n.t(message, ...args);

const DEFAULT_ID = '__default__';
const K_ACCOUNTS = 'accounts'; // local: [{ id, dir, mode }]
const K_META = 'accountMeta'; // synced: { [id]: { name, color, icon } }
const K_ENV = 'accountEnv'; // local: { [id]: { NAME: value } } (may hold secrets, never synced)
const K_AVATARS = 'accountAvatars'; // local: { [id]: fileName }
const K_REPO_DEFAULTS = 'repoDefaults'; // synced
const K_LAST_APPLIED = 'lastAppliedRepoDefault';
const K_SELECTED = 'selectedAccount';
const K_PREVIOUS = 'previousAccount';
const K_IMPORT_PROMPTED = 'importPrompted';
const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR; // value VS Code was launched with

const COLORS = ['orange', 'green', 'blue', 'purple', 'pink', 'yellow', 'teal', 'red'];
const ICONS = [
  'account', 'briefcase', 'home', 'organization', 'rocket', 'beaker', 'code', 'terminal',
  'heart', 'star-full', 'flame', 'zap', 'globe', 'coffee', 'mortar-board', 'shield',
];

let ctx;
// Output > Switchboard for Claude Code. Console until activate creates the channel.
let log = { info: console.log, warn: console.warn, error: console.error };
let statusItem;
let currentRepo = null;
const identityCache = new Map(); // id -> { key, data }
let usageCache = null; // { at, accountId, data }
const accountItems = new Map(); // id -> StatusBarItem (one per account, replaces statusItem)
const limitItems = new Map(); // id -> StatusBarItem with the numbers, shown only when they need a background
const limitsCache = new Map(); // id -> { data, error }
let statusLines = [];

// ───────────────────────── utilities ─────────────────────────

const cfg = (k) => vscode.workspace.getConfiguration('claudeAccounts').get(k);
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const homeClaudeDir = () => path.join(os.homedir(), '.claude');
const accountsRoot = () => expandHome(cfg('accountsRoot')) || path.join(os.homedir(), '.claude-accounts');
const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const folderPath = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => path.resolve(expandHome(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

function slugify(name) {
  return (
    name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
  );
}

function initials(name) {
  const words = String(name).replace(/[()~/.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

const isCodicon = (icon) => ICONS.includes(icon) || /^[a-z][a-z0-9-]*$/.test(icon || '');
const themeColor = (c) => (c && COLORS.includes(c) ? new vscode.ThemeColor(`claudeAccounts.${c}`) : undefined);

// ───────────────────────── accounts & metadata ─────────────────────────

const getMeta = () => ctx.globalState.get(K_META, {});
const getEnvMap = () => ctx.globalState.get(K_ENV, {});
const getAvatars = () => ctx.globalState.get(K_AVATARS, {});

async function updateMeta(id, patch) {
  const meta = { ...getMeta() };
  meta[id] = { ...(meta[id] || {}), ...patch };
  for (const k of Object.keys(meta[id])) if (meta[id][k] === undefined) delete meta[id][k];
  await ctx.globalState.update(K_META, meta);
}

function decorate(rec) {
  const m = getMeta()[rec.id] || {};
  return {
    ...rec,
    name: m.name || rec.name || rec.id,
    color: m.color,
    icon: m.icon,
    env: getEnvMap()[rec.id] || {},
    avatar: getAvatars()[rec.id],
  };
}

function defaultAccount() {
  return decorate({ id: DEFAULT_ID, name: t('Default (~/.claude)'), dir: null, mode: 'original' });
}
const getRecords = () => ctx.globalState.get(K_ACCOUNTS, []);
const saveRecords = (list) => ctx.globalState.update(K_ACCOUNTS, list.map(({ id, dir, mode }) => ({ id, dir, mode })));
const getAccounts = () => getRecords().map(decorate);
const allAccounts = () => [defaultAccount(), ...getAccounts()];
const findAccount = (id) => allAccounts().find((a) => a.id === id);
const getRepoDefaults = () => ctx.globalState.get(K_REPO_DEFAULTS, {});
const saveRepoDefaults = (m) => ctx.globalState.update(K_REPO_DEFAULTS, m);

// 1.0 kept the name inside the local record; 1.1 keeps it in synced metadata.
async function migrate() {
  const recs = getRecords();
  if (!recs.some((r) => r.name)) return;
  const meta = { ...getMeta() };
  for (const r of recs) if (r.name && !meta[r.id]?.name) meta[r.id] = { ...(meta[r.id] || {}), name: r.name };
  await ctx.globalState.update(K_META, meta);
  await saveRecords(recs);
}

function findAccountByRef(ref) {
  if (!ref) return null;
  const s = String(ref).toLowerCase();
  return allAccounts().find((a) => a.id.toLowerCase() === s) || allAccounts().find((a) => a.name.toLowerCase() === s) || null;
}

function modeLabel(m) {
  if (m === 'shared') return t('shared profile');
  if (m === 'isolated') return t('isolated profile');
  if (m === 'original') return t('original');
  return '?';
}

const configDirOf = (a) => a.dir || ORIGINAL_ENV || homeClaudeDir();

// Where the selection is remembered: per workspace (each window/repo) or globally.
const store = () => (cfg('scope') === 'user' ? ctx.globalState : ctx.workspaceState);
const selectedAccount = () => findAccount(store().get(K_SELECTED)) || defaultAccount();

// CLAUDE_CONFIG_DIR in claudeCode.environmentVariables (User settings) takes precedence
// over the process environment and would defeat switching.
function overridingSetting() {
  const list = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables');
  if (!Array.isArray(list)) return null;
  const e = list.find((v) => v && v.name === 'CLAUDE_CONFIG_DIR');
  return e && e.value ? e.value : null;
}

// ───────────────────────── applying an account ─────────────────────────

const touchedEnv = new Map(); // variable -> value before this extension changed it

function setProcessEnv(name, value) {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  if (value === undefined) {
    const orig = touchedEnv.get(name);
    if (orig === undefined) delete process.env[name];
    else process.env[name] = orig;
  } else {
    process.env[name] = value;
  }
}

function desiredEnv(account) {
  const env = { ...(account.env || {}) };
  delete env.CLAUDE_CONFIG_DIR;
  if (account.dir) env.CLAUDE_CONFIG_DIR = account.dir;
  return env;
}

function applyEnv(account) {
  // The window's extension host: the Claude Code extension inherits this environment
  // when it starts the CLI. Every VS Code window has its own extension host.
  const env = desiredEnv(account);
  for (const name of touchedEnv.keys()) if (!(name in env)) setProcessEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) setProcessEnv(name, value);

  // Integrated terminals of this window.
  const coll = ctx.environmentVariableCollection;
  coll.persistent = false;
  coll.clear();
  if (cfg('applyToTerminal')) {
    for (const [name, value] of Object.entries(env)) coll.replace(name, value);
    coll.description = t('Claude Code account: {0}', account.name);
  }
  // Only CLAUDE_CONFIG_DIR's value; other variables may hold secrets.
  const others = Object.keys(env).filter((n) => n !== 'CLAUDE_CONFIG_DIR');
  log.info(`Applied ${account.name}: CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? '(unset, Claude Code uses ~/.claude)'}${!env.CLAUDE_CONFIG_DIR && ORIGINAL_ENV ? ' (inherited from how VS Code was started)' : ''}`
    + (others.length ? `, also ${others.join(', ')}` : '') + (cfg('applyToTerminal') ? ', terminals too' : ', not in terminals'));
}

async function selectAccount(account, reason, { reload = true } = {}) {
  const prev = selectedAccount();
  if (prev.id !== account.id) await store().update(K_PREVIOUS, prev.id);
  await store().update(K_SELECTED, account.id);
  applyEnv(account);
  log.info(`Switched ${prev.name} → ${account.name}` + (reason ? ` (${reason})` : '') + ` · reload: ${reload ? cfg('reloadBehavior') : 'offered'}`);
  updateStatus();
  const msg = reason
    ? t('Claude Code account: {0} ({1}).', account.name, reason)
    : t('Claude Code account: {0}.', account.name);
  if (reload) return maybeReload(msg);
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(
    t('{0} If the Claude Code panel was already open, reload the window.', msg), reloadBtn);
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function maybeReload(msg) {
  const b = cfg('reloadBehavior');
  if (b === 'always') return vscode.commands.executeCommand('workbench.action.reloadWindow');
  if (b === 'never') {
    vscode.window.showInformationMessage(t('{0} Reload the window for Claude Code to use the new account.', msg));
    return;
  }
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(t('{0} Reload the window now?', msg), reloadBtn, t('Later'));
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function checkOverridingSetting() {
  const dir = overridingSetting();
  if (!dir) return;
  const removeBtn = t('Remove that entry');
  const pick = await vscode.window.showWarningMessage(
    t('Your user settings set CLAUDE_CONFIG_DIR={0} in claudeCode.environmentVariables. It takes precedence and makes every window use that folder, ignoring account switching.', dir),
    removeBtn,
    t('Ignore')
  );
  if (pick !== removeBtn) return;
  const c = vscode.workspace.getConfiguration('claudeCode');
  const list = (c.inspect('environmentVariables')?.globalValue || []).filter((v) => v && v.name !== 'CLAUDE_CONFIG_DIR');
  await c.update('environmentVariables', list.length ? list : undefined, vscode.ConfigurationTarget.Global);
  updateStatus();
  await maybeReload(t('Entry removed.'));
}

// ───────────────────────── shared items (links) ─────────────────────────

const historyItems = () => (cfg('shareHistory') ? cfg('historyItems') || [] : []);
// Config items for shared-profile mode (history is handled separately).
const configItems = () => (cfg('sharedItems') || []).filter((i) => !(cfg('historyItems') || []).includes(i));

function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p); // Windows junctions; removes only the link, never the target
  }
}

function isLinkedTo(d, s) {
  try {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink()) return samePath(fs.realpathSync(d), fs.realpathSync(s));
    if (st.isFile()) {
      const a = fs.statSync(d, { bigint: true });
      const b = fs.statSync(s, { bigint: true });
      return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev; // hard link
    }
  } catch {
    /* does not exist */
  }
  return false;
}

function moveFs(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// Moves the account's content (from) into ~/.claude (to), merging without overwriting.
function mergeInto(from, to, tag, out) {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) { removeLink(from); return; }
  if (st.isDirectory()) {
    if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); moveFs(from, to); out.merged++; return; }
    for (const e of fs.readdirSync(from)) mergeInto(path.join(from, e), path.join(to, e), tag, out);
    fs.rmSync(from, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); moveFs(from, to); out.merged++; return; }
  const extra = fs.readFileSync(from);
  const existing = fs.readFileSync(to);
  if (extra.equals(existing)) { fs.unlinkSync(from); return; }
  if (to.endsWith('.jsonl')) {
    // Line logs (sessions, prompt history): append what is missing.
    const have = new Set(existing.toString('utf8').split('\n'));
    const add = extra.toString('utf8').split('\n').filter((l) => l && !have.has(l));
    if (add.length) {
      const sep = existing.length && existing[existing.length - 1] !== 0x0a ? '\n' : '';
      fs.appendFileSync(to, sep + add.join('\n') + '\n');
    }
    fs.unlinkSync(from);
    out.merged++;
    return;
  }
  const conflict = `${to}.conflict-${tag}`;
  moveFs(from, conflict);
  out.conflicts.push(path.basename(conflict));
}

function linkItems(dir, items, { replaceLocal = false, merge = false, tag = 'account' } = {}) {
  const src = homeClaudeDir();
  const out = { linked: [], copied: [], skipped: [], backedUp: [], merged: 0, conflicts: [] };
  for (const item of items) {
    const s = path.join(src, item);
    const d = path.join(dir, item);
    if (isLinkedTo(d, s)) { out.linked.push(item); continue; }

    let st = null;
    try { st = fs.lstatSync(d); } catch { /* does not exist */ }
    if (st && st.isSymbolicLink()) { removeLink(d); st = null; }

    if (!fs.existsSync(s)) {
      if (!merge) { out.skipped.push(t('{0} (not present in ~/.claude)', item)); continue; }
      fs.mkdirSync(src, { recursive: true });
      if (st) { moveFs(d, s); st = null; out.merged++; }
      else if (path.extname(item)) fs.writeFileSync(s, '');
      else fs.mkdirSync(s, { recursive: true });
    }

    if (st) {
      if (merge) mergeInto(d, s, tag, out);
      else if (replaceLocal) { const bak = `${d}.bak-${timestamp()}`; fs.renameSync(d, bak); out.backedUp.push(path.basename(bak)); }
      else { out.skipped.push(t('{0} (this account already has its own version)', item)); continue; }
    }

    const isDir = fs.statSync(s).isDirectory();
    try {
      fs.symlinkSync(s, d, isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      out.linked.push(item);
    } catch (e) {
      if (isDir) { out.skipped.push(`${item} (${e.code || e.message})`); continue; }
      try { fs.linkSync(s, d); out.linked.push(item); } // Windows without symlink permission
      catch {
        if (merge) { out.skipped.push(t('{0} (could not create link)', item)); continue; }
        fs.copyFileSync(s, d); out.copied.push(item);
      }
    }
  }
  return out;
}

const linkSharedItems = (dir, opts) => linkItems(dir, configItems(), opts);
const linkHistory = (dir, tag) => linkItems(dir, historyItems(), { merge: true, tag });

// Undoes links. copy=true creates independent copies; copy=false leaves the account empty.
function unlinkItems(dir, items, { copy = true } = {}) {
  const src = homeClaudeDir();
  const done = [];
  for (const item of items) {
    const s = path.join(src, item);
    const d = path.join(dir, item);
    if (!isLinkedTo(d, s)) continue;
    if (fs.lstatSync(d).isSymbolicLink()) removeLink(d); else fs.unlinkSync(d);
    if (copy) fs.cpSync(s, d, { recursive: true });
    done.push(item);
  }
  return done;
}
const unlinkSharedItems = (dir) => unlinkItems(dir, configItems());

function brokenShares(account) {
  if (!account || !account.dir) return [];
  const src = homeClaudeDir();
  const cfgBroken = account.mode === 'shared'
    ? configItems().filter((i) => fs.existsSync(path.join(src, i)) && !isLinkedTo(path.join(account.dir, i), path.join(src, i)))
    : [];
  const histBroken = historyItems().filter((i) => !isLinkedTo(path.join(account.dir, i), path.join(src, i)));
  return [...cfgBroken, ...histBroken];
}

function removeAccountDir(dir) {
  // Remove links before deleting so ~/.claude is never followed into.
  if (!fs.existsSync(dir) || samePath(dir, homeClaudeDir()) || samePath(dir, os.homedir()) || path.dirname(path.resolve(dir)) === path.resolve(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    try { if (fs.lstatSync(p).isSymbolicLink()) removeLink(p); } catch { /* ignore */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function describe(r) {
  const parts = [];
  if (r.linked.length) parts.push(t('Shared: {0}.', r.linked.join(', ')));
  if (r.copied.length) parts.push(t('Copied (no link possible, will not sync): {0}.', r.copied.join(', ')));
  if (r.backedUp.length) parts.push(t('Backups: {0}.', r.backedUp.join(', ')));
  if (r.merged) parts.push(t('History items merged: {0}.', r.merged));
  if (r.conflicts.length) parts.push(t('Conflicts kept next to the original: {0}.', r.conflicts.join(', ')));
  if (r.skipped.length) parts.push(t('Skipped: {0}.', r.skipped.join('; ')));
  return parts.length ? ' ' + parts.join(' ') : '';
}

// ───────────────────────── repository & rules ─────────────────────────

async function detectRepo() {
  const folder = folderPath();
  if (!folder) return null;
  const [remote, root] = await Promise.all([
    git(['config', '--get', 'remote.origin.url'], folder),
    git(['rev-parse', '--show-toplevel'], folder),
  ]);
  const rootPath = root ? path.resolve(root) : null;
  const base = { folder, remote: remote || null, root: rootPath };
  if (remote) return { ...base, key: 'remote:' + normalizeRemote(remote), label: remote };
  const p = rootPath || folder;
  return { ...base, key: 'path:' + (process.platform === 'win32' ? p.toLowerCase() : p), label: p };
}

// Explicit repository default wins; otherwise the first matching rule.
function resolveDefault() {
  if (!currentRepo) return null;
  const id = getRepoDefaults()[currentRepo.key];
  const repoAcc = id && findAccount(id);
  if (repoAcc) return { account: repoAcc, source: 'repo' };
  const rule = matchRule(cfg('rules'), {
    folder: currentRepo.folder,
    remote: currentRepo.remote,
    home: os.homedir(),
    platform: process.platform,
  });
  const ruleAcc = rule && findAccountByRef(rule.account);
  return ruleAcc ? { account: ruleAcc, source: 'rule', pattern: rule.pattern } : null;
}

// One block in the log with everything that decides which account Claude Code ends up using.
function logDiagnostics(claudeWasActive) {
  const cur = selectedAccount();
  const id = identityOf(cur);
  const cc = vscode.extensions.getExtension('anthropic.claude-code');
  const lines = [
    `VS Code ${vscode.version}, ${process.platform}; Claude Code extension ${cc ? cc.packageJSON.version : 'NOT INSTALLED'}`
      + (claudeWasActive ? ' (was running before Switchboard: it keeps the previous account until a reload)' : ''),
    `Settings: scope=${cfg('scope')}, reloadBehavior=${cfg('reloadBehavior')}, applyToTerminal=${cfg('applyToTerminal')}, shareHistory=${cfg('shareHistory')}, autoApplyRepoDefault=${cfg('autoApplyRepoDefault')}`,
    `CLAUDE_CONFIG_DIR when VS Code started: ${ORIGINAL_ENV || '(unset)'}`,
    'Accounts: ' + allAccounts().map((a) => `${a.name} [${a.mode || 'original'}] ${configDirOf(a)}${fs.existsSync(configDirOf(a)) ? '' : ' (FOLDER MISSING)'}`).join('; '),
    `Selected in this window: ${cur.name}, ${configDirOf(cur)}, ${id ? (id.loggedIn ? 'logged in' + (id.email ? ' as ' + id.email : '') : 'NOT LOGGED IN') : 'login unknown'}`,
  ];
  const over = overridingSetting();
  if (over) lines.push(`PROBLEM: claudeCode.environmentVariables sets CLAUDE_CONFIG_DIR=${over}, which overrides switching`);
  const d = resolveDefault();
  if (d) lines.push(`Default for this folder: ${d.account.name} (${d.source === 'rule' ? 'rule ' + d.pattern : 'repository'})`);
  log.info('Diagnostics:\n  ' + lines.join('\n  '));
}

async function autoApply() {
  if (!cfg('autoApplyRepoDefault')) return;
  const d = resolveDefault();
  if (!d) return;
  // Only applies when the resolved default changes; manual switches in this window are respected.
  if (ctx.workspaceState.get(K_LAST_APPLIED) === d.account.id) {
    log.info(`Default ${d.account.name} (${d.source === 'rule' ? 'rule ' + d.pattern : 'repository'}) was already applied here once; keeping ${selectedAccount().name}`);
    return;
  }
  await ctx.workspaceState.update(K_LAST_APPLIED, d.account.id);
  if (selectedAccount().id === d.account.id) return;
  const reason = d.source === 'rule' ? t('rule {0}', d.pattern) : t('repository default');
  await selectAccount(d.account, reason, { reload: false });
}

// ───────────────────────── identity (plan, e-mail) ─────────────────────────

function identityArgs(a) {
  const dir = configDirOf(a);
  const legacy = a.id === DEFAULT_ID && !ORIGINAL_ENV ? path.join(os.homedir(), '.claude.json') : undefined;
  return { dir, legacy };
}

async function refreshIdentity(a) {
  const { dir, legacy } = identityArgs(a);
  const key = await mtimeKey(identityFiles(dir, legacy));
  const cached = identityCache.get(a.id);
  if (cached && cached.key === key) return cached.data;
  const data = await readIdentity(dir, { legacyJsonPath: legacy });
  identityCache.set(a.id, { key, data });
  return data;
}

async function refreshAllIdentities() {
  await Promise.all(allAccounts().map((a) => refreshIdentity(a).catch(() => null)));
  if (cfg('gravatar')) await Promise.all(allAccounts().map((a) => ensureGravatar(a).catch(() => null)));
  updateStatus();
}

const identityOf = (a) => identityCache.get(a.id)?.data || null;

function identityLine(a) {
  const id = identityOf(a);
  if (!id) return '';
  if (!id.loggedIn) return t('not logged in');
  // A personal plan's organization is just "<email>'s Organization": noise.
  const org = id.organization && id.organization !== `${id.email}'s Organization` ? id.organization : null;
  return [id.email, cfg('showPlan') ? id.plan : null, org].filter(Boolean).join(' · ');
}

// ───────────────────────── avatars ─────────────────────────

const storageDir = (...p) => path.join(ctx.globalStorageUri.fsPath, ...p);

function avatarUri(a) {
  if (a.avatar) {
    const p = storageDir('avatars', a.avatar);
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  if (cfg('gravatar')) {
    const email = identityOf(a)?.email;
    if (email) {
      const p = storageDir('gravatar', gravatarHash(email) + '.png');
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return vscode.Uri.file(p);
    }
  }
  return undefined;
}

const gravatarHash = (email) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

// Opt-in only: the single network request this extension can make.
async function ensureGravatar(a) {
  const email = identityOf(a)?.email;
  if (!email) return;
  const file = storageDir('gravatar', gravatarHash(email) + '.png');
  try {
    const st = fs.statSync(file);
    const maxAge = st.size > 0 ? 7 * 864e5 : 864e5; // empty file = "no gravatar", retry daily
    if (Date.now() - st.mtimeMs < maxAge) return;
  } catch { /* not cached */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const url = `https://www.gravatar.com/avatar/${gravatarHash(email)}?s=64&d=404`;
  const buf = await new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(Buffer.alloc(0)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
  if (buf) fs.writeFileSync(file, buf);
}

// ───────────────────────── usage & limits ─────────────────────────

const projectsDirOf = (a) => path.join(configDirOf(a), 'projects');

const historyFile = () => path.join(ctx.globalStorageUri.fsPath, 'usage-history.json');

async function computeUsage(a) {
  return updateHistory(historyFile(), projectsDirOf(a));
}

async function refreshCurrentUsage() {
  const a = selectedAccount();
  try {
    usageCache = { at: Date.now(), accountId: a.id, data: await computeUsage(a) };
    updateStatus();
  } catch { /* best effort */ }
}

// ───────────────────────── local artifact preview ─────────────────────────
// A claude.ai artifact opens only in a browser logged into the account that published it.
// The window that gets the port serves every account's artifacts on 127.0.0.1, found in the logs.

let preview = null; // { srv, scanner, startedAt, owner, ready, polling, timer, portBlocked }
const artifactsFile = () => path.join(ctx.globalStorageUri.fsPath, 'artifacts.json');
const previewPort = () => cfg('artifactPreviewPort') || 4999;
const previewUrl = (id) => `http://127.0.0.1:${previewPort()}/` + (id ? `a/${encodeURIComponent(id)}/` : '');

function artifactSources() {
  const seen = new Set();
  const out = [];
  for (const a of allAccounts()) {
    let dir;
    try { dir = fs.realpathSync(projectsDirOf(a)); } catch { continue; }
    if (seen.has(dir)) continue; // shared history: one folder for all accounts
    seen.add(dir);
    out.push({ dir, account: cfg('shareHistory') ? '' : a.name });
  }
  return out;
}

async function openArtifact(id) {
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(previewUrl(id)));
  return vscode.env.openExternal(uri);
}

function recordArtifacts(records, notify) {
  if (!records.length) return;
  const before = new Set(readRegistry(artifactsFile()).map((i) => i.id));
  try { addToRegistry(artifactsFile(), records); } catch (e) { log.error('Artifact registry:', e); return; }
  for (const r of new Map(records.map((x) => [x.id, x])).values()) {
    if (before.has(r.id)) continue; // republishes update the preview live, no new toast
    log.info(`Artifact found: ${r.title || r.id} (${r.account || 'shared history'}) → ${previewUrl(r.id)}, folder ${r.root}`);
    // Toast only for what is published now, not for old sessions read for the first time.
    if (!notify || !(Date.parse(r.updatedAt) >= (preview?.startedAt ?? Infinity))) continue;
    if (cfg('artifactPreviewAutoOpen')) {
      openArtifact(r.id);
      continue;
    }
    const open = t('Open locally');
    vscode.window.showInformationMessage(t('Artifact published: {0}', r.title || r.id), open)
      .then((b) => b === open && openArtifact(r.id));
  }
}

// One poll at a time: the timer and a request for an unknown id would read the same lines twice.
function pollArtifacts() {
  const p = preview;
  if (!p?.ready) return Promise.resolve();
  if (!p.polling) {
    p.polling = p.scanner.poll()
      .then((found) => recordArtifacts(found, true))
      .catch((e) => log.error('Artifact preview:', e))
      .finally(() => { p.polling = null; });
  }
  return p.polling;
}

async function findArtifact(id) {
  const hit = () => readRegistry(artifactsFile()).find((i) => i.id === id);
  if (hit()) return hit();
  await preview?.initDone; // first scan still running
  if (hit()) return hit();
  await pollArtifacts(); // published a moment ago
  return hit();
}

async function startPreview() {
  if (preview || !cfg('artifactPreview')) return;
  const health = `switchboard ${ctx.extension.packageJSON.version}`;
  const srv = createPreviewServer({ port: previewPort(), health, listItems: () => readRegistry(artifactsFile()), findItem: findArtifact });
  const p = (preview = {
    srv, scanner: new ArtifactScanner(artifactSources), startedAt: Date.now(),
    owner: false, ready: false, polling: null, timer: null, portBlocked: false,
  });
  const tryOwn = async () => {
    const r = await srv.listen().catch(() => 'error');
    if (r === 'listening') {
      p.owner = true;
      // First run: look further back so links shared before the install work too.
      const days = fs.existsSync(artifactsFile()) ? 7 : 30;
      p.initDone = p.scanner.init(days);
      const found = await p.initDone;
      recordArtifacts(found, false);
      p.ready = true;
      log.info(`Artifact preview serving on ${previewUrl()} (${found.length} publishes in the last ${days} days of logs)`);
      return;
    }
    if (p.portBlocked) return;
    // Another window serving is fine; anything else holds the port. Logged here, shown when the list is opened.
    const h = await fetch(`http://127.0.0.1:${previewPort()}/health`).then((x) => x.text()).catch(() => '');
    if (!h.startsWith('switchboard')) {
      p.portBlocked = true;
      log.warn(`Artifact preview: port ${previewPort()} is held by another program (health: ${JSON.stringify(h.slice(0, 40))})`);
    }
  };
  let busy = false;
  p.timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { p.owner ? await pollArtifacts() : await tryOwn(); } catch (e) { log.error('Artifact preview:', e); } finally { busy = false; }
  }, 5000);
  busy = true;
  await tryOwn().catch((e) => log.error('Artifact preview:', e)).finally(() => { busy = false; });
}

async function stopPreview() {
  const p = preview;
  preview = null;
  if (!p) return;
  clearInterval(p.timer);
  if (p.owner) await p.srv.close();
}

async function cmdShowArtifacts() {
  if (!cfg('artifactPreview')) {
    const on = t('Turn on');
    const b = await vscode.window.showInformationMessage(t('Local artifact preview is turned off.'), on);
    if (b === on) await vscode.workspace.getConfiguration('claudeAccounts').update('artifactPreview', true, vscode.ConfigurationTarget.Global);
    return;
  }
  if (preview?.portBlocked) {
    vscode.window.showWarningMessage(t('Artifact preview: port {0} is used by another program. Change claudeAccounts.artifactPreviewPort.', previewPort()));
  }
  const items = readRegistry(artifactsFile()).map((i) => ({
    label: i.title || i.id,
    description: [i.account, i.updatedAt && new Date(i.updatedAt).toLocaleString()].filter(Boolean).join(' · '),
    detail: i.root,
    id: i.id,
  }));
  const r = await vscode.window.showQuickPick(
    [{ label: '$(globe) ' + t('All artifacts in the browser'), id: '' }, ...items],
    { placeHolder: t('Artifacts published by Claude Code, previewed locally (no claude.ai login needed)'), matchOnDetail: true });
  if (r) await openArtifact(r.id);
}

let lastLimitPrompt = 0;

async function startLimitWatcher(context) {
  if (!cfg('suggestSwitchOnLimit')) return;
  const folder = folderPath();
  if (!folder) return;
  const account = selectedAccount();
  const configDir = configDirOf(account);
  const encoded = encodeProjectDir(folder);
  const projects = path.join(configDir, 'projects');

  // The file watcher does not follow symlinks, so watch the real projects folder when it exists.
  let base;
  let pattern;
  try {
    base = fs.realpathSync(projects);
    pattern = `${encoded}/**/*.jsonl`;
  } catch {
    if (!fs.existsSync(configDir)) return;
    base = configDir;
    pattern = `projects/${encoded}/**/*.jsonl`;
  }

  const tail = new TailReader();
  const sessionDir = path.join(base, pattern.startsWith('projects/') ? 'projects' : '', encoded);
  try {
    for (const f of fs.readdirSync(sessionDir)) if (f.endsWith('.jsonl')) await tail.prime(path.join(sessionDir, f));
  } catch { /* no sessions yet */ }

  const onFile = async (uri) => {
    const entries = await tail.readNew(uri.fsPath);
    const hit = entries.find((o) => isRateLimitEntry(o) && Date.now() - (Date.parse(o.timestamp) || Date.now()) < 15 * 60e3);
    if (hit) onLimitReached(account).catch(() => null);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
  context.subscriptions.push(watcher, watcher.onDidChange(onFile), watcher.onDidCreate(onFile));
}

async function onLimitReached(account) {
  if (Date.now() - lastLimitPrompt < 20 * 60e3) return; // at most once every 20 minutes
  lastLimitPrompt = Date.now();
  const others = allAccounts().filter((a) => a.id !== account.id && identityOf(a)?.loggedIn !== false);
  if (!others.length) return;
  const buttons = others.slice(0, 2).map((a) => ({ title: t('Switch to {0}', a.name), account: a }));
  if (others.length > 2) buttons.push({ title: t('Choose...') });
  const tip = cfg('shareHistory') ? '' : ' ' + t('Tip: turn on shared history to continue the same conversation in the other account.');
  const pick = await vscode.window.showWarningMessage(t('Account "{0}" hit its usage limit.', account.name) + tip, ...buttons);
  if (!pick) return;
  if (pick.account) return selectAccount(pick.account, t('usage limit reached'));
  return cmdSwitch();
}

// ───────────────────────── UI ─────────────────────────

function iconText(a) {
  if (a.icon && !isCodicon(a.icon)) return a.icon; // emoji
  return `$(${a.icon || 'account'})`;
}

function updateStatus() {
  if (!statusItem) return;
  const cur = selectedAccount();
  const override = overridingSetting();
  const id = identityOf(cur);
  const name = cur.id === DEFAULT_ID && !getMeta()[DEFAULT_ID]?.name ? t('default') : cur.name;
  const style = cfg('statusBarStyle');
  let text = style === 'icon' ? iconText(cur) : style === 'initials' ? `${iconText(cur)} ${initials(name)}` : `${iconText(cur)} Claude: ${name}`;
  if (cfg('showPlan') && id?.plan && style !== 'icon') text += ` · ${id.plan}`;
  statusItem.text = (override ? '$(warning) ' : '') + text;
  statusItem.color = themeColor(cur.color);

  const lines = [t('Account: {0}', cur.name)];
  if (id?.email) lines.push(t('E-mail: {0}', id.email));
  if (id?.plan) lines.push(t('Plan: {0}', id.plan));
  if (id?.organization) lines.push(t('Organization: {0}', id.organization));
  if (id && !id.loggedIn) lines.push(t('Not logged in'));
  lines.push(t('Folder: {0}', configDirOf(cur)), t('Mode: {0}', modeLabel(cur.mode)));
  if (cfg('shareHistory')) lines.push(t('History: shared'));
  const d = resolveDefault();
  if (d?.source === 'repo') lines.push(t('Repository default: {0}', d.account.name));
  if (d?.source === 'rule') lines.push(t('Default by rule {0}: {1}', d.pattern, d.account.name));
  if (usageCache && usageCache.accountId === cur.id) {
    const scope = cfg('shareHistory') ? t('all accounts') : cur.name;
    lines.push(t('Tokens today ({0}): {1}', scope, formatTokens(totalTokens(usageCache.data.today))));
  }
  if (override) lines.push('', t('Warning: claudeCode.environmentVariables in user settings forces {0}', override));
  statusLines = lines;
  statusItem.hide();
  renderAccountItems();
}

// ───────────────────────── per-account items with plan limits ─────────────────────────

function renderAccountItems() {
  const cur = selectedAccount();
  const accounts = allAccounts();
  for (const items of [accountItems, limitItems]) {
    for (const [id, item] of items) {
      if (!accounts.some((a) => a.id === id)) { item.dispose(); items.delete(id); }
    }
  }
  accounts.forEach((a, idx) => {
    let item = accountItems.get(a.id);
    if (!item) {
      item = vscode.window.createStatusBarItem(`claudeAccounts.account.${a.id}`, vscode.StatusBarAlignment.Left, 100 - idx / 100);
      accountItems.set(a.id, item);
    }
    let limitItem = limitItems.get(a.id);
    if (!limitItem) {
      // Just right of the account item.
      limitItem = vscode.window.createStatusBarItem(`claudeAccounts.limits.${a.id}`, vscode.StatusBarAlignment.Left, 100 - idx / 100 - 1e-4);
      limitItems.set(a.id, limitItem);
    }
    const isCur = a.id === cur.id;
    const name = a.id === DEFAULT_ID && !getMeta()[DEFAULT_ID]?.name ? t('default') : a.name;
    const loggedOut = identityOf(a)?.loggedIn === false || limitsCache.get(a.id)?.loggedOut;
    const entry = loggedOut ? {} : limitsCache.get(a.id) || {};
    const { error, stale } = entry;
    const data = cfg('planLimits') && entry.data && project(entry.data);
    item.name = `Claude: ${name}`;
    const icon = isCur ? '$(pass-filled)' : iconText(a);
    const worst = data && !stale ? Math.max(data.u5, data.u7) : 0;
    // A background color overrides the text color, so a warning goes on a separate item
    // with the numbers and the account keeps its own color.
    const warn = worst >= 90 ? 'statusBarItem.errorBackground' : worst >= 75 ? 'statusBarItem.warningBackground' : null;
    item.text = `${icon} ${name}` + (loggedOut ? ` $(sign-in) ${t('log in')}` : warn ? '' : data ? ` ${limitsText(data)}` : !cfg('planLimits') ? '' : error ? ' $(warning)' : ' …');
    // Last known numbers of an unused account: account color dimmed out, no warning.
    item.color = stale && data ? new vscode.ThemeColor('disabledForeground') : themeColor(a.color);
    const md = new vscode.MarkdownString(`**${name}**${isCur ? ' — ' + t('active') : ''}\n\n`, true);
    if (loggedOut) md.appendMarkdown(`$(sign-in) ${t('Logged out. Click to log in.')}\n\n`);
    if (data) md.appendMarkdown(limitsTable(data) + `\n\n${t('checked')} ${fmtClock(data.at)}\n\n`);
    if (stale) {
      md.appendMarkdown(`$(history) ${data
        ? t('Last known numbers: the login renews only while this account is in use. Windows whose reset time passed are shown as 0%.')
        : t('No numbers yet: the login renews only while this account is in use.')}\n\n`);
    } else if (error) {
      md.appendMarkdown(`$(warning) ${error}${data ? ' (' + t('numbers may be stale') + ')' : ''}\n\n`);
    }
    if (isCur) md.appendMarkdown(statusLines.map((l) => l.replace(/([\\`*_[\]<>|])/g, '\\$1')).join('  \n') + '\n\n');
    if (!loggedOut) md.appendMarkdown(isCur ? t('Click for account menu') : t('Click to switch and reload'));
    item.tooltip = md;
    item.command = { command: 'claudeAccounts.clickAccount', title: '', arguments: [a.id] };
    item.show();
    if (warn) {
      limitItem.name = `Claude: ${name} limits`;
      limitItem.text = limitsText(data);
      limitItem.backgroundColor = new vscode.ThemeColor(warn);
      limitItem.tooltip = md;
      limitItem.command = item.command;
      limitItem.show();
    } else {
      limitItem.hide();
    }
  });
}

// Every window polls, so results go through a file shared by all windows: a window that
// finds fresh numbers there uses them instead of sending its own requests.
const LIMITS_TTL = 50e3; // a bit under the 1-minute interval
const limitsFile = () => path.join(ctx.globalStorageUri.fsPath, 'limits.json');

function readSharedLimits() {
  try { return JSON.parse(fs.readFileSync(limitsFile(), 'utf8')); } catch { return {}; }
}

let limitsRunning = false;
async function refreshLimits({ force = false } = {}) {
  if (limitsRunning || !cfg('planLimits')) return;
  limitsRunning = true;
  try {
    const shared = readSharedLimits();
    await Promise.all(allAccounts().map(async (a) => {
      const dir = configDirOf(a);
      const s = shared[dir];
      if (!force && s && Date.now() - s.at < LIMITS_TTL) {
        limitsCache.set(a.id, s.entry);
        return;
      }
      let entry;
      try {
        entry = { data: await fetchLimits(dir) };
      } catch (e) {
        // Logged out: drop the numbers. Expired token (account not in use): keep the last
        // numbers as a quiet "stale". Anything else: keep them, with a warning.
        const prev = limitsCache.get(a.id)?.data || s?.entry?.data;
        entry = e instanceof LoggedOut ? { loggedOut: true }
          : e instanceof TokenExpired ? { data: prev, stale: true }
          : { data: prev, error: e.message || String(e) };
        // Logged once per new error, not every minute while it lasts (e.g. offline).
        if (entry.error && entry.error !== limitsCache.get(a.id)?.error) log.warn(`Limits for ${a.name}: ${entry.error}`);
      }
      limitsCache.set(a.id, entry);
      shared[dir] = { at: Date.now(), entry };
    }));
    fs.mkdirSync(path.dirname(limitsFile()), { recursive: true });
    fs.writeFileSync(limitsFile(), JSON.stringify(shared));
  } catch (e) {
    log.error('Limits refresh failed:', e);
  } finally {
    limitsRunning = false;
  }
  renderAccountItems();
}

async function cmdClickAccount(id) {
  const a = findAccount(id);
  if (!a) return cmdSwitch();
  if (identityOf(a)?.loggedIn === false) return loginTerminal(a);
  if (a.id === selectedAccount().id) return cmdSwitch();
  await selectAccount(a);
}

// Removing an account and the rarer actions live in "Manage accounts...".
function accountButtons(a) {
  if (identityOf(a)?.loggedIn === false) {
    return [{ iconPath: new vscode.ThemeIcon('sign-in'), tooltip: t('Log in'), action: 'login' }];
  }
  return [
    { iconPath: new vscode.ThemeIcon('edit'), tooltip: t('Rename'), action: 'rename' },
    { iconPath: new vscode.ThemeIcon('symbol-color'), tooltip: t('Appearance'), action: 'appearance' },
    { iconPath: new vscode.ThemeIcon('sign-out'), tooltip: t('Log out'), action: 'logout' },
  ];
}

function limitsLine(a) {
  if (identityOf(a)?.loggedIn === false) return t('logged out');
  const e = limitsCache.get(a.id);
  if (!e?.data) return '';
  const u = project(e.data);
  return `5h ${u.u5}% · 7d ${u.u7}%` + (e.stale ? ` (${t('last known')})` : '');
}

function accountItem(a, { markCurrent = true, buttons = true } = {}) {
  const cur = selectedAccount();
  const d = resolveDefault();
  const emoji = a.icon && !isCodicon(a.icon) ? a.icon + ' ' : '';
  const desc = [limitsLine(a)];
  if (d && d.account.id === a.id) desc.push(d.source === 'rule' ? t('default by rule') : t('repository default'));
  return {
    label: `${markCurrent && a.id === cur.id ? '$(check) ' : ''}${emoji}${a.name}`,
    description: desc.filter(Boolean).join(' · '),
    detail: identityLine(a) || configDirOf(a),
    iconPath: avatarUri(a) || (emoji ? undefined : new vscode.ThemeIcon(a.icon || 'account', themeColor(a.color))),
    buttons: buttons ? accountButtons(a) : undefined,
    account: a,
  };
}

// Quick pick with per-item buttons. Resolves to { item, button } or undefined.
function pick(items, placeHolder) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = placeHolder;
    qp.matchOnDetail = true;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); qp.hide(); } };
    qp.onDidAccept(() => finish(qp.selectedItems[0] ? { item: qp.selectedItems[0] } : undefined));
    qp.onDidTriggerItemButton((e) => finish({ item: e.item, button: e.button }));
    qp.onDidHide(() => { finish(undefined); qp.dispose(); });
    qp.show();
  });
}

async function runAccountAction(action, a) {
  if (action === 'rename') return rename(a);
  if (action === 'appearance') return cmdAppearance(a);
  if (action === 'login') return loginTerminal(a);
  if (action === 'logout') return logout(a);
  if (action === 'remove') return remove(a);
  if (action === 'env') return cmdEditEnv(a);
}

async function pickMode() {
  const p = await vscode.window.showQuickPick(
    [
      {
        label: '$(link) ' + t('Shared profile'),
        detail: t('Uses the same configuration as ~/.claude (settings, CLAUDE.md, agents, commands, skills...). Login and history stay separate. Changes to that configuration apply to every shared account.'),
        mode: 'shared',
      },
      {
        label: '$(lock) ' + t('Isolated profile'),
        detail: t('Configuration, history and login fully separate. ~/.claude is not touched.'),
        mode: 'isolated',
      },
    ],
    { placeHolder: t('How should this account handle configuration?') }
  );
  return p?.mode;
}

const loginTerminals = new Set();

function loginTerminal(account, command = cfg('loginCommand'), title = t('Claude login: {0}', account.name)) {
  const env = desiredEnv(account);
  if (!account.dir) env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV ?? null;
  const term = vscode.window.createTerminal({ name: title, env });
  loginTerminals.add(term); // closing it refreshes identity and limits
  term.show();
  term.sendText(command);
  // The terminal stays open after the CLI finishes, so also poll until the login state flips.
  const was = identityOf(account)?.loggedIn;
  let n = 0;
  const poll = setInterval(async () => {
    await refreshIdentity(account).catch(() => null);
    if (identityOf(account)?.loggedIn !== was || ++n >= 36) {
      clearInterval(poll);
      updateStatus();
      refreshLimits({ force: true });
    }
  }, 5000);
}

async function logout(a) {
  const ok = t('Log out');
  if (await vscode.window.showWarningMessage(t('Log out of "{0}"?', a.name), { modal: true }, ok) !== ok) return;
  // Same CLI as loginCommand, so it works with whatever path the user configured.
  loginTerminal(a, cfg('loginCommand').replace(/auth\s+login\b/, 'auth logout'), t('Claude logout: {0}', a.name));
}

// ───────────────────────── commands ─────────────────────────

async function cmdSwitch() {
  const cur = selectedAccount();
  refreshAllIdentities().catch(() => null);
  const items = allAccounts().map((a) => accountItem(a));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(add) ' + t('Add account...'), action: 'claudeAccounts.add' });
  items.push({ label: '$(gear) ' + t('More...'), more: true });

  const r = await pick(items, t('Current account: {0}', cur.name));
  if (!r) return;
  if (r.button) return runAccountAction(r.button.action, r.item.account);
  if (r.item.more) return cmdMore();
  if (r.item.action) return vscode.commands.executeCommand(r.item.action);
  if (identityOf(r.item.account)?.loggedIn === false) return loginTerminal(r.item.account);
  if (r.item.account.id === cur.id) return;
  await selectAccount(r.item.account);
}

async function cmdMore() {
  const items = [{ label: '$(gear) ' + t('Manage accounts...'), action: 'claudeAccounts.manage' }];
  if (currentRepo) {
    const d = resolveDefault();
    items.push({
      label: '$(pin) ' + t('Set default account for this repository...'),
      description: d?.source === 'repo' ? t('now: {0}', d.account.name) : undefined,
      action: 'claudeAccounts.setRepoDefault',
    });
    if (d?.source === 'repo') items.push({ label: '$(pinned-dirty) ' + t('Clear repository default'), action: 'claudeAccounts.clearRepoDefault' });
    items.push({ label: '$(list-filter) ' + t('Add default-account rule...'), action: 'claudeAccounts.addRule' });
  }
  items.push({
    label: '$(history) ' + (cfg('shareHistory') ? t('Stop sharing history...') : t('Share history across accounts...')),
    action: 'claudeAccounts.toggleHistorySharing',
  });
  items.push({ label: '$(graph) ' + t('Token usage by account (local logs)'), action: 'claudeAccounts.showUsage' });
  items.push({ label: '$(preview) ' + t('Artifacts (local preview)'), action: 'claudeAccounts.showArtifacts' });
  items.push(
    { label: '$(refresh) ' + t('Refresh plan limits'), action: 'claudeAccounts.refreshLimits' },
    { label: '$(output) ' + t('Show logs'), action: 'claudeAccounts.showLogs' },
    { label: '$(settings) ' + t('Settings'), settings: true },
  );
  const r = await vscode.window.showQuickPick(items, { placeHolder: t('More') });
  if (!r) return;
  if (r.settings) return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:wheatlay.switchboard-for-claude-code');
  return vscode.commands.executeCommand(r.action);
}

async function cmdSwitchToPrevious() {
  const prev = findAccount(store().get(K_PREVIOUS));
  if (!prev || prev.id === selectedAccount().id) {
    return vscode.window.showInformationMessage(t('There is no previous account in this window yet.'));
  }
  await selectAccount(prev);
}

async function cmdAdd() {
  const name = await vscode.window.showInputBox({
    prompt: t('Account name (e.g. Work, Personal)'),
    validateInput: (v) => (v.trim() ? null : t('Enter a name')),
  });
  if (!name) return;
  const mode = await pickMode();
  if (!mode) return;

  const recs = getRecords();
  const base = slugify(name);
  let id = base;
  for (let i = 2; recs.some((a) => a.id === id); i++) id = `${base}-${i}`;
  const dir = path.join(accountsRoot(), id);
  fs.mkdirSync(dir, { recursive: true });

  let summary = mode === 'shared' ? describe(linkSharedItems(dir)) : '';
  if (historyItems().length) { linkHistory(dir, id); summary += ' ' + t('History shared with the other accounts.'); }
  await saveRecords([...recs, { id, dir, mode }]);
  const used = new Set(allAccounts().map((a) => a.color).filter(Boolean));
  await updateMeta(id, { name: name.trim(), color: COLORS.find((c) => !used.has(c)) });
  updateStatus();

  const account = findAccount(id);
  const loginBtn = t('Log in');
  const res = await vscode.window.showInformationMessage(
    t('Account "{0}" created at {1}.{2} Log in now?', account.name, dir, summary),
    loginBtn,
    t('Later')
  );
  if (res === loginBtn) loginTerminal(account);
}

async function cmdManage() {
  // No row buttons here: the next step lists the same actions.
  const r = await pick(allAccounts().map((a) => accountItem(a, { buttons: false })), t('Which account?'));
  if (!r) return;
  const a = r.item.account;

  const actions = [
    identityOf(a)?.loggedIn === false
      ? { label: '$(sign-in) ' + t('Log in'), run: () => loginTerminal(a) }
      : { label: '$(sign-out) ' + t('Log out'), run: () => logout(a) },
    { label: '$(edit) ' + t('Rename'), run: () => rename(a) },
    { label: '$(symbol-color) ' + t('Appearance (color, icon, image)'), run: () => cmdAppearance(a) },
    { label: '$(symbol-variable) ' + t('Environment variables'), run: () => cmdEditEnv(a) },
  ];
  if (a.id !== DEFAULT_ID) {
    actions.push(
      a.mode === 'shared'
        ? { label: '$(lock) ' + t('Switch to isolated profile'), run: () => toIsolated(a) }
        : { label: '$(link) ' + t('Switch to shared profile'), run: () => toShared(a) }
    );
    if (a.mode === 'shared' || historyItems().length) {
      actions.push({ label: '$(sync) ' + t('Relink shared items'), run: () => relink(a) });
    }
    actions.push({ label: '$(trash) ' + t('Remove'), run: () => remove(a) });
  }
  actions.splice(actions.length - (a.id !== DEFAULT_ID ? 1 : 0), 0,
    { label: '$(folder-opened) ' + t('Open account folder'), run: () => vscode.env.openExternal(vscode.Uri.file(configDirOf(a))) });
  const act = await vscode.window.showQuickPick(actions, { placeHolder: `${a.name} · ${modeLabel(a.mode)}` });
  if (act) await act.run();
}

async function saveRecordPatch(id, patch) {
  await saveRecords(getRecords().map((x) => (x.id === id ? { ...x, ...patch } : x)));
  updateStatus();
}

async function toIsolated(a) {
  const copied = unlinkSharedItems(a.dir);
  await saveRecordPatch(a.id, { mode: 'isolated' });
  const extra = copied.length ? ' ' + t('Independent copies created: {0}.', copied.join(', ')) : '';
  vscode.window.showInformationMessage(t('"{0}" now uses an isolated profile.', a.name) + extra);
}

async function toShared(a) {
  const switchBtn = t('Switch');
  const ok = await vscode.window.showWarningMessage(
    t('Switch "{0}" to a shared profile?', a.name),
    { modal: true, detail: t('Items this account has its own version of that are in the shared list will be renamed to .bak and replaced by links to ~/.claude.') },
    switchBtn
  );
  if (ok !== switchBtn) return;
  const r = linkSharedItems(a.dir, { replaceLocal: true });
  await saveRecordPatch(a.id, { mode: 'shared' });
  vscode.window.showInformationMessage(t('"{0}" now uses a shared profile.', a.name) + describe(r));
}

async function relink(a) {
  let msg = '';
  if (a.mode === 'shared') msg += describe(linkSharedItems(a.dir, { replaceLocal: true }));
  if (historyItems().length) msg += describe(linkHistory(a.dir, a.id));
  vscode.window.showInformationMessage(t('Items relinked in "{0}".', a.name) + msg);
}

async function rename(a) {
  const name = await vscode.window.showInputBox({
    prompt: t('New name'),
    value: a.name,
    validateInput: (v) => (v.trim() ? null : t('Enter a name')),
  });
  if (!name) return;
  await updateMeta(a.id, { name: name.trim() });
  updateStatus();
}

async function cmdAppearance(a) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(symbol-color) ' + t('Color...'), id: 'color' },
      { label: '$(smiley) ' + t('Icon or emoji...'), id: 'icon' },
      { label: '$(file-media) ' + t('Image...'), id: 'image', detail: t('Shown in the account picker. The status bar only supports icons.') },
      ...(a.avatar ? [{ label: '$(close) ' + t('Remove image'), id: 'noimage' }] : []),
    ],
    { placeHolder: t('Appearance of "{0}"', a.name) }
  );
  if (!choice) return;

  if (choice.id === 'color') {
    const names = {
      orange: t('Orange'), green: t('Green'), blue: t('Blue'), purple: t('Purple'),
      pink: t('Pink'), yellow: t('Yellow'), teal: t('Teal'), red: t('Red'),
    };
    const c = await vscode.window.showQuickPick(
      [
        ...COLORS.map((col) => ({ label: names[col], color: col, iconPath: new vscode.ThemeIcon('circle-filled', themeColor(col)) })),
        { label: t('No color'), color: undefined, iconPath: new vscode.ThemeIcon('circle-outline') },
      ],
      { placeHolder: t('Color of "{0}"', a.name) }
    );
    if (c) await updateMeta(a.id, { color: c.color });
  } else if (choice.id === 'icon') {
    const i = await vscode.window.showQuickPick(
      [
        ...ICONS.map((ic) => ({ label: `$(${ic}) ${ic}`, icon: ic })),
        { label: '$(smiley) ' + t('Emoji...'), icon: '__emoji__' },
      ],
      { placeHolder: t('Icon of "{0}"', a.name) }
    );
    if (!i) return;
    let icon = i.icon;
    if (icon === '__emoji__') {
      icon = await vscode.window.showInputBox({
        prompt: t('Type or paste one emoji'),
        validateInput: (v) => (v.trim() && [...v.trim()].length <= 4 && !/[a-z0-9]/i.test(v) ? null : t('Enter a single emoji')),
      });
      if (!icon) return;
      icon = icon.trim();
    }
    await updateMeta(a.id, { icon });
  } else if (choice.id === 'image') {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [t('Images')]: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
    });
    if (!files?.length) return;
    const src = files[0].fsPath;
    if (fs.statSync(src).size > 2 * 1024 * 1024) return vscode.window.showWarningMessage(t('Choose an image smaller than 2 MB.'));
    const fileName = `${a.id}-${Date.now()}${path.extname(src).toLowerCase()}`;
    fs.mkdirSync(storageDir('avatars'), { recursive: true });
    fs.copyFileSync(src, storageDir('avatars', fileName));
    if (a.avatar) fs.rmSync(storageDir('avatars', a.avatar), { force: true });
    await ctx.globalState.update(K_AVATARS, { ...getAvatars(), [a.id]: fileName });
  } else if (choice.id === 'noimage') {
    fs.rmSync(storageDir('avatars', a.avatar), { force: true });
    const m = { ...getAvatars() };
    delete m[a.id];
    await ctx.globalState.update(K_AVATARS, m);
  }
  updateStatus();
}

async function cmdEditEnv(a) {
  for (;;) {
    const env = { ...(getEnvMap()[a.id] || {}) };
    const items = Object.entries(env).map(([k, v]) => ({ label: k, description: /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(k) ? '••••••••' : v, key: k }));
    items.push({ label: '$(add) ' + t('Add variable...'), key: null });
    const p = await vscode.window.showQuickPick(items, {
      placeHolder: t('Environment variables of "{0}" (kept on this machine only)', a.name),
    });
    if (!p) break;
    const input = await vscode.window.showInputBox({
      prompt: p.key ? t('Edit as NAME=value. Leave empty to remove {0}.', p.key) : t('Enter NAME=value'),
      value: p.key ? `${p.key}=${env[p.key]}` : '',
      validateInput: (v) => {
        if (!v.trim()) return p.key ? null : t('Enter NAME=value');
        const m = v.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
        if (!m) return t('Enter NAME=value');
        if (m[1] === 'CLAUDE_CONFIG_DIR') return t('CLAUDE_CONFIG_DIR is managed by the account itself.');
        return null;
      },
    });
    if (input === undefined) continue;
    if (p.key) delete env[p.key];
    const m = input.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (m) env[m[1]] = m[2];
    await ctx.globalState.update(K_ENV, { ...getEnvMap(), [a.id]: env });
    if (selectedAccount().id === a.id) {
      applyEnv(findAccount(a.id));
      await maybeReload(t('Environment variables of "{0}" updated.', a.name));
      break;
    }
  }
}

async function remove(a) {
  const keepBtn = t('Remove (keep folder)');
  const deleteBtn = t('Remove and delete folder');
  const choice = await vscode.window.showWarningMessage(
    t('Remove account "{0}"?', a.name),
    { modal: true, detail: t('Folder: {0}\n~/.claude is never deleted; shared links are undone before anything is deleted.', a.dir) },
    keepBtn,
    deleteBtn
  );
  if (!choice) return;
  const wasCurrent = selectedAccount().id === a.id;
  await saveRecords(getRecords().filter((x) => x.id !== a.id));
  const map = { ...getRepoDefaults() };
  for (const k of Object.keys(map)) if (map[k] === a.id) delete map[k];
  await saveRepoDefaults(map);
  // Drop everything stored for this id so a new account with the same name starts clean.
  const envMap = { ...getEnvMap() };
  delete envMap[a.id];
  await ctx.globalState.update(K_ENV, envMap);
  const meta = { ...getMeta() };
  delete meta[a.id];
  await ctx.globalState.update(K_META, meta);
  if (a.avatar) fs.rmSync(storageDir('avatars', a.avatar), { force: true });
  const avatars = { ...getAvatars() };
  delete avatars[a.id];
  await ctx.globalState.update(K_AVATARS, avatars);
  if (choice === deleteBtn) removeAccountDir(a.dir);
  updateStatus();
  if (wasCurrent) await selectAccount(defaultAccount(), t('previous account removed'));
}

async function cmdToggleHistory() {
  const enabled = !!cfg('shareHistory');
  const accounts = getAccounts();
  const items = cfg('historyItems') || [];

  if (!enabled) {
    const shareBtn = t('Share');
    const ok = await vscode.window.showWarningMessage(
      t('Share history across all accounts?'),
      {
        modal: true,
        detail: t('Items: {0}.\n\nThe history each account already has is merged into ~/.claude (nothing is deleted; conflicting files are kept alongside with the suffix .conflict-<account>), and every account will see the same conversations.\n\nClose the Claude Code panel in other windows before continuing.', items.join(', ')),
      },
      shareBtn
    );
    if (ok !== shareBtn) return;
    await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', true, vscode.ConfigurationTarget.Global);
    const total = { merged: 0, conflicts: [], skipped: [] };
    for (const a of accounts) {
      const r = linkHistory(a.dir, a.id);
      total.merged += r.merged;
      total.conflicts.push(...r.conflicts);
      total.skipped.push(...r.skipped.map((x) => `${a.name}: ${x}`));
    }
    const extra = [
      total.merged ? t('{0} items merged.', total.merged) : '',
      total.conflicts.length ? t('Conflicts: {0}.', total.conflicts.join(', ')) : '',
      total.skipped.length ? t('Skipped: {0}.', total.skipped.join('; ')) : '',
    ].filter(Boolean).join(' ');
    return maybeReload(t('History shared across {0} accounts.', accounts.length + 1) + (extra ? ' ' + extra : ''));
  }

  const copyBtn = t('Copy current history');
  const emptyBtn = t('Start empty');
  const choice = await vscode.window.showWarningMessage(
    t('Stop sharing history?'),
    { modal: true, detail: t('~/.claude keeps all current history. The other accounts can get a copy of it or start empty.') },
    copyBtn,
    emptyBtn
  );
  if (!choice) return;
  for (const a of accounts) unlinkItems(a.dir, items, { copy: choice === copyBtn });
  await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', false, vscode.ConfigurationTarget.Global);
  return maybeReload(t('History is no longer shared.'));
}

async function cmdSetRepoDefault() {
  currentRepo = currentRepo || (await detectRepo());
  if (!currentRepo) return vscode.window.showWarningMessage(t('Open a folder to set a default account.'));
  const r = await pick(allAccounts().map((a) => accountItem(a, { markCurrent: false, buttons: false })), t('Default account for {0}', currentRepo.label));
  if (!r) return;
  const acc = r.item.account;
  const map = { ...getRepoDefaults(), [currentRepo.key]: acc.id };
  await saveRepoDefaults(map);
  await ctx.workspaceState.update(K_LAST_APPLIED, acc.id);
  updateStatus();
  if (selectedAccount().id !== acc.id) await selectAccount(acc, t('repository default'));
  else vscode.window.showInformationMessage(t('"{0}" is now the default account for this repository.', acc.name));
}

async function cmdClearRepoDefault() {
  currentRepo = currentRepo || (await detectRepo());
  if (!currentRepo) return;
  const map = { ...getRepoDefaults() };
  delete map[currentRepo.key];
  await saveRepoDefaults(map);
  await ctx.workspaceState.update(K_LAST_APPLIED, undefined);
  updateStatus();
  vscode.window.showInformationMessage(t('Default account for this repository removed.'));
}

async function cmdAddRule() {
  currentRepo = currentRepo || (await detectRepo());
  const folder = folderPath();
  if (!folder) return vscode.window.showWarningMessage(t('Open a folder to set a default account.'));
  const home = os.homedir();
  const tilde = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p).replace(/\\/g, '/');
  const options = [];
  if (currentRepo?.remote) {
    const parts = normalizeRemote(currentRepo.remote).split('/');
    if (parts.length >= 3) {
      const org = parts.slice(0, -1).join('/');
      options.push({ label: t('Every repository of {0}', org), detail: org, pattern: org });
    }
  }
  const parent = path.dirname(currentRepo?.root || folder);
  options.push({ label: t('Every folder under {0}', tilde(parent)), detail: tilde(parent), pattern: tilde(parent) });
  options.push({ label: '$(edit) ' + t('Custom pattern...'), pattern: null });

  const o = await vscode.window.showQuickPick(options, { placeHolder: t('Which repositories should this rule cover?') });
  if (!o) return;
  let pattern = o.pattern;
  if (!pattern) {
    pattern = await vscode.window.showInputBox({
      prompt: t('Folder pattern (e.g. ~/work/**) or remote pattern (e.g. github.com/my-company/*)'),
      validateInput: (v) => (v.trim() ? null : t('Enter a pattern')),
    });
    if (!pattern) return;
    pattern = pattern.trim();
  }
  const r = await pick(allAccounts().map((a) => accountItem(a, { markCurrent: false, buttons: false })), t('Account for {0}', pattern));
  if (!r) return;
  const rules = [...(cfg('rules') || []).filter((x) => x?.pattern !== pattern), { pattern, account: r.item.account.id }];
  await vscode.workspace.getConfiguration('claudeAccounts').update('rules', rules, vscode.ConfigurationTarget.Global);
  await ctx.workspaceState.update(K_LAST_APPLIED, undefined);
  const editBtn = t('Edit rules');
  vscode.window.showInformationMessage(
    t('Rule added: {0} → {1}. A repository default set for a specific repository still wins.', pattern, r.item.account.name),
    editBtn
  ).then((b) => b === editBtn && vscode.commands.executeCommand('workbench.action.openSettings', 'claudeAccounts.rules'));
  await autoApply();
  updateStatus();
}

async function cmdShowUsage() {
  const shared = !!cfg('shareHistory');
  const targets = shared ? [selectedAccount()] : allAccounts();
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Reading local session logs...') },
    async () => Promise.all(targets.map(async (a) => ({ a, u: await computeUsage(a).catch(() => null) })))
  );
  const usd = (s) => '$' + s.cost.toFixed(2) + (s.unpriced ? '+' : '');
  const items = results.flatMap(({ a, u }) => {
    const head = {
      label: shared ? t('All accounts (history is shared)') : a.name,
      description: u ? t('today: {0} · 7 days: {1}', formatTokens(totalTokens(u.today)), formatTokens(totalTokens(u.week))) : t('no data'),
      detail: u
        ? t('7 days: input {0} · output {1} · cache write {2} · cache read {3} · {4} responses',
          formatTokens(u.week.input), formatTokens(u.week.output), formatTokens(u.week.cacheWrite), formatTokens(u.week.cacheRead), u.week.messages)
        : undefined,
    };
    if (!u) return [head];
    const periods = [
      [t('Today'), daysAgo(0)], [t('7 days'), daysAgo(6)], [t('30 days'), daysAgo(29)],
      [t('Since {0}', firstDay(u.days) || '—'), ''],
    ];
    return [head, ...periods.map(([label, from]) => {
      const s = sumDays(u.days, from);
      return {
        label: `    ${label}`,
        description: t('{0} tokens · ≈ {1} at API prices', formatTokens(totalTokens(s.totals)), usd(s)),
      };
    })];
  });
  await vscode.window.showQuickPick(items, {
    placeHolder: shared
      ? t('Usage cannot be split by account while history is shared.')
      : t('Tokens recorded on this machine (local logs only; other devices are not included).'),
  });
}

// Finds account folders that are not registered (e.g. created by an earlier install).
function findUnregisteredDirs() {
  const root = accountsRoot();
  if (!fs.existsSync(root)) return [];
  const known = getRecords();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter((d) => !known.some((a) => samePath(a.dir, d)));
}

async function cmdImport({ prompt = false } = {}) {
  const found = findUnregisteredDirs();
  if (!found.length) {
    if (!prompt) vscode.window.showInformationMessage(t('No unregistered account folders found in {0}.', accountsRoot()));
    return;
  }
  if (prompt) {
    const importBtn = t('Import');
    const res = await vscode.window.showInformationMessage(
      t('Found {0} account folder(s) in {1} that are not registered. Import them?', found.length, accountsRoot()),
      importBtn,
      t('Not now')
    );
    if (res !== importBtn) return;
  }
  const src = homeClaudeDir();
  const taken = new Set([DEFAULT_ID, ...getRecords().map((r) => r.id)]);
  const imported = found.map((d) => {
    const base = path.basename(d);
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    taken.add(id);
    const shared = (cfg('sharedItems') || []).some((i) => isLinkedTo(path.join(d, i), path.join(src, i)));
    return { id, dir: d, mode: shared ? 'shared' : 'isolated' };
  });
  await saveRecords([...getRecords(), ...imported]);
  updateStatus();
  const names = imported.map((a) => findAccount(a.id).name).join(', ');
  vscode.window.showInformationMessage(t('Imported: {0}. Use "Manage accounts" to rename them.', names));
}

async function checkSharedHealth() {
  const cur = selectedAccount();
  const broken = brokenShares(cur);
  if (!broken.length) return;
  const relinkBtn = t('Relink');
  const res = await vscode.window.showWarningMessage(
    t('Account "{0}" is not linked to these shared items: {1}. This happens when an item is created in ~/.claude later or gets rewritten over the link.', cur.name, broken.join(', ')),
    relinkBtn,
    t('Ignore')
  );
  if (res === relinkBtn) await relink(cur);
}

// ───────────────────────── activation ─────────────────────────

function reg(id, fn) {
  return vscode.commands.registerCommand(id, async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      vscode.window.showErrorMessage(`Switchboard for Claude Code: ${e.message || e}`);
    }
  });
}

// This fork has its own extension ID, so VS Code gives it empty storage. On first start copy
// what an earlier extension stored (accounts, names, colors, selection): the pre-rename fork first, then the original.
const ORIGINAL_IDS = ['wheatlay.claude-accounts-usage', 'kahuecosta.claude-code-multi-account'];
const K_MIGRATED = 'migratedFromOriginal';

function readOriginalState(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const id of ORIGINAL_IDS) {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(id);
        if (row) return JSON.parse(String(row.value));
      }
      return null;
    } finally {
      db.close();
    }
  } catch (e) {
    log.error('Cannot read the original extension state from', dbPath, e);
    return null;
  }
}

function migrateFromOriginal(context) {
  const copy = (memento, uri) => {
    if (!uri || memento.get(K_MIGRATED)) return;
    const old = readOriginalState(path.join(path.dirname(uri.fsPath), 'state.vscdb'));
    // Memento.update changes the in-memory value synchronously, so selectedAccount() sees it right away.
    for (const [k, v] of Object.entries(old || {})) if (memento.get(k) === undefined) memento.update(k, v);
    memento.update(K_MIGRATED, true);
  };
  copy(context.globalState, context.globalStorageUri);
  copy(context.workspaceState, context.storageUri);
  // Cached plan limits, so the status bar shows them right away.
  try {
    const to = path.join(context.globalStorageUri.fsPath, 'limits.json');
    const from = path.join(path.dirname(context.globalStorageUri.fsPath), ORIGINAL_IDS[0], 'limits.json');
    if (!fs.existsSync(to) && fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  } catch {}
}

async function activate(context) {
  ctx = context;
  const claudeWasActive = !!vscode.extensions.getExtension('anthropic.claude-code')?.isActive;
  log = vscode.window.createOutputChannel('Switchboard for Claude Code', { log: true });
  context.subscriptions.push(log);
  log.info(`Activated, version ${context.extension.packageJSON.version}`);
  migrateFromOriginal(context);
  // First, synchronously: set the environment before the Claude Code extension starts the CLI.
  applyEnv(selectedAccount());

  context.globalState.setKeysForSync([K_META, K_REPO_DEFAULTS]);
  statusItem = vscode.window.createStatusBarItem('claudeAccounts.status', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Switchboard for Claude Code';
  statusItem.command = 'claudeAccounts.switch';

  let lastFocusRefresh = 0;
  context.subscriptions.push(
    statusItem,
    reg('claudeAccounts.switch', cmdSwitch),
    reg('claudeAccounts.clickAccount', cmdClickAccount),
    reg('claudeAccounts.refreshLimits', () => refreshLimits({ force: true })),
    { dispose: () => { for (const i of [...accountItems.values(), ...limitItems.values()]) i.dispose(); } },
    reg('claudeAccounts.switchToPrevious', cmdSwitchToPrevious),
    reg('claudeAccounts.add', cmdAdd),
    reg('claudeAccounts.manage', cmdManage),
    reg('claudeAccounts.setRepoDefault', cmdSetRepoDefault),
    reg('claudeAccounts.clearRepoDefault', cmdClearRepoDefault),
    reg('claudeAccounts.addRule', cmdAddRule),
    reg('claudeAccounts.showUsage', cmdShowUsage),
    reg('claudeAccounts.showArtifacts', cmdShowArtifacts),
    reg('claudeAccounts.showLogs', () => log.show()),
    { dispose: () => { stopPreview(); } },
    reg('claudeAccounts.toggleHistorySharing', cmdToggleHistory),
    reg('claudeAccounts.importExisting', () => cmdImport()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCode.environmentVariables') || e.affectsConfiguration('claudeAccounts')) updateStatus();
      if (e.affectsConfiguration('claudeAccounts.planLimits')) { renderAccountItems(); refreshLimits({ force: true }); }
      if (e.affectsConfiguration('claudeAccounts.gravatar')) refreshAllIdentities().catch(() => null);
      if (e.affectsConfiguration('claudeAccounts.artifactPreview') || e.affectsConfiguration('claudeAccounts.artifactPreviewPort')) {
        stopPreview().then(startPreview).catch(() => null);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      currentRepo = await detectRepo();
      updateStatus();
    }),
    vscode.window.onDidCloseTerminal((term) => {
      if (loginTerminals.delete(term)) {
        refreshAllIdentities().catch(() => null);
        refreshLimits({ force: true });
      }
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && Date.now() - lastFocusRefresh > 60e3) {
        lastFocusRefresh = Date.now();
        refreshAllIdentities().catch(() => null);
      }
    })
  );

  try { await migrate(); } catch { /* keep going */ }
  updateStatus();
  currentRepo = await detectRepo();
  updateStatus();
  try {
    await autoApply();
    await startLimitWatcher(context);
    await refreshAllIdentities();
    logDiagnostics(claudeWasActive);
  } catch (e) {
    log.error('Startup:', e);
    vscode.window.showErrorMessage(`Switchboard for Claude Code: ${e.message || e}`);
  }
  const usageTimer = setTimeout(() => refreshCurrentUsage(), 3000);
  refreshLimits();
  startPreview().catch(() => null);
  const limitsTimer = setInterval(refreshLimits, 60e3);
  const countdownTimer = setInterval(renderAccountItems, 30e3); // keeps reset countdowns current, no requests
  context.subscriptions.push({ dispose: () => { clearTimeout(usageTimer); clearInterval(limitsTimer); clearInterval(countdownTimer); } });
  // Prompts wait for the user, so they must not hold activation (or the setup above) back.
  startupPrompts = runStartupPrompts(context);
}

let startupPrompts = Promise.resolve();

async function runStartupPrompts(context) {
  try {
    if (!getRecords().length && !context.globalState.get(K_IMPORT_PROMPTED)) {
      await context.globalState.update(K_IMPORT_PROMPTED, true);
      await cmdImport({ prompt: true });
    }
    await checkOverridingSetting();
    await checkSharedHealth();
  } catch (e) {
    vscode.window.showErrorMessage(`Switchboard for Claude Code: ${e.message || e}`);
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internals: {
    normalizeRemote, slugify, initials, linkSharedItems, unlinkSharedItems, linkHistory, unlinkItems,
    isLinkedTo, removeAccountDir, brokenShares, findUnregisteredDirs, resolveDefault, desiredEnv,
    startupDone: () => startupPrompts,
  },
};
