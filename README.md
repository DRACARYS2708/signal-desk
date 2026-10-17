# Signal Desk — real-time build (Fyers feed, free)

Intraday option-signal app for NSE indices, 17 liquid NSE stocks (Reliance, HDFC Bank, Federal Bank, Coal India and others) and MCX crude oil, natural gas, gold, silver and copper. Prices, candles and the option chain come in real time from your own Fyers account. Fyers does not charge for its API or market data. The page refreshes every 5 seconds.

This is analysis software. It places no orders.

---

## How people use it

The site opens like any website and shows a **Log in with Fyers** button. Each visitor logs in with their own Fyers account and sees live prices on their own login. Nobody shares your account, and the site cannot place orders. Fyers ends every login overnight, so each person clicks Log in with Fyers once a day.

## Before other people can log in

An app created at myapi.fyers.in accepts only the Fyers account that created it. With a normal app, **you** can log in and everyone else is refused by Fyers. To open it to other users, ask Fyers to approve your app for third-party use: write to Fyers API support (or post in the API section of the Fyers community) and say you run a web app where each user logs in with their own Fyers account. This is Fyers' decision; nothing in these files can bypass it.

Also check the rules before offering signals to the public. In India, giving buy or sell recommendations with targets can require SEBI Research Analyst registration, in particular if you charge for it. Take advice from a compliance professional before you invite users.

## Set it up (one time, by you, all in the browser)

Visitors never see this part. It tells the site which Fyers app it is.

### 1. Create a Fyers app

1. Log in at **myapi.fyers.in** with your Fyers account and open **Dashboard > Create App**.
2. App name: `Signal Desk`.
3. Redirect URL: your site address followed by `/auth/callback`, for example `https://signal-desk.onrender.com/auth/callback`. It must match exactly.
4. Leave the permissions as offered and create the app.
5. Copy the **App ID** (it ends in `-100`) and the **Secret ID**.

### 2. Put the files on GitHub

Open your `signal-desk` repository, choose **Add file > Upload files**, drag in the four files (`index.html`, `server.js`, `package.json`, `README.md`) and click **Commit changes**. `package.json` must be included: it adds the compression package that makes the page about three times smaller to download. Files with the same name are replaced. Render rebuilds the site by itself.

### 3. Add two settings on Render

Open your service on Render, go to **Environment**, and add:

| Key | Value |
|---|---|
| `FYERS_APP_ID` | the App ID |
| `FYERS_SECRET_ID` | the Secret ID |

Save. Render restarts the site. Never put the Secret ID in the files or on GitHub.

Do not add `SITE_PASSWORD` if you want the site to open normally. It exists only for keeping the whole site private behind one password.

### 4. Try it

Open your site. It shows the welcome page with **Log in with Fyers**. Click it, log in, and the app opens.

## What's in the app

The menu across the top has five pages.

**Home** — every live signal as an option trade, for example "NIFTY 50 — 25100 CE, expiry 13 Oct, Buy @ 126, Stop loss 100, Target 1 / 2 / 3 150 / 190 / 250", with the option's price now and its profit or loss. A buy signal gives a CALL and a sell signal gives a PUT, at the strike nearest the price, in the nearest expiry with at least a day left. Each card then says in words what is happening:

- *Signal hit positive* when the option is above the buy price, and which targets have been reached.
- *Safe exit* price at all times: the stop loss at first, your buy price once Target 1 is reached, Target 1 once Target 2 is reached.
- *Market is turning against this trade, safe exit now near …* when the option is below the buy price and the chart has turned, before the stop loss is hit.
- *Signal failed* when the stop loss is hit, with the exit price.

The buy price is the option's real traded price when the signal fired. Stop loss and targets are the premiums the option should show when the chart reaches its own stop and targets; for thinly traded options they fall back to −20% and +20% / +45% / +80%. Below the signals are live prices for every instrument.

