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
     FYERS_PER_MIN     optional   most Fyers data requests a minute (default 40;
                                  Fyers' free Standard plan allows 50)
     FYERS_PER_DAY     optional   most Fyers data requests a day (default 4500;
                                  the Standard plan allows 5,000)
     FYERS_FEED        optional   "off" turns the live WebSocket price feed off

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

const UNIVERSE = [            // known instruments; only the WATCH ones below are loaded on the pages
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
/* The watchlist the pages load and refresh: only the instruments asked for (the others above stay
   known, so Telegram calls, My trades and search can still use them, but they are not loaded or priced
   unless opened). The All F&O scan covers every instrument with options separately. */
const WATCH = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "HDFCBANK", "CRUDEOIL", "RELIANCE", "ICICIBANK", "SBIN", "NATURALGAS"]);
UNIVERSE.forEach(u => { u.watch = WATCH.has(u.tkr); });
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
const watched = () => UNIVERSE.filter(u => u.fy && u.watch);

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
/* Fyers' free Standard plan allows 5 data requests a second, 50 a minute and 5,000 a day
   (quotes, option chain and history all count). Going over the per-minute limit more than
   three times in a day blocks the app's data for the rest of that day. So:
   - at most 4 a second and FYERS_PER_MIN (40) in any 60 seconds, shared by every visitor;
   - at most FYERS_PER_DAY (4,500) a day, spread over the trading day (09:00-23:30 IST),
     so the morning can't use up the evening's share. The background scan gets less than half;
   - live prices come over the Fyers WebSocket instead (see "live feed" below), which is not
     counted as requests;
   - after a "too many requests" answer, nothing is sent for 65 s; if Fyers keeps refusing,
     the server assumes the app is blocked for today and stops asking (one check every 30 min).
   When a request can't be sent, callers get the last good data instead of waiting. */
let tail = Promise.resolve(), lastCall = 0;
const LIM = { perMin: Math.max(5, Math.min(480, +env("FYERS_PER_MIN") || 40)), perDay: Math.max(200, Math.min(480000, +env("FYERS_PER_DAY") || 4500)) };
const RL = { perMin: LIM.perMin, gapMs: 250, sent: [], waiting: 0, maxWaiting: 40, pauseUntil: 0, strikes: 0, day: "", dayCount: 0, limited: 0,
  limitedToday: 0, blockedDay: "", lastProbe: 0, denied: 0 };
const BUDGET_MSG = "Saving Fyers' daily request allowance: showing the last prices for now";
const BLOCK_MSG = "Fyers has paused this app's data requests for the rest of today (too many requests earlier). Live data returns tomorrow; saved data is shown until then.";
const USAGE_FILE = require("path").join(require("os").tmpdir(), "signal-desk-fyers-usage.json");
try { const u = JSON.parse(require("fs").readFileSync(USAGE_FILE, "utf8"));       // survives a restart of the server process
  if (u.day === new Date(Date.now() + 19800000).toISOString().slice(0, 10)) { RL.day = u.day; RL.dayCount = u.count || 0; RL.limitedToday = u.limited || 0; RL.blockedDay = u.blocked || ""; }
  RL.sent = (u.sent || []).filter(t => Date.now() - t < 60000); } catch (e) {}     // the last minute's requests still count after a restart
let usageSaveT = null;
function saveUsage() { if (usageSaveT) return; usageSaveT = setTimeout(() => { usageSaveT = null;
  try { require("fs").writeFileSync(USAGE_FILE, JSON.stringify({ day: RL.day, count: RL.dayCount, limited: RL.limitedToday, blocked: RL.blockedDay, sent: RL.sent.filter(t => Date.now() - t < 60000) })); } catch (e) {} }, 1000); }
// how many requests today may have been used by now: an even share of the day, plus a start-up allowance
function dayAllowance(low) {
  const x = new Date(Date.now() + 19800000), m = x.getUTCHours() * 60 + x.getUTCMinutes();
  const frac = Math.min(1, Math.max(0, (m - 540) / 870));
  const even = LIM.perDay * 0.8 * frac;
  return low ? Math.min(LIM.perDay * 0.45, even * 0.45 + LIM.perDay * 0.06) : Math.min(LIM.perDay, even + LIM.perDay * 0.15);
}
function budgetRefusal(low) {
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  if (RL.day !== today) { RL.day = today; RL.dayCount = 0; RL.limitedToday = 0; RL.strikes = 0; RL.perMin = LIM.perMin; }
  if (RL.blockedDay === today) {
    if (Date.now() - RL.lastProbe > 30 * 60000 && !low) { RL.lastProbe = Date.now(); return null; }   // one check every 30 minutes
    return BLOCK_MSG;
  }
  if (RL.blockedDay && RL.blockedDay !== today) RL.blockedDay = "";
  if (RL.dayCount >= LIM.perDay) return "Today's Fyers request allowance (" + LIM.perDay + ") is used up; showing the last data until tomorrow.";
  if (RL.dayCount >= dayAllowance(low)) return BUDGET_MSG;
  const left = RL.pauseUntil - Date.now();
  if (left > 3000) return "Fyers rate limit reached; slowing down.";
  return null;
}
const lane = new AsyncLocalStorage();          // "low" = the background scan; pages' own requests always go first
const Q = { hi: [], lo: [], pumping: false };
function queued(fn) {
  const low = lane.getStore() === "low";
  const no = budgetRefusal(low);
  if (no) { RL.denied++; const e = new Error(no); e.budget = true; return Promise.reject(e); }
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
      const isLow = !Q.hi.length, job = isLow ? Q.lo.shift() : Q.hi.shift(); RL.waiting = Q.hi.length + Q.lo.length;
      const no = budgetRefusal(isLow);
      if (no) { RL.denied++; const e = new Error(no); e.budget = true; job.reject(e); continue; }
      RL.sent.push(Date.now()); RL.dayCount++; lastCall = Date.now(); saveUsage();
      Promise.resolve().then(job.fn).then(job.resolve, job.reject);
    }
  } finally { Q.pumping = false; }
}
function rateLimited() {
  RL.limited++; RL.limitedToday++; RL.strikes = Math.min(RL.strikes + 1, 4);
  RL.pauseUntil = Date.now() + 65000 * RL.strikes;           // let Fyers' one-minute window clear: 65 s, then 130 s...
  // refused again and again with no good answer in between: the app is blocked for the day
  if (RL.strikes >= 3) { RL.blockedDay = istDay(Date.now()); RL.lastProbe = Date.now(); }
  if (RL.limitedToday >= 2) RL.perMin = Math.max(5, Math.floor(LIM.perMin / 2));       // be twice as careful for the rest of the day
  saveUsage();
  console.log("  Fyers said too many requests: pausing " + 65 * RL.strikes + " s" + (RL.blockedDay ? " (treating the app as blocked for today)" : ""));
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
  if (j && (j.s === "ok" || j.s === "no_data")) { if (RL.strikes) RL.strikes = 0; if (RL.blockedDay) { RL.blockedDay = ""; saveUsage(); } return j; }
  const code = j ? Number(j.code) : 0;
  if (r.status === 401 || r.status === 403 || AUTH_CODES.includes(code)) {
    dropAccess(NEED_LOGIN);
    throw new Error(NEED_LOGIN);
  }
  if (r.status === 429 || code === -429) { rateLimited(); throw new Error("Fyers rate limit reached; slowing down."); }
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
async function liveSet(cands0) {
  const ok = new Set();
  // only ask about candidates that exist in Fyers' own symbol lists (when loaded), so one unknown symbol can't spoil a batch
  const cands = SYM.byTicker.size ? cands0.filter(c => SYM.byTicker.has(c) || !/^MCX:/.test(c)) : cands0;
  let single = 0;
  for (let i = 0; i < cands.length; i += 50) {
    try {
      const j = await fy("/quotes", { symbols: cands.slice(i, i + 50).join(",") });
      for (const d of j.d || []) if (d && d.s !== "error" && d.v && d.v.lp > 0) ok.add(d.n);
    } catch (e) {
      if (e.message === NEED_LOGIN) throw e;
      if (/did not answer|rate limit|HTTP 5/.test(e.message)) { ok.failed = e; continue; }
      // Fyers refused the batch as a whole (for example one unknown symbol): ask one by one.
      for (const s of cands.slice(i, i + 50)) {
        if (++single > 8) { ok.failed = ok.failed || new Error("symbol check skipped to save requests"); break; }
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
/* Every listed option contract, by underlying ("NSE:NIFTY", "MCX:CRUDEOIL"), as [ticker, strike, "CE"|"PE", expiry ms, lot],
   from Fyers' public symbol lists. Used to build an option chain from the live price feed when Fyers' normal
   requests are refused or slow. */
let OPTS = new Map(), FUTS = new Map();         // FUTS: index / stock futures by underlying, [{t, exp}]
const OPT_TAIL = /(\d+(?:\.\d+)?)(CE|PE)$/;
const TICK = /^(NSE|BSE|MCX):[A-Z0-9&_.-]+$/;
async function loadMasters() {
  const list = [], fo = new Map(), mcx = new Map(), status = {}, opts = new Map(), futs = new Map();
  const addOpt = (key, t, strike, ty, exp, lot) => { if (!(strike > 0) || !exp) return; let a = opts.get(key); if (!a) { a = []; opts.set(key, a); } a.push([t, strike, ty, exp * 1000, lot]); };
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
          if (und && /FUT$/.test(t) && exp * 1000 > Date.now() - 864e5) { const k = exch + ":" + und; (futs.get(k) || futs.set(k, []).get(k)).push({ t, exp }); }
          if (und) { const k = exch + ":" + und, o = fo.get(k) || { opt: false, lot: null };
            if (/(CE|PE)$/.test(t)) o.opt = true; if (lot && !o.lot) o.lot = lot; fo.set(k, o);
            if (/(CE|PE)$/.test(t) && exp * 1000 > Date.now() - 864e5) {
              const ty = /^(CE|PE)$/.test(c[16] || "") ? c[16] : t.slice(-2);
              // strike: its own column; if that is empty, the date code + strike at the end of the ticker
              let k15 = parseFloat(c[15]);
              if (!(k15 > 0)) { const mm = /\d{2}(?:[A-Z]{3}|[1-9OND]\d{2})(\d+(?:\.\d+)?)(?:CE|PE)$/.exec(t); k15 = mm ? +mm[1] : 0; }
              addOpt(k, t, k15, ty, exp, lot);
            } }
          return;
        }
        if (name === "MCX_COM") {
          const m = /^MCX:([A-Z]+?)\d{2}[A-Z]{3}(FUT|\d+(CE|PE))$/.exec(t); if (!m) return;
          const k = m[1], o = mcx.get(k) || { opt: false, fut: null };
          if (m[3]) { o.opt = true;
            if (exp * 1000 > Date.now() - 864e5) { let k15 = parseFloat(c[15]); if (!(k15 > 0)) { const mm = /\d{2}[A-Z]{3}(\d+(?:\.\d+)?)(?:CE|PE)$/.exec(t); k15 = mm ? +mm[1] : 0; }
              addOpt("MCX:" + k, t, k15, m[3], exp, lot); } }
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
  if (opts.size) OPTS = opts; if (futs.size) FUTS = futs;
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
const usage = () => ({ lastMinute: RL.sent.filter(t => Date.now() - t < 60000).length, today: RL.dayCount, perDay: LIM.perDay, perMin: LIM.perMin,
  allowedByNow: Math.round(dayAllowance(false)), waiting: RL.waiting, pausedFor: Math.max(0, Math.round((RL.pauseUntil - Date.now()) / 1000)),
  limitedTimes: RL.limited, limitedToday: RL.limitedToday, blockedToday: RL.blockedDay === istDay(Date.now()), saved: RL.denied,
  feed: feedInfo() });
app.get("/healthz", (_req, res) => res.json({ ok: true, up: Math.round(process.uptime()), ts: Date.now(), fyers: usage() }));
app.get("/icon.svg", (_req, res) => res.type("image/svg+xml").send(ICON));
app.get("/manifest.webmanifest", (_req, res) => res.type("application/manifest+json").json({
  name: "Signal Desk", short_name: "Signal Desk", start_url: "/", scope: "/", display: "standalone",
  background_color: "#0F1319", theme_color: "#161B23",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
}));

/* The service worker: shows phone notifications sent by this server, even when the site is closed. */
const SW_JS = `self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("push",e=>{ let d={}; try{ d=e.data?e.data.json():{}; }catch(x){ d={title:"Signal Desk",body:e.data?e.data.text():""}; }
  e.waitUntil(self.registration.showNotification(d.title||"Signal Desk",{body:d.body||"",tag:d.tag||undefined,renotify:!!d.tag,icon:"/icon.svg",badge:"/icon.svg",data:{url:d.url||"/"},requireInteraction:!!d.sticky})); });
self.addEventListener("notificationclick",e=>{ e.notification.close(); const url=(e.notification.data&&e.notification.data.url)||"/";
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{ for(const w of ws){ if("focus" in w){ w.navigate&&w.navigate(url); return w.focus(); } } return self.clients.openWindow(url); })); });
self.addEventListener("fetch",()=>{});`;
app.get("/sw.js", (_req, res) => { res.set({ "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" }); res.send(SW_JS); });

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
    setAccess(j.access_token); setTimeout(feedEnsure, 500);
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
      // checking the token costs a request: skip it while Fyers has paused this app, and trust the token's own expiry
      if (RL.blockedDay !== istDay(Date.now())) await fy("/quotes", { symbols: "NSE:NIFTY50-INDEX" });
      setTimeout(feedEnsure, 500);
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
  if (ok) feedEnsure();
  res.json({ authenticated: ok, error: ok ? null : auth.error, login: APP_ID && SECRET ? "/auth/login" : null,
             redirect: REDIRECT, provider: "fyers", delayed: false, pollMs: 5000, ts: Date.now(), fyers: usage(),
             feed: feedInfo(), note: RL.blockedDay === istDay(Date.now()) ? BLOCK_MSG : null });
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
  fo: u.fo, open: u.open, close: u.close, watch: !!u.watch,
})))));

