'use strict';
// Local preview server for artifacts: serves each artifact's folder on 127.0.0.1 with live reload,
// so it can be opened in any browser, whichever claude.ai account the browser is logged into.
const http = require('http');
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// Path inside root, or null. No absolute paths, no "..", no hidden files or folders (.env, .git).
function safeResolve(root, rel) {
  if (!rel || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  if (rel.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
  const rootN = path.resolve(root);
  const full = path.resolve(rootN, rel);
  if (full !== rootN && !full.startsWith(rootN + path.sep)) return null;
  return full;
}

const BASE_CSS = `:root{--bg:#fafaf9;--fg:#1c1c1e;--mut:#6b6b70;--card:#fff;--bd:#e4e4e0;--ac:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececee;--mut:#9a9aa0;--card:#212124;--bd:#333338;--ac:#8aa8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,'Segoe UI',sans-serif;line-height:1.5}
a{color:var(--ac)}`;

function page(title, body, status = 200) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${BASE_CSS}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.card h2{font-size:16px;margin:0 0 4px}.meta{color:var(--mut);font-size:12.5px;word-break:break-all}.links{display:flex;flex-wrap:wrap;gap:16px;margin:6px 0;font-size:14px}</style></head><body><main>${body}</main></body></html>`;
  return { status, type: 'text/html; charset=utf-8', body: html };
}
const errPage = (status, msg) => page('Error', `<h1>${esc(msg)}</h1><p><a href="/">All artifacts</a></p>`, status);

function send(res, r) {
  res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(r.body);
}

function indexPage(items) {
  let body = '<h1>Claude artifacts (local preview)</h1>';
  if (!items.length) body += '<p class="meta">No artifacts yet. They show up here after Claude Code publishes one from a local file.</p>';
  for (const it of items) {
    const when = it.updatedAt ? new Date(it.updatedAt).toLocaleString() : '';
    const by = it.account ? ` · ${esc(it.account)}` : '';
    body += `<div class="card"><h2>${esc(it.title || it.id)}</h2><div class="links"><a href="/a/${esc(it.id)}/">Open locally</a>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">claude.ai ↗</a>` : ''}</div><div class="meta">${esc(when)}${by} · ${esc(it.root)}</div></div>`;
  }
  return page('Claude artifacts', body);
}

const reloadSnippet = (id) => `<script>new EventSource('/events?id=${encodeURIComponent(id)}').addEventListener('reload',()=>location.reload())</script>`;
function injectReload(html, id) {
  const s = reloadSnippet(id);
  const i = html.lastIndexOf('</body>');
  return i >= 0 ? html.slice(0, i) + s + html.slice(i) : html + s;
}

