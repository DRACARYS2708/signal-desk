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

Open your `signal-desk` repository, choose **Add file > Upload files**, drag in the four files and click **Commit changes**. Files with the same name are replaced. Render rebuilds the site by itself.

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

**Signals** — fire on a fresh EMA cross or Supertrend flip that also scores 60 or more out of 100 on eleven checks. No new entries in the last 25 minutes of a session; open signals close 5 minutes before the session ends (15:30 for NSE, 23:30 for MCX). On an option's own chart, signals refer to the premium.

**Times** — everything is shown in India time (IST).

## Audit of the previous signal engine (October 2026)

- **Repainting and look-ahead:** order blocks, liquidity sweeps and swing points were worked out with later candles. On test data about 5% of signals shown live later changed or vanished, and the Results page was flattered.
- **One idea counted seven times:** 76 of the 100 score points measured the same thing (price recently went up: EMA order, EMA cross, above EMA 50, VWAP, MACD, Supertrend, ADX), so any small upswing scored 60.
- **Late, lagging triggers:** entries came on EMA crossovers or Supertrend flips, after the move, and fired constantly in sideways markets.
- **Stops inside the noise and blind targets:** stops sat just under the last three candles; targets were fixed at 1R/2R/3R regardless of resistance in the way; costs were ignored.
- **No real higher timeframe, and volume silently missing:** indices have no volume in the feed, so the volume check could never pass and VWAP was not a real VWAP.
- **Option contract not checked:** no check of spread or trading in the chosen option.

All of these are addressed by the new engine above.

## Limits to know

- **MCX contracts** roll every month. The site picks the nearest live contract by itself each day and shows its month beside the name.
- **Lot sizes** are a built-in table, not from the exchange. Check them with your broker.
- **Free hosting sleeps** after about 15 minutes without visitors; the next visit takes up to a minute.
- **Each visitor sees data on their own Fyers login.** A visitor who is not logged in gets no prices.
- **Free hosting is for trying it out.** With several users at once, move to a paid Render plan so the site stays awake and responsive.

## Limits of the signals

**No signal system is risk-free.** Expect roughly a 35–45% hit rate at 1:3 reward to risk; most trades lose small and a minority carry the book. Results shown exclude slippage, brokerage and taxes.
