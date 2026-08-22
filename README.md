# My Investment Dashboard

A single-page, no-backend investment tracker you host for free on GitHub Pages. Tracks stocks, gold, silver, platinum, palladium, and any other asset you want to log manually. Gives a plain-English 🟢🟡🔴 signal on whether now looks like a good, fair, or expensive time to buy more of something — plus a beginner-friendly "Learn Investing" section.

Everything runs entirely in your browser. There is no server and no database — your holdings are stored in your browser's `localStorage`, and price lookups go straight from your browser to free public price APIs.

## What's inside

- `index.html` — the page structure
- `style.css` — all styling
- `app.js` — all logic (data storage, price fetching, the buy/sell signal engine, education content)
- `README.md` — this file

## How it gets prices

- **Gold, silver, platinum, palladium**: [gold-api.com](https://gold-api.com) — free, no signup, explicitly supports being called directly from a browser.
- **Stocks**: the app tries several free sources in order (Yahoo Finance, then Yahoo via a CORS-friendly relay, then Stooq) and automatically falls back through them. Free stock APIs without a signup are not perfectly reliable — if all of them are temporarily unreachable, the app tells you in the Settings → "Data Provider Status" log, and you can always type in a price yourself so the dashboard is never stuck.
- **Optional**: in Settings, you can paste a free [Twelve Data](https://twelvedata.com/pricing) API key (no credit card needed, 800 free requests/day) to add one more reliable stock source to the fallback chain. Not required.

## The "is now a good time to buy" signal

For each holding, the app looks at the current price against whatever recent-price context it has (a ~1-year price history from the data source, or a 52-week high/low, or — if neither is available — the price history the app has quietly collected itself while you keep it open) and gives one of three plain-English verdicts:

- 🟢 **Possible buying opportunity** — price is near the low end of its recent range.
- 🟡 **Middle of its range** — no strong signal either way.
- 🔴 **Looks pricey right now** — price is near the high end of its recent range.

This is a simple, transparent rule (not a prediction and not financial advice) — hover over any badge to see the exact reasoning. The Learn Investing tab explains the idea behind it (moving averages, 52-week ranges) in plain language.

## Running it locally first (recommended before publishing)

1. Open the `investment-dashboard` folder.
2. Double-click `index.html` to open it in your browser — or, for the most reliable behavior, serve it locally (double-clicking sometimes restricts fetch requests in some browsers):
   - If you have Python installed: open a terminal in this folder and run `python3 -m http.server 8000`, then visit `http://localhost:8000`.
3. Try adding a stock and a gold holding, click "Refresh now", and check Settings → "Data Provider Status" to see which price sources succeeded.

## Publishing to GitHub Pages

1. **Create a GitHub account** if you don't have one, at github.com.
2. **Create a new repository**: click the "+" in the top right → "New repository". Give it a name like `investment-dashboard`. Set it to Public (GitHub Pages on a free personal account requires the repo to be public). Click "Create repository".
3. **Upload the files**: on the new repo's page, click "uploading an existing file", then drag in `index.html`, `style.css`, and `app.js` from this folder. Commit the changes.
4. **Turn on GitHub Pages**: in the repository, go to Settings → Pages (left sidebar). Under "Build and deployment", set Source to "Deploy from a branch", pick branch `main` and folder `/ (root)`, then Save.
5. **Wait about 1 minute**, then refresh the Pages settings page — it will show your live URL, something like `https://yourusername.github.io/investment-dashboard/`.
6. Visit that URL. Your dashboard is now live and accessible from any device — though remember, each browser/device keeps its own separate data, since everything is stored locally (see below).

## Important things to know

- **Your data lives in your browser only.** Nothing you type is sent to any server (only public price lookups happen over the network). This means: (a) nobody else can see your portfolio, but also (b) if you open the site on a different browser or device, it starts empty, and clearing your browser data will erase it.
- **Back up regularly.** Use Settings → "Export Backup (.json)" to download a copy of everything, and "Import Backup" to restore it (e.g. on a new device, or after clearing your browser). Do this every so often, especially after adding holdings.
- **Free stock price sources can be flaky.** They're not official, paid, guaranteed feeds — treat live prices as "usually right, occasionally delayed or unavailable" and use the manual price field as your safety net.
- **This is not financial advice.** The buy/sell signal is a simple, transparent, rule-based hint meant for learning — not a recommendation to buy or sell anything.

## Customizing later

Everything is plain HTML/CSS/JS with no build step, so you can open any of the three files in a text editor and change it directly — colors and layout live in `style.css`, the lesson text lives near the bottom of `app.js` in the `LESSONS` array, and the buy/sell rule lives in the `computeSignal` function in `app.js`.
