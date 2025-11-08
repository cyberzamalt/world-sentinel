// worker.js — World Sentinel (fix D1 "duration") — build final FR
// --------------------------------------------------------------
console.log("🛰️ World Sentinel started at", new Date().toISOString());

// -------- Utils --------
const J = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", ...h },
  });
const H = (b, s = 200, h = {}) =>
  new Response(b, {
    status: s,
    headers: { "content-type": "text/html; charset=utf-8", ...h },
  });
const nowISO = () => new Date().toISOString();
async function digestHex(str) {
  const b = new TextEncoder().encode(str);
  const d = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// -------- RSS --------
function parseRSS(xml) {
  const items = [];
  const it =
    xml.match(/<item[\s\S]*?<\/item>/gi) ||
    xml.match(/<entry[\s\S]*?<\/entry>/gi) ||
    [];
  for (const block of it) {
    const g = re => (block.match(re) || ["", ""])[1]?.trim() || "";
    const title = g(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const link =
      g(/<link[^>]*>([\s\S]*?)<\/link>/i) ||
      (block.match(/<link[^>]*href="([^"]+)"/i) || ["", ""])[1] ||
      "";
    const guid =
      g(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || link || title || crypto.randomUUID();
    const pub =
      g(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      g(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
      g(/<published[^>]*>([\s\S]*?)<\/published>/i) ||
      "";
    const desc =
      g(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      g(/<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
      "";
    if (title) items.push({ title, link, guid, published_at: pub, description: desc });
  }
  return items;
}

// -------- Classif & ton --------
function classify(text) {
  const t = (text || "").toLowerCase();
  let sector = "autre";
  if (/oil|opec|energie|energy|gaz|pétrole/.test(t)) sector = "energie";
  else if (/bank|banque|credit|finance|fed|ecb|bce|taux/.test(t)) sector = "banques";
  else if (/chip|semi|nvidia|intel|ai|cloud|tech|software|apple|google|microsoft/.test(t)) sector = "technologie";
  else if (/auto|tesla|toyota|volkswagen/.test(t)) sector = "auto";
  let region = "monde";
  if (/france|paris|macron|amf/.test(t)) region = "fr";
  else if (/europe|eurozone|germany|german|ecb|bce|commission/.test(t)) region = "eu";
  else if (/usa|u\.s\.|united states|washington|sec\b/.test(t)) region = "us";
  return { sector, region };
}
function tone(text) {
  const t = (text || "").toLowerCase();
  const pos = /record profit|beat|growth|upgrade|rally|optimis|green|progress/.test(t);
  const neg = /crisis|war|conflict|down|drop|cut|ban|fine|probe|fraud|red|strike|sanction|layoff/.test(t);
  return pos && !neg ? 1 : !pos && neg ? -1 : 0;
}

// -------- D1 helpers (sans exec) --------
async function runDDL(env, ddl) {
  const stmts = ddl
    .split(";")
    .map(s => s.trim())
    .filter(s => s && !s.startsWith("--"));
  for (const sql of stmts) {
    await env.DB.prepare(sql).run();
  }
}

async function ensureSchema(env) {
  const ddl = `
  CREATE TABLE IF NOT EXISTS news(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE,
    title TEXT NOT NULL,
    url TEXT,
    source TEXT,
    category TEXT,
    region TEXT,
    lang TEXT,
    published_at TEXT,
    summary TEXT,
    sentiment INTEGER,
    impact INTEGER,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);
  CREATE TABLE IF NOT EXISTS indices(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT,
    sector TEXT,
    score INTEGER,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS signals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT,
    level TEXT,
    reason TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS meta(
    k TEXT PRIMARY KEY,
    v TEXT
  );
  `;
  await runDDL(env, ddl);
}

async function setMeta(env, k, v) {
  await env.DB.prepare(
    `INSERT INTO meta(k,v) VALUES(?1,?2)
     ON CONFLICT(k) DO UPDATE SET v=excluded.v`
  ).bind(k, v).run();
}
async function getMeta(env, k) {
  const r = await env.DB.prepare(`SELECT v FROM meta WHERE k=?1`).bind(k).first();
  return r?.v ?? null;
}

// -------- Sources --------
const SOURCES = [
  { name: "Reuters World",      type: "rss",   url: "https://www.reuters.com/world/rss" },
  { name: "BBC World",          type: "rss",   url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "The Guardian World", type: "rss",   url: "https://www.theguardian.com/world/rss" },
  { name: "DW",                 type: "rss",   url: "https://rss.dw.com/rdf/rss-en-world" },
];

// -------- Ingestion --------
async function saveNews(env, items, source) {
  let inserted = 0;
  for (const it of items) {
    const { sector, region } = classify(`${it.title} ${it.description || ""} ${source}`);
    const s = tone(`${it.title} ${it.description || ""}`);
    const url = it.link || "";
    const hash = await digestHex(`${source}|${it.title}|${url}|${it.published_at || ""}`);
    try {
      await env.DB.prepare(
        `INSERT INTO news(hash,title,url,source,category,region,lang,published_at,summary,sentiment,impact)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      ).bind(
        hash,
        it.title,
        url,
        source,
        sector,
        region,
        null,
        it.published_at || nowISO(),
        (it.description || "").slice(0, 1000),
        s,
        Math.max(0, Math.min(100, 50 + s * 20))
      ).run();
      inserted++;
    } catch (_) {
      /* doublon -> ignore */
    }
  }
  return inserted;
}

async function fetchRSS(url) {
  const r = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  return parseRSS(await r.text());
}

async function recomputeIndices(env) {
  const q = await env.DB.prepare(`
    WITH win AS (
      SELECT region, category AS sector, sentiment
      FROM news
      WHERE published_at >= datetime('now','-1 day')
    )
    SELECT region, sector, AVG(COALESCE(sentiment,0)) AS s
    FROM win
    GROUP BY region, sector
  `).all();
  const now = nowISO();
  for (const r of (q.results || [])) {
    const score = Math.max(0, Math.min(100, Math.round(50 + (r.s || 0) * 20)));
    await env.DB.prepare(
      `INSERT INTO indices(region,sector,score,updated_at) VALUES(?1,?2,?3,?4)`
    ).bind(r.region || "monde", r.sector || "autre", score, now).run();
  }
}

async function generateSignals(env) {
  const q = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM news
    WHERE category='energie' AND region='eu' AND sentiment<0
      AND published_at >= datetime('now','-1 day')
  `).first();
  if ((q?.n || 0) >= 15) {
    await env.DB.prepare(
      `INSERT INTO signals(topic,level,reason,created_at)
       VALUES('energie/eu','orange','>15 actus négatives énergie EU sur 24h',?1)`
    ).bind(nowISO()).run();
  }
}

async function runIngest(env) {
  await ensureSchema(env);
  let total = 0;
  for (const s of SOURCES) {
    try {
      if (s.type === "rss") total += await saveNews(env, await fetchRSS(s.url), s.name);
    } catch (e) {
      console.error("⚠️ Source failed:", s.name, e);
    }
  }
  await recomputeIndices(env);
  await generateSignals(env);
  await setMeta(env, "last_run", nowISO());
  return { ok: true, inserted: total };
}

// -------- UI (/app) --------
const APP_HTML = `<!doctype html>
<html lang="fr">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>World Sentinel</title>
<style>
:root { color-scheme: dark; }
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; margin:0; background:#0f172a; color:#e2e8f0}
.header{display:flex;gap:.75rem;align-items:center;padding:20px 24px;border-bottom:1px solid #1e293b}
h1{font-size:20px;margin:0}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;background:#334155;color:#e2e8f0;margin-left:8px}
.toolbar{display:flex;gap:12px;align-items:center;padding:16px 24px}
select,input,button{background:#0b1220;color:#e2e8f0;border:1px solid #233046;border-radius:8px;padding:8px 10px}
button.primary{background:#1e293b;border-color:#2a3a55}
.tabs{display:flex;gap:10px;padding:0 24px}
.tab{padding:8px 14px;border:1px solid #263248;border-bottom:none;border-radius:10px 10px 0 0;background:#0b1220;cursor:pointer}
.tab.active{background:#12213a}
.panel{margin:0 24px 24px;border:1px solid #263248;border-radius:0 10px 10px 10px;background:#12213a;overflow:auto}
.table{width:100%;border-collapse:collapse}
.table th,.table td{padding:10px 12px;border-bottom:1px solid #1e2a44}
.table th{text-align:left;color:#93c5fd}
.small{opacity:.7;font-size:12px}
</style>
<body>
<div class="header">
  <div>🌍</div>
  <h1>World Sentinel</h1>
  <span class="badge">alpha</span>
</div>
<div class="toolbar">
  <label>Secteur
    <select id="sector">
      <option value="">Tous</option>
      <option value="energie">Energie</option>
      <option value="banques">Banques</option>
      <option value="technologie">Technologie</option>
      <option value="auto">Auto</option>
      <option value="autre">Autre</option>
    </select>
  </label>
  <label>Région
    <select id="region">
      <option value="">Toutes</option>
      <option value="eu">EU</option>
      <option value="fr">FR</option>
      <option value="us">US</option>
      <option value="monde">Monde</option>
    </select>
  </label>
  <label>Limite
    <input id="limit" type="number" value="50" min="1" max="200"/>
  </label>
  <button id="btnRefresh" class="primary">Actualiser</button>
  <button id="btnIngest">Ingestion</button>
  <div class="small">Dernier cron : <span id="lastCron">—</span></div>
</div>

<div class="tabs">
  <div class="tab active" data-tab="indices">Indices</div>
  <div class="tab" data-tab="news">Actualités</div>
  <div class="tab" data-tab="signals">Signaux</div>
</div>

<div class="panel">
  <table class="table" id="table">
    <thead><tr id="thead"></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
async function getJSON(url){ const r = await fetch(url); return r.json(); }
function esc(s){ return String(s ?? "").replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function refresh(){
  const sector = document.getElementById('sector').value;
  const region = document.getElementById('region').value;
  const limit  = document.getElementById('limit').value || 50;
  const active = document.querySelector('.tab.active').dataset.tab;

  document.getElementById('lastCron').textContent = '...';
  const last = await getJSON('/api/last-run');
  document.getElementById('lastCron').textContent = last.last_run || '—';

  const thead = document.getElementById('thead');
  const tbody = document.getElementById('tbody');
  tbody.innerHTML='';

  if (active === 'indices'){
    thead.innerHTML = '<th>Région</th><th>Secteur</th><th>Score</th><th>Mise à jour</th>';
    const rows = await getJSON('/api/indices');
    for (const r of rows){
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>'+esc(r.region)+'</td><td>'+esc(r.sector)+'</td><td>'+esc(r.score)+'</td><td>'+esc(r.updated_at)+'</td>';
      tbody.appendChild(tr);
    }
  } else if (active === 'news'){
    thead.innerHTML = '<th>Titre</th><th>Source</th><th>Secteur</th><th>Région</th><th>Date</th><th>Sentiment</th>';
    const q = new URLSearchParams();
    if (sector) q.set('sector',sector);
    if (region) q.set('region',region);
    q.set('limit',limit);
    const rows = await getJSON('/api/news?'+q.toString());
    for (const n of rows){
      const tr = document.createElement('tr');
      const link = n.url ? '<a href="'+esc(n.url)+'" target="_blank">'+esc(n.source||'source')+'</a>' : esc(n.source||'source');
      tr.innerHTML = '<td>'+esc(n.title)+'</td><td>'+link+'</td><td>'+esc(n.category)+'</td><td>'+esc(n.region)+'</td><td>'+esc(n.published_at)+'</td><td>'+esc(n.sentiment)+'</td>';
      tbody.appendChild(tr);
    }
  } else {
    thead.innerHTML = '<th>Topic</th><th>Niveau</th><th>Raison</th><th>Date</th>';
    const rows = await getJSON('/api/signals');
    for (const s of rows){
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>'+esc(s.topic)+'</td><td>'+esc(s.level)+'</td><td>'+esc(s.reason)+'</td><td>'+esc(s.created_at)+'</td>';
      tbody.appendChild(tr);
    }
  }
}

document.getElementById('btnRefresh').addEventListener('click', refresh);
document.getElementById('btnIngest').addEventListener('click', async () => {
  const res = await getJSON('/admin/run?key=1234abc'); // ⚠️ remplace en prod par ta vraie clé stockée en secret
  alert('Ingestion: ' + (res.ok ? ('ok ('+res.inserted+')') : res.error));
  refresh();
});
for (const el of document.querySelectorAll('.tab')){
  el.addEventListener('click', e => {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    el.classList.add('active');
    refresh();
  });
}
refresh();
</script>
</body></html>`;

// -------- HTTP --------
function home(){
  return H(`<!doctype html><meta charset="utf-8"><title>World Sentinel</title>
  <h1>World Sentinel</h1>
  <p>Serveur + Base OK ✅</p>
  <ul>
    <li>Ping: <code>/api/health</code></li>
    <li>Dernier cron: <code>/api/last-run</code></li>
    <li>News: <code>/api/news?limit=50&sector=energie&region=eu</code></li>
    <li>Indices: <code>/api/indices</code></li>
    <li>Signaux: <code>/api/signals</code></li>
    <li>Sources: <code>/api/sources</code></li>
    <li>Interface: <code>/app</code></li>
    <li>Ingestion (protégé): <code>/admin/run?key=VOTRE_CLE</code></li>
  </ul>`);
}

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const p = url.pathname;

    try {
      if (p === "/")               return home();
      if (p === "/app")           return H(APP_HTML, 200, { "cache-control":"no-store" });
      if (p === "/api/health")     return J({ ok: true, time: nowISO() });
      if (p === "/api/last-run")   { await ensureSchema(env); return J({ ok: true, last_run: await getMeta(env, "last_run") }); }
      if (p === "/api/sources")    return J(SOURCES.map(s => ({ name: s.name, type: s.type, url: s.url })));

      if (p === "/admin/run"){
        const key = url.searchParams.get("key") || "";
        const storedKey = env.SECRETS ? await env.SECRETS.get("API_KEY") : (env.API_KEY || "");
        if (!storedKey)        return J({ ok: false, error: "API_KEY non configurée (Secrets Store ou variable)" }, 500);
        if (key !== storedKey) return J({ ok: false, error: "unauthorized" }, 401);
        return J(await runIngest(env));
      }

      if (p === "/api/news"){
        await ensureSchema(env);
        const sector = url.searchParams.get("sector");
        const region = url.searchParams.get("region");
        const limit  = Math.min(Number(url.searchParams.get("limit") || 50), 200);

        let q = `SELECT title,url,source,category,region,lang,published_at,summary,sentiment,impact FROM news`;
        const w = [], b = [];
        if (sector){ w.push("category=?"); b.push(sector); }
        if (region){ w.push("region=?");   b.push(region); }
        if (w.length) q += " WHERE " + w.join(" AND ");
        q += " ORDER BY published_at DESC LIMIT ?";
        b.push(limit);

        const rs = await env.DB.prepare(q).bind(...b).all();
        return J(rs.results || []);
      }

      if (p === "/api/indices"){
        await ensureSchema(env);
        const rs = await env.DB.prepare(
          `SELECT region,sector,score,updated_at FROM indices ORDER BY id DESC LIMIT 200`
        ).all();
        return J(rs.results || []);
      }

      if (p === "/api/signals"){
        await ensureSchema(env);
        const rs = await env.DB.prepare(
          `SELECT topic,level,reason,created_at FROM signals ORDER BY id DESC LIMIT 100`
        ).all();
        return J(rs.results || []);
      }

      return J({ ok:false, error:"Not found" }, 404);
    } catch(e){
      console.error("💥 Worker error:", e);
      return J({ ok:false, error:String(e?.message || e) }, 500);
    }
  },
  async scheduled(_event, env, ctx){
    ctx.waitUntil(runIngest(env).catch(e => console.error("cron", e)));
  }
};