/* ------------------------------------------------------------ live feed -- */
/* Live prices over the Fyers data WebSocket (official "fyers-api-v3" package, free).
   Ticks are not counted against the request limits, so the server builds 1-minute
   candles from them and serves charts, quotes and the scan from memory. History is
   fetched once per instrument per day (and again after a reconnect) and joined to
   the live candles. If the WebSocket can't be used, everything falls back to normal
   requests, at a slower pace that stays inside the limits. */
let FyersDS = null, FEED_LOAD_ERR = null;
// The package allows one WebSocket object per process, tied to the login it was made with. A fresh copy of the
// package is loaded for each new connection (after closing the old one), so a reconnect or a new login works.
function loadDS() {
  for (const k of Object.keys(require.cache)) if (/[\\/]fyers-api-v3[\\/]/.test(k)) delete require.cache[k];
  return require("fyers-api-v3").fyersDataSocket;
}
try { FyersDS = loadDS(); } catch (e) { FEED_LOAD_ERR = "fyers-api-v3 package not installed"; }
const FEED = { sock: null, tok: null, state: env("FYERS_FEED") === "off" ? "off" : FyersDS ? "idle" : "unavailable", err: FEED_LOAD_ERR,
  since: 0, connAt: 0, lastTick: 0, ticks: 0, retryAt: 0, fails: 0, subs: new Map(), pend: new Set(), last: new Map(), m1: new Map(), vol: new Map() };
const FEED_MAX = 3000;
const feedInfo = () => ({ state: FEED.state, symbols: FEED.subs.size, ticking: FEED.last.size, ticks: FEED.ticks,
  lastTickAgo: FEED.lastTick ? Math.round((Date.now() - FEED.lastTick) / 1000) : null, error: FEED.err });
function bestSession() {
  return [...sessions.values()].filter(v => v.access && (!v.exp || Date.now() < v.exp - 60000)).sort((a, b) => b.seen - a.seen)[0] || null;
}
function feedClose() {
  const s0 = FEED.sock; FEED.sock = null;
  if (s0) try { s0.close(); } catch (e) {}
}
function feedEnsure() {
  if (FEED.state === "off" || FEED.state === "unavailable") return;
  const sess = bestSession();
  if (!sess) { if (FEED.sock) { feedClose(); FEED.state = "idle"; } return; }
  if (FEED.sock && FEED.tok === sess.access && (FEED.state === "live" || FEED.state === "connecting")) {
    // connected but silent while a market is open: reconnect
    if (FEED.state === "live" && anyOpen() && FEED.lastTick && Date.now() - FEED.lastTick > 180000 && FEED.subs.size) { FEED.err = "no prices for 3 minutes; reconnecting"; feedClose(); FEED.state = "closed"; }
    else if (FEED.state === "connecting" && Date.now() - FEED.since > 45000) { FEED.err = "the WebSocket did not connect within 45 s"; feedClose(); FEED.state = "closed"; FEED.fails++; FEED.retryAt = Date.now() + Math.min(600000, 15000 * 2 ** Math.min(FEED.fails, 5)); }
    else return;
  }
  if (Date.now() < FEED.retryAt && FEED.tok === sess.access) return;
  feedClose();
  FEED.tok = sess.access; FEED.state = "connecting"; FEED.since = Date.now();
  let sk;
  try { sk = new (loadDS())(APP_ID + ":" + sess.access, require("os").tmpdir(), false); }
  catch (e) { FEED.err = "WebSocket could not start: " + e.message; FEED.state = "closed"; FEED.fails++; FEED.retryAt = Date.now() + 300000; return; }
  FEED.sock = sk;
  sk.on("connect", () => {
    if (FEED.sock !== sk) return;
    FEED.state = "live"; FEED.connAt = Date.now(); FEED.err = null; FEED.fails = 0;
    const syms = [...FEED.subs.keys()]; for (const k of syms) FEED.subs.set(k, Date.now());   // anything older needs history again
    try { sk.mode(sk.FullMode); } catch (e) {}
    feedSendSubs(syms);
    console.log("  live feed: WebSocket connected (" + syms.length + " symbols)");
  });
  sk.on("message", m => { if (FEED.sock === sk) feedTick(m); });
  sk.on("error", e => { if (FEED.sock !== sk) return; FEED.err = typeof e === "string" ? e : (e && (e.message || e.msg || JSON.stringify(e))) || "WebSocket error"; });
  sk.on("close", () => {
    if (FEED.sock !== sk) return;
    FEED.sock = null; FEED.state = "closed"; FEED.fails++;
    FEED.retryAt = Date.now() + Math.min(600000, 10000 * 2 ** Math.min(FEED.fails, 6));
    console.log("  live feed: WebSocket closed" + (FEED.err ? " (" + String(FEED.err).slice(0, 120) + ")" : "") + "; using normal requests until it reconnects");
  });
  try { sk.connect(); } catch (e) { FEED.err = e.message; FEED.state = "closed"; FEED.sock = null; FEED.fails++; FEED.retryAt = Date.now() + 120000; }
}
function feedSendSubs(syms) {
  const sk = FEED.sock; if (!sk || FEED.state !== "live" || !syms.length) return;
  for (let i = 0; i < syms.length; i += 100) { try { sk.subscribe(syms.slice(i, i + 100)); } catch (e) { FEED.err = "subscribe: " + e.message; } }
}
// ask for live prices of these symbols (kept for the day; at most FEED_MAX)
function feedSub(list) {
  if (FEED.state === "off" || FEED.state === "unavailable") return;
  const add = [];
  for (const t of list) if (t && !FEED.subs.has(t) && FEED.subs.size < FEED_MAX) { FEED.subs.set(t, Date.now()); add.push(t); }
  if (add.length) feedSendSubs(add);
}
function feedTick(m) {
  if (Array.isArray(m)) { m.forEach(feedTick); return; }
  if (!m || typeof m !== "object" || !m.symbol || !(m.ltp > 0)) return;
  const now = Date.now(), sym = m.symbol;
  let ts = (+m.exch_feed_time || +m.last_traded_time || 0) * 1000;
  if (!ts || Math.abs(ts - now) > 90000) ts = now;
  FEED.lastTick = now; FEED.ticks++;
  const prev = FEED.last.get(sym) || {};
  FEED.last.set(sym, { ltp: m.ltp, open: m.open_price ?? prev.open, high: m.high_price ?? prev.high, low: m.low_price ?? prev.low,
    prev: m.prev_close_price ?? prev.prev, chp: m.chp ?? prev.chp, vol: m.vol_traded_today ?? prev.vol, bid: m.bid_price ?? prev.bid, ask: m.ask_price ?? prev.ask, at: now });
  const min = Math.floor(ts / 60000) * 60000;
  let arr = FEED.m1.get(sym); if (!arr) { arr = []; FEED.m1.set(sym, arr); }
  let dv = 0; const pv = FEED.vol.get(sym);
  if (m.vol_traded_today != null) { if (pv != null && m.vol_traded_today >= pv) dv = m.vol_traded_today - pv; FEED.vol.set(sym, m.vol_traded_today); }
  const b = arr[arr.length - 1];
  if (b && b[0] === min) { if (m.ltp > b[2]) b[2] = m.ltp; if (m.ltp < b[3]) b[3] = m.ltp; b[4] = m.ltp; b[5] += dv; }
  else if (!b || min > b[0]) { arr.push([min, m.ltp, m.ltp, m.ltp, m.ltp, dv]); if (arr.length > 1600) arr.splice(0, arr.length - 1500); }
}
// prices for this symbol are flowing (or the market is shut and the last ones are final)
function feedHas(t, u) {
  if (FEED.state !== "live" || !FEED.subs.has(t)) return false;
  if (FEED.lastTick && Date.now() - FEED.lastTick > 180000 && anyOpen()) return false;              // the whole feed went quiet
  const subAt = FEED.subs.get(t), x = FEED.last.get(t);
  if (!x && Date.now() - subAt > 180000 && (!u || openNow(u))) return false;                        // never priced: not served by the feed
  return true;
}
// live 1-minute bars since `from`, grouped into `want`-minute candles aligned to the session open
function liveCandles(u, want, from) {
  const arr = FEED.m1.get(u.fy) || [], out = []; let key = null, cur = null;
  const open = u.open || 555, close = u.close || 930;
  for (const b of arr) {
    if (b[0] < from) continue;
    const lt = b[0] + IST, dayStart = Math.floor(lt / 864e5) * 864e5 - IST, mod = Math.floor((lt % 864e5) / 60000);
    if (mod < open || mod >= close) continue;
    const start = dayStart + (open + Math.floor((mod - open) / want) * want) * 60000;
    if (start !== key) { key = start; cur = [start, b[1], b[2], b[3], b[4], b[5]]; out.push(cur); }
    else { if (b[2] > cur[2]) cur[2] = b[2]; if (b[3] < cur[3]) cur[3] = b[3]; cur[4] = b[4]; cur[5] += b[5]; }
  }
  return out;
}
setInterval(() => { try { feedEnsure(); } catch (e) { FEED.err = e.message; } }, 20000).unref();

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
  res.json(await candlesOf(u, want, req.query.hot === "1"));
}));
/* With the live feed: history once per day (and again after a reconnect), joined to candles built from ticks.
   Without it: history requests, at most every minute for the chart being looked at and every 10 minutes for the rest. */
