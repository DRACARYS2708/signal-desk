/* ============================================================================
   SIGNAL DESK — free data backend
   ----------------------------------------------------------------------------
   No subscription, no API key, no broker account required.

     candles + quotes  ->  Yahoo Finance  (free, no key, ~15 min delayed on NSE)
     option chain      ->  NSE public API (free, no key, real OI and IV)

   Run it and it works. See the note at the bottom about removing the delay.

   Setup:
     npm install express cors      # that's the whole dependency list
     node server.js                # needs Node 18+ for built-in fetch
   ========================================================================= */

const express = require("express");
const cors = require("cors");

const PORT = process.env.PORT || 8787;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ------------------------------------------------------------- universe -- */
/* `y` = Yahoo symbol. `nse` = NSE option-chain symbol (null where no chain is
   published free). `kind` picks the NSE endpoint: indices vs equities.
   `lot` is a fallback only — the free sources don't publish lot sizes, and the
   exchange revises them, so verify against your broker before sizing a trade. */
const UNIVERSE = [
  { sym:"NIFTY 50",    tkr:"NIFTY",      seg:"IDX", y:"^NSEI",               nse:"NIFTY",      kind:"indices",  step:50,  lot:75 },
  { sym:"BANK NIFTY",  tkr:"BANKNIFTY",  seg:"IDX", y:"^NSEBANK",            nse:"BANKNIFTY",  kind:"indices",  step:100, lot:30 },
  { sym:"FIN NIFTY",   tkr:"FINNIFTY",   seg:"IDX", y:"NIFTY_FIN_SERVICE.NS",nse:"FINNIFTY",   kind:"indices",  step:50,  lot:65 },
  { sym:"MIDCAP NIFTY",tkr:"MIDCPNIFTY", seg:"IDX", y:"NIFTY_MID_SELECT.NS", nse:"MIDCPNIFTY", kind:"indices",  step:25,  lot:120 },
  { sym:"SENSEX",      tkr:"SENSEX",     seg:"IDX", y:"^BSESN",              nse:null,         kind:null,       step:100, lot:20 },
  { sym:"RELIANCE",    tkr:"RELIANCE",   seg:"EQ",  y:"RELIANCE.NS",         nse:"RELIANCE",   kind:"equities", step:20,  lot:500 },
  { sym:"HDFC BANK",   tkr:"HDFCBANK",   seg:"EQ",  y:"HDFCBANK.NS",         nse:"HDFCBANK",   kind:"equities", step:20,  lot:550 },
  { sym:"ICICI BANK",  tkr:"ICICIBANK",  seg:"EQ",  y:"ICICIBANK.NS",        nse:"ICICIBANK",  kind:"equities", step:10,  lot:700 },
  { sym:"INFOSYS",     tkr:"INFY",       seg:"EQ",  y:"INFY.NS",             nse:"INFY",       kind:"equities", step:20,  lot:400 },
  { sym:"TCS",         tkr:"TCS",        seg:"EQ",  y:"TCS.NS",              nse:"TCS",        kind:"equities", step:40,  lot:175 },
  { sym:"SBIN",        tkr:"SBIN",       seg:"EQ",  y:"SBIN.NS",             nse:"SBIN",       kind:"equities", step:10,  lot:1500 },
  { sym:"TATA MOTORS", tkr:"TATAMOTORS", seg:"EQ",  y:"TATAMOTORS.NS",       nse:"TATAMOTORS", kind:"equities", step:10,  lot:1425 },
  { sym:"HDFC AMC",    tkr:"HDFCAMC",    seg:"EQ",  y:"HDFCAMC.NS",          nse:"HDFCAMC",    kind:"equities", step:50,  lot:200 },
  { sym:"BAJAJ FINANCE",tkr:"BAJFINANCE",seg:"EQ",  y:"BAJFINANCE.NS",       nse:"BAJFINANCE", kind:"equities", step:50,  lot:750 },
  /* Commodities: MCX publishes no free feed. These are the global contracts —
     COMEX gold/silver/copper, NYMEX crude/gas — quoted in USD, on different
     contract specs. They track MCX direction but are NOT MCX prices, so they
     are labelled GLB and carry no option chain here. */
  { sym:"GOLD (COMEX)",   tkr:"XAU", seg:"GLB", y:"GC=F", nse:null, kind:null, step:10, lot:null },
  { sym:"SILVER (COMEX)", tkr:"XAG", seg:"GLB", y:"SI=F", nse:null, kind:null, step:1,  lot:null },
  { sym:"CRUDE (NYMEX)",  tkr:"WTI", seg:"GLB", y:"CL=F", nse:null, kind:null, step:1,  lot:null },
];

