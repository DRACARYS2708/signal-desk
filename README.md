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

**Two tabs on Home: Strict signals and Other signals** — Strict signals are the ones where the bigger trend points the same way and is still moving, trend strength is above its threshold, price is on the right side of VWAP and Supertrend, the score is 72 or more, and it is not the first 15 or last 45 minutes of the session. Other signals passed the basic rules only and are weaker. Neither tab is guaranteed to profit; the Results page shows how each has actually done.

**Three groups on Home** — signals and live prices are shown separately for Indices (blue, chart icon), Commodities (amber, dashed frame, drop icon) and Stocks (violet, squared frame, bars icon). Each group shows up to six signals, active ones first, with a count of all its signals today.

**On every signal card**
- *Current price*, large, with the profit or loss in percent and a small line of the recent price.
- *Direction*: whether the price is moving up, moving down or flat over the last three candles, and whether that is in favour of the trade or against it.
- *Price track*: where the price sits between stop loss, entry and the three targets.
- *Entry taken or not*: press "I took this entry" and the card follows your own entry price from then on. This is remembered on your device only.
- *Late entry*: if you have not entered, the card says whether entering now still makes sense. If it does, it gives the entry at the current price, the stop loss, the targets and the new risk against reward. If Target 1 is already reached, the market has turned, or the reward no longer covers the risk, it says not to enter.

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

## Limits to know

- **MCX contracts** roll every month. The site picks the nearest live contract by itself each day and shows its month beside the name.
- **Lot sizes** are a built-in table, not from the exchange. Check them with your broker.
- **Free hosting sleeps** after about 15 minutes without visitors; the next visit takes up to a minute.
- **Each visitor sees data on their own Fyers login.** A visitor who is not logged in gets no prices.
- **Free hosting is for trying it out.** With several users at once, move to a paid Render plan so the site stays awake and responsive.

## Limits of the signals

**No signal system is risk-free.** Expect roughly a 35–45% hit rate at 1:3 reward to risk; most trades lose small and a minority carry the book. Results shown exclude slippage, brokerage and taxes.
