# Signal Desk — free build

Intraday signal terminal for NSE. No subscription, no API key, no broker account.

| | Source | Cost | Delay |
|---|---|---|---|
| Candles and quotes | Yahoo Finance | Free | About 15 minutes on NSE |
| Option chain | NSE public endpoint | Free | Live |

This is analysis software. It places no orders.

## Put it online as a website link

1. Create a free GitHub account and a new repository. Upload the four files.
2. Create a free account at render.com, choose **New > Web Service**, and pick that repository.
3. Set the build command to `npm install` and the start command to `node server.js`. Choose the free plan and create it.
4. Render gives you an address like `https://signal-desk.onrender.com`. That is your link; it opens on any phone or computer.

Things to know:

- The free plan sleeps after about 15 minutes without visitors. The first visit after that takes up to a minute.
- NSE often refuses requests from cloud servers. If the option chain shows an error online while the chart works, that is the cause.
- Anyone who has the link can open the page. It holds no account or password.
- All times are India market time (IST), whatever time zone you are in.

## Run it on your computer instead

```bash
npm install
node server.js    # needs Node 18+
```

Then open http://localhost:8787.

## What's in it

**Chart** — EMA 9/21/50, session VWAP, Supertrend, Bollinger, with volume/RSI/MACD panes. Drag to pan, scroll to zoom.

**Structure** — order blocks, liquidity pools and fair value gaps, each from one mechanical definition.

**Signals** — fire on a fresh EMA cross or Supertrend flip that also scores 60 or more out of 100 on eleven confluence checks. Each carries a stop, three targets at 1R/2R/3R, and an `ACTIVE` or `EXPIRED` state. The page refreshes every 20 seconds and rescans the watchlist in rotation.

**Option chain** — OI, change in OI, volume, LTP and IV from NSE, with PCR, max pain and your signal's strike outlined.

## Limits of free data

- **The delay matters.** Signal times are candle times, about 15 minutes behind the market. That is fine for studying setups; for firing intraday entries you would be acting on a price that has already moved.
- **Yahoo has no guarantee.** Symbols are sometimes renamed or dropped. The server checks every symbol at start-up and lists any that failed in its log.
- **Lot sizes are a built-in table**, not from the exchange. Check them against your broker.
- **Commodities are global contracts** (COMEX/NYMEX, in USD), not MCX rupee prices.

## Limits of the signals

**No signal system is risk-free.** Expect roughly a 35–45% hit rate at 1:3 R:R; most trades lose small and a minority carry the book. The performance line excludes slippage, brokerage and taxes, so treat it as an upper bound.