// Design-canvas pages (.dc.html) need claude.ai's runtime; here only simple {{values}} from the
// default props are filled in, with a note when something dynamic is left out.
function dcShim(src, item) {
  let out = src.replace(/<script[^>]*src=["'][^"']*support\.js["'][^>]*>\s*<\/script>/gi, '');
  const vals = {};
  const m = out.match(/<script[^>]*type=["']text\/x-dc["'][^>]*>[\s\S]*?<\/script>/i);
  if (m) {
    const pm = m[0].match(/data-props='([^']*)'/) || m[0].match(/data-props="([^"]*)"/);
    if (pm) {
      try {
        const props = JSON.parse(pm[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        for (const [k, v] of Object.entries(props || {})) {
          if (v && typeof v === 'object' && 'default' in v && (typeof v.default !== 'object' || v.default === null)) vals[k] = v.default;
        }
      } catch { /* leave placeholders */ }
    }
    out = out.replace(m[0], '');
  }
  const hadDynamic = /<sc-for|<sc-if|<dc-import|<x-import/i.test(src);
  out = out.replace(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g, (all, name) => (name in vals ? esc(vals[name]) : all));
  const css = '<style>x-dc,helmet{display:contents}</style>';
  const banner = hadDynamic || out.includes('{{')
    ? `<div style="position:fixed;right:10px;bottom:10px;z-index:99999;max-width:300px;background:#fff8e1;color:#5d4200;border:1px solid #e0c46c;border-radius:8px;padding:8px 10px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)">Simplified preview: some dynamic parts only work on claude.ai${item.url ? ` · <a href="${esc(item.url)}" target="_blank" rel="noopener" style="color:#7a5200">Open on claude.ai</a>` : ''}</div>`
    : '';
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, css + '</head>') : css + out;
  if (banner) {
    const i = out.lastIndexOf('</body>');
    out = i >= 0 ? out.slice(0, i) + banner + out.slice(i) : out + banner;
  }
  return out;
}

function canvasPage(item) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(item.title || item.id)}</title><style>${BASE_CSS}
html,body{height:100%;overflow:hidden}
#bar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--card);border-bottom:1px solid var(--bd);z-index:10;font-size:14px;white-space:nowrap;overflow-x:auto}
#bar b{font-size:15px}#bar .sp{flex:1}
button{font:inherit;font-size:13px;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:4px 10px;cursor:pointer}
button.on{background:var(--ac);color:#fff;border-color:var(--ac)}
#vp{position:fixed;top:44px;left:0;right:0;bottom:0;overflow:hidden;cursor:grab;background:var(--bg);background-image:radial-gradient(var(--bd) 1px,transparent 1px);background-size:24px 24px}
#vp.drag{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.board{position:absolute}
.board .nm{position:absolute;left:0;bottom:100%;padding-bottom:4px;font-size:14px;font-weight:600;white-space:nowrap;cursor:pointer;color:var(--mut)}
.board .nm:hover{color:var(--ac);text-decoration:underline}
.board iframe{border:1px solid var(--bd);background:#fff;display:block}
.note{position:absolute;white-space:pre-wrap}
.note.t1{width:max-content;font-weight:700;font-size:72px;line-height:1.1}
.note.st{padding:14px 16px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.18);color:#222;font-size:16px;line-height:1.45}
.drag iframe{pointer-events:none}
</style></head><body>
<div id="bar"><b id="ttl"></b><span id="tabs"></span><span class="sp"></span><button id="fit">Fit</button><button id="one">100%</button>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">claude.ai ↗</a>` : ''}<a href="/">All artifacts</a></div>
<div id="vp"><div id="world"></div></div>
<script>
(function(){
var ID=${JSON.stringify(item.id)};
var vp=document.getElementById('vp'),world=document.getElementById('world');
var FILL={gray:'#e6e6e6',red:'#ffc9c9',orange:'#ffd8a8',green:'#b2f2bb',teal:'#99e9f2',blue:'#a5d8ff',purple:'#d0bfff',pink:'#fcc2d7'};
var S={x:0,y:0,k:1},data=null,page=null,KEY='preview:'+ID;
function save(){try{sessionStorage.setItem(KEY,JSON.stringify({x:S.x,y:S.y,k:S.k,page:page}))}catch(e){}}
function apply(){world.style.transform='translate('+S.x+'px,'+S.y+'px) scale('+S.k+')';save()}
function boardPage(b){return b.page||(data.pages&&data.pages[0]&&data.pages[0].id)||null}
function visible(){
  var bs=[],ns=[],f,n;
  var hasPages=data.pages&&data.pages.length;
  for(f in (data.boards||{})){var b=data.boards[f];if(!hasPages||boardPage(b)===page)bs.push([f,b])}
  for(n in (data.notes||{})){var o=data.notes[n];if(!hasPages||!o.page||o.page===page)ns.push([n,o])}
  return {bs:bs,ns:ns};
}
function render(){
  var v=visible();world.innerHTML='';
  var order=data.order||[];
  v.bs.sort(function(a,b){return order.indexOf(a[0])-order.indexOf(b[0])});
  v.bs.forEach(function(p){
    var f=p[0],b=p[1],d=document.createElement('div');d.className='board';
    d.style.cssText='left:'+(b.x||0)+'px;top:'+(b.y||0)+'px;width:'+b.w+'px;height:'+b.h+'px';
    var nm=document.createElement('div');nm.className='nm';nm.textContent=b.title||f;
    nm.onclick=function(){location.href='/a/'+ID+'/f/project/'+encodeURI(f)};
    var fr=document.createElement('iframe');fr.style.width=b.w+'px';fr.style.height=b.h+'px';
    fr.src='/a/'+ID+'/f/project/'+encodeURI(f);
    d.appendChild(nm);d.appendChild(fr);world.appendChild(d);
  });
  v.ns.forEach(function(p){
    var o=p[1],d=document.createElement('div');
    if(o.kind==='title1'){d.className='note t1';if(o.maxW)d.style.maxWidth=o.maxW+'px'}
    else if(!o.kind){d.className='note st';d.style.background=FILL[o.fill]||'#fff3a3';if(o.w)d.style.width=o.w+'px';
      if(o.size==='s')d.style.fontSize='13px';else if(o.size==='l')d.style.fontSize='20px';else if(o.size==='m')d.style.fontSize='16px'}
    else return;
    d.style.left=(o.x||0)+'px';d.style.top=(o.y||0)+'px';d.textContent=o.text||'';world.appendChild(d);
  });
  var tabs=document.getElementById('tabs');tabs.innerHTML='';
  if(data.pages&&data.pages.length){data.pages.forEach(function(pg){
    var t=document.createElement('button');t.textContent=pg.name||pg.id;if(pg.id===page)t.className='on';
    t.onclick=function(){page=pg.id;render();fit()};tabs.appendChild(t)})}
}
function bounds(){
  var v=visible(),x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  v.bs.forEach(function(p){var b=p[1];x0=Math.min(x0,b.x||0);y0=Math.min(y0,(b.y||0)-24);x1=Math.max(x1,(b.x||0)+b.w);y1=Math.max(y1,(b.y||0)+b.h)});
  v.ns.forEach(function(p){var o=p[1];if(o.kind&&o.kind!=='title1')return;var w=o.w||o.maxW||600;x0=Math.min(x0,o.x||0);y0=Math.min(y0,o.y||0);x1=Math.max(x1,(o.x||0)+w);y1=Math.max(y1,(o.y||0)+(o.kind==='title1'?90:120))});
  return x0>x1?null:{x0:x0,y0:y0,x1:x1,y1:y1};
}
function fit(){
  var b=bounds();if(!b){S={x:0,y:0,k:1};apply();return}
  var W=vp.clientWidth,H=vp.clientHeight,pad=40;
  var k=Math.min((W-2*pad)/(b.x1-b.x0),(H-2*pad)/(b.y1-b.y0),1.5);
  S.k=k;S.x=(W-(b.x1-b.x0)*k)/2-b.x0*k;S.y=(H-(b.y1-b.y0)*k)/2-b.y0*k;apply();
}
function zoomAt(cx,cy,f){var k=Math.max(0.05,Math.min(4,S.k*f)),r=k/S.k;S.x=cx-(cx-S.x)*r;S.y=cy-(cy-S.y)*r;S.k=k;apply()}
vp.addEventListener('wheel',function(e){e.preventDefault();var r=vp.getBoundingClientRect();zoomAt(e.clientX-r.left,e.clientY-r.top,Math.exp(-e.deltaY*(e.ctrlKey?0.01:0.0015)))},{passive:false});
var dr=null;
vp.addEventListener('mousedown',function(e){if(e.target.closest&&e.target.closest('.nm'))return;dr={x:e.clientX,y:e.clientY,sx:S.x,sy:S.y};vp.classList.add('drag');e.preventDefault()});
window.addEventListener('mousemove',function(e){if(!dr)return;S.x=dr.sx+e.clientX-dr.x;S.y=dr.sy+e.clientY-dr.y;apply()});
window.addEventListener('mouseup',function(){dr=null;vp.classList.remove('drag')});
document.getElementById('fit').onclick=fit;
document.getElementById('one').onclick=function(){var r=vp.getBoundingClientRect();zoomAt(r.width/2,r.height/2,1/S.k)};
function load(first){
  fetch('/a/'+ID+'/canvas.json?t='+Date.now()).then(function(r){return r.json()}).then(function(j){
    data=j;document.getElementById('ttl').textContent=j.title||'';
    var saved=null;try{saved=JSON.parse(sessionStorage.getItem(KEY))}catch(e){}
    if(first){page=(saved&&saved.page)||(j.pages&&j.pages[0]&&j.pages[0].id)||null}
    render();
    if(first){if(saved&&typeof saved.k==='number'){S.x=saved.x;S.y=saved.y;S.k=saved.k;apply()}else fit()}
  }).catch(function(){document.getElementById('ttl').textContent='Could not load canvas.json'});
}
load(true);
new EventSource('/events?id='+encodeURIComponent(ID)).addEventListener('reload',function(){load(false)});
})();
</script></body></html>`;
  return { status: 200, type: 'text/html; charset=utf-8', body: html };
}

// opts: { port, health, listItems(), findItem(id) → item | Promise<item> }
function createPreviewServer(opts) {
  const watchers = new Map(); // root -> { clients, timer, watcher }

  function getWatcher(root) {
    let w = watchers.get(root);
    if (w) return w;
    w = { clients: new Set(), timer: null, watcher: null };
    try {
      w.watcher = fs.watch(root, { recursive: true }, () => {
        clearTimeout(w.timer);
        w.timer = setTimeout(() => { for (const c of w.clients) { try { c.write('event: reload\ndata: 1\n\n'); } catch { /* closed */ } } }, 150);
      });
      w.watcher.on('error', () => {});
    } catch { /* no live reload for this folder */ }
    watchers.set(root, w);
    return w;
  }

  function serveFile(res, item, full) {
    let st;
    try { st = fs.statSync(full); } catch { return send(res, errPage(404, 'File not found')); }
    if (!st.isFile()) return send(res, errPage(404, 'File not found'));
    const ext = path.extname(full).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      let html = fs.readFileSync(full, 'utf8');
      if (full.toLowerCase().endsWith('.dc.html')) html = dcShim(html, item);
      return send(res, { status: 200, type, body: injectReload(html, item.id) });
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(full).on('error', () => res.end()).pipe(res);
  }

  async function handle(req, res) {
    // Only requests addressed to this machine by name: blocks DNS rebinding from web pages.
    const port = server.address()?.port;
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, errPage(403, 'Forbidden'));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, errPage(405, 'Method not allowed'));

    const url = new URL(req.url, 'http://127.0.0.1');
    let p = url.pathname;
    if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(opts.health); }
    if (p === '/') return send(res, indexPage(opts.listItems()));
    if (p.startsWith('/_blob/')) return send(res, page('Not available', '<h1>File uploaded to claude.ai</h1><p>Assets uploaded to claude.ai are only available there, not in the local preview.</p>', 404));
    if (p === '/events') {
      const item = await opts.findItem(url.searchParams.get('id') || '');
      if (!item) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const w = getWatcher(item.root);
      w.clients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 20000);
      req.on('close', () => { clearInterval(ka); w.clients.delete(res); });
      return;
    }
    const m = p.match(/^\/a\/([^/]+)(\/.*)?$/);
    if (!m) return send(res, errPage(404, 'Page not found'));
    let id;
    try { id = decodeURIComponent(m[1]); p = m[2] || '/'; } catch { return send(res, errPage(400, 'Bad address')); }
    const item = await opts.findItem(id);
    if (!item) return send(res, errPage(404, 'Unknown artifact: ' + id));
    if (!m[2]) { res.writeHead(302, { Location: `/a/${encodeURIComponent(id)}/` }); return res.end(); }
    if (!fs.existsSync(item.root)) return send(res, errPage(404, 'The artifact folder no longer exists: ' + item.root));
    const canvas = path.join(item.root, 'project', 'canvas.json');
    if (p === '/') {
      if (fs.existsSync(canvas)) return send(res, canvasPage(item));
      const full = safeResolve(item.root, item.entry || 'index.html');
      if (!full) return send(res, errPage(400, 'Bad entry file'));
      return serveFile(res, item, full);
    }
    if (p === '/canvas.json') {
      try {
        const raw = fs.readFileSync(canvas, 'utf8');
        JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(raw);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (p.startsWith('/f/')) {
      let rel;
      try { rel = decodeURIComponent(p.slice(3)); } catch { return send(res, errPage(400, 'Bad address')); }
      const full = safeResolve(item.root, rel);
      if (!full) return send(res, errPage(403, 'Path not allowed'));
      return serveFile(res, item, full);
    }
    return send(res, errPage(404, 'Page not found'));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      try { if (!res.headersSent) send(res, errPage(500, 'Server error')); else res.end(); } catch { /* closed */ }
    });
  });

  // Resolves 'listening', or 'in-use' when the port is taken (another window, or another program).
  const listen = () => new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); e.code === 'EADDRINUSE' ? resolve('in-use') : reject(e); };
    const onOk = () => { server.off('error', onErr); resolve('listening'); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(opts.port, '127.0.0.1');
  });

  function close() {
    for (const w of watchers.values()) { try { w.watcher?.close(); } catch { /* ignore */ } for (const c of w.clients) c.end(); }
    watchers.clear();
    return new Promise((r) => server.close(() => r()));
  }

  return { server, listen, close };
}

module.exports = { createPreviewServer, safeResolve };