async function candlesOf(u, want, hot) {
  feedSub([u.fy]);
  if (feedHas(u.fy, u)) {
    const subAt = FEED.subs.get(u.fy), key = `bf:${u.tkr}:${want}`, hit = cache.get(key);
    // history is good if it was fetched after live prices started for this symbol, today
    const fresh = hit && hit.val && hit.val.fetchedAt >= subAt && istDay(hit.val.fetchedAt) === istDay(Date.now());
    let bf;
    try { bf = await cached(key, fresh ? 864e5 : 0, () => restHistory(u, want)); }
    catch (e) { if (hit && hit.val) bf = hit.val; else if (e.message !== NEED_LOGIN) bf = { candles: [], partial: true }; else throw e; }   // history not available now: live candles only (the page adds its saved history)
    const live = liveCandles(u, want, Math.floor(subAt / 60000) * 60000);
    const out = bf.candles.slice();
    for (const c of live) {                                 // join: a candle in both keeps the wider range and the live close
      const i = out.length ? out.findIndex((x, k) => k >= out.length - 400 && x[0] === c[0]) : -1;
      if (i >= 0) { const x = out[i]; out[i] = [x[0], x[1], Math.max(x[2], c[2]), Math.min(x[3], c[3]), c[4], x[5] + c[5]]; }
      else if (!out.length || c[0] > out[out.length - 1][0]) out.push(c);
    }
    return { tkr: u.tkr, interval: want + "m", candles: out, feed: "live", partial: !!bf.partial };
  }
  const ttl = !openNow(u) ? 1800000 : want >= 15 ? 600000 : hot ? 60000 : 600000;
  return cached(`c:${u.tkr}:${want}`, ttl, () => restHistory(u, want));
}
const restHistory = async (u, want) => {
    const j = await fy("/history", { symbol: u.fy, resolution: String(want), date_format: "1",
      range_from: istDay(Date.now() - DAYS[want] * 864e5), range_to: istDay(Date.now()), cont_flag: "1" });
    const candles = (j.candles || []).filter(c => c && c.length >= 5 && c[1] != null && c[4] != null)
      .map(c => [c[0] < 1e11 ? c[0] * 1000 : c[0], c[1], c[2], c[3], c[4], c[5] || 0])
      .sort((a, b) => a[0] - b[0]);
    return { tkr: u.tkr, interval: want + "m", candles, fetchedAt: Date.now() };
  };

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
  feedEnsure(); feedSub(watched().map(u => u.fy).concat(extra));
  const allLive = watched().every(u => feedHas(u.fy, u) && FEED.last.has(u.fy)) && extra.every(t => FEED.last.has(t));
  let out;
  try { out = await cached("quotes:" + extra.join(","), !anyOpen() || FEED.state === "live" ? 600000 : 60000, async () => {
    const j = await fy("/quotes", { symbols: watched().map(u => u.fy).concat(extra).join(",") });
    const q = { __at: Date.now() };
    for (const d of j.d || []) {
      const u = UNIVERSE.find(x => x.fy === d.n) || (extra.includes(d.n) ? { tkr: d.n } : null), v = d.v;
      if (!u || !v || v.lp == null) continue;
      const prev = v.prev_close_price > 0 ? v.prev_close_price : null;
      q[u.tkr] = { ltp: v.lp, open: v.open_price || null, high: v.high_price || null, low: v.low_price || null,
                   close: prev, chg: v.chp != null ? v.chp : (prev ? ((v.lp - prev) / prev) * 100 : 0), vol: v.volume || 0 };
    }
    return q;
  }); } catch (e) { if (!(FEED.state === "live" && FEED.last.size)) throw e; out = { __at: 0 }; }
  // live prices from the feed replace the requested ones
  out = Object.assign({}, out); let at = out.__at || 0;
  for (const u of watched().concat(extra.map(t => ({ tkr: t, fy: t })))) {
    const x = FEED.state === "live" && FEED.last.get(u.fy); if (!x) continue;
    const p0 = out[u.tkr] || {}, prev = x.prev > 0 ? x.prev : p0.close || null;
    out[u.tkr] = { ltp: x.ltp, open: x.open || p0.open || null, high: x.high || p0.high || null, low: x.low || p0.low || null, close: prev,
      chg: x.chp != null ? x.chp : prev ? (x.ltp - prev) / prev * 100 : p0.chg || 0, vol: x.vol != null ? x.vol : p0.vol || 0 };
    if (x.at > at) at = x.at;
  }
  const { __at, ...quotes } = out;
  res.json({ ts: at || Date.now(), quotes, delayed: false, feed: FEED.state === "live" ? "live" : "requests" });
}));

/* ---------------------------------------------------------- option chain -- */
const isoOf = dmy => { const [d, m, y] = String(dmy).split("-"); return `${y}-${m}-${d}`; };
async function rawChain(u, epoch) {
  const p = { symbol: u.fy, strikecount: "20", timestamp: epoch || "" };
  try { return await fy("/options-chain-v3", { ...p, greeks: "1" }); }
  catch (e) { if (e.message === NEED_LOGIN) throw e; return fy("/options-chain-v3", p); }
}
// with the live feed the premiums near the price are live anyway, so the chain itself (OI, far strikes) is asked for every 5 minutes
const chainOf = (u, epoch) => cached(`ch:${u.tkr}:${epoch || ""}`, !openNow(u) ? 900000 : FEED.state === "live" ? 300000 : 120000, () => rawChain(u, epoch));
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
  try { res.json({ expiries: (await expiriesOf(u)).slice(0, 6).map(e => e.iso) }); }
  catch (e) {                                       // the symbol lists know the expiries too
    const ex = [...new Set((OPTS.get(undKey(u)) || []).map(o => o[3]).filter(t => t > Date.now() - 6 * 3600e3))].sort((a, b) => a - b).map(istDay);
    if (!ex.length || e.message === NEED_LOGIN) throw e; res.json({ expiries: ex.slice(0, 6) }); }
}));

app.get("/api/chain", guard(async (req, res) => {
  const u = bySym(req.query.tkr);
  if (!u) return res.status(404).json({ error: "unknown symbol" });
  if (!u.fo) return res.status(404).json({ error: "no option chain for " + u.name });
  res.json(await chainData(u, req.query.expiry));
}));
/* The underlying name the symbol lists use: "NSE:NIFTY", "BSE:SENSEX", "NSE:RELIANCE", "MCX:CRUDEOIL". */
function undKey(u) {
  if (u.seg === "MCX") { const m = /^MCX:([A-Z]+?)\d{2}[A-Z]{3}FUT$/.exec(u.fy || ""); return "MCX:" + (m ? m[1] : u.tkr); }
  const ex = (u.fy || "NSE:").slice(0, 3);
  if (u.seg === "IDX") { const m = /^(?:NSE|BSE):([A-Z0-9]+)-INDEX$/.exec(u.fy || ""); return ex + ":" + (m ? idxUnder(m[1]) : u.tkr); }
  const m = /^(?:NSE|BSE):([A-Z0-9&_-]+?)-(EQ|BE|A|B)$/.exec(u.fy || ""); return ex + ":" + (m ? m[1] : u.tkr);
}
/* An option chain built from Fyers' public symbol lists and the live price feed (no request counted against the
   limit): live premiums, bid / ask and volume for the strikes near the price. Open interest is not in the feed. */
async function feedChain(u, expiry) {
  if (FEED.state !== "live") throw new Error("the live price feed is not connected");
  const all = (OPTS.get(undKey(u)) || []).filter(o => o[3] > Date.now() - 6 * 3600e3);
  if (!all.length) throw new Error("no listed options found for " + (u.label || u.name || u.tkr) + " in Fyers' symbol lists");
  const exps = [...new Set(all.map(o => o[3]))].sort((a, b) => a - b), iso = ms => istDay(ms);
  const pick = exps.find(e => iso(e) === expiry) || exps[0];
  feedSub([u.fy]);
  let lv = FEED.last.get(u.fy);
  for (let i = 0; i < 12 && !lv; i++) { await sleep(250); lv = FEED.last.get(u.fy); }
  if (!lv) throw new Error("no live price yet for " + (u.label || u.name || u.tkr));
  const spot = lv.ltp, legs = all.filter(o => o[3] === pick);
  const strikes = [...new Set(legs.map(o => o[1]))].sort((a, b) => a - b);
  const near = strikes.slice().sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, 41).sort((a, b) => a - b);
  const sym = (k, ty) => (legs.find(o => o[1] === k && o[2] === ty) || [])[0];
  const want = near.flatMap(k => [sym(k, "CE"), sym(k, "PE")]).filter(Boolean);
  feedSub(want);
  for (let i = 0; i < 12 && want.filter(t => FEED.last.has(t)).length < Math.min(6, want.length); i++) await sleep(250);
  const leg = t => { const x = t && FEED.last.get(t); return { sym: t || null, ltp: x ? x.ltp : 0, oi: 0, chgOi: 0, vol: x && x.vol || 0, chg: 0, iv: null, bid: x && x.bid || null, ask: x && x.ask || null }; };
  const rows = near.map(k => ({ strike: k, ce: leg(sym(k, "CE")), pe: leg(sym(k, "PE")) })).filter(r => r.ce.sym && r.pe.sym);
  if (!rows.length) throw new Error("no option contracts near the price for " + (u.label || u.name || u.tkr));
  const gaps = near.slice(1).map((k, i) => k - near[i]).filter(g => g > 0).sort((a, b) => a - b), step = gaps[0] || u.step || 50;
  const lot = (legs[0] || [])[4] || u.lot || null;
  return { tkr: u.tkr, expiry: iso(pick), expiries: exps.map(iso), spot, prevClose: lv.prev || null, atm: Math.round(spot / step) * step, step,
    lot, daysOut: Math.max((pick - Date.now()) / 864e5, 0.02), rows, ivFromFeed: false, source: "feed",
    note: "Built from the live price feed because Fyers' option-chain request was not available: premiums, bid / ask and volume are live; open interest is not included." };
}
async function chainData(u, expiry) {
  try { return await chainDataRest(u, expiry); }
  catch (e) { if (e.message === NEED_LOGIN || FEED.state !== "live") throw e;
    try { return await feedChain(u, expiry); } catch (e2) { throw new Error(e.message + "; " + e2.message); } }
}
async function chainDataRest(u, expiry) {
  const list = await expiriesOf(u);
  if (!list.length) throw new Error("Fyers returned no expiries for " + u.name);
  const pick = list.find(e => e.iso === expiry) || list[0];
  const j = await chainOf(u, pick === list[0] ? "" : pick.epoch);

  const iv = v => (v > 0 ? (v > 3 ? v / 100 : v) : null);   // percent or fraction, either way
  let spot = null, prevClose = null; const by = new Map();      // spot may be replaced by the live price below
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
  // live premiums for the strikes near the price (the chain itself is asked for at most once a minute)
  if (FEED.state === "live") {
    const near6 = rows.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 12);
    feedSub(near6.flatMap(r => [r.ce.sym, r.pe.sym]).filter(Boolean));
    const lv = FEED.last.get(u.fy); if (lv && Date.now() - lv.at < 120000) spot = lv.ltp;
    for (const r of rows) for (const k of ["ce", "pe"]) { const x = r[k].sym && FEED.last.get(r[k].sym);
      if (x && Date.now() - x.at < 120000) Object.assign(r[k] = Object.assign({}, r[k]), { ltp: x.ltp, bid: x.bid || r[k].bid, ask: x.ask || r[k].ask, vol: x.vol != null ? x.vol : r[k].vol }); }
  }
  const near = rows.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
                   .slice(0, 7).map(r => r.strike).sort((a, b) => a - b);
  const gaps = near.slice(1).map((s, i) => s - near[i]).filter(g => g > 0).sort((a, b) => a - b);
  const step = gaps.length ? gaps[0] : u.step;
  const atm = Math.round(spot / step) * step;
  const daysOut = Math.max((pick.epoch * 1000 - Date.now()) / 864e5, 0.02);
  return { tkr: u.tkr, expiry: pick.iso, expiries: list.map(e => e.iso), spot, prevClose, atm, step,
             lot: u.lot, daysOut, rows, ivFromFeed: true };
}



