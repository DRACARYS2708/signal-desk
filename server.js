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
/* Any other NSE / BSE / MCX symbol found by search: allowed if it is in Fyers' own symbol list. */
const searchedOf = t => {
  const r = SYM.byTicker.get(t); if (!r) return null;
  return { tkr: t, fy: t, name: r.short, seg: r.type, fo: r.fo, lot: r.lot || null, open: r.exch === "MCX" ? 540 : 555, close: r.exch === "MCX" ? 1410 : 930 };
};
const bySym = t => UNIVERSE.find(u => u.tkr === t && u.fy) || optionOf(String(t || "")) || searchedOf(String(t || ""));
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
/* Fyers allows 10 requests a second, 200 a minute and 1,00,000 a day. Stay well
   inside: at most 6 a second and 150 in any 60 seconds, shared by all visitors.
   After a "too many requests" answer, pause for 30 s (longer if it repeats).
   If too many requests are already waiting, refuse new ones at once so callers
   fall back to the last good data instead of waiting minutes. */
const RL = { perMin: 150, gapMs: 170, sent: [], waiting: 0, maxWaiting: 40, pauseUntil: 0, strikes: 0, day: "", dayCount: 0, limited: 0 };
const lane = new AsyncLocalStorage();          // "low" = the background scan; pages' own requests always go first
const Q = { hi: [], lo: [], pumping: false };
function queued(fn) {
  const low = lane.getStore() === "low";
  if (!low && Q.hi.length >= RL.maxWaiting) return Promise.reject(new Error("Fyers rate limit reached; slowing down."));
  return new Promise((resolve, reject) => { (low ? Q.lo : Q.hi).push({ fn, resolve, reject }); RL.waiting = Q.hi.length + Q.lo.length; pump(); });
}
// Starts requests no closer than RL.gapMs apart and within the per-minute budget. Requests run side by side,
// so one slow Fyers answer no longer holds up the ones behind it.
async function pump() {
  if (Q.pumping) return; Q.pumping = true;
  try {
    while (Q.hi.length || Q.lo.length) {
      const now = Date.now();
      RL.sent = RL.sent.filter(t => now - t < 60000);
      let wait = Math.max(lastCall + RL.gapMs - now, RL.pauseUntil - now, 0);
      if (RL.sent.length >= RL.perMin) wait = Math.max(wait, RL.sent[0] + 60000 - now + 50);
      if (wait > 0) { await sleep(Math.min(wait, 1000)); continue; }
      const job = Q.hi.length ? Q.hi.shift() : Q.lo.shift(); RL.waiting = Q.hi.length + Q.lo.length;
      const d = istDay(Date.now()); if (d !== RL.day) { RL.day = d; RL.dayCount = 0; }
      RL.sent.push(Date.now()); RL.dayCount++; lastCall = Date.now();
      Promise.resolve().then(job.fn).then(job.resolve, job.reject);
    }
  } finally { Q.pumping = false; }
}
function rateLimited() {
  RL.limited++; RL.strikes = Math.min(RL.strikes + 1, 4);
  RL.pauseUntil = Date.now() + 30000 * RL.strikes;           // 30 s, then 60, 90, 120
  console.log("  Fyers said too many requests: pausing " + 30 * RL.strikes + " s");
}
const AUTH_CODES = [-8, -15, -16, -17];

async function fy(pathname, params) {
  const tok = await access();
  const url = DATA + pathname + "?" + new URLSearchParams(params);
  const once = () => queued(() => fetch(url, { headers: { Authorization: APP_ID + ":" + tok, version: "3", Accept: "application/json" },
    signal: AbortSignal.timeout(10000) }));
  let r;
  try { r = await once(); }
  catch (e) { try { r = await once(); } catch (e2) { throw new Error("Fyers did not answer in time; try again shortly"); } }
  if (r.status >= 500) { try { r = await once(); } catch (e) {} }
  const j = await r.json().catch(() => null);
  if (j && (j.s === "ok" || j.s === "no_data")) return j;
  const code = j ? Number(j.code) : 0;
  if (r.status === 401 || r.status === 403 || AUTH_CODES.includes(code)) {
    dropAccess(NEED_LOGIN);
    throw new Error(NEED_LOGIN);
  }
  if (r.status === 429 || code === -429) { rateLimited(); throw new Error("Fyers rate limit reached; slowing down."); }
  if (RL.strikes && Date.now() > RL.pauseUntil + 120000) RL.strikes = 0;     // calm again
  const e = new Error((j && (j.message || j.errmsg)) || ("Fyers answered HTTP " + r.status));
  e.code = code; throw e;
}

/* ------------------------------------------------------------------ cache -- */
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  // a refresh is already running: give the last good answer if it is slow (the refresh carries on)
  if (hit && hit.pending) return hit.val !== undefined ? Promise.race([hit.pending, sleep(5000).then(() => hit.val)]) : hit.pending;
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.val);
  const pending = fn().then(
    val => { cache.set(key, { at: Date.now(), val }); return val; },
    err => {
      if (hit && hit.val !== undefined && err.message !== NEED_LOGIN) {      // keep showing the last good answer
        cache.set(key, { at: Date.now() - ttlMs + Math.min(ttlMs, 15000), val: hit.val });   // and ask again a little later
        return hit.val;
      }
      cache.delete(key); throw err; });
  cache.set(key, { at: hit ? hit.at : 0, val: hit ? hit.val : undefined, pending });
  pending.catch(() => {});
  return hit && hit.val !== undefined ? Promise.race([pending, sleep(5000).then(() => hit.val)]) : pending;
}

/* --------------------------------------------------- instrument look-up -- */
/* Ask Fyers which candidate symbol is live for each instrument. Done once per
   login and again each new day, so MCX contracts roll by themselves. */
let resolved = null, lastProbeFailed = false;                          // { day, promise }
/* Which candidate symbols are live: all candidates in one or two quote requests
   (Fyers takes up to 50 symbols per request) instead of one request each. */
async function liveSet(cands) {
  const ok = new Set();
  for (let i = 0; i < cands.length; i += 50) {
    try {
      const j = await fy("/quotes", { symbols: cands.slice(i, i + 50).join(",") });
      for (const d of j.d || []) if (d && d.s !== "error" && d.v && d.v.lp > 0) ok.add(d.n);
    } catch (e) {
      if (e.message === NEED_LOGIN) throw e;
      if (/did not answer|rate limit|HTTP 5/.test(e.message)) { ok.failed = e; continue; }
      // Fyers refused the batch as a whole (for example one unknown symbol): ask one by one.
      for (const s of cands.slice(i, i + 50)) {
        try { const j = await fy("/quotes", { symbols: s }); const d = (j.d || [])[0]; if (d && d.s !== "error" && d.v && d.v.lp > 0) ok.add(d.n); }
        catch (e2) { if (e2.message === NEED_LOGIN) throw e2; if (/did not answer|rate limit|HTTP 5/.test(e2.message)) ok.failed = e2; }
      }
    }
  }
  return ok;
}
function ensureUniverse() {
  const day = istDay(Date.now());
  if (resolved && resolved.day === day) return resolved.promise;
  const promise = (async () => {
    const all = [...new Set(UNIVERSE.flatMap(u => u.cands()))];
    const ok = await liveSet(all); lastProbeFailed = !!ok.failed;
    // If Fyers could not be asked, do not decide anything for the day: try again on the next request.
    // If Fyers could not be asked (busy or rate limited), use the symbol lists instead and ask again in 5 minutes.
    const fallback = ok.failed && (SYM.byTicker.size || UNIVERSE.some(u => u.fy));
    if (ok.failed && !fallback) throw new Error("Fyers is not answering right now (" + ok.failed.message + ")");
    if (ok.failed) setTimeout(() => { if (resolved && resolved.partial) resolved = null; }, 300000);
    for (const u of UNIVERSE) {
      const found = u.cands().find(c => ok.has(c)) || (ok.failed ? (u.fy || u.cands().find(c => SYM.byTicker.has(c)) || u.cands()[0] || null) : null);
      if (found !== u.fy) cache.clear();
      u.fy = found;
      // "MCX:CRUDEOIL26OCTFUT" -> show the contract month beside the name
      const m = found && /(\d{2})([A-Z]{3})FUT$/.exec(found);
      u.label = m ? `${u.name} ${m[2][0]}${m[2].slice(1).toLowerCase()}` : u.name;
    }
    const lost = UNIVERSE.filter(u => !u.fy).map(u => u.name);
    console.log(`  instruments live: ${live().length}/${UNIVERSE.length}` + (lost.length ? " — not found: " + lost.join(", ") : ""));
  })();
  resolved = { day, promise };
  promise.then(() => { if (resolved && resolved.promise === promise) resolved.partial = !!lastProbeFailed; }).catch(() => {});
  promise.catch(() => { resolved = null; });
  return promise;
}

