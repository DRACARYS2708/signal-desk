/* ============================================================================
   SIGNAL DESK — real-time backend (Fyers data feed, free)
   ----------------------------------------------------------------------------
   The site opens for anyone and shows "Log in with Fyers". Each visitor logs in
   with their own Fyers account and gets their own session; prices, candles and
   the option chain then come in real time through the Fyers API v3.

   Note: an app created at myapi.fyers.in only accepts its creator's Fyers
   account. For other people to log in, Fyers has to approve the app for
   third-party use. Until then, other visitors' logins are refused by Fyers.

   Settings (environment variables — set them on your host, never in this file):

     FYERS_APP_ID      required   App ID of the app you create at myapi.fyers.in
     FYERS_SECRET_ID   required   Secret ID of that app
     SITE_PASSWORD     optional   asks every visitor for this password before the
                                  page opens. Leave it unset for a normal public site.
     PUBLIC_URL        optional   your site address, if the host doesn't provide
                                  it (Render does)

   The Fyers app's redirect address must be:  <your site address>/auth/callback

   Run:  npm install && node server.js      (needs Node 18+)
   ========================================================================= */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 8787;
const env = k => (process.env[k] || "").trim();
const APP_ID = env("FYERS_APP_ID");
const SECRET = env("FYERS_SECRET_ID");
const { AsyncLocalStorage } = require("async_hooks");
const SITE_PASSWORD = env("SITE_PASSWORD");
const BASE = (env("PUBLIC_URL") || env("RENDER_EXTERNAL_URL") || `http://localhost:${PORT}`).replace(/\/+$/, "");
const REDIRECT = BASE + "/auth/callback";
const API = env("FYERS_API_BASE") || "https://api-t1.fyers.in/api/v3";
const DATA = env("FYERS_DATA_BASE") || "https://api-t1.fyers.in/data";
const APP_HASH = crypto.createHash("sha256").update(APP_ID + ":" + SECRET).digest("hex");
const IST = 19800000;                       // UTC+5:30 in ms
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istDay = ms => new Date(ms + IST).toISOString().slice(0, 10);

/* ------------------------------------------------------------- universe -- */
/* `cands` lists the Fyers symbols to try, in order; the first one Fyers
   recognises is used. MCX futures roll every month, so their candidates are
   generated from the calendar and the nearest live contract wins.
   `lot` is a fallback table — check it against your broker before sizing.
   `open`/`close` are session times in minutes after midnight IST. */
const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function mcxCands(root) {
  const d = new Date(Date.now() + IST), out = [];
  for (let k = 0; k < 7; k++) {
    const m = d.getUTCMonth() + k, y = d.getUTCFullYear() + Math.floor(m / 12);
    out.push(`MCX:${root}${String(y).slice(2)}${MON[m % 12]}FUT`);
  }
  return out;
}
const idx = (name, tkr, sym, step, lot) => ({ name, tkr, seg:"IDX", cands:() => [sym], step, lot, fo:true });
const eq  = (name, tkr, step, lot, alt) => ({ name, tkr, seg:"EQ", cands:() => [`NSE:${tkr}-EQ`].concat(alt || []), step, lot, fo:true });
const mcx = (name, tkr, step) => ({ name, tkr, seg:"MCX", cands:() => mcxCands(tkr), step, lot:null, fo:true, open:540, close:1410 });