**How a signal is found** — the engine reads three timeframes: trend (default 1 hour), setup (15 minutes) and entry (the candle size you choose, default 5 minutes). Change setup and trend next to the candle-size buttons on the chart. A CALL BUY setup needs all of:

1. Trend timeframe: the last structure break was bullish (closed candles only).
2. Setup timeframe: price recently reached a bullish order block, an unfilled bullish fair value gap, or the discount half of the dealing range.
3. Entry timeframe: sell-side liquidity (a swing low, equal lows, previous day or week low) was swept: a wick below and a close back above.
4. After the sweep, a bullish break of structure or change of character on a candle close, with a displacement candle in the move.
5. RSI above 50; and for stocks and MCX, volume at 1.2× average on the sweep or the break. Indices have no volume in the feed, so this check is skipped and the card says so.
6. Entry by limit at the near edge of the gap (or order block) the move left, filled within 18 candles before the stop or Target 1 trades.
7. Stop beyond the sweep, 0.5 to 2.5 ATR from entry.
8. Room: the first opposing liquidity is at least 1.5R away after costs. Targets are that liquidity and the next pools beyond it.

PUT BUY is the mirror image. One trade per instrument at a time; no new entries in the first 15 or last 45 minutes.

**Grades and tabs** — Strict signals are grade A: the zone was an order block or gap, the break was a market structure shift or came on high volume, and there is room for 2R or more. Other signals are grade B: every core rule passed but not the extras. Expect only a few signals a day across all instruments, and days with none.

**Every instrument has a state** — shown on its Home tile and above the chart: CALL BUY SETUP, PUT BUY SETUP, WAIT (setup forming, with what is missing, or a confirmed setup waiting for the pull-back entry) or NO TRADE (with the reason).

**No repainting** — every value for a candle uses only candles that had closed by then, and higher-timeframe candles only once they have closed. A signal never changes or disappears afterwards, so the Results page counts exactly what was shown live.

**On the chart** — EMA 20/50/200, VWAP where there is volume, swing labels (HH, HL, LH, LL), BOS / CHoCH / MSS lines, order blocks (fresh or tested; broken ones removed), fair value gaps (unfilled or part filled), liquidity levels with their type and whether swept, and premium / discount around the 50% line. RSI, MACD, volume and Bollinger are optional.

**On every signal card**
- *Current price*, large, with the profit or loss in percent and a small line of the recent price.
- *Direction*: whether the price is moving up, moving down or flat over the last three candles, and whether that is in favour of the trade or against it.
- *Price track*: where the price sits between stop loss, entry and the three targets.
- *Entry taken or not*: press "I took this entry" and the card follows your own entry price from then on. This is remembered on your device only.
- *Late entry*: if you have not entered, the card says whether entering now still makes sense. If it does, it gives the entry at the current price, the stop loss, the targets and the new risk against reward. If Target 1 is already reached, the market has turned, or the reward no longer covers the risk, it says not to enter.

**Copy for WhatsApp** — every signal card has *Copy signal for WhatsApp*, which copies it in this form, ready to paste:

```
NIFTY 50 - 13 OCT EXPIRY
BUY 22000 CE @ 260
SL - 200
T1/T2/T3 - 290/350/390
```

*Copy update* copies the latest news on that trade (for example "✅ T2 350 DONE. Trail SL 332" or "⚠️ EXIT NOW near 345 to book profit"), and *Send on WhatsApp* opens WhatsApp with the signal filled in so you can pick the group.

**Protecting profit** — after Target 1 the stop loss moves to the entry price. After Target 2 a trailing stop loss locks 60% of the best gain so far (never less than Target 1) and rises as the price makes new highs; the card shows its value. If, after any target, the chart turns against the trade (structure turns or price closes back through EMA 20), the card shows an EXIT ALERT with the price to exit at and the profit it keeps. The Results page uses the same trailing rule.

