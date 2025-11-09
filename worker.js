// worker.js — World Sentinel (Signals v2, sans install locale)
// -----------------------------------------------------------
// BINDINGS Cloudflare à avoir (déjà faits chez toi) :
// - D1 Database binding : Name = DB  → pointe sur ta base ws-db
// - Secret/API          : API_KEY    → pour /admin/run
// - Cron trigger        : ex. 0 */3 * * *  (toutes les 3h) ou 0 5 * * *  (5h)

// Petit log
console.log("🛰️ World Sentinel boot:", new Date().toISOString());

// ---------- Utils ----------
const J = (o, s=200, h={}) => new Response(JSON.stringify(o, null, 2),
  { status:s, headers:{ "content-type":"application/json; charset=utf-8", ...h }});
const H = (b, s=200) => new Response(b,
  { status:s, headers:{ "content-type":"text/html; charset=utf-8" }});
const nowISO = () => new Date().toISOString();
async function digestHex(str){
  const b = new TextEncoder().encode(str);
  const d = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2,"0")).join("");
}

// ---------- Config Signaux (fallback embarqué) ----------
const SIGNALS_CONFIG = {
  window_hours: 24,
  volume_sigma_orange: 2.0,
  volume_sigma_rouge: 3.0,
  sentiment_orange: { min: -1, max: -0.5 },
  sentiment_rouge:  { min: -1, max: -0.8 },
  positive_orange:  { min:  0.5, max:  1 },
  positive_rouge:   { min:  0.8, max:  1 },

  // Familles de mots-clés (détection “thème”)
  families: {
    energie:  ["opec","opep","oil","pétrole","gaz","pipeline","raffinerie","énergie","blackout","electricity"],
    banques:  ["bce","ecb","fed","taux","rate","qe","qt","liquidity","bank","banque","credit"],
    tech:     ["ai","chip","semi","nvidia","intel","export control","data center","cloud","software"],
    auto:     ["tesla","toyota","volkswagen","voiture","automobile","ev","battery"],
    crypto:   ["bitcoin","crypto","ethereum","binance","coinbase","wallet","hack","listing","delisting"],
    reg:      ["sec","amf","esma","antitrust","sanction","embargo","tariff","droit de douane","ban","enquête"],
    social:   ["strike","grève","protest","manifestation","blocage","syndicat"],
    geo:      ["war","guerre","ceasefire","cessez-le-feu","attaque","missile","otAN","ONU"]
  },

  // Liste blanche “sources officielles” (on cherche ces noms dans source ou titre)
  whitelist_officielles: [
    "White House","Federal Reserve","U.S. Treasury","U.S. Commerce",
    "European Commission","European Central Bank","ECB","BCE","ESMA","AMF",
    "OPEC","IEA","RTE","CRE",
    "United Nations","UN","OTAN","NATO","IMF","World Bank","Banque mondiale",
    "Elysée","Matignon","Ministère"
  ]
};