/* -------------------------------------------------------- symbol search -- */
/* Fyers publishes its full symbol lists as CSV files. They are read in the
   background at start-up and once a day; nothing waits for them. Each row is
   matched by its ticker ("NSE:SBIN-EQ"), so a change in column order does not
   break it. Lot sizes come from the futures and options lists. */
const MASTERS = [
  ["NSE_CM", "https://public.fyers.in/sym_details/NSE_CM.csv"],
  ["BSE_CM", "https://public.fyers.in/sym_details/BSE_CM.csv"],
  ["NSE_FO", "https://public.fyers.in/sym_details/NSE_FO.csv"],
  ["BSE_FO", "https://public.fyers.in/sym_details/BSE_FO.csv"],
  ["MCX_COM", "https://public.fyers.in/sym_details/MCX_COM.csv"],
];
const SYM = { list: [], byTicker: new Map(), at: 0, status: {}, busy: null };
const TICK = /^(NSE|BSE|MCX):[A-Z0-9&_.-]+$/;
async function loadMasters() {
  const list = [], fo = new Map(), mcx = new Map(), status = {};
  for (const [name, url] of MASTERS) {
    try {
      const r = await fetch(env("FYERS_MASTER_BASE") ? env("FYERS_MASTER_BASE") + "/" + name + ".csv" : url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      const dec = new TextDecoder(); let buf = "", rows = 0;
      const row = line => {
        const c = line.split(","), t = c.find(x => TICK.test(x)); if (!t) return;
        rows++;
        const exch = t.slice(0, 3), desc = (c[1] || "").trim(), lot = parseFloat(c[3]) || null, exp = parseFloat(c[8]) || 0;
        if (name.endsWith("_FO")) {                       // remember which underlyings have options, and their lot size
          const m = /^(NSE|BSE):([A-Z0-9&-]+?)\d{2}(?:[A-Z]{3}|[1-9OND]\d{2})/.exec(t), und = (c[13] && /^[A-Z0-9&-]+$/.test(c[13])) ? c[13] : m && m[2];
          if (und) { const k = exch + ":" + und, o = fo.get(k) || { opt: false, lot: null };
            if (/(CE|PE)$/.test(t)) o.opt = true; if (lot && !o.lot) o.lot = lot; fo.set(k, o); }
          return;
        }
        if (name === "MCX_COM") {
          const m = /^MCX:([A-Z]+?)\d{2}[A-Z]{3}(FUT|\d+(CE|PE))$/.exec(t); if (!m) return;
          const k = m[1], o = mcx.get(k) || { opt: false, fut: null };
          if (m[3]) o.opt = true;
          else if (exp * 1000 > Date.now() - 864e5 && (!o.fut || exp < o.fut.exp)) o.fut = { t, exp, lot, desc };
          mcx.set(k, o); return;
        }
        const type = /-INDEX$/.test(t) ? "IDX" : "EQ";
        if (type === "EQ" && exch === "NSE" && !/-(EQ|BE|BZ|SM|ST)$/.test(t)) return;   // skip bonds, ETFs' odd series, etc.
        const short = t.slice(4).replace(/-(EQ|BE|BZ|SM|ST|INDEX|[A-Z]{1,2})$/, "");
        list.push({ t, exch, type, short, name: desc || short, lot: null, fo: false });
      };
      for await (const chunk of r.body) { buf += dec.decode(chunk, { stream: true }); let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { row(buf.slice(0, nl).replace(/\r$/, "")); buf = buf.slice(nl + 1); } }
      if (buf.trim()) row(buf);
      status[name] = { ok: true, rows };
    } catch (e) { status[name] = { ok: false, error: e.message }; }
  }
  for (const x of list) { const f = fo.get(x.exch + ":" + (x.type === "IDX" ? idxUnder(x.short) : x.short)); if (f) { x.fo = f.opt; x.lot = f.lot; } }
  for (const [k, o] of mcx) if (o.fut) {
    const mm = /(\d{2})([A-Z]{3})FUT$/.exec(o.fut.t);
    list.push({ t: o.fut.t, exch: "MCX", type: "MCX", short: k, name: `${k} futures ${mm ? mm[2][0] + mm[2].slice(1).toLowerCase() + " 20" + mm[1] : ""}`.trim(),
      lot: o.fut.lot, fo: o.opt, expiry: o.fut.exp });
  }
  // the built-in watchlist is always searchable, even if the lists failed
  for (const u of UNIVERSE) if (u.fy && !list.some(x => x.t === u.fy))
    list.push({ t: u.fy, exch: u.fy.slice(0, 3), type: u.seg, short: u.tkr, name: u.label || u.name, lot: u.lot, fo: u.fo });
  if (list.length) { SYM.list = list; SYM.byTicker = new Map(list.map(x => [x.t, x])); SYM.at = Date.now(); }
  SYM.status = status;
  console.log("  symbol lists: " + Object.entries(status).map(([k, v]) => k + (v.ok ? " " + v.rows : " FAILED (" + v.error + ")")).join(", "));
}
const idxUnder = s => ({ NIFTY50: "NIFTY", NIFTYBANK: "BANKNIFTY", FINNIFTY: "FINNIFTY", MIDCPNIFTY: "MIDCPNIFTY", SENSEX: "SENSEX", BANKEX: "BANKEX" }[s] || s);
function mastersFresh() {
  if (SYM.busy || Date.now() - SYM.at < 20 * 3600e3) return;
  SYM.busy = loadMasters().catch(() => {}).finally(() => { SYM.busy = null; });
}

/* ------------------------------------------------------------------- news -- */
/* Headlines from publishers' public RSS feeds. Each feed is fetched on its own
   with a time limit, so one slow or failed feed never holds up the others. The
   page is told which feeds worked and when each was last read. */
const FEEDS = [
  ["Business Standard", "https://www.business-standard.com/rss/markets-106.rss", "India"],
  ["Business Standard", "https://www.business-standard.com/rss/economy-102.rss", "India"],
  ["Economic Times", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "India"],
  ["Mint", "https://www.livemint.com/rss/markets", "India"],
  ["Moneycontrol", "https://www.moneycontrol.com/rss/business.xml", "India"],
  ["CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "Global"],
  ["Google News", "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-IN&gl=IN&ceid=IN:en", "India"],
];
const NEWS = { items: [], feeds: [], at: 0, busy: null };
const ent = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();
const tag = (x, t) => { const m = new RegExp("<" + t + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + t + ">", "i").exec(x); return m ? ent(m[1]) : ""; };
async function readFeed([name, url, region]) {
  const t0 = Date.now();
  try {
    const r = await fetch(env("NEWS_FEED_BASE") ? env("NEWS_FEED_BASE") + "/" + encodeURIComponent(url) : url,
      { headers: { "User-Agent": "Mozilla/5.0 SignalDesk/1.0", Accept: "application/rss+xml,application/xml,text/xml" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const xml = await r.text(), out = [];
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
      const x = m[0], title = tag(x, "title"), link = tag(x, "link") || (/<link[^>]*href="([^"]+)"/i.exec(x) || [])[1] || "";
      const when = Date.parse(tag(x, "pubDate") || tag(x, "dc:date") || tag(x, "published") || "");
      const src = tag(x, "source");
      if (!title || !link) continue;
      out.push({ title: src && title.endsWith(" - " + src) ? title.slice(0, -src.length - 3) : title, link,
        source: src || name, via: src ? name : null, region, published: isFinite(when) ? when : null, summary: tag(x, "description").slice(0, 280) });
    }
    return { feed: name, url, ok: true, items: out, ms: Date.now() - t0, at: Date.now() };
  } catch (e) { return { feed: name, url, ok: false, error: e.name === "TimeoutError" ? "no answer within 8 s" : e.message, items: [], ms: Date.now() - t0, at: Date.now() }; }
}
async function refreshNews() {
  const res = await Promise.all(FEEDS.map(readFeed));
  const seen = new Set(), items = [];
  const key = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").slice(0, 70);
  for (const it of res.flatMap(r => r.items).sort((a, b) => (b.published || 0) - (a.published || 0))) {
    const k = key(it.title); if (seen.has(k) || seen.has(it.link)) continue;       // the same story from two feeds counts once
    seen.add(k); seen.add(it.link); items.push(it);
  }
  NEWS.items = items.slice(0, 120); NEWS.feeds = res.map(({ items, ...r }) => ({ ...r, count: items.length })); NEWS.at = Date.now();
}

/* ------------------------------------------------------------------ app -- */
const app = express();
try { app.use(require("compression")()); } catch (e) { /* optional: responses are just not compressed */ }
app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json({ limit: "20kb" }));

/* Lets a phone or computer install the site as an app (Add to Home screen).
   Served before the password check; neither holds anything private. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0F1319"/>
<path d="M96 344l88-96 72 56 112-152" fill="none" stroke="#26A96C" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="368" cy="152" r="34" fill="#4C9AFF"/></svg>`;
const usage = () => ({ lastMinute: RL.sent.filter(t => Date.now() - t < 60000).length, today: RL.dayCount, waiting: RL.waiting,
  pausedFor: Math.max(0, Math.round((RL.pauseUntil - Date.now()) / 1000)), limitedTimes: RL.limited });
app.get("/healthz", (_req, res) => res.json({ ok: true, up: Math.round(process.uptime()), ts: Date.now(), fyers: usage() }));
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

const sendApp = (_req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(__dirname, "index.html")); };
app.get("/", sendApp);

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
  } catch (e) {
    // Only a clear "token rejected" answer from Fyers ends the login. If Fyers is
    // merely slow or unreachable, keep the token so the site recovers by itself.
    if (e.message === NEED_LOGIN || !hasAccess()) { dropAccess(NEED_LOGIN); return res.json({ ok: false }); }
    res.json({ ok: true, a: auth.access, unverified: e.message });
  }
});

app.get("/api/search", (req, res) => {
  mastersFresh();
  const q = String(req.query.q || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, 40);
  if (q.length < 1) return res.json({ q, results: [], lists: SYM.status, ready: SYM.at > 0 });
  const rank = x => {
    const s = x.short, n = x.name.toUpperCase();
    let r = s === q ? 0 : s.startsWith(q) ? 1 : n.startsWith(q) ? 2 : n.split(" ").some(w => w.startsWith(q)) ? 3 : (s.includes(q) || n.includes(q)) ? 4 : 99;
    if (r === 99) return r;
    return r + (x.exch === "NSE" ? 0 : x.exch === "MCX" ? 0.1 : 0.2) - (x.type === "IDX" ? 0.3 : 0) - (x.fo ? 0.2 : 0);
  };
  const results = SYM.list.map(x => [rank(x), x]).filter(r => r[0] < 99).sort((a, b) => a[0] - b[0]).slice(0, 25)
    .map(([, x]) => ({ sym: x.t, short: x.short, name: x.name, exch: x.exch, type: x.type, lot: x.lot, fo: x.fo, expiry: x.expiry || null }));
  res.json({ q, results, lists: SYM.status, ready: SYM.at > 0 });
});

app.get("/api/news", async (_req, res) => {
  if (Date.now() - NEWS.at > 5 * 60000) {                       // at most one refresh every 5 minutes, shared by everyone
    NEWS.busy = NEWS.busy || refreshNews().finally(() => { NEWS.busy = null; });
    if (!NEWS.at) await NEWS.busy;                               // only the very first visitor waits
  }
  res.json({ at: NEWS.at, items: NEWS.items, feeds: NEWS.feeds });
});

app.get("/api/status", async (_req, res) => {
  let ok = true;
  try { await access(); } catch (e) { ok = false; auth.error = auth.error || e.message; }
  res.json({ authenticated: ok, error: ok ? null : auth.error, login: APP_ID && SECRET ? "/auth/login" : null,
             redirect: REDIRECT, provider: "fyers", delayed: false, pollMs: 5000, ts: Date.now(), fyers: usage() });
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
  sym: u.label || u.name, tkr: u.tkr, fy: u.fy, seg: u.seg, step: u.step, lot: (SYM.byTicker.get(u.fy) || {}).lot || u.lot,
  lotFromFeed: !!(SYM.byTicker.get(u.fy) || {}).lot,
  fo: u.fo, open: u.open, close: u.close,
})))));

/* -------------------------------------------------------------- candles -- */
const DAYS = { 1: 5, 3: 6, 5: 12, 15: 30, 30: 60, 60: 90, 240: 90 };

/* Is this instrument's market open now (IST)? Slightly wider than the session so the last candle is caught. */
function openNow(u) {
  const x = new Date(Date.now() + IST), wd = x.getUTCDay(), m = x.getUTCHours() * 60 + x.getUTCMinutes();
  return wd >= 1 && wd <= 5 && m >= (u.open || 555) - 5 && m <= (u.close || 930) + 10;
}
const anyOpen = () => UNIVERSE.some(u => u.fy && openNow(u));
app.get("/api/candles", guard(async (req, res) => {
  const u = bySym(req.query.tkr);
  if (!u) return res.status(404).json({ error: "unknown symbol" });
  const want = DAYS[+req.query.interval] ? +req.query.interval : 5;
  res.json(await candlesOf(u, want));
}));
// market shut: the candles can't change, so ask Fyers at most every 30 minutes
const candlesOf = (u, want) => cached(`c:${u.tkr}:${want}`, !openNow(u) ? 1800000 : want >= 60 ? 120000 : want >= 15 ? 45000 : 15000, async () => {
    const j = await fy("/history", { symbol: u.fy, resolution: String(want), date_format: "1",
      range_from: istDay(Date.now() - DAYS[want] * 864e5), range_to: istDay(Date.now()), cont_flag: "1" });
    const candles = (j.candles || []).filter(c => c && c.length >= 5 && c[1] != null && c[4] != null)
      .map(c => [c[0] < 1e11 ? c[0] * 1000 : c[0], c[1], c[2], c[3], c[4], c[5] || 0])
      .sort((a, b) => a[0] - b[0]);
    return { tkr: u.tkr, interval: want + "m", candles };
  });

/* Daily candles for the daily EMAs (5 to 250 days and the 30-week average). About two years,
   fetched in two requests (Fyers allows one year of daily candles per request), kept for 12 hours:
   only completed days are used, and those change once a day. */
const dailyOf = u => cached(`d:${u.tkr}:${istDay(Date.now())}`, 12 * 3600e3, async () => {
  const part = async (fromDays, toDays) => {
    const j = await fy("/history", { symbol: u.fy, resolution: "D", date_format: "1",
      range_from: istDay(Date.now() - fromDays * 864e5), range_to: istDay(Date.now() - toDays * 864e5), cont_flag: "1" });
    return (j.candles || []).filter(c => c && c.length >= 5 && c[4] != null).map(c => [c[0] < 1e11 ? c[0] * 1000 : c[0], c[1], c[2], c[3], c[4], c[5] || 0]);
  };
  const older = await part(730, 366).catch(() => []), recent = await part(365, 0);
  const seen = new Set(), candles = older.concat(recent).sort((a, b) => a[0] - b[0]).filter(c => { const d = istDay(c[0]); if (seen.has(d)) return false; seen.add(d); return true; });
  return { tkr: u.tkr, interval: "1d", candles };
});
app.get("/api/daily", guard(async (req, res) => {
  const u = bySym(req.query.tkr);
  if (!u) return res.status(404).json({ error: "unknown symbol" });
  res.json(await dailyOf(u));
}));

/* --------------------------------------------------------------- quotes -- */
app.get("/api/quotes", guard(async (req, res) => {
  // `x` = option contracts the viewer has opened, quoted alongside the watchlist
  const extra = [...new Set(String(req.query.x || "").split(",").filter(s => OPT_RE.test(s) || SYM.byTicker.has(s)))].slice(0, 20);
  const out = await cached("quotes:" + extra.join(","), anyOpen() ? 4000 : 600000, async () => {
    const j = await fy("/quotes", { symbols: live().map(u => u.fy).concat(extra).join(",") });
    const q = { __at: Date.now() };
    for (const d of j.d || []) {
      const u = UNIVERSE.find(x => x.fy === d.n) || (extra.includes(d.n) ? { tkr: d.n } : null), v = d.v;
      if (!u || !v || v.lp == null) continue;
      const prev = v.prev_close_price > 0 ? v.prev_close_price : null;
      q[u.tkr] = { ltp: v.lp, open: v.open_price || null, high: v.high_price || null, low: v.low_price || null,
                   close: prev, chg: v.chp != null ? v.chp : (prev ? ((v.lp - prev) / prev) * 100 : 0), vol: v.volume || 0 };
    }
    return q;
  });
  const { __at, ...quotes } = out;
  res.json({ ts: __at || Date.now(), quotes, delayed: false });
}));

/* ---------------------------------------------------------- option chain -- */
const isoOf = dmy => { const [d, m, y] = String(dmy).split("-"); return `${y}-${m}-${d}`; };
async function rawChain(u, epoch) {
  const p = { symbol: u.fy, strikecount: "20", timestamp: epoch || "" };
  try { return await fy("/options-chain-v3", { ...p, greeks: "1" }); }
  catch (e) { if (e.message === NEED_LOGIN) throw e; return fy("/options-chain-v3", p); }
}
const chainOf = (u, epoch) => cached(`ch:${u.tkr}:${epoch || ""}`, openNow(u) ? 15000 : 900000, () => rawChain(u, epoch));
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
  res.json(await chainData(u, req.query.expiry));
}));
async function chainData(u, expiry) {
  const list = await expiriesOf(u);
  if (!list.length) throw new Error("Fyers returned no expiries for " + u.name);
  const pick = list.find(e => e.iso === expiry) || list[0];
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
  return { tkr: u.tkr, expiry: pick.iso, expiries: list.map(e => e.iso), spot, prevClose, atm, step,
             lot: u.lot, daysOut, rows, ivFromFeed: true };
}