/* -------------------------------------------------- phone notifications -- */
/* Web Push: the free notification service built into Android Chrome (and iPhone Safari for a site added to the
   home screen). No account or app store is involved. The keys are worked out from the Fyers secret, so they
   stay the same after a restart and nothing has to be added on Render. Subscriptions are kept in a file and the
   page sends its own again each time it opens, so a restart loses nothing for long. */
let webpush = null; try { webpush = require("web-push"); } catch (e) {}
const PUSH = { subs: new Map(), sent: new Set(), ok: false, err: null, file: path.join(require("os").tmpdir(), "signal-desk-push.json"), pub: null };
(function pushInit() {
  if (!webpush) { PUSH.err = "web-push package not installed"; return; }
  let seed = SECRET ? crypto.createHash("sha256").update("signal-desk-vapid|" + APP_ID + "|" + SECRET).digest() : crypto.randomBytes(32), pub = null;
  for (let i = 0; i < 6 && !pub; i++) { try { const e = crypto.createECDH("prime256v1"); e.setPrivateKey(seed); pub = e.getPublicKey(); } catch (x) { seed = crypto.createHash("sha256").update(seed).digest(); } }
  try { webpush.setVapidDetails(BASE.startsWith("https") ? BASE : "mailto:alerts@signal-desk.invalid", pub.toString("base64url"), seed.toString("base64url"));
    PUSH.pub = pub.toString("base64url"); PUSH.ok = true; } catch (e) { PUSH.err = e.message; }
  try { for (const x of JSON.parse(require("fs").readFileSync(PUSH.file, "utf8"))) if (x && x.sub && x.sub.endpoint) PUSH.subs.set(x.sub.endpoint, x); } catch (e) {}
})();
const pushSave = () => { try { require("fs").writeFileSync(PUSH.file, JSON.stringify([...PUSH.subs.values()])); } catch (e) {} };
// kinds: "watch" (signals on the watchlist), "fno" (strict signals on any F&O instrument), "tg" (new Telegram posts)
function pushSend(kind, key, msg) {
  if (!PUSH.ok || PUSH.sent.has(key)) return; PUSH.sent.add(key);
  if (PUSH.sent.size > 5000) PUSH.sent = new Set([...PUSH.sent].slice(-2000));
  for (const x of [...PUSH.subs.values()]) {
    if (!(x.prefs || {})[kind]) continue;
    webpush.sendNotification(x.sub, JSON.stringify(msg), { TTL: 900, urgency: "high" })
      .then(() => { x.okAt = Date.now(); x.fails = 0; })
      .catch(e => { if (e.statusCode === 404 || e.statusCode === 410) { PUSH.subs.delete(x.sub.endpoint); pushSave(); } else { x.fails = (x.fails || 0) + 1; x.err = e.message; } });
  }
}
app.get("/api/push/key", (_req, res) => res.json({ ok: PUSH.ok, key: PUSH.pub, error: PUSH.err }));
app.post("/api/push/sub", (req, res) => {
  const sub = req.body && req.body.sub, p = (req.body && req.body.prefs) || {};
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    return res.status(400).json({ error: "not a valid push subscription" });
  if (!PUSH.subs.has(sub.endpoint) && PUSH.subs.size >= 50) return res.status(429).json({ error: "too many devices" });
  PUSH.subs.set(sub.endpoint, { sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
    prefs: { watch: p.watch !== false, fno: !!p.fno, tg: p.tg !== false }, at: Date.now() });
  pushSave(); res.json({ ok: true, devices: PUSH.subs.size });
});
app.post("/api/push/unsub", (req, res) => { const e = req.body && req.body.endpoint; if (e) { PUSH.subs.delete(String(e)); pushSave(); } res.json({ ok: true }); });
app.post("/api/push/test", (req, res) => {
  const x = PUSH.subs.get(String((req.body && req.body.endpoint) || ""));
  if (!PUSH.ok || !x) return res.status(400).json({ error: PUSH.ok ? "this device is not signed up for notifications" : PUSH.err });
  webpush.sendNotification(x.sub, JSON.stringify({ title: "Signal Desk", body: "Test notification: phone notifications are working.", tag: "test" }), { TTL: 60 })
    .then(() => res.json({ ok: true })).catch(e => res.status(502).json({ error: "the push service refused it: " + e.message }));
});
/* With phones signed up, stay awake on weekdays from 09:00 to 23:35 IST (Render's free plan sleeps after 15 minutes
   without requests, and a sleeping server can't send anything). About 340 of the 750 free hours a month. */
setInterval(() => {
  if (!PUSH.subs.size || !BASE.startsWith("https")) return;
  const x = new Date(Date.now() + IST), wd = x.getUTCDay(), m = x.getUTCHours() * 60 + x.getUTCMinutes();
  if (wd >= 1 && wd <= 5 && m >= 535 && m <= 1415) fetch(BASE + "/healthz", { signal: AbortSignal.timeout(20000) }).catch(() => {});
}, 10 * 60000).unref();

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
    EN = vm.runInContext(src + "\n;({analyseTF,engine,engineNormal,engineTrend,engineORB,aggregate,toBars,bs,impliedVol,demaOf,demaJudge,PRO,proPrep,proEval,proScan,proTrack,proTrend,proVol,proGrade,proCharges});", box, { timeout: 5000 });
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
  if (!sess || (Date.now() - sess.seen > 4 * 3600e3 && !PUSH.subs.size)) return;   // nobody has used the site for hours and no phone is signed up: don't spend their Fyers allowance
  SCAN.running = true; SCAN.started = Date.now(); let cpu = 0;
  try {
    await visitor.run(sess, () => lane.run("low", async () => {
      await ensureUniverse().catch(() => {});
      const day = istDay(Date.now());
      if (day !== SCAN.day) { SCAN.day = day; SCAN.signals = []; SCAN.pending = []; SCAN.opts.clear(); }
      const all = scanList(), first = !SCAN.at;
      feedEnsure(); feedSub(all.map(u => u.fy));
      const viaFeed = FEED.state === "live";
      // without the live feed, scanning every instrument costs a request each, so do it only every 30 minutes
      if (!viaFeed && !first && Date.now() - (SCAN.restAt || 0) < 30 * 60000) { SCAN.note = "Scanning every 30 minutes until the live feed connects (saves Fyers requests)"; return; }
      if (!viaFeed) SCAN.restAt = Date.now();
      SCAN.note = viaFeed ? null : "Scanning every 30 minutes until the live feed connects (saves Fyers requests)";
      const list = all.filter(u => first || openNow(u));
      if (!list.length) return;
      SCAN.total = list.length; SCAN.done = 0; SCAN.failed = 0; SCAN.emaBlocked = 0;
      const keep = new Map(SCAN.signals.map(s => [s.tkr, s]));           // instruments not scanned now keep their last result
      const found = [], pend = [];
      for (const u of list) {
        // leave room for visitors' own requests: the scan uses at most about 100 a minute
        while (RL.sent.filter(t => Date.now() - t < 60000).length >= RL.perMin * 0.5 || Q.hi.length > 0 || Q.lo.length > 1 || Date.now() < RL.pauseUntil) await sleep(400);
        let d;
        try { d = await candlesOf(u, 5); }
        catch (e) { SCAN.failed++; SCAN.lastErr = u.sym + ": " + e.message; if (e.message === NEED_LOGIN) break; if (e.budget) { SCAN.note = "Scan paused for now to stay within Fyers' daily request allowance"; break; } continue; }
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
      feedSub(live.map(o => o.sym));
      for (const o of live) { const x = FEED.state === "live" && FEED.last.get(o.sym); if (x) { o.now = x.ltp; o.nowAt = x.at; } }
      if (live.length && live.some(o => !(FEED.state === "live" && FEED.last.has(o.sym)))) try {
        const j = await fy("/quotes", { symbols: [...new Set(live.map(o => o.sym))].join(",") });
        for (const q of j.d || []) if (q && q.v && q.v.lp > 0) live.filter(o => o.sym === q.n).forEach(o => { o.now = q.v.lp; o.nowAt = Date.now(); });
      } catch (e) {}
    }));
    try { scanNotify(); } catch (e) {}
    SCAN.at = Date.now(); SCAN.cycleMs = Date.now() - SCAN.started; SCAN.cpuMs = cpu;
  } finally { SCAN.running = false; }
}
// phone notifications for new scan signals (only ones from the last 15 minutes), then for their Target 1 and their end
function scanNotify() {
  const f2 = v => v == null ? "—" : (v >= 1000 ? Math.round(v).toLocaleString("en-IN") : (+v.toFixed(2)).toString());
  const KIND = { strict: "Strict", other: "Other", normal: "Normal" };
  for (const s of SCAN.signals) {
    const k = scanKey(s), o = SCAN.opts.get(k), watch = WATCH.has(s.tkr), kind = watch ? "watch" : s.tab === "strict" ? "fno" : null;
    if (!kind) continue;
    const opt = o && o.strike ? `${o.strike} ${o.ty}` : (s.side === "BUY" ? "CALL (CE)" : "PUT (PE)");
    if (s.state === "ACTIVE" && Date.now() - s.ts < 15 * 60000)
      pushSend(kind, "new|" + k, { title: `${s.sym} — BUY ${opt}`, tag: "sig-" + k, url: "/",
        body: (o && o.buy ? `Premium ₹${f2(o.buy)} · SL ₹${f2(o.sl)} · T1 ₹${f2(o.t1)}` : `${s.sym} entry ${f2(s.entry)} · SL ${f2(s.sl)} · T1 ${f2(s.t1)}`) +
          ` · ${KIND[s.tab] || ""} signal ${new Date(s.ts + IST).toISOString().slice(11, 16)} IST` });
    if (!PUSH.sent.has("new|" + k)) continue;                       // follow-ups only for signals that were notified
    if (s.hit >= 1) pushSend(kind, "t1|" + k, { title: `${s.sym} ${opt} — Target 1 reached`, tag: "sig-" + k, url: "/", body: "Stop loss can move to the entry price. Open Signal Desk for the trailing stop." });
    if (s.state !== "ACTIVE") pushSend(kind, "end|" + k, { title: `${s.sym} ${opt} — signal ended`, tag: "sig-" + k, url: "/", body: String(s.status || "Ended") });
  }
}
// run 25 s after every 5-minute candle closes (IST is a whole number of 5-minute steps from UTC)
function scheduleScan() {
  const step = 300000, wait = step - (Date.now() % step) + 25000;
  setTimeout(() => { scanCycle().catch(e => { SCAN.lastErr = e.message; }).then(() => proCycle()).catch(e => { PROS.err = e.message; }).finally(scheduleScan); }, wait).unref();
}
app.get("/api/scan", guard(async (_req, res) => {
  if (!SCAN.at && !SCAN.running) scanCycle().catch(() => {});               // first visitor of the day starts it
  res.json({ at: SCAN.at, running: SCAN.running, total: SCAN.total, done: SCAN.done, failed: SCAN.failed, cycleMs: SCAN.cycleMs, cpuMs: SCAN.cpuMs,
    instruments: scanList().length, engineOk: SCAN.engineOk, engineErr: SCAN.engineErr, lastErr: SCAN.lastErr, note: FEED.state === "live" && /until the live feed/.test(SCAN.note || "") ? null : SCAN.note || null, feed: FEED.state,
    signals: SCAN.signals.map(s => Object.assign({}, s, { opt: SCAN.opts.get(scanKey(s)) || null })), pending: SCAN.pending });
}));