**Alerts** — *Turn on alerts* on Home plays a sound and shows a notification for a new signal, each target, an exit alert, a stop, or a closed trade. They work only while the site is open in a tab or as an installed app.

**Dark and light theme** — the Light / Dark button in the header.

**Results** — every signal the rules gave over the loaded history (about 12 trading days on 5-minute candles), winners and losers alike: how many won and lost, the win rate, the average win and loss, a running total, and a breakdown by instrument and by day, for Strict and All side by side. Results are measured on the index, share or future price in R, where 1R is the distance from entry to stop loss. Use this page to judge the signals before risking money. Nothing is hidden from it.

**Charts & signals** — pick a symbol, read the live price, and see today's signals as cards with Entry, Stop and three Targets. Every signal is boxed on the chart: green up to the target, red down to the stop. Each card names the option to buy (CALL for a buy signal, PUT for a sell signal). The Future / Call / Put switch opens the at-the-money call or put as its own live chart. The Simple / Advanced switch shows the full terminal with indicators, order blocks and the signal table.

**Option chain** — live OI, change in OI, volume, IV and price for every strike, with PCR and max pain. Tap any call or put price to chart that contract.

**Open interest** — bar charts of open interest and today's change by strike, with a plain reading of where support and resistance sit.

**Strategy builder** — choose a ready-made strategy (buy call, spreads, straddle, strangle, iron condor) or build your own legs. It shows what you pay or receive, maximum profit, maximum loss, breakevens and a payoff graph at expiry and today. It never places an order.

**Log in with Fyers / Log out** — the login is used only to read prices.

**Install as an app** — on a phone, open the site in Chrome or Safari and choose "Add to Home screen". It then opens full-screen from its own icon.

**Signals** — come from the structure engine described above (liquidity sweep, structure break, pull-back entry, higher-timeframe agreement). No new entries near the end of a session; open signals close shortly before it ends (15:30 for NSE, 23:30 for MCX). On an option's own chart, signals refer to the premium.

**Times** — everything is shown in India time (IST).

**Normal signals tab** — a third tab next to Strict and Other. These are classic trend signals from standard market analysis, and they come more often than the structure signals:
- 1-hour trend: EMA 20 above EMA 50 and price above EMA 50 for a buy (the reverse for a sell);
- on the chart timeframe, price pulls back to EMA 20, then a candle closes back in the trend direction beyond the previous candle's high (or low);
- RSI between 50 and 72 (28 to 50 for a sell), MACD histogram rising (falling), ADX at least 18;
- stop beyond the last five candles (0.6 to 2.2 ATR), targets at 1R, 2R and 3R, and no unbroken swing level closer than 1.2R;
- one at a time per instrument, never against a live structure signal, and none in the first 15 or last 45 minutes.
They use closed candles only, so they never change after they appear. Being looser, they lose more often; the Results page shows their own record separately.