/* ------------------------------------------------------ all-F&O scanner -- */
/* Every instrument with listed options (NSE F&O stocks, index options, MCX
   commodities with options) is checked once after each 5-minute candle closes,
   with the very same signal rules the page uses (read from index.html, so there
   is one copy of them). One scan serves every visitor. Requests are paced to
   leave room for the pages' own requests. Only CALL / PUT buy signals. */
const fs = require("fs"), vm = require("vm");
const SCAN = { at: 0, started: 0, running: false, total: 0, done: 0, failed: 0, cycleMs: 0, cpuMs: 0, day: "",
  signals: [], pending: [], opts: new Map(), engineOk: false, engineErr: null, lastErr: null };
let EN = null;
function loadEngine() {
  try {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const pick = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i + 1);
      if (i < 0 || j < 0) throw new Error("rule code not found in index.html (" + a.slice(0, 30) + ")"); return html.slice(i, j); };
    let src = pick("function aggregate(bars, mins, open){", "/* Setup and trend timeframe candles.") +
      pick("const toBars=", "let rafPending") +
      pick("/* ------------------------------------------------------------ indicators -- */", "/* ---------------------------------------------------------------- chart -- */");
    src = src.replace("const isFocus=t=>FOCUS.has(t);", "const isFocus=t=>true;");     // the scan covers every instrument
    for (const name of ["MAX_LIFE", "RF"]) {                                   // settings defined elsewhere in the page
      const m = new RegExp("const " + name + "\\s*=\\s*([0-9.]+)").exec(html); if (m && !new RegExp("const " + name + "\\s*=").test(src)) src = "const " + name + "=" + m[1] + ";\n" + src; }     // the scan covers every instrument
    const box = { S: { tf: 5, universe: [], chainCache: {}, ctx: {}, sigs: {}, bars: {}, quotes: {}, otr: {}, page: "", tab: "" },
      store: { get: (k, d) => d, set() {} }, localStorage: { getItem: () => null, setItem() {} }, document: {}, window: {}, C: {}, console };
    vm.createContext(box);
    EN = vm.runInContext(src + "\n;({analyseTF,engine,engineNormal,engineTrend,engineORB,aggregate,toBars,bs,impliedVol,demaOf,demaJudge});", box, { timeout: 5000 });
    SCAN.engineOk = true;
  } catch (e) { SCAN.engineErr = e.message; console.log("  scanner: rules not loaded — " + e.message); }
}
function scanList() {
  const out = new Map();
  for (const u of UNIVERSE) if (u.fy && u.fo) out.set(u.fy, { tkr: u.tkr, fy: u.fy, sym: u.label || u.name, name: u.name, seg: u.seg, fo: true,
    lot: (SYM.byTicker.get(u.fy) || {}).lot || u.lot, open: u.open, close: u.close, step: u.step });
  for (const x of SYM.list) if (x.fo && !out.has(x.t) && ((x.type === "EQ" && x.exch === "NSE") || x.type === "IDX" || x.type === "MCX"))
    out.set(x.t, { tkr: x.t, fy: x.t, sym: x.type === "MCX" ? x.name.replace(" futures", "") : x.short, name: x.name, seg: x.type, fo: true,
      lot: x.lot, open: x.exch === "MCX" ? 540 : 555, close: x.exch === "MCX" ? 1410 : 930 });
  return [...out.values()];
}
const tabOfSig = s => s.grade === "N" ? "normal" : s.strict ? "strict" : "other";
const scanKey = s => s.tkr + "|" + s.ts + "|" + s.side + "|" + s.grade;
async function scanOption(u, s) {               // the contract to buy, its premium now, and premium stop / targets
  let d = await chainData(u);
  if (d.daysOut < 0.6 && d.expiries[1]) d = await chainData(u, d.expiries[1]);   // skip an expiry that ends today
  const row = d.rows.reduce((a, r) => Math.abs(r.strike - s.entry) < Math.abs(a.strike - s.entry) ? r : a, d.rows[0]);
  const ty = s.side === "BUY" ? "CE" : "PE", leg = ty === "CE" ? row.ce : row.pe;
  if (!leg || !(leg.ltp > 0)) throw new Error("no traded price for the " + row.strike + " " + ty);
  const buy = leg.ltp, T = Math.max(d.daysOut / 365, 1 / (365 * 24)), spot = d.spot || s.entry;
  const iv = EN.impliedVol(buy, spot, row.strike, T, ty) || leg.iv;
  const at = (p, fb) => iv ? EN.bs(p, row.strike, Math.max(T - 30 / 525600, 1 / (365 * 24)), iv, ty).px : buy * fb;
  const band = (v, lo, hi) => Math.max(buy * lo, Math.min(buy * hi, v)), t05 = v => Math.max(0.05, Math.round(v * 20) / 20);
  // levels measured from the price when the signal fired, moved by today's difference between spot and that price
  const shift = v => v + (spot - s.last);
  const sl = band(at(shift(s.sl), 0.8), 0.55, 0.92), t1 = band(at(shift(s.t1), 1.2), 1.08, 1.6);
  const t2 = Math.max(band(at(shift(s.t2), 1.45), 1.2, 2.4), t1 * 1.08), t3 = Math.max(band(at(shift(s.t3), 1.8), 1.35, 3.5), t2 * 1.08);
  return { sym: leg.sym, strike: row.strike, ty, expiry: d.expiry, buy: t05(buy), sl: t05(sl), t1: t05(t1), t2: t05(t2), t3: t05(t3),
    lot: d.lot || u.lot || null, bid: leg.bid, ask: leg.ask, oi: leg.oi, vol: leg.vol,
    spread: leg.bid > 0 && leg.ask > 0 ? (leg.ask - leg.bid) / ((leg.ask + leg.bid) / 2) * 100 : null, at: Date.now(), now: buy, nowAt: Date.now() };
}
async function scanCycle() {
  if (!EN || SCAN.running) return;
  const sess = [...sessions.values()].filter(v => v.access && (!v.exp || Date.now() < v.exp - 60000)).sort((a, b) => b.seen - a.seen)[0];
  if (!sess || Date.now() - sess.seen > 4 * 3600e3) return;              // nobody has used the site for hours: don't spend their Fyers allowance
  SCAN.running = true; SCAN.started = Date.now(); let cpu = 0;
  try {
    await visitor.run(sess, () => lane.run("low", async () => {
      await ensureUniverse().catch(() => {});
      const day = istDay(Date.now());
      if (day !== SCAN.day) { SCAN.day = day; SCAN.signals = []; SCAN.pending = []; SCAN.opts.clear(); }
      const all = scanList(), first = !SCAN.at;
      const list = all.filter(u => first || openNow(u));
      if (!list.length) return;
      SCAN.total = list.length; SCAN.done = 0; SCAN.failed = 0; SCAN.emaBlocked = 0;
      const keep = new Map(SCAN.signals.map(s => [s.tkr, s]));           // instruments not scanned now keep their last result
      const found = [], pend = [];
      for (const u of list) {
        // leave room for visitors' own requests: the scan uses at most about 100 a minute
        while (RL.sent.filter(t => Date.now() - t < 60000).length >= 90 || Q.hi.length > 0 || Q.lo.length > 1 || Date.now() < RL.pauseUntil) await sleep(400);
        let d;
        try { d = await candlesOf(u, 5); }
        catch (e) { SCAN.failed++; SCAN.lastErr = u.sym + ": " + e.message; if (e.message === NEED_LOGIN) break; continue; }
        const t0 = Date.now();
        try {
          const b = EN.toBars(d.candles);
          if (b.length >= 80) {
            const E = EN.analyseTF(b), St = EN.analyseTF(EN.aggregate(b, 15, u.open)), H = EN.analyseTF(EN.aggregate(b, 60, u.open));
            const ctx = { u, E, St, H, tf: 5, stf: 15, htf: 60 };
            const smc = EN.engine(ctx, { lite: true });
            const sigs = smc.concat(EN.engineNormal(ctx, { lite: true }, smc), EN.engineTrend(ctx, { lite: true }, smc), EN.engineORB(ctx, { lite: true }, smc));
            const last = b[b.length - 1];
            // daily EMA check: fetched only for instruments with a signal today (keeps the Fyers allowance)
            let DB = null;
            if (sigs.some(s => istDay(s.ts) === day)) { try { DB = EN.toBars((await dailyOf(u)).candles); } catch (e) { DB = null; } }
            const ema = s => { const g = EN.demaJudge(DB ? EN.demaOf(DB, istDay(s.ts)) : null, s.side === "BUY" ? 1 : -1, s.entry); return g; };
            for (const s0 of sigs) { const g = ema(s0); if (g.block) { SCAN.emaBlocked = (SCAN.emaBlocked || 0) + 1; continue; }
              const s = Object.assign({}, s0, { reasons: (s0.reasons || []).concat(g.lines.map(x => "Daily EMAs: " + x)) });
              found.push({ tkr: u.tkr, fy: u.fy, sym: u.sym, seg: u.seg, lot: u.lot, side: s.side, tab: tabOfSig(s), grade: s.grade,
              setup: s.setup || (s.grade === "N" ? "trend pull-back" : s.trig || "structure"), ts: s.ts, entry: s.entry, sl: s.sl, t1: s.t1, t2: s.t2, t3: s.t3,
              rr: s.rr, reasons: s.reasons, state: s.res.state, status: s.res.status, hit: s.res.hit, px: s.res.px, R: s.res.R, stop: s.res.stop,
              last: last.c, lastTs: last.ts, ema: { score: g.score, of: g.of, label: g.label, missing: !!g.missing } }); }
            if (smc.pending && !ema(smc.pending).block) pend.push({ tkr: u.tkr, fy: u.fy, sym: u.sym, seg: u.seg, side: smc.pending.side, grade: smc.pending.grade, ts: smc.pending.ts,
              entry: smc.pending.entry, sl: smc.pending.sl, t1: smc.pending.t1, t2: smc.pending.t2, t3: smc.pending.t3, limit: smc.pending.limit });
          }
          keep.delete(u.tkr);
        } catch (e) { SCAN.failed++; SCAN.lastErr = u.sym + ": " + e.message; }
        cpu += Date.now() - t0; SCAN.done++;
        await new Promise(r => setImmediate(r));                       // let page requests through between instruments
      }
      // results for instruments not scanned this time (market shut) stay as they were
      const old = SCAN.signals.filter(s => keep.has(s.tkr) || !list.some(u => u.tkr === s.tkr));
      SCAN.signals = old.concat(found.filter(s => s.ts >= Date.now() - 864e5 * 3 && istDay(s.ts) === day)).sort((a, b) => b.ts - a.ts);
      SCAN.pending = pend;
      // contracts for new live signals (a few per cycle), and current premiums for all live ones in one request
      let built = 0;
      for (const s of SCAN.signals.filter(x => x.state === "ACTIVE" && !SCAN.opts.has(scanKey(x)))) {
        if (built++ >= 12) break;
        const u = list.find(x => x.tkr === s.tkr) || all.find(x => x.tkr === s.tkr); if (!u) continue;
        try { SCAN.opts.set(scanKey(s), await scanOption(u, s)); } catch (e) { SCAN.opts.set(scanKey(s), { err: e.message, at: Date.now() }); }
      }
      const live = SCAN.signals.filter(x => x.state === "ACTIVE").map(x => SCAN.opts.get(scanKey(x))).filter(o => o && o.sym).slice(0, 50);
      if (live.length) try {
        const j = await fy("/quotes", { symbols: [...new Set(live.map(o => o.sym))].join(",") });
        for (const q of j.d || []) if (q && q.v && q.v.lp > 0) live.filter(o => o.sym === q.n).forEach(o => { o.now = q.v.lp; o.nowAt = Date.now(); });
      } catch (e) {}
    }));
    SCAN.at = Date.now(); SCAN.cycleMs = Date.now() - SCAN.started; SCAN.cpuMs = cpu;
  } finally { SCAN.running = false; }
}
// run 25 s after every 5-minute candle closes (IST is a whole number of 5-minute steps from UTC)
function scheduleScan() {
  const step = 300000, wait = step - (Date.now() % step) + 25000;
  setTimeout(() => { scanCycle().catch(e => { SCAN.lastErr = e.message; }).finally(scheduleScan); }, wait).unref();
}
app.get("/api/scan", guard(async (_req, res) => {
  if (!SCAN.at && !SCAN.running) scanCycle().catch(() => {});               // first visitor of the day starts it
  res.json({ at: SCAN.at, running: SCAN.running, total: SCAN.total, done: SCAN.done, failed: SCAN.failed, cycleMs: SCAN.cycleMs, cpuMs: SCAN.cpuMs,
    instruments: scanList().length, engineOk: SCAN.engineOk, engineErr: SCAN.engineErr, lastErr: SCAN.lastErr,
    signals: SCAN.signals.map(s => Object.assign({}, s, { opt: SCAN.opts.get(scanKey(s)) || null })), pending: SCAN.pending });
}));