// ---------- Schéma D1 ----------
async function runDDL(env, ddl){
  const stmts = ddl.split(";").map(s => s.trim()).filter(Boolean);
  for (const sql of stmts){ await env.DB.prepare(sql).run(); }
}
async function ensureSchema(env){
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
  );`;
  await runDDL(env, ddl);
}
async function setMeta(env,k,v){
  await env.DB.prepare(
    `INSERT INTO meta(k,v) VALUES(?1,?2)
     ON CONFLICT(k) DO UPDATE SET v=excluded.v`
  ).bind(k,v).run();
}
async function getMeta(env,k){
  const r = await env.DB.prepare(`SELECT v FROM meta WHERE k=?1`).bind(k).first();
  return r?.v ?? null;
}

// ---------- Parsing RSS ----------
function parseRSS(xml){
  const items = [];
  const it = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of it){
    const g = re => (block.match(re)||["",""])[1]?.trim()||"";
    const title = g(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const link  = g(/<link[^>]*>([\s\S]*?)<\/link>/i) || (block.match(/<link[^>]*href="([^"]+)"/i)||["",""])[1] || "";
    const guid  = g(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || link || title || crypto.randomUUID();
    const pub   = g(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || g(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || g(/<published[^>]*>([\s\S]*?)<\/published>/i) || "";
    const desc  = g(/<description[^>]*>([\s\S]*?)<\/description>/i) || g(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || "";
    if (title) items.push({ title, link, guid, published_at: pub, description: desc });
  }
  return items;
}

// ---------- Classif & ton ----------
function classify(text){
  const t=(text||"").toLowerCase();
  let sector="autre";
  if (/oil|opec|energie|energy|gaz|pétrole/.test(t)) sector="energie";
  else if (/bank|banque|credit|finance|fed|ecb|bce|taux/.test(t)) sector="banques";
  else if (/chip|semi|nvidia|intel|ai|cloud|tech|software|apple|google|microsoft/.test(t)) sector="technologie";
  else if (/auto|tesla|toyota|volkswagen/.test(t)) sector="auto";
  else if (/bitcoin|crypto|ethereum|binance|coinbase/.test(t)) sector="crypto";
  let region = "monde";
  if (/france|paris|macron|amf/.test(t)) region="fr";
  else if (/europe|eurozone|germany|german|ecb|bce|commission/.test(t)) region="eu";
  else if (/usa|u\.s\.|united states|washington|sec\b/.test(t)) region="us";
  return { sector, region };
}
function tone(text){
  const t = (text||"").toLowerCase();
  const pos = /record profit|beat|growth|upgrade|rally|optimis|green|progress|surge|boom/.test(t);
  const neg = /crisis|war|conflict|down|drop|cut|ban|fine|probe|fraud|red|strike|sanction|layoff|collapse|plunge/.test(t);
  return pos && !neg ? 1 : (!pos && neg ? -1 : 0);
}

// ---------- Sources (point de départ robuste) ----------
const SOURCES = [
  { name:"Reuters World",       type:"rss", url:"https://www.reuters.com/world/rss" },
  { name:"AP News World",       type:"rss", url:"https://apnews.com/hub/apf-worldnews?output=rss" },
  { name:"BBC World",           type:"rss", url:"http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name:"The Guardian World",  type:"rss", url:"https://www.theguardian.com/world/rss" },
  { name:"DW",                  type:"rss", url:"https://rss.dw.com/rdf/rss-en-world" },
  { name:"Euronews",            type:"rss", url:"https://www.euronews.com/rss?level=theme&name=news" },
  { name:"EU Commission",       type:"rss", url:"https://ec.europa.eu/commission/presscorner/home/en?format=rss" },
  { name:"ECB Press",           type:"rss", url:"https://www.ecb.europa.eu/press/press.html?format=rss" },
  { name:"AMF France",          type:"rss", url:"https://www.amf-france.org/fr/actualites?format=rss" },
  { name:"SEC EDGAR current",   type:"rss", url:"https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&dateb=&owner=include&start=0&output=atom" }
];

// ---------- Ingestion ----------
async function fetchRSS(url){
  const r = await fetch(url, { cf:{ cacheTtl:300, cacheEverything:true }});
  return parseRSS(await r.text());
}
async function saveNews(env, items, source){
  let inserted = 0;
  for (const it of items){
    const { sector, region } = classify(`${it.title} ${it.description||""} ${source}`);
    const s = tone(`${it.title} ${it.description||""}`);
    const url  = it.link || "";
    const hash = await digestHex(`${source}|${it.title}|${url}|${it.published_at||""}`);
    try{
      await env.DB.prepare(
        `INSERT INTO news(hash,title,url,source,category,region,lang,published_at,summary,sentiment,impact)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      ).bind(hash, it.title, url, source, sector, region, null,
              it.published_at || nowISO(),
              (it.description||"").slice(0,1000),
              s, Math.max(0, Math.min(100, 50 + s*20))
      ).run();
      inserted++;
    }catch(_){ /* doublon */ }
  }
  return inserted;
}
async function recomputeIndices(env){
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
  const t = nowISO();
  for (const r of (q.results||[])){
    const score = Math.max(0, Math.min(100, Math.round(50 + (r.s || 0) * 20)));
    await env.DB.prepare(
      `INSERT INTO indices(region,sector,score,updated_at) VALUES(?1,?2,?3,?4)`
    ).bind(r.region || "monde", r.sector || "autre", score, t).run();
  }
}

// ---------- Détection des signaux (v2) ----------
function textHasAny(text, list){
  const t = (text||"").toLowerCase();
  return list.some(k => t.includes(k.toLowerCase()));
}
function famillyOf(item){
  const blob = `${item.title} ${item.summary||""} ${item.source||""}`.toLowerCase();
  for (const [fam, words] of Object.entries(SIGNALS_CONFIG.families)){
    if (words.some(w => blob.includes(w.toLowerCase()))) return fam;
  }
  return "autre";
}