/* ======================================================= PRO SIGNALS (server) ==
   The Pro engine (rules in index.html, read like the scanner's) run every 5 minutes on the watchlist
   and on the F&O instruments that are moving, with the market's trend (NIFTY + BANK NIFTY), the index
   futures' volume and VWAP, the option chain (OI, PCR, writing, build-up), market breadth and sector
   strength. Signals scoring 75+ open a PAPER trade (never a real order), followed on the option's live
   premium with Indian charges. Every signal and every change is written to an audit log. */
const PROCFG = { strong: +env("PRO_THR_STRONG") || 75, veryStrong: +env("PRO_THR_VERY") || 85, watch: +env("PRO_THR_WATCH") || 65, minRR: +env("PRO_MIN_RR") || 1.5 };
const PROS = { day: "", signals: [], avoid: [], seenKeys: new Set(), lastTs: new Map(), market: null, overview: null, at: 0, busy: false, err: null,
  paper: [], file: path.join(require("os").tmpdir(), "signal-desk-pro.json"), logFile: path.join(require("os").tmpdir(), "signal-desk-pro-log.jsonl"), bt: new Map() };
try { const j = JSON.parse(require("fs").readFileSync(PROS.file, "utf8")); PROS.paper = j.paper || []; PROS.hist = j.hist || []; } catch (e) { PROS.hist = []; }
const proSave = () => { try { require("fs").writeFileSync(PROS.file, JSON.stringify({ paper: PROS.paper.filter(t => Date.now() - t.created < 60 * 864e5), hist: PROS.hist.filter(s => Date.now() - s.created < 60 * 864e5) })); } catch (e) {} };
const proLog = (id, event, data) => { try { require("fs").appendFileSync(PROS.logFile, JSON.stringify({ at: new Date().toISOString(), id, event, data }) + "\n"); } catch (e) {} };
const SECTORS = { "NSE:NIFTYIT-INDEX": "IT", "NSE:NIFTYBANK-INDEX": "Bank", "NSE:NIFTYPSUBANK-INDEX": "PSU bank", "NSE:NIFTYPVTBANK-INDEX": "Private bank", "NSE:FINNIFTY-INDEX": "Financial services",
  "NSE:NIFTYAUTO-INDEX": "Auto", "NSE:NIFTYPHARMA-INDEX": "Pharma", "NSE:NIFTYFMCG-INDEX": "FMCG", "NSE:NIFTYMETAL-INDEX": "Metal", "NSE:NIFTYENERGY-INDEX": "Energy",
  "NSE:NIFTYREALTY-INDEX": "Realty", "NSE:NIFTYMEDIA-INDEX": "Media", "NSE:NIFTYINFRA-INDEX": "Infrastructure" };
// main sector of common F&O stocks (others are scored on breadth only)
const STOCK_SECTOR = (() => { const m = {}, add = (sec, list) => list.split(" ").forEach(s => m[s] = sec);
  add("NSE:NIFTYIT-INDEX", "INFY TCS WIPRO HCLTECH TECHM LTIM PERSISTENT COFORGE MPHASIS OFSS");
  add("NSE:NIFTYPVTBANK-INDEX", "HDFCBANK ICICIBANK AXISBANK KOTAKBANK INDUSINDBK IDFCFIRSTB FEDERALBNK BANDHANBNK RBLBANK");
  add("NSE:NIFTYPSUBANK-INDEX", "SBIN BANKBARODA PNB CANBK UNIONBANK BANKINDIA INDIANB");
  add("NSE:FINNIFTY-INDEX", "BAJFINANCE BAJAJFINSV HDFCLIFE SBILIFE ICICIGI ICICIPRULI CHOLAFIN SHRIRAMFIN MUTHOOTFIN PFC RECLTD HDFCAMC LICHSGFIN");
  add("NSE:NIFTYAUTO-INDEX", "MARUTI TATAMOTORS TMPV M&M BAJAJ-AUTO HEROMOTOCO EICHERMOT TVSMOTOR ASHOKLEY BHARATFORG MOTHERSON BOSCHLTD");
  add("NSE:NIFTYPHARMA-INDEX", "SUNPHARMA DRREDDY CIPLA DIVISLAB LUPIN AUROPHARMA ZYDUSLIFE BIOCON GLENMARK TORNTPHARM ALKEM");
  add("NSE:NIFTYFMCG-INDEX", "HINDUNILVR ITC NESTLEIND BRITANNIA DABUR TATACONSUM MARICO GODREJCP COLPAL UBL");
  add("NSE:NIFTYMETAL-INDEX", "TATASTEEL JSWSTEEL HINDALCO VEDL SAIL JINDALSTEL NMDC NATIONALUM HINDZINC COALINDIA");
  add("NSE:NIFTYENERGY-INDEX", "RELIANCE ONGC NTPC POWERGRID BPCL IOC GAIL TATAPOWER ADANIGREEN");
  add("NSE:NIFTYREALTY-INDEX", "DLF GODREJPROP OBEROIRLTY PRESTIGE LODHA");
  add("NSE:NIFTYINFRA-INDEX", "LT ADANIPORTS ULTRACEMCO GRASIM BHARTIARTL"); return m; })();
const OVERVIEW_SYMS = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "NSE:FINNIFTY-INDEX", "NSE:INDIAVIX-INDEX"];
function proBreadth() {                          // advance / decline of F&O stocks, from the live feed
  if (FEED.state !== "live") return null;
  let adv = 0, dec = 0; for (const u of scanList()) if (u.seg === "EQ") { const x = FEED.last.get(u.fy); if (x && x.chp != null) { if (x.chp > 0.05) adv++; else if (x.chp < -0.05) dec++; } }
  if (adv + dec < 30) return null;
  const sec = Object.entries(SECTORS).map(([t, n]) => { const x = FEED.last.get(t); return x && x.chp != null ? { t, name: n, chp: x.chp } : null; }).filter(Boolean).sort((a, b) => b.chp - a.chp);
  return { adv, dec, ratio: dec ? adv / dec : adv, sectors: sec }; }
function breadthCtx(B, u) {
  if (!B) return null;
  const st = STOCK_SECTOR[(String(u.fy || "").match(/^NSE:([A-Z0-9&-]+)-EQ$/) || [])[1] || u.tkr], sx = st && B.sectors.find(s => s.t === st);
  return { score: d => (d > 0 ? (B.ratio >= 1.5 ? 3 : B.ratio >= 1.1 ? 2 : 0) : (B.ratio <= 0.67 ? 3 : B.ratio <= 0.9 ? 2 : 0)) + (sx ? (sx.chp * d > 0.3 ? 2 : sx.chp * d > 0 ? 1 : 0) : 0),
    text: `breadth ${B.adv} up / ${B.dec} down (ratio ${B.ratio.toFixed(2)})${sx ? `, ${sx.name} sector ${sx.chp >= 0 ? "+" : ""}${sx.chp.toFixed(2)}%` : ""}` }; }
/* Option chain: PCR, writing near the money, OI walls, build-up at the money. Never treated as a sure direction:
   it adds to (or takes from) a signal the chart already gives. */
function oiCtx(ch) {
  const rows = ch.rows || [], spot = ch.spot, ceOI = rows.reduce((a, r) => a + (r.ce.oi || 0), 0), peOI = rows.reduce((a, r) => a + (r.pe.oi || 0), 0);
  if (!(ceOI + peOI > 0)) return null;                                // a chain built from the live feed has no OI
  const pcr = ceOI ? peOI / ceOI : null, near = rows.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 11);
  const dCE = near.reduce((a, r) => a + (r.ce.chgOi || 0), 0), dPE = near.reduce((a, r) => a + (r.pe.chgOi || 0), 0);
  const above = rows.filter(r => r.strike > spot), below = rows.filter(r => r.strike < spot);
  const res = above.reduce((a, r) => !a || r.ce.oi > a.ce.oi ? r : a, null), sup = below.reduce((a, r) => !a || r.pe.oi > a.pe.oi ? r : a, null);
  const atm = near[0], bu = leg => leg && leg.chgOi != null && leg.chg != null ? (leg.chg > 0 && leg.chgOi > 0 ? "long build-up" : leg.chg > 0 && leg.chgOi < 0 ? "short covering" : leg.chg < 0 && leg.chgOi > 0 ? "short build-up" : leg.chg < 0 && leg.chgOi < 0 ? "long unwinding" : "no clear build-up") : "not known";
  const ceB = bu(atm && atm.ce), peB = bu(atm && atm.pe), L = n => (Math.abs(n) >= 1e5 ? (n / 1e5).toFixed(1) + "L" : String(Math.round(n)));
  return { pcr, dCE, dPE, res: res && res.strike, sup: sup && sup.strike, ceB, peB, atm: atm && atm.strike,
    wallFor: d => d > 0 ? (res && res.strike) : (sup && sup.strike),
    score: d => { let s = 0;
      if (pcr != null) s += d > 0 ? (pcr >= 1.2 ? 5 : pcr >= 1.0 ? 3 : pcr >= 0.8 ? 1 : 0) : (pcr <= 0.7 ? 5 : pcr <= 0.9 ? 3 : pcr <= 1.1 ? 1 : 0);
      const fav = d > 0 ? dPE - dCE : dCE - dPE, size = Math.max(Math.abs(dCE), Math.abs(dPE), 1); s += fav > 0.3 * size ? 5 : fav > 0 ? 3 : 0;
      const w = d > 0 ? res : sup; if (w && Math.abs(w.strike - spot) / spot > 0.004) s += 2;
      const b = d > 0 ? ceB : peB; if (b === "long build-up" || b === "short covering") s += 3;
      return s; },
    text: d => `PCR ${pcr == null ? "—" : pcr.toFixed(2)}; near the money put OI ${dPE >= 0 ? "+" : ""}${L(dPE)} vs call OI ${dCE >= 0 ? "+" : ""}${L(dCE)} today (${dPE > dCE ? "put writing leads: supportive below" : "call writing leads: pressure above"}); `
      + `most call OI at ${res ? res.strike : "—"} (resistance), most put OI at ${sup ? sup.strike : "—"} (support); ATM ${d > 0 ? "call" : "put"}: ${d > 0 ? ceB : peB}` }; }