const bySym = t => UNIVERSE.find(u => u.tkr === t);

/* ------------------------------------------------------------------ cache -- */
/* Both sources are free and unmetered but rate-limit aggressively. Cache hard:
   Yahoo NSE data is delayed anyway, so a few seconds of staleness costs nothing
   and keeps us from getting blocked. */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

/* ------------------------------------------------------- Yahoo Finance -- */
const YF_INTERVAL = { 1:"1m", 3:"5m", 5:"5m", 15:"15m", 30:"30m", 60:"60m" };
const YF_RANGE    = { "1m":"5d", "5m":"1mo", "15m":"1mo", "30m":"1mo", "60m":"3mo" };

async function yahooChart(ySym, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}`
            + `?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${ySym}`);
  const j = await r.json();
  if (j.chart?.error) throw new Error(j.chart.error.description || "Yahoo error");
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(`no data for ${ySym}`);
  return res;
}

function toCandles(res) {
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;   // Yahoo pads gaps with nulls
    out.push([ts[i] * 1000, o, h, l, c, q.volume?.[i] || 0]);
  }
  return out;
}

/* --------------------------------------------------------- NSE public API -- */
/* NSE requires a browser-like session: hit a page first to collect cookies,
   then call the JSON endpoint with them. Cookies expire, so refresh on 401/403. */
let nseCookie = null, nseCookieAt = 0;

async function nseSession(force) {
  if (!force && nseCookie && Date.now() - nseCookieAt < 8 * 60 * 1000) return nseCookie;
  const r = await fetch("https://www.nseindia.com/option-chain", {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml",
               "Accept-Language": "en-US,en;q=0.9" },
  });
  const raw = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : [r.headers.get("set-cookie")].filter(Boolean);
  nseCookie = raw.map(c => String(c).split(";")[0]).join("; ");
  nseCookieAt = Date.now();
  if (!nseCookie) throw new Error("NSE did not return a session cookie");
  return nseCookie;
}

async function nseChain(u, retry) {
  const cookie = await nseSession(!!retry);
  const url = `https://www.nseindia.com/api/option-chain-${u.kind}?symbol=${encodeURIComponent(u.nse)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json",
               "Accept-Language": "en-US,en;q=0.9",
               "Referer": "https://www.nseindia.com/option-chain", "Cookie": cookie },
  });
  if ((r.status === 401 || r.status === 403) && !retry) return nseChain(u, true);
  if (!r.ok) throw new Error(`NSE ${r.status} — the public endpoint throttles; try again shortly`);
  const j = await r.json();
  if (!j.records?.data) throw new Error("unexpected NSE payload shape");
  return j;
}

/* ------------------------------------------------------------------ app -- */
const app = express();
app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));

/* Serve the page itself, so one hosted address gives both the site and its
   data. Only index.html is exposed — not this file. */
const path = require("path");
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/api/status", (_req, res) => res.json({
  authenticated: true, provider: "yahoo+nse", delayed: true, delayNote: "~15 min (Yahoo NSE)",
  free: true, pollMs: 20000, ts: Date.now(),
}));

/* If the start-up check failed for every symbol, Yahoo was unreachable at that
   moment rather than every symbol being dead — so show the full list. */
