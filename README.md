# Signal Desk — real-time build (Fyers feed, free)

Intraday signal terminal for NSE indices, NSE stocks and MCX crude oil, natural gas, gold, silver and copper. Prices, candles and the option chain come in real time from your own Fyers account. Fyers does not charge for its API or market data. The page refreshes every 5 seconds.

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

## Using the page

**Simple view (default)** — pick a symbol from the dropdown, read the live price, and see today's signals as cards with Entry, Stop and three Targets. Tap a card to draw those levels on the chart. Buttons zoom the chart; on a phone, slide sideways to move and pinch to zoom.

**Trade boxes** — every signal is boxed on the chart from its entry candle to where it ended: green up to the target, red down to the stop. The latest signal shows its TP, Entry and SL prices; tap any other card to box that one.

**Calls and puts** — each signal card names the option to buy (CALL for a buy signal, PUT for a sell signal). The Future / Call / Put switch beside the price opens the at-the-money call or put as its own live chart with its own signals. **More strikes** opens the option chain; tap any call or put price there to chart that contract. Opened options stay in the dropdown under "Options you opened". On an option's own chart, signals refer to the premium: BUY means buy that option, SELL means the premium is falling.

**Advanced view** — the full terminal: watchlist, indicator read-outs, order blocks, liquidity pools, fair value gaps, RSI/MACD panes, the full signal table, the trade plan panel and the option chain.

**Signals** — fire on a fresh EMA cross or Supertrend flip that also scores 60 or more out of 100 on eleven checks. No new entries in the last 25 minutes of a session; open signals close 5 minutes before the session ends (15:30 for NSE, 23:30 for MCX).

**Times** — everything is shown in India time (IST).

## Limits to know

- **MCX contracts** roll every month. The site picks the nearest live contract by itself each day and shows its month beside the name.
- **Lot sizes** are a built-in table, not from the exchange. Check them with your broker.
- **Free hosting sleeps** after about 15 minutes without visitors; the next visit takes up to a minute.
- **Exchange data is licensed to you** for your own use. Set `SITE_PASSWORD` and don't share the link publicly.

## Limits of the signals

**No signal system is risk-free.** Expect roughly a 35–45% hit rate at 1:3 reward to risk; most trades lose small and a minority carry the book. Results shown exclude slippage, brokerage and taxes.