/* The contract: at the money or one strike in the money (one out only when those are thin), liquid, with a tight spread. */
function selectContract(ch, d, u) {
  const ty = d > 0 ? "CE" : "PE", k = ty === "CE" ? "ce" : "pe", spot = ch.spot, rows = ch.rows.slice().sort((a, b) => a.strike - b.strike);
  const ai = rows.reduce((bi, r, i) => Math.abs(r.strike - spot) < Math.abs(rows[bi].strike - spot) ? i : bi, 0);
  const cand = [[ai, "ATM"], [ty === "CE" ? ai - 1 : ai + 1, "1 strike ITM"], [ty === "CE" ? ai + 1 : ai - 1, "1 strike OTM"]].filter(([i]) => rows[i]);
  const T = Math.max(ch.daysOut / 365, 1 / (365 * 24)), vols = rows.map(r => r[k].vol || 0).sort((a, b) => a - b), ois = rows.map(r => r[k].oi || 0).sort((a, b) => a - b);
  const rank = (arr, v) => arr.length ? arr.filter(x => x <= v).length / arr.length : 0;
  const scored = cand.map(([i, kind]) => { const r = rows[i], L = r[k]; if (!L || !L.sym || !(L.ltp > 0)) return null;
    const mid = L.bid > 0 && L.ask > 0 ? (L.bid + L.ask) / 2 : L.ltp, spread = L.bid > 0 && L.ask > 0 ? (L.ask - L.bid) / mid * 100 : null;
    const iv = L.iv || EN.impliedVol(L.ltp, spot, r.strike, T, ty), g = iv ? EN.bs(spot, r.strike, T, iv, ty) : null, delta = g ? Math.abs(g.delta) : null;
    const why = []; let s = 0;
    if (spread == null) why.push("no bid / ask"); else if (spread > 5) return { reject: `${r.strike} ${ty}: bid-ask spread ${spread.toFixed(1)}%` }; else s += spread <= 1.5 ? 3 : spread <= 3 ? 2 : 0.5;
    if (!(L.vol > 0) && ch.source !== "feed") return { reject: `${r.strike} ${ty}: no trades today` };
    s += 2 * rank(vols, L.vol || 0) + 2 * rank(ois, L.oi || 0) + (kind === "ATM" ? 2 : kind === "1 strike ITM" ? 1.5 : 0.3);
    if (delta != null) s += delta >= 0.42 && delta <= 0.68 ? 1.5 : 0;
    const lot = (OPTS.get(undKey(u)) || []).find(o => o[0] === L.sym);
    return { s, sym: L.sym, strike: r.strike, ty, kind, ltp: L.ltp, bid: L.bid, ask: L.ask, spread, vol: L.vol, oi: L.oi, iv, delta, lot: (lot && lot[4]) || ch.lot || u.lot || null, expiry: ch.expiry, daysOut: ch.daysOut, T }; }).filter(Boolean);
  const ok = scored.filter(x => !x.reject).sort((a, b) => b.s - a.s);
  return ok[0] || { reject: scored.map(x => x.reject).filter(Boolean).join("; ") || "no tradable contract near the money" }; }
function premLevels(c, L, spot, d) {              // the underlying's levels turned into premiums with Black-Scholes (30 minutes on)
  // anchored on the real premium: the premium at an underlying level = premium now + (model price there − model price now)
  const T2 = Math.max(c.T - 30 / 525600, 1 / (365 * 24)), iv = c.iv;
  const r2 = v => Math.round(v * 20) / 20, buy = c.ask > 0 && Math.abs(c.ask - c.ltp) / c.ltp < 0.2 ? c.ask : c.ltp;
  // the chart's levels moved by the gap between the chain's price and the signal candle's close (normally a few points)
  const shift = spot - L.entry, now = iv ? EN.bs(spot, c.strike, c.T, iv, c.ty).px : null;
  const at = v => iv ? Math.max(0.05, buy + EN.bs(v + shift, c.strike, T2, iv, c.ty).px - now) : Math.max(0.05, buy + (c.delta || 0.5) * d * (v - L.entry));
  const p = { entry: r2(buy), entryMax: r2(Math.max(buy, at(L.zoneHi))), sl: r2(Math.min(at(L.sl), buy * 0.93)), t1: r2(at(L.t1)), t2: r2(at(L.t2)), t3: r2(at(L.t3)) };
  p.rr = (p.t1 - p.entry) / Math.max(0.05, p.entry - p.sl); return p; }
function marketTrend(a, b) {                      // NIFTY 50 with BANK NIFTY
  if (!a) return null; if (!b) return a;
  if (a.cls === "HIGH VOLATILITY" || b.cls === "HIGH VOLATILITY") return { cls: "HIGH VOLATILITY", T: a.T };
  const T = 0.6 * a.T + 0.4 * b.T, agree = Math.sign(a.T) === Math.sign(b.T);
  const cls = Math.abs(T) < 0.2 ? "SIDEWAYS" : T >= 0.6 && agree ? "STRONG BULLISH" : T > 0 ? "BULLISH" : T <= -0.6 && agree ? "STRONG BEARISH" : "BEARISH";
  return { cls, T, nifty: a.cls, bank: b.cls }; }
function futFor(u) {                              // the near-month future of an index (its volume and VWAP)
  if (u.seg !== "IDX") return null; const f = (FUTS.get(undKey(u)) || []).filter(x => x.exp * 1000 > Date.now() + 864e5).sort((a, b) => a.exp - b.exp)[0];
  return f ? { tkr: f.t, fy: f.t, name: f.t, seg: "FUT", open: u.open, close: u.close } : null; }
const lastClosed = (b, m) => { let i = b.length - 1; while (i >= 0 && b[i].ts + m * 60000 > Date.now()) i--; return i; };
async function proPrepLive(u) {
  const c = await candlesOf(u, 5), b = EN.toBars(c.candles); if (b.length < 80) throw new Error("not enough 5-minute history");
  let fut = null; const fu = futFor(u); if (fu) { try { fut = EN.toBars((await candlesOf(fu, 5)).candles); } catch (e) {} }
  let D = null; try { D = EN.demaOf(EN.toBars((await dailyOf(u)).candles), b[b.length - 1].day); } catch (e) {}
  return { P: EN.proPrep(u, b, fut), D }; }
async function proCycle() {
  if (!EN || !EN.proEval || PROS.busy) return;
  const sess = bestSession(); if (!sess) return;
  PROS.busy = true; const t0 = Date.now();
  try { await visitor.run(sess, () => lane.run("low", async () => {
    await ensureUniverse().catch(() => {});
    feedSub(OVERVIEW_SYMS.concat(Object.keys(SECTORS)));
    const day = istDay(Date.now()); if (day !== PROS.day) { PROS.day = day; PROS.signals = []; PROS.seenKeys.clear(); PROS.lastTs.clear(); }
    Object.assign(EN.PRO.thr, { strong: PROCFG.strong, veryStrong: PROCFG.veryStrong, watch: PROCFG.watch }); EN.PRO.minRR = PROCFG.minRR;
    // market context
    const N = UNIVERSE.find(u => u.tkr === "NIFTY" && u.fy), BN = UNIVERSE.find(u => u.tkr === "BANKNIFTY" && u.fy);
    let mN = null, mB = null, prepN = null;
    try { prepN = await proPrepLive(N); const i = lastClosed(prepN.P.b, 5); mN = { P: prepN.P, i, tr: EN.proTrend(prepN.P, i, prepN.D) }; } catch (e) { PROS.err = "NIFTY: " + e.message; }
    try { const x = await proPrepLive(BN); const i = lastClosed(x.P.b, 5); mB = { tr: EN.proTrend(x.P, i, x.D) }; } catch (e) {}
    const market = marketTrend(mN && mN.tr, mB && mB.tr); PROS.market = market;
    const B = proBreadth();
    // which instruments: the watchlist, plus (with the live feed) F&O stocks moving most today and those with a scanner signal
    const list = new Map(watched().filter(u => u.fo).map(u => [u.tkr, u]));
    if (FEED.state === "live") { const sl = scanList();
      const movers = sl.filter(u => u.seg === "EQ").map(u => ({ u, x: FEED.last.get(u.fy) })).filter(z => z.x && z.x.chp != null).sort((a, b) => Math.abs(b.x.chp) - Math.abs(a.x.chp)).slice(0, 20).map(z => z.u);
      const flagged = sl.filter(u => SCAN.signals.some(s => s.tkr === u.tkr && s.state === "ACTIVE"));
      for (const u of movers.concat(flagged)) if (!list.has(u.tkr) && list.size < 45) list.set(u.tkr, u); }
    const avoid = []; let chains = 0;
    for (const u of list.values()) {
      if (!openNow(u)) continue;
      let prep; try { prep = u.tkr === "NIFTY" && prepN ? prepN : await proPrepLive(u); } catch (e) { avoid.push({ tkr: u.tkr, sym: u.label || u.name || u.sym, why: "data not available: " + e.message }); continue; }
      const P = prep.P, i = lastClosed(P.b, 5); if (i < 0) continue;
      if (Date.now() - (P.b[i].ts + 5 * 60000) > 12 * 60000) { avoid.push({ tkr: u.tkr, sym: u.label || u.name || u.sym, why: `prices stale (last closed candle ${new Date(P.b[i].ts + IST).toISOString().slice(11, 16)} IST)` }); continue; }
      const isIdx = u.seg === "IDX", mctx = u.seg === "MCX" ? null : market;
      const seenTs = PROS.lastTs.get(u.tkr); let from = i;
      if (seenTs != null) { if (P.b[i].ts <= seenTs) continue; const f = P.b.findIndex(x => x.ts > seenTs); from = Math.max(i - 2, f < 0 ? i : f); }
      PROS.lastTs.set(u.tkr, P.b[i].ts);
      let last = null;
      for (let k = Math.max(from, 0); k <= i; k++) {
        const base = { market: mctx, marketName: isIdx ? "NIFTY + BANK NIFTY" : "NIFTY 50 + BANK NIFTY", D: prep.D };
        let r = EN.proEval(P, k, base); last = r;
        if (r.none || r.score < PROCFG.watch - 8) continue;
        const key = day + "|" + u.tkr + "|" + r.d + "|" + r.setup; if (PROS.seenKeys.has(key)) continue;
        if (PROS.signals.some(s => s.tkr === u.tkr && s.d === r.d && s.state === "ACTIVE")) continue;
        // the option chain: essential for a trade (contract and premium); OI adds to the score when Fyers gives it
        if (chains >= 12) { avoid.push({ tkr: u.tkr, sym: u.sym, why: "option chain not checked this round (request budget)" }); continue; }
        let ch; try { chains++; ch = await chainData(u); if (ch.daysOut < 0.6 || (ch.daysOut < 1 && P.b[k].t > 810)) { const nx = (ch.expiries || [])[1]; if (nx) ch = await chainData(u, nx); } }
        catch (e) { avoid.push({ tkr: u.tkr, sym: u.sym, why: "option chain not available: " + e.message }); continue; }
        const oc = oiCtx(ch); const bc = breadthCtx(B, u);
        r = EN.proEval(P, k, Object.assign({}, base, { oi: oc && Object.assign(oc, { wall: oc.wallFor(r.d) }), breadth: bc }));
        if (r.none) { avoid.push({ tkr: u.tkr, sym: u.sym, why: r.none }); continue; }
        if (r.score < PROCFG.watch) continue;
        if (Math.abs(ch.spot - P.b[k].c) / P.b[k].c > 0.01) { avoid.push({ tkr: u.tkr, sym: u.sym, why: `option chain price ${ch.spot.toFixed(2)} and chart price ${P.b[k].c.toFixed(2)} disagree by over 1%: data not reliable, no trade` }); continue; }
        const c = selectContract(ch, r.d, u); if (c.reject) { avoid.push({ tkr: u.tkr, sym: u.sym, why: "no liquid contract: " + c.reject }); continue; }
        const prem = premLevels(c, r.L, ch.spot, r.d);
        if (prem.rr < 1.2) { avoid.push({ tkr: u.tkr, sym: u.sym, why: `premium reward : risk ${prem.rr.toFixed(2)} too low` }); continue; }
        PROS.seenKeys.add(key);
        const x = P.b[k], I = P.t5.I, vv = EN.proVol(P, k);
        const sig = { id: crypto.randomBytes(5).toString("hex"), key, tkr: u.tkr, sym: u.label || u.name || u.sym, seg: u.seg, d: r.d, ty: r.ty, score: r.score, grade: r.grade,
          parts: r.sc.parts, why: r.sc.why, miss: r.sc.miss, setup: r.setup, trigger: r.sc.best.label, candles: r.sc.candles,
          trend: r.tr.cls, marketTrend: mctx ? mctx.cls : "own trend (MCX)", tfs: r.tr.s, rsi: I.rsi[k], vwap: vv.vw == null ? "not available" : (vv.vw > 0 ? "above" : "below") + " VWAP" + (vv.src === "future" ? " (index future)" : ""), ema: `${x.c > I.e20[k] ? "above" : "below"} EMA 20, EMA 20 ${I.e20[k] > I.e50[k] ? "above" : "below"} EMA 50${I.e200[k] != null ? ", " + (x.c > I.e200[k] ? "above" : "below") + " EMA 200" : ""}`,
          created: x.ts + 5 * 60000, at: Date.now(), under: { entry: r.L.entry, zoneHi: r.L.zoneHi, sl: r.L.sl, t1: r.L.t1, t2: r.L.t2, t3: r.L.t3, rr: r.L.rr, invalid: r.L.invalid },
          contract: c, prem, oi: oc ? oc.text(r.d) : "OI not available (chain from the live feed)", state: r.trade ? "ACTIVE" : "WATCH", cap: r.cap,
          validity: `Valid until ${proExchOf(u) === "MCX" ? "23:20" : "15:20"} IST. Invalid if ${u.label || u.sym} closes a 5-minute candle ${r.d > 0 ? "below" : "above"} ${r.L.invalid.toFixed(2)} before Target 1, or the stop loss trades.` };
        PROS.signals.push(sig); PROS.hist.push(sig); proLog(sig.id, "signal", sig);
        if (sig.state === "ACTIVE") paperOpen(sig, u);
        const kind = WATCH.has(u.tkr) ? "watch" : r.score >= PROCFG.veryStrong ? "fno" : null;
        if (kind && sig.state === "ACTIVE") pushSend(kind, "pro|" + sig.id, { title: `${sig.sym} — ${c.ty} BUY ${c.strike} (${sig.score}/100)`, tag: "pro-" + sig.id, url: "/",
          body: `Buy up to ₹${prem.entryMax} · SL ₹${prem.sl} · T1 ₹${prem.t1} · ${sig.grade}` });
      }
      if (last && last.none) avoid.push({ tkr: u.tkr, sym: u.label || u.name || u.sym, why: last.none, trend: last.tr && last.tr.cls });
    }
    PROS.avoid = avoid; PROS.at = Date.now(); PROS.cycleMs = Date.now() - t0; proSave();
  })); } catch (e) { PROS.err = e.message; } finally { PROS.busy = false; }
}
const proExchOf = u => String(u.fy || u.tkr).startsWith("MCX") || u.seg === "MCX" ? "MCX" : String(u.fy || "").startsWith("BSE") ? "BSE" : "NSE";
/* ---- paper trading: never a real order. Entry at the ask when the signal is given; exits on the option's premium. */
function paperOpen(sig, u) {
  const c = sig.contract, lot = c.lot || 1;
  const t = { id: sig.id, sym: sig.sym, tkr: sig.tkr, contract: `${sig.sym} ${c.strike} ${c.ty}`, opt: c.sym, ty: c.ty, d: sig.d, ex: proExchOf(u), qty: lot, lots: 1,
    created: Date.now(), entry: sig.prem.entry, sl: sig.prem.sl, t1: sig.prem.t1, t2: sig.prem.t2, t3: sig.prem.t3, invalid: sig.under.invalid, underTkr: sig.tkr,
    state: "OPEN", hit: 0, trailSL: sig.prem.sl, now: sig.prem.entry, nowAt: Date.now(), events: [{ at: Date.now(), what: `Paper buy ${lot} qty at ₹${sig.prem.entry} (the ask)` }], score: sig.score, grade: sig.grade, setup: sig.setup };
  PROS.paper.push(t); feedSub([c.sym]); proLog(t.id, "paper-open", t); }