const listed = () => { const ok = UNIVERSE.filter(u => u.ok !== false); return ok.length ? ok : UNIVERSE; };
app.get("/api/instruments", (_req, res) => res.json(
  listed()
    .map(u => ({ sym:u.sym, tkr:u.tkr, seg:u.seg, step:u.step, lot:u.lot, fo: !!u.nse }))
));

/* Yahoo occasionally renames or drops a ticker — especially the newer NSE
   indices. Probe once at boot so a dead symbol never becomes a dead watchlist
   row, and name it in the log so it can be corrected. */
async function probeUniverse() {
  await Promise.all(UNIVERSE.map(async u => {
    try { await yahooChart(u.y, "1d", "5d"); u.ok = true; }
    catch (e) { u.ok = false; }
  }));
  const dead = UNIVERSE.filter(u => u.ok === false);
  console.log(`  symbols live: ${UNIVERSE.length - dead.length}/${UNIVERSE.length}`);
  if (dead.length) console.log("  unavailable on Yahoo (edit their `y` field): " +
    dead.map(u => `${u.sym} [${u.y}]`).join(", "));
}

/* -------------------------------------------------------------- candles -- */
app.get("/api/candles", async (req, res) => {
  try {
    const u = bySym(req.query.tkr);
    if (!u) return res.status(404).json({ error: "unknown symbol" });
    const want = +req.query.interval || 5;
    const iv = YF_INTERVAL[want] || "5m";
    // Key on the requested timeframe, not the Yahoo one: 3m and 5m both map to
    // Yahoo's "5m" bucket and would otherwise share a cache entry.
    const key = `c:${u.tkr}:${want}`;
    const out = await cached(key, 25000, async () => {
      if (want === 3) {                       // Yahoo has no 3m — build it from 1m
        const m1 = await yahooChart(u.y, "1m", "5d");
        return { tkr: u.tkr, interval: "3m", candles: rollup(toCandles(m1), 3) };
      }
      const r = await yahooChart(u.y, iv, YF_RANGE[iv]);
      return { tkr: u.tkr, interval: iv, candles: toCandles(r) };
    });
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

function rollup(c, n) {
  const out = [];
  for (let i = 0; i < c.length; i += n) {
    const g = c.slice(i, i + n);
    if (!g.length) break;
    out.push([g[0][0], g[0][1], Math.max(...g.map(x => x[2])), Math.min(...g.map(x => x[3])),
              g[g.length-1][4], g.reduce((s,x) => s + x[5], 0)]);
  }
  return out;
}

/* --------------------------------------------------------------- quotes -- */
app.get("/api/quotes", async (_req, res) => {
  try {
    const out = await cached("quotes", 20000, async () => {
      const q = {};
      await Promise.all(UNIVERSE.map(async u => {
        try {
          const r = await yahooChart(u.y, "1d", "1d");   // smallest payload carrying meta
          const m = r.meta || {};
          const ltp = m.regularMarketPrice;
          const prev = m.chartPreviousClose ?? m.previousClose;
          if (ltp == null) return;
          q[u.tkr] = {
            ltp, open: m.regularMarketDayOpen ?? null,
            high: m.regularMarketDayHigh ?? null, low: m.regularMarketDayLow ?? null,
            close: prev ?? null,
            chg: prev ? ((ltp - prev) / prev) * 100 : 0,
            vol: m.regularMarketVolume || 0,
          };
        } catch (e) { /* one bad symbol shouldn't blank the watchlist */ }
      }));
      return q;
    });
    res.json({ ts: Date.now(), quotes: out, delayed: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------------------------------------------------------- option chain -- */
app.get("/api/expiries", async (req, res) => {
  try {
    const u = bySym(req.query.tkr);
    if (!u) return res.status(404).json({ error: "unknown symbol" });
    if (!u.nse) return res.json({ expiries: [], note: "no free option chain for this instrument" });
    const j = await cached(`x:${u.tkr}`, 300000, () => nseChain(u));
    res.json({ expiries: (j.records.expiryDates || []).slice(0, 6).map(toISO) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

const MONTHS = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
function toISO(d) {                       // NSE ships "28-Aug-2026"
  const [dd, mon, yyyy] = String(d).split("-");
  const m = MONTHS[mon];
  if (m == null) return String(d);
  return `${yyyy}-${String(m+1).padStart(2,"0")}-${dd.padStart(2,"0")}`;
}

app.get("/api/chain", async (req, res) => {
  try {
    const u = bySym(req.query.tkr);
    if (!u) return res.status(404).json({ error: "unknown symbol" });
    if (!u.nse) return res.status(404).json({ error: "no free option chain for " + u.sym });

    const j = await cached(`ch:${u.tkr}`, 25000, () => nseChain(u));
    const expiries = (j.records.expiryDates || []).map(toISO);
    const expiry = req.query.expiry && expiries.includes(req.query.expiry)
      ? req.query.expiry : expiries[0];

    const spot = j.records.underlyingValue;
    const rows = [];
    for (const d of j.records.data) {
      if (toISO(d.expiryDate) !== expiry) continue;
      const leg = side => side ? {
        ltp: side.lastPrice, oi: side.openInterest,
        chgOi: side.changeinOpenInterest, vol: side.totalTradedVolume,
        chg: side.change,
        // NSE publishes IV directly, so the client doesn't need to solve for it.
        // It reports 0 for illiquid strikes — treat that as absent, not as zero vol.
        iv: side.impliedVolatility > 0 ? side.impliedVolatility / 100 : null,
        bid: side.bidprice || null, ask: side.askPrice || null,
      } : null;
      const ce = leg(d.CE), pe = leg(d.PE);
      if (ce && pe) rows.push({ strike: d.strikePrice, ce, pe });
    }
    rows.sort((a, b) => a.strike - b.strike);

    // Derive the real strike step from the data rather than trusting the table
    const gaps = rows.slice(1).map((r, i) => r.strike - rows[i].strike).filter(g => g > 0);
    const step = gaps.length ? gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] : u.step;
    const atm = Math.round(spot / step) * step;

    // Keep the payload to 20 strikes either side of ATM
    const near = rows.filter(r => Math.abs(r.strike - atm) <= 20 * step);
    const daysOut = Math.max((new Date(expiry + "T15:30:00+05:30") - Date.now()) / 864e5, 0.02);

    res.json({ tkr: u.tkr, expiry, expiries, spot, prevClose: null, atm, step,
               lot: u.lot, daysOut, rows: near, ivFromFeed: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\nSignal Desk (free feed) on http://localhost:${PORT}`);
  console.log("  candles/quotes : Yahoo Finance  — no key, ~15 min delayed on NSE");
  console.log("  option chain   : NSE public API — no key, live OI and IV");
  console.log("");
  probeUniverse()
    .then(() => console.log(`\nNo login needed. Open http://localhost:${PORT} in your browser.\n`))
    .catch(e => console.log("  probe failed (continuing): " + e.message));
});

/* ============================================================================
   Removing the 15-minute delay
   ----------------------------------------------------------------------------
   Real-time NSE prices only come through a broker's data feed on your own
   account. Fyers states its API and market data are free; Dhan charges about
   Rs 499 a month for its Data API. To switch, reimplement yahooChart() and
   nseChain() above and keep every route intact — the page never changes.

   Notes on the free sources:
     - Yahoo has no official SLA. Symbols occasionally change and the endpoint
       can rate-limit; the cache above keeps requests modest.
     - The NSE endpoint is undocumented and meant for their own website. It
       throttles, often refuses cloud servers, and can break without notice.
       The 25s cache here is deliberate.
     - Neither source publishes F&O lot sizes. Check the fallback table above
       against your broker before you size anything with real money.
   ========================================================================= */