**Telegram tab (on Home)** — trade calls from Telegram sources you choose, checked against live market data. They are other people's calls: shown separately, never mixed into the site's own signals or results, and a failed call is never turned into the opposite trade.
- **Sources:** add a public channel by its link (https://t.me/name) or @name; the site reads Telegram's free public preview page (t.me/s/name), at most 20 pages a minute. Private groups can't be read from an invite link; for a group you are in, create a free bot with @BotFather, turn its privacy mode off (/setprivacy → Disable), add it to the group, and put its token on Render as TELEGRAM_BOT_TOKEN. The bot sees only messages posted after it joined, and the server keeps them in memory until it restarts (the page keeps its own copy).
- **Your Telegram account (optional, free):** reads any channel or group you are a member of, including ones with no public preview. One-time setup: on my.telegram.org → API development tools, create an app and copy api_id and api_hash; on Render → Environment add TELEGRAM_API_ID and TELEGRAM_API_HASH. Then on the Telegram tab → Sources, log in with your phone number, the code Telegram sends to your app, and your two-step password if you use one, and tick the channels to follow. You stay logged in until you press "Log out of Telegram" (the browser keeps an encrypted copy of the login, which only this server can open, so it comes back after the free server sleeps). The site never posts or messages anyone. New posts arrive within seconds while the server is awake and are checked within about 15 seconds while the page is open; when the server wakes up it reads the last 150 posts of each followed chat, so nothing is skipped.
- **Signal Desk plan:** for each live call the site works out its own plan from the underlying's levels and the option's live premium: TAKE (buy up to a price, stop loss, three targets, reward : risk at least 1.5, underlying trend in the call's direction, option liquid) or SKIP with the reason. It is worked out even when the source keeps its stop loss back, is shown separately from the source's numbers, never says TAKE on a call that is contradicted, stopped, cancelled or expired, and premium levels are estimates. With alerts on, a TAKE plan beeps and notifies.
- **Late calls:** if the premium has already moved past the channel's entry (for example "buy above 200" and it is now 300), the plan is worked out again from the current price and needs reward : risk of 2 or better; if the premium is more than 60% past the channel's entry the site says SKIP (most of the move is gone). If a "buy above" trigger has not been crossed yet, the site says wait.
- **Trade now (the tab's first view):** only calls the site's plan says can be traded now. Each card asks "Did you take this trade?". No: the updated entry, stop loss and targets keep refreshing (about every 40 seconds for today's calls). Yes: type your buy price (pre-filled with the current premium) and lots; the trade is added to My trades and the card switches to live advice (hold with stop loss, book half and trail, book profit, exit / cut loss, exit before close) on your own buy price. "I didn't take it after all" removes it. Your answers are kept on this device.
- **Reading calls:** finds instrument, strike, CE/PE, entry or entry range ("110–115", "above 95", "@ 60"), stop loss, up to three targets, lots and expiry. Missing items are shown as missing, never filled in. Follow-ups ("Target 1 done", "SL hit", "exit", "cancel / avoid") are attached to their call. The same call posted again or forwarded from another channel counts once. Edits keep the original text; posts deleted later stay in the record.
- **Checks:** the contract exists near the current price and the expiry is listed; the option's own 5-minute prices from the moment of publication (was the entry reached, then which came first, stop or targets); fresh prices; stop, entry and targets in order; reward : risk to Target 1 at least your minimum (1.2 by default); liquidity (trades today, bid-ask spread up to 5%); and whether the underlying's 5-minute structure and 1-hour EMAs both point against the call.
- **Statuses:** VALIDATED — SETUP CONFIRMED, PARTIALLY VALIDATED, ENTRY MISSED, CONTRADICTED BY MARKET, INVALIDATED, EXPIRED, NO TRADE and AWAITING DATA, each with its reason.
- **Views:** Validated (inside the entry range now) and Being followed (entry reached), Latest (today), Rejected / missed, Source performance, and Sources. Target 1 alerts fire only when the option's own prices confirm it.
- **Source performance:** for each source, from each post's publication time: calls, complete calls, judged, T1 before SL, T2 before SL, SL hits, missed / not filled, cancelled, ambiguous, win rate, average win / loss and net, after an estimated 1% for charges. A win rate appears only after 20 judged calls; before that it says INSUFFICIENT HISTORY. Only contracts that are still listed can be checked (Fyers has no prices for expired contracts), so for weekly options the history reaches back about a week.
- Sources added for you: t.me/BankNifty_Option_Groww_trading_8 and t.me/Gxtradermadhav_trading_mcx_stock (on every device; remove them on the Sources view). Posts that advertise a paid or VIP group mark the source as PAID SOURCE (nothing is subscribed); a stop loss given only as "VIP" counts as withheld; "target done" posts that don't name a call are counted as unverifiable claims; price-only posts ("CRUDEOIL 351") are kept as updates of the call they follow.
- Not included: daily loss limits or position limits across trades (the site has no account-wide risk module), and posts from before a source was added beyond the last 6 pages / 7 days of its public preview.

**All F&O tab (first on Home)** — CALL / PUT buy signals on every instrument with listed options: all NSE F&O stocks, the index options (NIFTY, BANK NIFTY, FIN NIFTY, MIDCAP NIFTY, SENSEX, BANKEX) and MCX commodities with options.
- The server scans them all once after each 5-minute candle closes, with exactly the same rules as the Strict, Other and Normal tabs (it reads them from index.html, so there is one copy). One scan serves every device; the page only reads the result.
- Each signal shows the option to buy (strike nearest the price, nearest expiry with more than half a day left), its premium when the signal was found, premium stop and three targets (estimated from its implied volatility), the premium now, the underlying's levels, and why. Copy for WhatsApp in the usual format; View on chart opens any of them.
- Filters: Live now / All today, All types / Strict / Other / Normal, and a name filter. Setups confirmed but waiting for entry are listed at the top.
- The scan is paced at about 100 Fyers requests a minute so the pages' own requests still fit under Fyers' 200 a minute. It runs on the Fyers login of whoever used the site most recently, and pauses if nobody has used the site for 4 hours.
- On the free Render plan the server has little CPU; a full scan of about 220 instruments took about 3.5 minutes in testing, inside the 5-minute candle.
- The Strict, Other and Normal tabs now show only instruments with options, so every signal there is a CALL or PUT buy.

**Focus list and the Other tab** — the Other tab now covers only NIFTY 50, BANK NIFTY, SENSEX, HDFC BANK, CRUDE OIL, RELIANCE, ICICI BANK, SBI and NATURAL GAS (instruments with busy option markets). It shows three kinds of signals for them:
- opening range breakouts (new): the first 15 minutes set a range (NSE 09:15–09:30; MCX 09:00–09:15 and 18:00–18:15). A CALL needs a strong candle closing 0.1 ATR above the range high before 13:30 (MCX 13:00 / 22:00), a range 0.5–3 ATR tall, the 1-hour close above EMA 20, RSI 55–75, above VWAP where there is volume, and no level in the way closer than 1.2R. Stop at the middle of the range, targets 1R / 2R / 3R, one trade per range per day. PUT is the mirror;
- grade A trendline trades and grade B structure signals, as before, now for the focus list only.
Results has an "Opening range" record.

**Active now / Signals today** — tap either box on Home to list those signals (all types).

**Waiting for entry** — Strict and Other show setups that are confirmed but waiting for price to come back to the entry, so you see them before they fill.

**Updates** — the open chart and one focus instrument refresh every 5 seconds (each focus instrument about every 45 s), the rest in rotation; every 20 s while the page is in the background; everything at once when you come back to the page. With alerts on, every new strict or focus-list signal (and every confirmed setup) beeps and notifies, whichever tab is open.

**My trades (on Home)** — type the option you bought, e.g. "sensex 82000 pe buy 230 lot 10". The site finds the contract in the live option chain (nearest expiry, or the next one if the strike is only there), shows the live premium and your profit or loss, and gives a rule-based view: EXIT / CUT LOSS, BOOK PROFIT, BOOK HALF AND TRAIL, HOLD WITH STOP LOSS, HOLD WITH A TIGHT STOP, EXIT BEFORE CLOSE or MARKET CLOSED, with the reasons (trend, live signals for or against, support and resistance, time to close, expiry) and a premium stop and target worked out from the underlying's levels with the option's delta. It refreshes every 30 s while open, alerts you when the advice changes, and keeps your trades on that device only. It cannot see news or your broker account.

**Home sub-tabs** — Strict signals, Other signals, Normal signals, Scalp, BTST and My trades. (Scalp and BTST used to be separate menu pages; old links to them now open the right Home tab.)

**Other signals: grade A trendline trades** — besides the grade B structure signals, the Other tab shows trendline signals for intraday options:
- lines join the two most recent confirmed major swing points (5 candles each side), so a line never moves once drawn;
- breakout: a falling resistance line (two lower highs), never closed above since it began and touched 3 times (or broken on 1.5x volume), is broken by a strong candle closing 0.1 ATR above it; bounce: a rising support line (two higher lows), never closed below, holds on its third touch and price closes above the previous high; puts are the mirror image;
- all of: 1-hour EMA 20 above EMA 50 and 1-hour structure not against the trade; RSI 52–72 (breakout) or 45–68 (bounce); ADX 18+; MACD histogram above zero (breakout) or rising (bounce); volume 1.2x where available; stop 0.6–2 ATR; first swing level in the way at least 2R away after costs;
- the trendline is drawn on the chart for the picked or latest signal; Results has a separate "Trendline signals" record.

**Scalp tab (on Home)** — quick trades on indices and MCX commodities using 3-minute candles, separate from all other signals:
- 15-minute trend (EMA 20 vs EMA 50) sets the direction; on 3-minute candles EMA 9 and EMA 20 agree, price pulls back to EMA 20, then a candle breaks the last three highs (lows for a put);
- RSI 55–78 (22–45 for puts), ADX 20 or more, and the right side of VWAP where volume exists;
- stop beyond the last three candles (0.4–1.2 ATR), targets 1R / 1.5R / 2R, stop to entry at T1 and to T1 at T2, exit after 30 minutes or before the session ends;
- the ATM option and its current premium come from the live option chain; premium stop and targets are estimates from delta, shown only when the chain's spot matches the chart;
- before any scalp is shown you enter a scalping budget and the most you will lose on one trade (% of budget); both are kept on that device and can be changed any time;
- each active scalp then suggests how many lots (and quantity) to buy and at what price: the premium must fit the budget, and the loss at the estimated premium stop (or, if it can't be estimated, a 25% fall in premium) must stay within your limit; if even 1 lot doesn't fit, it says skip. For futures without options it sizes by risk only and reminds you to check margin with your broker;
- "NO SCALP TRADE right now" lists what each instrument is waiting for; the record below counts every past scalp, wins and losses, after estimated costs.

**BTST tab (on Home)** — buy a strong stock at 15:15–15:29, sell next morning by 10:15. Stocks only. Decided on the hourly candle that closes at 15:15 IST:
- daily uptrend (price above 20-day EMA, 20-day above 50-day), up 1–6% on the day, closing in the top 30% of the range and above yesterday's high;
- volume by 15:15 at least 1.2x the 20-day average volume by 15:15, daily RSI 55–75, and NIFTY 50 above its 20-day EMA;
- stop below today's low (0.4–0.8 daily ATR), targets +0.6 and +1.0 daily ATR;
- next-day check: gap past the stop or Target 2 exits at the open; otherwise the first hour decides; if a candle touches both a target and the stop, the stop is counted (the cautious choice); charges of 0.25% are included;
- before 15:15 stocks that meet the rules so far are listed as "forming", not as picks.
Both tabs use closed candles only (no repainting: checked on 1,000+ cut points of test data).

**Search** — the box at the top finds any NSE or BSE stock or index and any MCX commodity (nearest futures contract), using the symbol lists Fyers publishes each day. Picking a result opens its chart with a plain summary underneath:
- price card (last price, change, open/high/low, volume against usual), trend card (UP / DOWN / SIDEWAYS from the 1h, setup and entry timeframes, RSI, ADX, ATR), and the nearest support and resistance levels;
- a status: **VALID CE SIGNAL**, **VALID PE SIGNAL**, **NO VALID SIGNAL** (nothing qualifies, with the reason), or **SIGNAL NOT CONFIRMED** (market closed, data stale or saved, or contract data missing). Only one direction is ever live at a time, so "both valid" does not occur;
- when a signal is live and options are listed: the real contract from the Fyers option chain (strike, expiry, premium, bid/ask, open interest), entry range, stop, three targets, reward-to-risk, what cancels the setup, and a position-size helper (your capital and risk %, rounded to whole lots);
- the reasons the rules passed, and any related headline from the news tab as a warning.
Searched instruments stay in your list after a reload. Instruments without listed options (most BSE-only stocks, some MCX commodities) show the setup on the underlying only, marked "no options".

**Simple chart** — in Simple view the chart shows only candles, the signal box (BUY/SELL, entry, stop, targets) and a trend badge (UPTREND / DOWNTREND / SIDEWAYS). Order blocks, gaps, liquidity and indicators still drive the signals in the background; switch to Advanced to see them drawn.

**Market news** — headlines from public RSS feeds (Business Standard, Economic Times, Mint, Moneycontrol, CNBC, Google News), newest first, with source, publication time in IST and when they were read. Each item lists the instruments it may affect with their live trend and signal status, a short potential-impact note, direction, typical time horizon, risks and what to watch. The headline is the reported fact; everything under it is worked out automatically from the headline's words and is labelled as such. **News never creates a trade.** If a headline points against a live signal, the signal shows a news-risk warning. Feeds that fail are named at the top; the rest still show.

**Data labels** — every price and signal says where it came from: **Live** (fresh from Fyers), **Delayed** or **Stale** (no fresh price or candle while the market should be open — a holiday, halt or feed problem), **Saved** (this browser's copy from the last visit, shown at once while fresh data loads), **Closed** (market shut; last candle time shown). Signals are only issued on live data during market hours.


### Daily EMAs (every section)

Every signal is checked against the daily EMAs before it is shown: Strict, Other, Normal, trendline, opening range, All F&O, Scalp, BTST, the Telegram plan and the My trades advice.

| EMA | What it is used for |
|---|---|
| 5 EMA | strong momentum (price above it and 5 above 10, for a call) |
| 9 EMA | trailing stop (My trades: in 30%+ profit and price past it → book profit) |
| 10 EMA | short-term trend (price on the trade's side and the 10 EMA moving that way) |
| 20 EMA | pullback support: price within half a day's range of it in an uptrend is marked as a good place to join |
| 30 EMA | stage analysis: stage 2 = price above a rising 30 EMA, stage 4 = below a falling one, 1 and 3 = flat after a fall (base) or after a rise (top) |
| 50 EMA | uptrend defence line |
| 100 EMA | big-dip zone (marked when price is within a day's range of it) |
| 200 EMA | long-term trend: bulls' last stand in an uptrend, bears' last stand in a downtrend |
| 250 EMA | value zone (marked when price is near it) |

- Stage uses the 30-day EMA: its slope over the last 5 sessions (more than ±0.3% = rising / falling) and where it was 20 sessions ago.
- The check uses completed daily candles only (the days before the signal's day), so signals don't change after they appear. About two years of daily candles are fetched once a day per instrument (two Fyers requests each, kept 12 hours). The All F&O scan fetches them only for instruments with a signal that day.
- A signal is **dropped** only when it fights the daily trend on all three big measures at once: the wrong side of the 200 EMA and of the 50 EMA, in the opposite stage (a call in stage 4, a put in stage 2). A signal with none of the checks on its side (0/5) is dropped too. Every other signal shows a line such as "Daily EMAs 4/5 with the trade · Stage 2 · above 200 EMA", and the details are under "Why this signal".
- BTST adds "Daily EMAs" to its checklist. The Telegram plan says SKIP when the call is against the daily EMAs. My trades shows the 9 EMA trailing stop, and turns HOLD into HOLD, TIGHT STOP when the daily EMAs are all against your option.
- The chart page has a "Daily EMAs" panel with each EMA's value, whether price is above or below it, the stage, and the score for a call and for a put.
- If daily history isn't available (a new listing, or Fyers didn't answer), the card says "not checked" instead of guessing, and the signal is not dropped.

## Audit of the previous signal engine (October 2026)

- **Repainting and look-ahead:** order blocks, liquidity sweeps and swing points were worked out with later candles. On test data about 5% of signals shown live later changed or vanished, and the Results page was flattered.
- **One idea counted seven times:** 76 of the 100 score points measured the same thing (price recently went up: EMA order, EMA cross, above EMA 50, VWAP, MACD, Supertrend, ADX), so any small upswing scored 60.
- **Late, lagging triggers:** entries came on EMA crossovers or Supertrend flips, after the move, and fired constantly in sideways markets.
- **Stops inside the noise and blind targets:** stops sat just under the last three candles; targets were fixed at 1R/2R/3R regardless of resistance in the way; costs were ignored.
- **No real higher timeframe, and volume silently missing:** indices have no volume in the feed, so the volume check could never pass and VWAP was not a real VWAP.
- **Option contract not checked:** no check of spread or trading in the chosen option.

All of these are addressed by the new engine above.

## Costs: what this site uses

Everything the site uses is free; nothing paid is switched on, and if a free service stops working the page says so rather than moving to a paid one. The full list, with each service's free limits and status, is at the bottom of the **Results** page.

- **Render (hosting), free plan:** 750 hours a month (enough for this one site all month), sleeps after 15 minutes without visitors, and comes with a monthly outbound-data allowance. Render charges only if that allowance is exceeded and a payment card is saved on your Render account; with no card it suspends the site until the next month instead. To be sure nothing is ever billed, keep no card on the account (Render → Account → Billing). This site sends little data (about 70 KB per page load and a few kilobytes per price update).
- **Fyers API:** free (prices, candles and option chains included), with request limits that the site keeps under.
- **News RSS feeds, Fyers symbol lists, Telegram public preview pages, Telegram Bot API, Google Fonts:** free.
- **Optional:** UptimeRobot's free plan (keeps the site awake). Paid Render plans or any paid service are never needed for the site to work.

## Fyers request limits

Fyers allows about 10 requests a second, 200 a minute and a daily total. The server keeps every visitor together under 6 a second and 150 a minute. If Fyers still answers "too many requests", it pauses for 30 seconds (longer if it repeats) and keeps serving the last good prices, marked as older, instead of failing. While all markets are closed the page checks only every 5 minutes and the server reuses its data for up to 30 minutes, so a page left open overnight no longer uses up the daily allowance. `/healthz` shows requests in the last minute and today.

## Limits to know

- **MCX contracts** roll every month. The site picks the nearest live contract by itself each day and shows its month beside the name.
- **Lot sizes** come from Fyers' daily symbol lists when they load, otherwise from a built-in table. Check them with your broker.
- **Market holidays** are not built in. On a holiday the site sees no new candles and shows the market as closed or the data as delayed; it does not issue signals.
- **Free hosting sleeps** after about 15 minutes without visitors; the next visit takes up to a minute. This is a Render rule and cannot be changed in code. The page now opens at once from the last saved data while the server wakes, and keeps retrying for three minutes. To keep it awake, either:
  - create a free monitor at uptimerobot.com (HTTP(s), URL `https://signal-desk-8jcn.onrender.com/healthz`, every 5 minutes). Render's free plan gives 750 hours a month, enough for one site running all month; or
  - move the service to Render's Starter plan (about $7 a month), which never sleeps.
- **Each visitor sees data on their own Fyers login.** A visitor who is not logged in gets no prices.
- **Free hosting is for trying it out.** With several users at once, move to a paid Render plan so the site stays awake and responsive.

## Limits of the signals

**No signal system is risk-free.** Expect roughly a 35–45% hit rate at 1:3 reward to risk; most trades lose small and a minority carry the book. Results shown exclude slippage, brokerage and taxes.