function paperClose(t, px, how) {
  t.state = "CLOSED"; t.exit = Math.round(px * 20) / 20; t.how = how; t.closed = Date.now();
  const buy = t.entry * (1 + EN.PRO.cost.slip / 2) * t.qty, sell = t.exit * (1 - EN.PRO.cost.slip / 2) * t.qty, ch = EN.proCharges(t.ex, buy, sell);
  t.gross = Math.round((sell - buy) * 100) / 100; t.charges = Math.round(ch.total * 100) / 100; t.net = Math.round((t.gross - ch.total) * 100) / 100;
  t.events.push({ at: Date.now(), what: `Paper exit at ₹${t.exit}: ${how}. Net ₹${t.net} after ₹${t.charges} charges` }); proLog(t.id, "paper-close", { exit: t.exit, how, net: t.net });
  pushSend(WATCH.has(t.tkr) ? "watch" : "fno", "paper|" + t.id + "|close", { title: `${t.contract} — ${how}`, tag: "pro-" + t.id, url: "/", body: `Exit ₹${t.exit} · paper P&L ₹${t.net} after charges` }); }
// every 15 s: open paper trades against the live premium (stop first, then targets; stop moves after T1 / T2 are separate)
function paperTick() { try {
  const nowM = (() => { const x = new Date(Date.now() + IST); return x.getUTCHours() * 60 + x.getUTCMinutes(); })(); let ch = false;
  for (const t of PROS.paper) { if (t.state !== "OPEN") continue;
    if (istDay(t.created) !== istDay(Date.now())) { paperClose(t, t.now, "not closed in its session (closed at the last premium seen)"); ch = true; continue; }
    const x = FEED.state === "live" && FEED.last.get(t.opt); if (x && x.at > t.nowAt - 1000) { t.now = x.ltp; t.nowAt = x.at; }
    if (t.now <= t.trailSL) { paperClose(t, Math.min(t.now, t.trailSL), t.hit ? `trailed stop after Target ${t.hit}` : "stop loss"); ch = true; continue; }   // filled at the price seen (a gap past the stop costs more)
    const T = [t.t1, t.t2, t.t3]; while (t.hit < 3 && t.now >= T[t.hit]) { t.hit++; t.events.push({ at: Date.now(), what: `Target ${t.hit} ₹${T[t.hit - 1]} reached` });
      t.trailSL = t.hit === 1 ? Math.max(t.trailSL, t.entry) : t.hit === 2 ? Math.max(t.trailSL, t.t1) : t.trailSL;
      pushSend(WATCH.has(t.tkr) ? "watch" : "fno", "paper|" + t.id + "|t" + t.hit, { title: `${t.contract} — Target ${t.hit} reached`, tag: "pro-" + t.id, url: "/", body: `Premium ₹${t.now}. Suggested stop now ₹${t.trailSL}` }); ch = true; }
    if (t.hit >= 3) { paperClose(t, t.t3, "Target 3"); continue; }
    const u = UNIVERSE.find(z => z.tkr === t.underTkr) || bySym(t.underTkr), lu = u && FEED.last.get(u.fy);
    if (t.hit === 0 && lu && (t.d > 0 ? lu.ltp < t.invalid : lu.ltp > t.invalid) && Date.now() - t.created > 5 * 60000) { t.invalidSeen = (t.invalidSeen || 0) + 1;
      if (t.invalidSeen >= 20) { paperClose(t, t.now, "exit alert: setup invalid (price back through the trigger level)"); ch = true; continue; } } else t.invalidSeen = 0;
    if (nowM >= (t.ex === "MCX" ? 1400 : 920)) { paperClose(t, t.now, "time exit"); ch = true; } }
  if (ch) proSave();
} catch (e) {} }
setInterval(paperTick, 15000).unref();
/* ---- market overview: indices, VIX, trend, breadth, sentiment, data status */
function proOverview() {
  const q = t => { const x = FEED.state === "live" && FEED.last.get(t); return x ? { ltp: x.ltp, chp: x.chp, at: x.at } : (PROS.ovq && PROS.ovq.d[t]) || null; };
  const nowOpen = anyOpen(), age = FEED.lastTick ? Date.now() - FEED.lastTick : null;
  const status = !nowOpen ? "CLOSED" : FEED.state === "live" && age != null && age < 15000 ? "LIVE" : FEED.state === "live" && age != null && age < 120000 ? "DELAYED" : FEED.state !== "live" && RL.dayCount ? "DELAYED" : "STALE";
  const B = proBreadth(), vix = q("NSE:INDIAVIX-INDEX"), m = PROS.market;
  const sent = !m ? null : (m.cls.includes("BULL") && (!B || B.ratio >= 1) && (!vix || vix.ltp < 18)) ? "Risk-on (bullish)" : (m.cls.includes("BEAR") && (!B || B.ratio <= 1)) ? "Risk-off (bearish)" : m.cls === "HIGH VOLATILITY" || (vix && vix.ltp >= 22) ? "Fearful / volatile" : "Mixed / cautious";
  return { nifty: q("NSE:NIFTY50-INDEX"), bank: q("NSE:NIFTYBANK-INDEX"), fin: q("NSE:FINNIFTY-INDEX"), vix, market: m, breadth: B, sentiment: sent,
    status, statusNote: status === "LIVE" ? "live WebSocket prices" : status === "DELAYED" ? (FEED.state === "live" ? "live feed slow" : "prices about every minute (live feed not connected)") : status === "STALE" ? "no fresh prices; no signals are given" : "markets closed",
    lastTick: FEED.lastTick || null, cycleAt: PROS.at || null }; }
app.get("/api/pro", guard(async (_req, res) => {
  if (!PROS.at && !PROS.busy) proCycle().catch(() => {});
  // without the live feed: one quote request for the overview, at most every 2 minutes
  if (FEED.state !== "live") try { const q = await cached("pro-ov", anyOpen() ? 120000 : 1800000, () => fy("/quotes", { symbols: OVERVIEW_SYMS.join(",") }));
    PROS.ovq = { at: Date.now(), d: Object.fromEntries((q.d || []).filter(x => x && x.v && x.v.lp > 0).map(x => [x.n, { ltp: x.v.lp, chp: x.v.chp, at: Date.now() }])) }; } catch (e) {}
  const today = istDay(Date.now()), sig = PROS.signals.filter(s => istDay(s.created) === today);
  const byScore = (a, b) => b.score - a.score;
  res.json({ cfg: PROCFG, weights: EN && EN.PRO ? EN.PRO.w : null, at: PROS.at, busy: PROS.busy, err: PROS.err, overview: proOverview(),
    ce: sig.filter(s => s.ty === "CE" && s.state !== "WATCH").sort(byScore), pe: sig.filter(s => s.ty === "PE" && s.state !== "WATCH").sort(byScore),
    watch: sig.filter(s => s.state === "WATCH").sort(byScore), avoid: PROS.avoid,
    paper: PROS.paper.filter(t => t.state === "OPEN" || istDay(t.created) === today), history: PROS.paper.filter(t => t.state === "CLOSED").slice(-200).reverse() });
}));
app.get("/api/pro/log", guard(async (req, res) => {
  let lines = []; try { lines = require("fs").readFileSync(PROS.logFile, "utf8").trim().split("\n").slice(-500).map(l => JSON.parse(l)); } catch (e) {}
  if (req.query.id) lines = lines.filter(l => l.id === req.query.id); res.json({ entries: lines.reverse() }); }));