async function generateSignals(env){
  const hours = SIGNALS_CONFIG.window_hours || 24;
  const since = `datetime('now','-${hours} hours')`;

  // 1) Compte par "famille" (déduite des mots-clés)
  const rows = await env.DB.prepare(
    `SELECT title, source, summary, category, region, sentiment, published_at
     FROM news WHERE published_at >= ${since}`
  ).all();

  const items = (rows.results||[]).map(r => ({
    ...r,
    fam: famillyOf(r),
    txt: `${r.title} ${r.summary||""} ${r.source||""}`
  }));

  const byFam = {};
  for (const it of items){
    byFam[it.fam] ??= [];
    byFam[it.fam].push(it);
  }

  // 2) Stat volume & sentiment par famille
  for (const [fam, list] of Object.entries(byFam)){
    const count = list.length;
    const avgSent = list.reduce((a,b)=>a+(b.sentiment||0), 0) / Math.max(1,count);

    // Moyenne & σ historique simples (30j) par volume
    const hist = await env.DB.prepare(
      `SELECT COUNT(*) as n
       FROM news
       WHERE published_at >= datetime('now','-30 days')
         AND (${["title","summary","source"].map(c=>`${c} LIKE ?`).join(" OR ")})`
    ).bind(`%${fam}%`,`%${fam}%`,`%${fam}%`).first();

    // On approxime sigma via racine(n) si pas d’info détaillée
    const mean = (hist?.n || 0) / 30; // /jour
    const sigma = Math.max(1, Math.sqrt(mean||1));

    let level = null;
    let reason = [];

    // Volume anormal
    const sigmaScore = (count - mean) / (sigma||1);
    if (sigmaScore >= SIGNALS_CONFIG.volume_sigma_rouge) { level = "rouge"; reason.push(`volume +${sigmaScore.toFixed(1)}σ`); }
    else if (sigmaScore >= SIGNALS_CONFIG.volume_sigma_orange){ level = "orange"; reason.push(`volume +${sigmaScore.toFixed(1)}σ`); }

    // Sentiment agrégé
    if (avgSent <= SIGNALS_CONFIG.sentiment_rouge.max){ level = "rouge"; reason.push(`sentiment ${avgSent.toFixed(2)}`); }
    else if (avgSent <= SIGNALS_CONFIG.sentiment_orange.max){ level ??= "orange"; reason.push(`sentiment ${avgSent.toFixed(2)}`); }

    // Source officielle présente ?
    const hasOfficial = list.some(it => textHasAny(it.txt, SIGNALS_CONFIG.whitelist_officielles));
    if (hasOfficial){ level = (level==="orange" ? "rouge" : (level||"orange")); reason.push("source officielle"); }

    if (level){
      await env.DB.prepare(
        `INSERT INTO signals(topic,level,reason,created_at)
         VALUES(?1,?2,?3,?4)`
      ).bind(fam, level, reason.join(" | "), nowISO()).run();
    }
  }
}

// ---------- Run complet ----------
async function runIngest(env){
  await ensureSchema(env);
  let total = 0;
  for (const s of SOURCES){
    try{
      total += await saveNews(env, await fetchRSS(s.url), s.name);
    }catch(e){ /* on ignore l’erreur de source */ }
  }
  await recomputeIndices(env);
  await generateSignals(env);
  await setMeta(env, "last_run", nowISO());
  return { ok:true, inserted: total };
}

// ---------- HTTP ----------
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
    <li>Ingestion manuelle (protégé): <code>/admin/run?key=VOTRE_CLE</code></li>
  </ul>`);
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const p   = url.pathname;

    try{
      if (p === "/")               return home();
      if (p === "/api/health")     return J({ ok:true, time: nowISO() });
      if (p === "/api/last-run")   { await ensureSchema(env); return J({ ok:true, last_run: await getMeta(env,"last_run") }); }
      if (p === "/api/sources")    return J(SOURCES.map(s => ({ name:s.name, type:s.type, url:s.url })));

      if (p === "/admin/run"){
        const key = url.searchParams.get("key") || "";
        const storedKey = env.SECRETS ? await env.SECRETS.get("API_KEY") : (env.API_KEY || "");
        if (!storedKey)        return J({ ok:false, error:"API_KEY non configurée" }, 500);
        if (key !== storedKey) return J({ ok:false, error:"unauthorized" }, 401);
        return J(await runIngest(env));
      }

      if (p === "/api/news"){
        await ensureSchema(env);
        const sector = url.searchParams.get("sector");
        const region = url.searchParams.get("region");
        const limit  = Math.min(Number(url.searchParams.get("limit")||50), 200);

        let q = `SELECT title,url,source,category,region,lang,published_at,summary,sentiment,impact FROM news`;
        const w=[]; const b=[];
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
    }catch(e){
      return J({ ok:false, error:String(e?.message || e) }, 500);
    }
  },

  async scheduled(_event, env, ctx){
    ctx.waitUntil(runIngest(env).catch(e => console.error("cron", e)));
  }
};