/* ------------------------------------------------------------- Telegram -- */
/* Two free, permitted ways to read trade calls posted on Telegram:
   1. Public channels, from Telegram's own public web preview (t.me/s/<name>),
      the same page anyone can open in a browser without logging in.
   2. Groups or channels where you have added your own bot (free Bot API,
      token in the TELEGRAM_BOT_TOKEN setting on Render, never in the code).
   Nothing private is read without that access, and nothing here is paid. */
const TG = { cache: new Map(), fetches: [], bot: { enabled: false, error: null, offset: 0, chats: new Map(), msgs: new Map(), lastPoll: 0 } };
const TG_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const tgText = h => ent(String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n")).replace(/[ \t]+\n/g, "\n");
// ent() collapses whitespace; keep line breaks by converting them to a marker first
const tgClean = h => tgText(String(h || "").replace(/<br\s*\/?>/gi, " ⏎ ")).replace(/\s*⏎\s*/g, "\n").trim();
function tgParsePage(html, name) {
  const out = [];
  const title = (/<div class="tgme_channel_info_header_title"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/.exec(html) || [])[1];
  const parts = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  for (const p of parts) {
    const post = (/data-post="([^"]+)"/.exec(p) || [])[1]; if (!post) continue;
    const id = +post.split("/")[1]; if (!id) continue;
    const dt = (/<time[^>]*datetime="([^"]+)"/.exec(p) || [])[1];
    // the post's own text (a reply also shows a quoted copy of the earlier post, marked js-message_reply_text)
    const tm = /<div class="tgme_widget_message_text[^"]*\bjs-message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(p)
      || [...p.matchAll(/<div class="(tgme_widget_message_text[^"]*)"[^>]*>([\s\S]*?)<\/div>/g)].filter(x => !/reply_text/.test(x[1])).map(x => [x[0], x[2]])[0];
    const meta = (/<span class="tgme_widget_message_meta">([\s\S]*?)<\/span>\s*<\/span>|<span class="tgme_widget_message_meta">([\s\S]*?)<\/a>/.exec(p) || [])[0] || "";
    const fwd = (/class="tgme_widget_message_forwarded_from_name"[^>]*>([\s\S]*?)<\/(a|span)>/.exec(p) || [])[1];
    const reply = (/class="tgme_widget_message_reply"[^>]*href="https:\/\/t\.me\/[^/]+\/(\d+)"/.exec(p) || [])[1];
    const views = (/class="tgme_widget_message_views">([^<]*)</.exec(p) || [])[1];
    out.push({ id, ts: dt ? Date.parse(dt) : null, text: tm ? tgClean(tm[1]) : "", edited: /\bedited\b/i.test(meta),
      fwd: fwd ? ent(fwd) : null, reply: reply ? +reply : null, views: views || null, link: "https://t.me/" + post });
  }
  const more = (/class="tme_messages_more[^"]*"[^>]*data-before="(\d+)"/.exec(html) || [])[1];
  return { name, title: title ? ent(title) : null, messages: out.sort((a, b) => a.id - b.id), before: more ? +more : null };
}
async function tgChannel(name, before) {
  const key = name.toLowerCase() + "|" + (before || "");
  const hit = TG.cache.get(key);
  if (hit && Date.now() - hit.at < (before ? 600000 : 60000)) return hit.val;   // newest page: 1 min, older pages: 10 min
  TG.fetches = TG.fetches.filter(t => Date.now() - t < 60000);
  if (TG.fetches.length >= 20) { if (hit) return hit.val; throw new Error("reading Telegram slowly on purpose (20 pages a minute); try again shortly"); }
  TG.fetches.push(Date.now());
  const r = await fetch((env("TELEGRAM_WEB_BASE") || "https://t.me") + "/s/" + encodeURIComponent(name) + (before ? "?before=" + before : ""),
    { headers: { "User-Agent": "Mozilla/5.0 SignalDesk/1.0", Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
  const noPreview = "Telegram shows no public preview for this channel (the owner has switched it off, or it can only be viewed in the Telegram app), so the site can't read it. A bot can only read a channel where you are an admin.";
  if (r.redirected && !/\/s\//.test(r.url)) throw new Error(noPreview);
  if (!r.ok) throw new Error("Telegram answered HTTP " + r.status);
  const html = await r.text();
  if (!/tgme_widget_message_wrap|tgme_channel_info/.test(html) || !/\/s\//.test(r.url))
    throw new Error("Telegram shows no public preview for this channel (the owner has switched it off, or it can only be viewed in the Telegram app), so the site can't read it. A bot can only read a channel where you are an admin.");
  const val = tgParsePage(html, name); val.at = Date.now();
  TG.cache.set(key, { at: Date.now(), val });
  if (TG.cache.size > 300) TG.cache.delete(TG.cache.keys().next().value);
  return val;
}
app.get("/api/tg/channel", async (req, res) => {
  try { await access(); } catch (e) { return res.status(401).json({ error: e.message }); }
  const name = String(req.query.name || "").replace(/^@/, "");
  if (!TG_NAME.test(name)) return res.status(400).json({ error: "not a valid public channel name" });
  const before = /^\d+$/.test(req.query.before || "") ? +req.query.before : null;
  try { res.json(await tgChannel(name, before)); } catch (e) { res.status(502).json({ error: e.message }); }
});
/* Optional bot: long-polls getUpdates (free). Messages are kept in memory only, so the page keeps its own copy. */
async function tgBotLoop() {
  const tok = env("TELEGRAM_BOT_TOKEN"); if (!tok) return;
  TG.bot.enabled = true;
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/getUpdates?timeout=25&offset=${TG.bot.offset}&allowed_updates=${encodeURIComponent('["message","edited_message","channel_post","edited_channel_post"]')}`,
        { signal: AbortSignal.timeout(35000) });
      const j = await r.json();
      if (!j.ok) { TG.bot.error = j.description || ("HTTP " + r.status); await sleep(60000); continue; }
      TG.bot.error = null; TG.bot.lastPoll = Date.now();
      for (const u of j.result || []) {
        TG.bot.offset = u.update_id + 1;
        const m = u.message || u.edited_message || u.channel_post || u.edited_channel_post; if (!m || !m.chat) continue;
        const c = m.chat, id = String(c.id);
        TG.bot.chats.set(id, { id, title: c.title || c.username || id, type: c.type, username: c.username || null });
        const list = TG.bot.msgs.get(id) || [];
        const text = m.text || m.caption || "";
        const ex = list.find(x => x.id === m.message_id);
        if (ex) { if (ex.text !== text) { ex.editedText = text; ex.edited = true; } }
        else list.push({ id: m.message_id, ts: (m.date || 0) * 1000, text, edited: !!(u.edited_message || u.edited_channel_post),
          fwd: m.forward_origin ? (m.forward_origin.chat && m.forward_origin.chat.title) || (m.forward_origin.sender_user && m.forward_origin.sender_user.first_name) || "forwarded" : null,
          reply: m.reply_to_message ? m.reply_to_message.message_id : null, link: c.username ? `https://t.me/${c.username}/${m.message_id}` : null });
        TG.bot.msgs.set(id, list.slice(-400));
      }
    } catch (e) { TG.bot.error = e.message; await sleep(15000); }
  }
}
app.get("/api/tg/bot", async (req, res) => {
  try { await access(); } catch (e) { return res.status(401).json({ error: e.message }); }
  const chat = String(req.query.chat || "");
  res.json({ enabled: TG.bot.enabled, error: TG.bot.error, lastPoll: TG.bot.lastPoll, chats: [...TG.bot.chats.values()],
    messages: chat ? (TG.bot.msgs.get(chat) || []) : [] });
});


/* ------------------------------------------------- Telegram account login -- */
/* Optional. You log in once with your own Telegram account (phone, code, and your
   two-step password if you have one) through Telegram's official API, using the
   free api_id / api_hash from my.telegram.org (TELEGRAM_API_ID and
   TELEGRAM_API_HASH on Render). The site then reads the channels and groups you
   choose, exactly as your Telegram app would, and nothing else. The login lives
   in the server's memory; your browser keeps an encrypted copy (useless without
   this server's key) so it comes back after the free server restarts, until you
   press "Log out of Telegram". Nothing is ever posted from your account. */
let GJ = null; try { GJ = { ...require("telegram"), sessions: require("telegram/sessions"), password: require("telegram/Password"), events: require("telegram/events"), Edited: require("telegram/events/EditedMessage") }; } catch (e) {}
const TGU_ID = +env("TELEGRAM_API_ID") || 0, TGU_HASH = env("TELEGRAM_API_HASH") || "";
const tguKey = crypto.createHash("sha256").update("signal-desk-telegram|" + (env("TELEGRAM_SESSION_SECRET") || SECRET || "local")).digest();
const seal = txt => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", tguKey, iv);
  const ct = Buffer.concat([c.update(txt, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url"); };
const unseal = b => { const raw = Buffer.from(String(b), "base64url"), d = crypto.createDecipheriv("aes-256-gcm", tguKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"); };
const tguOf = () => { const s = visitor.getStore(); if (!s) return null; s.tg = s.tg || { state: "off", msgs: new Map(), watch: new Set() }; return s.tg; };
const tguMsg = m => ({ id: m.id, ts: (m.date || 0) * 1000, text: m.message || "", edited: !!m.editDate,
  fwd: m.fwdFrom ? (m.fwdFrom.fromName || "forwarded") : null, reply: m.replyTo ? m.replyTo.replyToMsgId || null : null, link: null, at: Date.now() });
function tguStore(T, chat, m) {
  const list = T.msgs.get(chat) || [], i = list.findIndex(x => x.id === m.id);
  if (i < 0) list.push(m); else if (list[i].text !== m.text) { list[i].editedText = m.text; list[i].edited = true; }
  list.sort((a, b) => a.id - b.id); T.msgs.set(chat, list.slice(-400)); T.lastNew = Date.now();
}
async function tguClient(session) {
  const c = new GJ.TelegramClient(new GJ.sessions.StringSession(session || ""), TGU_ID, TGU_HASH, { connectionRetries: 3, deviceModel: "Signal Desk (web)", appVersion: "1.0" });
  try { c.setLogLevel("error"); } catch (e) {}
  await c.connect(); return c;
}
function tguListen(T) {                          // new and edited messages arrive within a second or two
  const on = async ev => { try { const m = ev.message; const chat = String(m.chatId); if (!T.watch.has(chat)) return; tguStore(T, chat, tguMsg(m)); } catch (e) {} };
  T.client.addEventHandler(on, new GJ.events.NewMessage({}));
  try { T.client.addEventHandler(on, new GJ.Edited.EditedMessage({})); } catch (e) {}
}
async function tguReady(T) {
  T.state = "ready"; T.error = null;
  try { const me = await T.client.getMe(); T.me = { name: [me.firstName, me.lastName].filter(Boolean).join(" "), username: me.username || null }; } catch (e) {}
  tguListen(T);
  return { ok: true, state: "ready", me: T.me, blob: seal(T.client.session.save()) };
}
const tguGuard = fn => async (req, res) => {
  try { await access(); } catch (e) { return res.status(401).json({ error: e.message }); }
  if (!GJ) return res.status(501).json({ error: "the Telegram library is not installed on the server (upload the new package.json)" });
  if (!TGU_ID || !TGU_HASH) return res.status(501).json({ error: "TELEGRAM_API_ID and TELEGRAM_API_HASH are not set on Render yet" });
  try { res.json(await fn(req, tguOf())); }
  catch (e) { const m = e.errorMessage || e.message || String(e);
    const nice = { PHONE_CODE_INVALID: "That code is not right. Check the latest code in your Telegram app.", PHONE_CODE_EXPIRED: "That code has expired. Ask for a new one.",
      PHONE_NUMBER_INVALID: "Telegram says this phone number is not valid. Include the country code, e.g. +971…", PASSWORD_HASH_INVALID: "That two-step password is not right.",
      FLOOD: "Telegram asks to wait before trying again." }[Object.keys({ PHONE_CODE_INVALID: 1, PHONE_CODE_EXPIRED: 1, PHONE_NUMBER_INVALID: 1, PASSWORD_HASH_INVALID: 1, FLOOD: 1 }).find(k => m.includes(k)) || ""];
    res.status(400).json({ error: nice || m }); }
};
app.get("/api/tgu/status", async (req, res) => {
  try { await access(); } catch (e) { return res.status(401).json({ error: e.message }); }
  const T = tguOf();
  res.json({ library: !!GJ, configured: !!(TGU_ID && TGU_HASH), state: T ? T.state : "off", me: T && T.me || null, error: T && T.error || null, watching: T ? [...T.watch] : [], lastNew: T && T.lastNew || 0 });
});
app.post("/api/tgu/start", tguGuard(async (req, T) => {
  const phone = String(req.body && req.body.phone || "").replace(/[^\d+]/g, "");
  if (!/^\+?\d{8,15}$/.test(phone)) throw new Error("Enter your phone number with the country code, e.g. +971501234567");
  if (T.client) { try { await T.client.disconnect(); } catch (e) {} }
  T.client = await tguClient("");
  const r = await T.client.invoke(new GJ.Api.auth.SendCode({ phoneNumber: phone, apiId: TGU_ID, apiHash: TGU_HASH, settings: new GJ.Api.CodeSettings({}) }));
  T.phone = phone; T.hash = r.phoneCodeHash; T.state = "code";
  return { ok: true, state: "code" };
}));
app.post("/api/tgu/code", tguGuard(async (req, T) => {
  if (T.state !== "code" || !T.client) throw new Error("Start again with your phone number.");
  const code = String(req.body && req.body.code || "").replace(/\D/g, "");
  try { await T.client.invoke(new GJ.Api.auth.SignIn({ phoneNumber: T.phone, phoneCodeHash: T.hash, phoneCode: code })); }
  catch (e) { if ((e.errorMessage || "").includes("SESSION_PASSWORD_NEEDED")) { T.state = "password"; return { ok: true, state: "password" }; } throw e; }
  return tguReady(T);
}));
app.post("/api/tgu/password", tguGuard(async (req, T) => {
  if (T.state !== "password" || !T.client) throw new Error("Start again with your phone number.");
  const pw = await T.client.invoke(new GJ.Api.account.GetPassword());
  const check = await GJ.password.computeCheck(pw, String(req.body && req.body.password || ""));
  await T.client.invoke(new GJ.Api.auth.CheckPassword({ password: check }));
  return tguReady(T);
}));
app.post("/api/tgu/restore", tguGuard(async (req, T) => {           // after a server restart: the browser hands back its sealed copy
  if (T.state === "ready") return { ok: true, state: "ready", me: T.me };
  let session; try { session = unseal(req.body && req.body.blob); } catch (e) { return { ok: false, state: "off", error: "saved Telegram login could not be opened; log in again" }; }
  T.client = await tguClient(session);
  if (!(await T.client.checkAuthorization())) { T.state = "off"; return { ok: false, state: "off", error: "Telegram ended this login (logged out from another device?). Log in again." }; }
  for (const c of (req.body.watch || []).map(String)) T.watch.add(c);
  const r = await tguReady(T); delete r.blob; return r;
}));
app.post("/api/tgu/logout", tguGuard(async (_req, T) => {
  try { if (T.client) { await T.client.invoke(new GJ.Api.auth.LogOut()); await T.client.disconnect(); } } catch (e) {}
  T.client = null; T.state = "off"; T.me = null; T.msgs.clear(); T.watch.clear();
  return { ok: true, state: "off" };
}));
app.get("/api/tgu/dialogs", tguGuard(async (_req, T) => {
  if (T.state !== "ready") throw new Error("Log in to Telegram first.");
  const ds = await T.client.getDialogs({ limit: 300 });
  return { chats: ds.filter(d => d.isChannel || d.isGroup).map(d => ({ id: String(d.id), title: d.title || d.name || String(d.id),
    type: d.isChannel && !d.isGroup ? "channel" : "group", username: d.entity && d.entity.username || null })) };
}));
app.get("/api/tgu/messages", tguGuard(async (req, T) => {
  if (T.state !== "ready") throw new Error("Log in to Telegram first.");
  const chat = String(req.query.chat || ""); if (!chat) throw new Error("no chat");
  T.watch.add(chat);
  const have = T.msgs.get(chat);
  if (!have || !T.filled || !T.filled.has(chat)) {           // first time (or after a restart): the last 150 messages
    const ms = await T.client.getMessages(chat, { limit: 150 });
    for (const m of ms) if (m && m.id) tguStore(T, chat, tguMsg(m));
    (T.filled = T.filled || new Set()).add(chat);
  }
  const since = +req.query.since || 0;
  return { chat, messages: (T.msgs.get(chat) || []).filter(m => m.id > since || m.editedText), lastNew: T.lastNew || 0 };
}));

/* ---------------------------------------------------- services and costs -- */
/* What this site uses outside itself, what is free, and the limits. Shown on the Results page. */
app.get("/api/services", (_req, res) => res.json({ services: [
  { name: "Render (hosting)", cost: "Free plan", account: "Your Render account", limits: "750 free hours a month (enough for one site all month); sleeps after 15 minutes without visitors and takes about a minute to wake; included outbound data per month. If the free data allowance is exceeded and a payment card is saved, Render bills the extra; with no card it suspends the site until the next month instead.", status: "in use" },
  { name: "Fyers API (prices, candles, option chains)", cost: "Free", account: "Your Fyers app (FYERS_APP_ID / FYERS_SECRET_ID on Render)", limits: "About 10 requests a second, 200 a minute and a daily cap. The site keeps itself under 150 a minute.", status: APP_ID && SECRET ? "in use" : "not set up" },
  { name: "Fyers symbol lists", cost: "Free public download", account: "None", limits: "Read once a day.", status: SYM.at ? "in use" : "not loaded yet" },
  { name: "News feeds (Business Standard, Economic Times, Mint, Moneycontrol, CNBC, Google News)", cost: "Free public RSS", account: "None", limits: "Read at most every 5 minutes. A feed that stops working is named on the news page; nothing paid replaces it.", status: "in use" },
  { name: "Telegram public channel pages (t.me/s)", cost: "Free, public", account: "None", limits: "Only public channels; about the last 20 posts per page; the site reads at most 20 pages a minute.", status: "in use when you add a public channel" },
  { name: "Telegram Bot API", cost: "Free", account: "Your own bot (TELEGRAM_BOT_TOKEN on Render)", limits: "Reads only groups/channels where you added the bot (with privacy mode off for groups). Messages are kept in the server's memory until it restarts.", status: TG.bot.enabled ? (TG.bot.error ? "error: " + TG.bot.error : "in use") : "not set up (optional)" },
  { name: "Telegram account login (official Telegram API)", cost: "Free", account: "Your Telegram account; api_id / api_hash from my.telegram.org (TELEGRAM_API_ID / TELEGRAM_API_HASH on Render)", limits: "Reads only the channels and groups you pick, as your Telegram app would; never posts. Telegram may limit accounts that make too many requests, so the site reads each chat once and then listens for new messages.", status: GJ && TGU_ID && TGU_HASH ? "available" : "not set up (optional)" },
  { name: "Google Fonts", cost: "Free", account: "None", limits: "Fonts for the page; the site works with system fonts if blocked.", status: "in use" },
  { name: "UptimeRobot (optional, keeps the free server awake)", cost: "Free plan", account: "Your UptimeRobot account, if you create one", limits: "Pings /healthz every 5 minutes. Uses about 744 of Render's 750 free hours a month for this one site.", status: "optional, set up by you" },
], paid: "None. The site uses no paid API, paid data feed, paid Telegram feature, paid database or paid add-on." }));

app.get(/^\/(?!api\/|auth\/).*/, sendApp);   // e.g. /home or /chart after a reload

app.listen(PORT, () => {
  console.log(`\nSignal Desk (Fyers real-time feed) on ${BASE}`);
  console.log("  Fyers app  : " + (APP_ID && SECRET ? "set" : "NOT SET — add FYERS_APP_ID and FYERS_SECRET_ID"));
  console.log("  redirect   : " + REDIRECT + "   (enter exactly this in the Fyers app)");
  console.log("  visitors   : each logs in with their own Fyers account");
  setTimeout(mastersFresh, 2000);
  loadEngine(); scheduleScan(); tgBotLoop();                                // symbol lists load in the background
  console.log("  password   : " + (SITE_PASSWORD ? "on — asked before the page opens" : "off — the site opens normally") + "\n");
});