/* ---- backtest: the same rules, candle by candle, on Fyers' history (no look-ahead) ---- */
const restHistoryDays = async (u, res, days) => {
  const j = await fy("/history", { symbol: u.fy, resolution: String(res), date_format: "1", range_from: istDay(Date.now() - days * 864e5), range_to: istDay(Date.now()), cont_flag: "1" });
  return (j.candles || []).filter(c => c && c.length >= 5 && c[4] != null).map(c => [c[0] < 1e11 ? c[0] * 1000 : c[0], c[1], c[2], c[3], c[4], c[5] || 0]).sort((a, b) => a[0] - b[0]); };
function expiryDays(u, ts) {                      // days to the expiry a trader would use (estimate when the real calendar isn't known)
  const x = new Date(ts + IST), wd = x.getUTCDay(), weekly = { NIFTY: 2, SENSEX: 4 }[u.tkr];
  if (u.seg === "MCX") return 15;
  const daysTo = target => ((target - wd + 7) % 7);
  if (weekly != null) { let dd = daysTo(weekly); if (dd === 0 && x.getUTCHours() * 60 + x.getUTCMinutes() > 810) dd = 7; return Math.max(dd, 0.25); }
  const lastTue = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1); return d; };
  let e = lastTue(x.getUTCFullYear(), x.getUTCMonth()); if ((e - x) / 864e5 < 2) e = lastTue(x.getUTCFullYear(), x.getUTCMonth() + 1);
  return Math.max((e - x) / 864e5, 0.25); }
function realizedVol(days, beforeDay, n) { const c = days.filter(d => d.day < beforeDay).slice(-(n + 1)).map(d => d.c); if (c.length < 10) return null;
  const r = c.slice(1).map((v, i) => Math.log(v / c[i])), m = r.reduce((a, v) => a + v, 0) / r.length; return Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1) * 252); }
async function proBacktest(sessions, thrStrong) {
  const res = { sessions, thr: thrStrong, made: Date.now(), instruments: [], trades: [], notes: [], skipped: [] };
  const N = UNIVERSE.find(u => u.tkr === "NIFTY" && u.fy), BN = UNIVERSE.find(u => u.tkr === "BANKNIFTY" && u.fy);
  const calDays = Math.min(95, Math.ceil(sessions * 7 / 5) + 25);
  const load = async u => { const b = EN.toBars(await restHistoryDays(u, 5, calDays)); let fut = null; const fu = futFor(u);
    if (fu) { try { fut = EN.toBars(await restHistoryDays(fu, 5, calDays)); } catch (e) { res.notes.push(`${u.name}: index-future volume not available (${e.message}); volume left out for it`); } }
    let daily = []; try { daily = EN.toBars((await dailyOf(u)).candles); } catch (e) {}
    return { P: EN.proPrep(u, b, fut), daily }; };
  const mN = await load(N), mB = await load(BN);
  let vix = []; try { vix = EN.toBars(await restHistoryDays({ fy: "NSE:INDIAVIX-INDEX" }, "D", 200)); } catch (e) { res.notes.push("INDIA VIX history not available; index option prices use realised volatility instead"); }
  const dayList = [...new Set(mN.P.b.map(x => x.day))]; const testDays = dayList.slice(-sessions); res.from = testDays[0]; res.to = testDays[testDays.length - 1]; res.sessionsFound = testDays.length;
  const idxAt = P => { const m = new Map(P.b.map((x, i) => [x.ts, i])); return ts => m.get(ts); };
  const nAt = idxAt(mN.P), bAt = idxAt(mB.P);
  const mkAt = ts => { const i = nAt(ts), j = bAt(ts); if (i == null) return null;
    const a = EN.proTrend(mN.P, i, EN.demaOf(mN.daily, mN.P.b[i].day)), b = j != null ? EN.proTrend(mB.P, j, EN.demaOf(mB.daily, mB.P.b[j].day)) : null; return marketTrend(a, b); };
  const mkCache = new Map(), marketAt = ts => { if (!mkCache.has(ts)) mkCache.set(ts, mkAt(ts)); return mkCache.get(ts); };
  const save = EN.PRO.thr.strong; EN.PRO.thr.strong = thrStrong;
  try {
    for (const u of watched().filter(z => z.fo)) {
      let L; try { L = u.tkr === "NIFTY" ? mN : u.tkr === "BANKNIFTY" ? mB : await load(u); } catch (e) { res.skipped.push(`${u.name}: ${e.message}`); continue; }
      const P = L.P, first = P.b.findIndex(x => x.day >= testDays[0]); if (first < 0) { res.skipped.push(`${u.name}: no candles in the test period`); continue; }
      const sigs = EN.proScan(P, first, P.b.length - 1, i => ({ market: u.seg === "MCX" ? null : marketAt(P.b[i].ts), D: EN.demaOf(L.daily, P.b[i].day) }), thrStrong);
      const nifRV = d => realizedVol(mN.daily, d, 20);
      res.instruments.push({ tkr: u.tkr, name: u.name, candles: P.b.length, signals: sigs.length });
      for (const s of sigs) {
        if (!s.trade) continue;
        const t = EN.proTrack(P, s); if (t.state === "ACTIVE") continue;
        const x = P.b[s.i], ts = x.ts + 5 * 60000, step = u.step || 50, K = Math.round(s.L.entry / step) * step;
        const vx = vix.filter(v => v.day < x.day).pop(), rv = realizedVol(L.daily, x.day, 20), rvN = nifRV(x.day);
        let iv = u.seg === "IDX" && vx ? vx.c / 100 * (u.tkr === "NIFTY" || !rv || !rvN ? 1 : Math.min(1.6, Math.max(0.8, rv / rvN))) : rv ? rv * 1.1 : null;
        if (!iv) { res.skipped.push(`${u.name} ${x.day}: no volatility estimate`); continue; } iv = Math.min(1.2, Math.max(0.08, iv));
        const dE = expiryDays(u, ts), T0 = dE / 365, exitTs = P.b[t.exitI].ts + 5 * 60000, T1 = Math.max(T0 - (exitTs - ts) / (365 * 864e5), 1 / (365 * 24));
        const ty = s.d > 0 ? "CE" : "PE", pIn = EN.bs(s.L.entry, K, T0, iv, ty).px, pOut = EN.bs(t.exitPx, K, T1, iv, ty).px;
        if (!(pIn > 0.5)) continue;
        const lot = ((OPTS.get(undKey(u)) || [])[0] || [])[4] || u.lot || 1, ex = proExchOf(u);
        const buy = pIn * (1 + EN.PRO.cost.slip / 2) * lot, sell = Math.max(0.05, pOut * (1 - EN.PRO.cost.slip / 2)) * lot, ch = EN.proCharges(ex, buy, sell);
        res.trades.push({ tkr: u.tkr, name: u.name, day: x.day, time: new Date(ts + IST).toISOString().slice(11, 16), tmin: x.t + 5, ty, setup: s.setup, score: s.score, grade: s.grade,
          cond: s.tr.cls, market: s.sc && s.sc.why[0], how: t.how, hit: t.hit, entryU: s.L.entry, exitU: t.exitPx, R: (t.exitPx - s.L.entry) * s.d / s.L.risk,
          strike: K, iv: +iv.toFixed(3), days: +dE.toFixed(2), pIn: +pIn.toFixed(2), pOut: +pOut.toFixed(2), lot, gross: +(sell - buy).toFixed(2), charges: +ch.total.toFixed(2), net: +(sell - buy - ch.total).toFixed(2) });
      }
    }
  } finally { EN.PRO.thr.strong = save; }
  res.trades.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
  const stats = list => { const n = list.length, w = list.filter(t => t.net > 0), l = list.filter(t => t.net <= 0), gp = w.reduce((a, t) => a + t.net, 0), gl = -l.reduce((a, t) => a + t.net, 0);
    let eq = 0, peak = 0, dd = 0; for (const t of list) { eq += t.net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    return { trades: n, wins: w.length, losses: l.length, winRate: n ? w.length / n * 100 : null, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, net: +eq.toFixed(2),
      avgWin: w.length ? gp / w.length : null, avgLoss: l.length ? -gl / l.length : null, maxDD: +dd.toFixed(2), avgR: n ? list.reduce((a, t) => a + t.R, 0) / n : null, charges: list.reduce((a, t) => a + t.charges, 0) }; };
  const group = (key) => Object.entries(res.trades.reduce((m, t) => { const k = key(t); (m[k] = m[k] || []).push(t); return m; }, {})).map(([k, v]) => ({ k, ...stats(v) }));
  res.summary = stats(res.trades); res.byType = group(t => t.ty); res.byTime = group(t => t.tmin < 660 ? "09:30-11:00" : t.tmin < 780 ? "11:00-13:00" : t.tmin < 900 ? "13:00-15:00" : "after 15:00 (MCX)");
  res.byCond = group(t => t.cond); res.byInst = group(t => t.name); res.bySetup = group(t => t.setup);
  res.assumptions = ["Signals: the live rules, candle by candle on closed 5-minute candles; higher timeframes only once closed; daily EMAs from earlier days.",
    "Option chain / OI and market breadth are not in Fyers' history, so those two parts (20 of 100 points) are left out and the rest of the score is scaled to 100.",
    "Fyers keeps no prices for expired option contracts, so each trade's premium is estimated with Black-Scholes: the at-the-money strike, volatility from INDIA VIX (indices, scaled by each index's realised volatility) or 20-day realised volatility × 1.1 (stocks, MCX), and the days to the usual expiry (weekly Tuesday NIFTY, weekly Thursday SENSEX, last-Tuesday monthly for others, 15 days for MCX).",
    "Exits on the underlying: stop loss (checked first inside a candle), stop to entry after T1 and to T1 after T2, exit when the trigger level fails, time exit at 15:20 / 23:20.",
    "Costs per round trip for 1 lot: ₹20 + ₹20 brokerage, STT 0.15% of the sell premium (CTT 0.05% for MCX), exchange charges (NSE 0.0355%, BSE 0.0325%, MCX 0.0418%), clearing 0.009%, SEBI fee, stamp duty 0.003% on the buy, GST 18% on brokerage and fees, and 0.5% slippage on the premium."];
  return res; }
app.get("/api/pro/backtest", guard(async (req, res) => {
  const sessions = Math.max(5, Math.min(60, +req.query.sessions || 25)), thr = Math.max(50, Math.min(95, +req.query.thr || PROCFG.strong));
  const key = sessions + "|" + thr + "|" + istDay(Date.now()), hit = PROS.bt.get(key);
  if (hit && !req.query.force) return res.json(hit);
  const r = await proBacktest(sessions, thr); PROS.bt.set(key, r); res.json(r); }));


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
  const onNew = async ev => { try { const m = ev.message, chat = String(m.chatId);
    if (!T.watch.has(chat) || !m.message || Date.now() - (m.date || 0) * 1000 > 120000) return;
    let title = "Telegram"; try { const ch = await m.getChat(); title = (ch && (ch.title || ch.firstName)) || title; } catch (e) {}
    pushSend("tg", "tg|" + chat + "|" + m.id, { title: "Telegram · " + title, tag: "tg-" + chat + "-" + m.id, url: "/",
      body: m.message.replace(/\s+/g, " ").slice(0, 150) + " — open Signal Desk for its own signal." }); } catch (e) {} };
  T.client.addEventHandler(on, new GJ.events.NewMessage({}));
  T.client.addEventHandler(onNew, new GJ.events.NewMessage({}));
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