const UNIVERSE = [
  idx("NIFTY 50", "NIFTY", "NSE:NIFTY50-INDEX", 50, 75),
  idx("BANK NIFTY", "BANKNIFTY", "NSE:NIFTYBANK-INDEX", 100, 30),
  idx("FIN NIFTY", "FINNIFTY", "NSE:FINNIFTY-INDEX", 50, 65),
  idx("MIDCAP NIFTY", "MIDCPNIFTY", "NSE:MIDCPNIFTY-INDEX", 25, 120),
  idx("SENSEX", "SENSEX", "BSE:SENSEX-INDEX", 100, 20),
  mcx("CRUDE OIL", "CRUDEOIL", 50),
  mcx("NATURAL GAS", "NATURALGAS", 5),
  mcx("GOLD", "GOLD", 100),
  mcx("COPPER", "COPPER", 5),
  mcx("SILVER", "SILVER", 100),
  eq("RELIANCE", "RELIANCE", 20, 500),
  eq("HDFC BANK", "HDFCBANK", 20, 550),
  eq("ICICI BANK", "ICICIBANK", 10, 700),
  eq("INFOSYS", "INFY", 20, 400),
  eq("TCS", "TCS", 40, 175),
  eq("SBIN", "SBIN", 10, 750),
  eq("TATA MOTORS", "TATAMOTORS", 10, null, ["NSE:TMPV-EQ"]),
  eq("BAJAJ FINANCE", "BAJFINANCE", 10, 750),
  eq("FEDERAL BANK", "FEDERALBNK", 2.5, null),
  eq("COAL INDIA", "COALINDIA", 5, null),
  eq("AXIS BANK", "AXISBANK", 10, null),
  eq("KOTAK BANK", "KOTAKBANK", 20, null),
  eq("ITC", "ITC", 5, null),
  eq("L&T", "LT", 20, null),
  eq("BHARTI AIRTEL", "BHARTIARTL", 20, null),
  eq("TATA STEEL", "TATASTEEL", 2.5, null),
  eq("HDFC AMC", "HDFCAMC", 50, 150),
];
UNIVERSE.forEach(u => { u.open = u.open || 555; u.close = u.close || 930; u.fy = null; });
/* A single option contract (a call or a put) can be charted too. It is not in
   the list above; the page asks for it by its Fyers symbol. */
const OPT_RE = /^(NSE|BSE|MCX):[A-Z0-9&_-]{3,40}(CE|PE)$/;
const optionOf = t => OPT_RE.test(t)
  ? { tkr: t, fy: t, name: t, seg: "OPT", fo: false, open: t.startsWith("MCX") ? 540 : 555, close: t.startsWith("MCX") ? 1410 : 930 }
  : null;
const bySym = t => UNIVERSE.find(u => u.tkr === t && u.fy) || optionOf(String(t || ""));
const live = () => UNIVERSE.filter(u => u.fy);

/* ----------------------------------------------------------------- login -- */
/* One session per visitor, found by a cookie. Whatever a request does later —
   however deep in the code — `auth` is that visitor's own session, so one
   person's Fyers login is never used as another person's. */
const NEED_LOGIN = "Log in with Fyers to start the live feed.";
const sessions = new Map();
const blank = () => ({ access: null, exp: 0, error: null, seen: Date.now() });
const visitor = new AsyncLocalStorage(), NOBODY = blank();
const auth = new Proxy({}, {
  get: (_t, k) => (visitor.getStore() || NOBODY)[k],
  set: (_t, k, v) => { (visitor.getStore() || NOBODY)[k] = v; return true; },
});
setInterval(() => {                           // forget visitors not seen for a day and a half
  for (const [k, v] of sessions) if (Date.now() - v.seen > 36 * 3600e3) sessions.delete(k);
}, 3600e3).unref();

function jwtExp(tok) {
  try { return JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).exp * 1000 || 0; }
  catch (e) { return 0; }
}
function setAccess(tok) { auth.access = tok; auth.exp = jwtExp(tok); auth.error = null; }
function dropAccess(why) { auth.access = null; auth.exp = 0; auth.error = why || NEED_LOGIN; }
const hasAccess = () => !!auth.access && (!auth.exp || Date.now() < auth.exp - 60000);

async function postJson(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.s !== "ok" || !j.access_token) throw new Error(j.message || ("Fyers answered HTTP " + r.status));
  return j;
}
const exchangeCode = code => postJson(API + "/validate-authcode",
  { grant_type: "authorization_code", appIdHash: APP_HASH, code });

async function access() {
  if (!APP_ID || !SECRET) throw new Error(auth.error = "FYERS_APP_ID and FYERS_SECRET_ID are not set on the server.");
  if (hasAccess()) return auth.access;
  dropAccess(NEED_LOGIN);
  throw new Error(NEED_LOGIN);
}

