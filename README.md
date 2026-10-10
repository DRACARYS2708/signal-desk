# Signal Desk — real-time build (Fyers feed, free)

Intraday option-signal app for NSE indices, 17 liquid NSE stocks (Reliance, HDFC Bank, Federal Bank, Coal India and others) and MCX crude oil, natural gas, gold, silver and copper. Prices, candles and the option chain come in real time from your own Fyers account. Fyers does not charge for its API or market data. The page refreshes every 5 seconds.

This is analysis software. It places no orders.

---

## Set it up (about 15 minutes, all in the browser)

### 1. Create a Fyers app

1. Log in at **myapi.fyers.in** with your Fyers account and open **Dashboard > Create App**.
2. App name: `Signal Desk`.
3. Redirect URL: your site address followed by `/auth/callback`, for example `https://signal-desk.onrender.com/auth/callback`. It must match exactly.
4. Leave the permissions as offered and create the app.
5. Copy the **App ID** (it ends in `-100`) and the **Secret ID**.

### 2. Replace the files on GitHub

Open your `signal-desk` repository, choose **Add file > Upload files**, drag in the four files and click **Commit changes**. Files with the same name are replaced. Render rebuilds the site by itself.

### 3. Add the settings on Render

Open your service on Render, go to **Environment**, and add:

| Key | Value |
|---|---|
| `FYERS_APP_ID` | the App ID |
| `FYERS_SECRET_ID` | the Secret ID |
| `FYERS_PIN` | your 4-digit Fyers PIN (optional, see below) |
| `SITE_PASSWORD` | a password of your choice for the site (recommended) |

Save. Render restarts the site.

### 4. Log in

Open your site and click **Log in to Fyers**. After the Fyers login the chart opens.

## How often you log in

Fyers closes every login overnight; that is a rule for all Indian brokers.

- **With `FYERS_PIN` set:** the site renews the login by itself for 15 days, on any browser where you logged in. After 15 days, click Log in to Fyers once.
- **Without it:** click Log in to Fyers once each morning.

The PIN stays in Render's private settings. Never put it, or the Secret ID, in the files or on GitHub.

## What's in the app

The menu across the top has five pages.

**Home** — every live signal as an option trade, for example "NIFTY 50 — 25100 CE, expiry 13 Oct, Buy @ 126, Stop loss 100, Target 1 / 2 / 3 150 / 190 / 250", with the option's price now and its profit or loss. A buy signal gives a CALL and a sell signal gives a PUT, at the strike nearest the price, in the nearest expiry with at least a day left. Each card then says in words what is happening:

- *Signal hit positive* when the option is above the buy price, and which targets have been reached.
- *Safe exit* price at all times: the stop loss at first, your buy price once Target 1 is reached, Target 1 once Target 2 is reached.
- *Market is turning against this trade, safe exit now near …* when the option is below the buy price and the chart has turned, before the stop loss is hit.
- *Signal failed* when the stop loss is hit, with the exit price.

The buy price is the option's real traded price when the signal fired. Stop loss and targets are the premiums the option should show when the chart reaches its own stop and targets; for thinly traded options they fall back to −20% and +20% / +45% / +80%. Below the signals are live prices for every instrument.

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
- **Exchange data is licensed to you** for your own use. Set `SITE_PASSWORD` and don't share the link publicly.

## Limits of the signals

**No signal system is risk-free.** Expect roughly a 35–45% hit rate at 1:3 reward to risk; most trades lose small and a minority carry the book. Results shown exclude slippage, brokerage and taxes.