/* ------------------------------------------------------- Fyers requests -- */
/* Fyers allows 10 requests a second and 200 a minute. One queue with a gap
   keeps us well inside both. */
let tail = Promise.resolve(), lastCall = 0;
function queued(fn) {
  const run = tail.then(async () => {
    const wait = lastCall + 130 - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastCall = Date.now(); }
  });
  tail = run.catch(() => {});
  return run;
}
const AUTH_CODES = [-8, -15, -16, -17];

async function fy(pathname, params) {
  const tok = await access();
  const r = await queued(() => fetch(DATA + pathname + "?" + new URLSearchParams(params),
    { headers: { Authorization: APP_ID + ":" + tok, version: "3", Accept: "application/json" } }));
  const j = await r.json().catch(() => null);
  if (j && (j.s === "ok" || j.s === "no_data")) return j;
  const code = j ? Number(j.code) : 0;
  if (r.status === 401 || r.status === 403 || AUTH_CODES.includes(code)) {
    dropAccess(NEED_LOGIN);
    throw new Error(NEED_LOGIN);
  }
  if (r.status === 429 || code === -429) throw new Error("Fyers rate limit reached; slowing down.");
  const e = new Error((j && (j.message || j.errmsg)) || ("Fyers answered HTTP " + r.status));
  e.code = code; throw e;
}

/* ------------------------------------------------------------------ cache -- */
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.pending || Promise.resolve(hit.val);
  const pending = fn().then(
    val => { cache.set(key, { at: Date.now(), val }); return val; },
    err => { if (hit && hit.val !== undefined) cache.set(key, { at: hit.at, val: hit.val }); else cache.delete(key); throw err; });
  cache.set(key, { at: hit ? hit.at : 0, val: hit ? hit.val : undefined, pending });
  return pending;
}

/* --------------------------------------------------- instrument look-up -- */
/* Ask Fyers which candidate symbol is live for each instrument. Done once per
   login and again each new day, so MCX contracts roll by themselves. */
let resolved = null;                          // { day, promise }
async function probe(sym) {
  try {
    const j = await fy("/quotes", { symbols: sym });
    const d = j.d && j.d[0];
    return !!(d && d.s !== "error" && d.v && d.v.lp > 0);
  } catch (e) {
    if (e.message === NEED_LOGIN) throw e;
    return false;
  }
}
function ensureUniverse() {
  const day = istDay(Date.now());
  if (resolved && resolved.day === day) return resolved.promise;
  const promise = (async () => {
    await Promise.all(UNIVERSE.map(async u => {
      let found = null;
      for (const c of u.cands()) { if (await probe(c)) { found = c; break; } }
      if (found !== u.fy) cache.clear();
      u.fy = found;
      // "MCX:CRUDEOIL26OCTFUT" -> show the contract month beside the name
      const m = found && /(\d{2})([A-Z]{3})FUT$/.exec(found);
      u.label = m ? `${u.name} ${m[2][0]}${m[2].slice(1).toLowerCase()}` : u.name;
    }));
    const lost = UNIVERSE.filter(u => !u.fy).map(u => u.name);
    console.log(`  instruments live: ${live().length}/${UNIVERSE.length}` + (lost.length ? " — not found: " + lost.join(", ") : ""));
  })();
  resolved = { day, promise };
  promise.catch(() => { resolved = null; });
  return promise;
}

/* ------------------------------------------------------------------ app -- */
const app = express();
app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json({ limit: "20kb" }));

/* Lets a phone or computer install the site as an app (Add to Home screen).
   Served before the password check; neither holds anything private. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0F1319"/>
<path d="M96 344l88-96 72 56 112-152" fill="none" stroke="#26A96C" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="368" cy="152" r="34" fill="#4C9AFF"/></svg>`;
app.get("/icon.svg", (_req, res) => res.type("image/svg+xml").send(ICON));
app.get("/manifest.webmanifest", (_req, res) => res.type("application/manifest+json").json({
  name: "Signal Desk", short_name: "Signal Desk", start_url: "/", scope: "/", display: "standalone",
  background_color: "#0F1319", theme_color: "#161B23",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
}));

/* Optional password. Real-time exchange data is licensed to you for your own
   use, and every visitor spends your Fyers request limit, so keep it private. */
if (SITE_PASSWORD) app.use((req, res, next) => {
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  const given = m ? Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":") : "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(SITE_PASSWORD).digest();
  if (m && crypto.timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Signal Desk"').status(401).send("Password required");
});

app.use((req, res, next) => {
  const m = /(?:^|;\s*)sd_sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
  let sid = m && m[1], s = sid && sessions.get(sid);
  if (!s) {
    if (sessions.size > 20000) sessions.delete(sessions.keys().next().value);
    if (!sid) sid = crypto.randomBytes(24).toString("hex");
    s = blank(); sessions.set(sid, s);
    res.append("Set-Cookie", `sd_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${BASE.startsWith("https") ? "; Secure" : ""}`);
  }
  s.seen = Date.now(); req.sid = sid;
  visitor.run(s, next);
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

/* ---- login with Fyers ---------------------------------------------------- */
const states = new Map();                     // one-time values that tie a login to this site
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Desk</title><body style="font:17px/1.6 system-ui;background:#0F1319;color:#E4E9F0;padding:40px 20px;max-width:560px;margin:auto">
<h2 style="font-size:22px">${title}</h2>${body}</body>`;
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

app.get("/auth/login", (req, res) => {
  if (!APP_ID || !SECRET) return res.status(500).send(page("Setup is not finished",
    "<p>FYERS_APP_ID and FYERS_SECRET_ID are not set on the server.</p>"));
  const state = crypto.randomBytes(16).toString("hex");
  states.set(state, { at: Date.now(), sid: req.sid });
  for (const [k, v] of states) if (Date.now() - v.at > 15 * 60000) states.delete(k);
  res.redirect(API + "/generate-authcode?" + new URLSearchParams(
    { client_id: APP_ID, redirect_uri: REDIRECT, response_type: "code", state }));
});

app.get("/auth/callback", async (req, res) => {
  const fail = why => res.status(400).send(page("Fyers login did not complete",
    `<p>${escHtml(why)}</p><p><a href="/auth/login" style="color:#4C9AFF">Try again</a></p>`));
  const code = req.query.auth_code, state = String(req.query.state || "");
  const st = states.get(state);
  states.delete(state);
  if (!st || st.sid !== req.sid) return fail("This login link has expired. Start again from the site.");
  if (!code) return fail(String(req.query.message || "Fyers did not return a login code."));
  try {
    const j = await exchangeCode(String(code));
    setAccess(j.access_token);
    console.log(`  a visitor logged in with Fyers (${[...sessions.values()].filter(v => v.access).length} logged in now)`);
    // Keep the tokens in this browser too, so the site can wake the server
    // after it sleeps without another login.
    const keep = JSON.stringify({ a: j.access_token }).replace(/</g, "\\u003c");
    res.send(page("Logged in", `<p>Opening Signal Desk…</p><script>
      try{ localStorage.setItem("sd_fy", JSON.stringify(${keep})); }catch(e){}
      location.replace("/");</script>`));
  } catch (e) { fail(e.message + " If this is not the Fyers account that created the app, Fyers has to approve the app for other users first. Otherwise check that FYERS_APP_ID and FYERS_SECRET_ID are correct and that the app's redirect address is exactly " + REDIRECT); }
});

app.post("/auth/logout", (_req, res) => { dropAccess(NEED_LOGIN); res.json({ ok: true }); });

/* After the server restarts it has forgotten every login. The visitor's own
   browser hands its token back; it is accepted only if Fyers still honours it. */
app.post("/auth/restore", async (req, res) => {
  const a = typeof req.body?.a === "string" && req.body.a.length < 4000 ? req.body.a : "";
  try {
    if (!hasAccess()) {
      if (!a || (jwtExp(a) && Date.now() > jwtExp(a) - 60000)) throw new Error(NEED_LOGIN);
      setAccess(a);
      await fy("/quotes", { symbols: "NSE:NIFTY50-INDEX" });
    }
    res.json({ ok: hasAccess(), a: auth.access });
  } catch (e) { dropAccess(NEED_LOGIN); res.json({ ok: false }); }
});

app.get("/api/status", async (_req, res) => {
  let ok = true;
  try { await access(); } catch (e) { ok = false; auth.error = auth.error || e.message; }
  res.json({ authenticated: ok, error: ok ? null : auth.error, login: APP_ID && SECRET ? "/auth/login" : null,
             redirect: REDIRECT, provider: "fyers", delayed: false, pollMs: 5000, ts: Date.now() });
});

const guard = fn => async (req, res) => {
  try {
    await access();                            // the visitor must be logged in themselves
    for (let attempt = 0; ; attempt++) {
      try { await ensureUniverse(); return await fn(req, res); }
      catch (e) {
        // The answer may have been fetched on someone else's login that had just run out. Ask again on this visitor's own.
        if (e.message === NEED_LOGIN && hasAccess() && attempt < 2) continue;
        throw e;
      }
    }
  } catch (e) { if (!res.headersSent) res.status(e.message === NEED_LOGIN ? 401 : 502).json({ error: e.message }); }
};

app.get("/api/instruments", guard(async (_req, res) => res.json(live().map(u => ({
  sym: u.label || u.name, tkr: u.tkr, seg: u.seg, step: u.step, lot: u.lot, lotFromFeed: false,
  fo: u.fo, open: u.open, close: u.close,
})))));

/* -------------------------------------------------------------- candles -- */
const DAYS = { 1: 5, 3: 6, 5: 12, 15: 30, 30: 60, 60: 90 };

app.get("/api/candles", guard(async (req, res) => {
  const u = bySym(req.query.tkr);
  if (!u) return res.status(404).json({ error: "unknown symbol" });
  const want = DAYS[+req.query.interval] ? +req.query.interval : 5;
  res.json(await cached(`c:${u.tkr}:${want}`, 4000, async () => {
    const j = await fy("/history", { symbol: u.fy, resolution: String(want), date_format: "1",
      range_from: istDay(Date.now() - DAYS[want] * 864e5), range_to: istDay(Date.now()), cont_flag: "1" });
    const candles = (j.candles || []).filter(c => c && c.length >= 5 && c[1] != null && c[4] != null)
      .map(c => [c[0] < 1e11 ? c[0] * 1000 : c[0], c[1], c[2], c[3], c[4], c[5] || 0])
      .sort((a, b) => a[0] - b[0]);
    return { tkr: u.tkr, interval: want + "m", candles };
  }));
}));

/* --------------------------------------------------------------- quotes -- */
app.get("/api/quotes", guard(async (req, res) => {
  // `x` = option contracts the viewer has opened, quoted alongside the watchlist
  const extra = [...new Set(String(req.query.x || "").split(",").filter(s => OPT_RE.test(s)))].slice(0, 20);
  const out = await cached("quotes:" + extra.join(","), 3000, async () => {
    const j = await fy("/quotes", { symbols: live().map(u => u.fy).concat(extra).join(",") });
    const q = {};
    for (const d of j.d || []) {
      const u = UNIVERSE.find(x => x.fy === d.n) || (extra.includes(d.n) ? { tkr: d.n } : null), v = d.v;
      if (!u || !v || v.lp == null) continue;
      const prev = v.prev_close_price > 0 ? v.prev_close_price : null;
      q[u.tkr] = { ltp: v.lp, open: v.open_price || null, high: v.high_price || null, low: v.low_price || null,
                   close: prev, chg: v.chp != null ? v.chp : (prev ? ((v.lp - prev) / prev) * 100 : 0), vol: v.volume || 0 };
    }
    return q;
  });
  res.json({ ts: Date.now(), quotes: out, delayed: false });
}));

/* ---------------------------------------------------------- option chain -- */
const isoOf = dmy => { const [d, m, y] = String(dmy).split("-"); return `${y}-${m}-${d}`; };
async function rawChain(u, epoch) {
  const p = { symbol: u.fy, strikecount: "20", timestamp: epoch || "" };
  try { return await fy("/options-chain-v3", { ...p, greeks: "1" }); }
  catch (e) { if (e.message === NEED_LOGIN) throw e; return fy("/options-chain-v3", p); }
}
const chainOf = (u, epoch) => cached(`ch:${u.tkr}:${epoch || ""}`, 6000, () => rawChain(u, epoch));
async function expiriesOf(u) {
  const j = await chainOf(u, "");
  const list = (j.data?.expiryData || []).map(e => ({ iso: isoOf(e.date), epoch: String(e.expiry) }))
    .sort((a, b) => a.epoch - b.epoch);
  if (list.length) u.expiries = list;
  return u.expiries || [];
}

app.get("/api/expiries", guard(async (req, res) => {
  const u = bySym(req.query.tkr);
  if (!u) return res.status(404).json({ error: "unknown symbol" });
  if (!u.fo) return res.json({ expiries: [], note: "no option chain for this instrument" });
  res.json({ expiries: (await expiriesOf(u)).slice(0, 6).map(e => e.iso) });
}));

app.get("/api/chain", guard(async (req, res) => {
  const u = bySym(req.query.tkr);
  if (!u) return res.status(404).json({ error: "unknown symbol" });
  if (!u.fo) return res.status(404).json({ error: "no option chain for " + u.name });
  const list = await expiriesOf(u);
  if (!list.length) throw new Error("Fyers returned no expiries for " + u.name);
  const pick = list.find(e => e.iso === req.query.expiry) || list[0];
  const j = await chainOf(u, pick === list[0] ? "" : pick.epoch);

  const iv = v => (v > 0 ? (v > 3 ? v / 100 : v) : null);   // percent or fraction, either way
  let spot = null, prevClose = null; const by = new Map();
  for (const e of j.data?.optionsChain || []) {
    if (e.option_type !== "CE" && e.option_type !== "PE") {
      if (e.ltp > 0) { spot = e.ltp; prevClose = e.ltpch != null ? e.ltp - e.ltpch : null; }
      continue;
    }
    const row = by.get(e.strike_price) || { strike: e.strike_price };
    row[e.option_type === "CE" ? "ce" : "pe"] = {
      sym: OPT_RE.test(e.symbol || "") ? e.symbol : null,
      ltp: e.ltp || 0, oi: e.oi || 0, chgOi: e.oich || 0, vol: e.volume || 0, chg: e.ltpch || 0,
      iv: iv(e.iv ?? e.greeks?.iv), bid: e.bid || null, ask: e.ask || null };
    by.set(e.strike_price, row);
  }
  const rows = [...by.values()].filter(r => r.ce && r.pe).sort((a, b) => a.strike - b.strike);
  if (!rows.length || !spot) throw new Error("Fyers returned an empty option chain for " + u.name);
  const near = rows.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
                   .slice(0, 7).map(r => r.strike).sort((a, b) => a - b);
  const gaps = near.slice(1).map((s, i) => s - near[i]).filter(g => g > 0).sort((a, b) => a - b);
  const step = gaps.length ? gaps[0] : u.step;
  const atm = Math.round(spot / step) * step;
  const daysOut = Math.max((pick.epoch * 1000 - Date.now()) / 864e5, 0.02);
  res.json({ tkr: u.tkr, expiry: pick.iso, expiries: list.map(e => e.iso), spot, prevClose, atm, step,
             lot: u.lot, daysOut, rows, ivFromFeed: true });
}));

app.listen(PORT, () => {
  console.log(`\nSignal Desk (Fyers real-time feed) on ${BASE}`);
  console.log("  Fyers app  : " + (APP_ID && SECRET ? "set" : "NOT SET — add FYERS_APP_ID and FYERS_SECRET_ID"));
  console.log("  redirect   : " + REDIRECT + "   (enter exactly this in the Fyers app)");
  console.log("  visitors   : each logs in with their own Fyers account");
  console.log("  password   : " + (SITE_PASSWORD ? "on — asked before the page opens" : "off — the site opens normally") + "\n");
});
