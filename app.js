/* ============================================================
   MY INVESTMENT DASHBOARD
   Pure client-side JS. No build step. No backend.
   All your data lives in this browser's localStorage.
   ============================================================ */

const STORAGE_KEY = "invdash_state_v1";

/* ---------- State ---------- */

let state = loadState();

function defaultState() {
  return {
    holdings: [],        // { id, kind: 'stock'|'metal', type, symbol, name, qty, avgCost,
                          //   manualPrice, manualHigh, manualLow, notes,
                          //   lastPrice, lastPriceTime, source, closesHistory, week52High, week52Low,
                          //   priceHistory: [{t, p}], lastSignalLevel }
    benchmark: null,      // { closesHistory, week52High, week52Low, source, lastUpdated, lastSignalLevel }
    settings: {
      refreshInterval: 300000,
      apiKey: "",
      notificationsEnabled: false,
      aiProvider: "anthropic",
      aiModel: "claude-sonnet-5",
      aiApiKey: ""
    }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    console.warn("Could not load saved data, starting fresh.", e);
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Tab switching ---------- */

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

/* ============================================================
   PRICE PROVIDERS
   Every provider function returns a Promise that resolves to
   a normalized object or rejects/throws on failure:
   { price, prevClose, week52High, week52Low, closesHistory, source }
   Metals use gold-api.com (confirmed free, no key, CORS-enabled,
   no rate limit). Stocks try several free sources in order of
   how much data they give us, and fall back gracefully.
   ============================================================ */

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const METAL_SYMBOLS = { gold: "XAU", silver: "XAG", platinum: "XPT", palladium: "XPD" };

async function getMetalData(metalType) {
  const sym = METAL_SYMBOLS[metalType];
  if (!sym) throw new Error("no live source for this asset type");
  const data = await fetchJson(`https://api.gold-api.com/price/${sym}`, 8000);
  if (!data || typeof data.price !== "number") throw new Error("bad response");
  return { price: data.price, source: "gold-api.com", closesHistory: null, week52High: null, week52Low: null };
}

// Provider A/B: Yahoo Finance chart endpoint (direct, then via CORS proxy).
// Gives price, previous close, 52-week high/low, and ~1y of daily closes
// (used to compute 50/200-day moving averages) all in a single call.
async function getYahooChart(symbol, viaProxy) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  const url = viaProxy ? `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}` : target;
  const data = await fetchJson(url, 9000);
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error("bad response");
  const meta = result.meta;
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] &&
    result.indicators.quote[0].close || []).filter(v => typeof v === "number");
  return {
    price: meta.regularMarketPrice,
    prevClose: meta.previousClose,
    week52High: meta.fiftyTwoWeekHigh || null,
    week52Low: meta.fiftyTwoWeekLow || null,
    closesHistory: closes.length ? closes : null,
    source: viaProxy ? "Yahoo Finance (via proxy)" : "Yahoo Finance"
  };
}

// Provider C: Stooq daily history CSV -> compute our own range + moving averages.
// getStooqHistoryRaw expects the exact Stooq symbol (e.g. "aapl.us" or "^spx").
async function getStooqHistoryRaw(rawSymbol) {
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(rawSymbol)}&i=d`, 9000);
  const lines = csv.trim().split("\n");
  if (lines.length < 2 || !/date/i.test(lines[0])) throw new Error("no data");
  const rows = lines.slice(1).map(l => l.split(","));
  const closes = rows.map(r => parseFloat(r[4])).filter(v => !isNaN(v));
  if (!closes.length) throw new Error("no closes");
  return {
    price: closes[closes.length - 1],
    closesHistory: closes,
    week52High: Math.max(...closes.slice(-252)),
    week52Low: Math.min(...closes.slice(-252)),
    source: "Stooq (historical)"
  };
}

async function getStooqHistory(symbol) {
  const sym = symbol.toLowerCase().includes(".") || symbol.startsWith("^")
    ? symbol.toLowerCase()
    : symbol.toLowerCase() + ".us";
  return getStooqHistoryRaw(sym);
}

// Provider D: Twelve Data quote (only used if the user supplied a free key).
async function getTwelveData(symbol, apiKey) {
  const data = await fetchJson(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`, 8000);
  if (!data || data.status === "error" || !data.close) throw new Error(data && data.message || "bad response");
  return {
    price: parseFloat(data.close),
    prevClose: parseFloat(data.previous_close),
    week52High: data.fifty_two_week ? parseFloat(data.fifty_two_week.high) : null,
    week52Low: data.fifty_two_week ? parseFloat(data.fifty_two_week.low) : null,
    closesHistory: null,
    source: "Twelve Data"
  };
}

// Provider E: Stooq simple last-quote CSV (price only, last resort automated source).
async function getStooqQuote(symbol) {
  const sym = symbol.toLowerCase().includes(".") ? symbol.toLowerCase() : symbol.toLowerCase() + ".us";
  const csv = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`, 7000);
  const lines = csv.trim().split("\n");
  if (lines.length < 2) throw new Error("no data");
  const cols = lines[1].split(",");
  const price = parseFloat(cols[6]);
  if (isNaN(price)) throw new Error("no price");
  return { price, source: "Stooq (quote)", closesHistory: null, week52High: null, week52Low: null };
}

async function getStockData(symbol, apiKey, log) {
  const attempts = [
    { name: "Yahoo Finance", fn: () => getYahooChart(symbol, false) },
    { name: "Yahoo Finance (proxy)", fn: () => getYahooChart(symbol, true) },
    { name: "Stooq history", fn: () => getStooqHistory(symbol) },
  ];
  if (apiKey) attempts.push({ name: "Twelve Data", fn: () => getTwelveData(symbol, apiKey) });
  attempts.push({ name: "Stooq quote", fn: () => getStooqQuote(symbol) });

  for (const attempt of attempts) {
    try {
      const result = await attempt.fn();
      log.push(`✔ ${symbol}: ${attempt.name} succeeded`);
      return result;
    } catch (e) {
      log.push(`✘ ${symbol}: ${attempt.name} failed (${e.message})`);
    }
  }
  return null; // all providers failed — caller falls back to manual price
}

// S&P 500 benchmark — same idea as getStockData, but using the index's own
// symbols (Yahoo: ^GSPC, Stooq: ^spx) instead of a per-holding ticker.
async function getSP500Data(log) {
  const attempts = [
    { name: "Yahoo Finance", fn: () => getYahooChart("^GSPC", false) },
    { name: "Yahoo Finance (proxy)", fn: () => getYahooChart("^GSPC", true) },
    { name: "Stooq history", fn: () => getStooqHistoryRaw("^spx") }
  ];
  for (const attempt of attempts) {
    try {
      const result = await attempt.fn();
      log.push(`✔ S&P 500: ${attempt.name} succeeded`);
      return result;
    } catch (e) {
      log.push(`✘ S&P 500: ${attempt.name} failed (${e.message})`);
    }
  }
  return null;
}

/* ============================================================
   SIGNAL ENGINE
   Rule-based "is now a decent time to buy" hint. Never financial
   advice — just a plain-English read of where the price sits
   relative to its own recent history.
   ============================================================ */

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeSignal(h) {
  const price = getEffectivePrice(h);
  if (price == null) {
    return { level: "gray", text: "No price yet", detail: "Refresh or enter a price manually to get a signal." };
  }

  let high = h.week52High, low = h.week52Low;
  let sma50 = null, sma200 = null;
  let basis = "";

  if (h.closesHistory && h.closesHistory.length >= 20) {
    const hist = h.closesHistory;
    if (high == null) high = Math.max(...hist);
    if (low == null) low = Math.min(...hist);
    sma50 = average(hist.slice(-Math.min(50, hist.length)));
    sma200 = hist.length >= 60 ? average(hist.slice(-Math.min(200, hist.length))) : null;
    basis = "based on ~1 year of price history";
  } else if (high == null || low == null) {
    // Fall back to locally-accumulated history collected while you use the app.
    const ph = (h.priceHistory || []).map(pt => pt.p);
    if (ph.length >= 8) {
      if (high == null) high = Math.max(...ph);
      if (low == null) low = Math.min(...ph);
      sma50 = average(ph.slice(-Math.min(50, ph.length)));
      basis = "based on data this app has collected since you added this holding";
    } else if (h.manualHigh != null && h.manualLow != null) {
      high = h.manualHigh; low = h.manualLow;
      basis = "based on the 52-week range you entered";
    }
  } else {
    basis = "based on the 52-week range from your data source";
  }

  if (high == null || low == null || high === low) {
    return {
      level: "gray",
      text: "Not enough data yet",
      detail: "Keep the app refreshing for a while, or enter a 52-week high/low manually for this holding to unlock a signal."
    };
  }

  const rangePct = Math.min(1, Math.max(0, (price - low) / (high - low)));
  let score = 0;
  if (rangePct <= 0.25) score += 2;
  else if (rangePct >= 0.75) score -= 2;
  if (sma200 != null) score += price < sma200 ? 1 : -1;
  if (sma50 != null) score += price < sma50 ? 1 : -1;

  const pctFromHigh = ((high - price) / high * 100).toFixed(1);
  const pctFromLow = ((price - low) / low * 100).toFixed(1);

  if (score >= 2) {
    return {
      level: "green",
      text: "Possible buying opportunity",
      detail: `Price is ${pctFromHigh}% below its recent high and ${pctFromLow}% above its recent low (${basis}). Historically, buying near the lower end of a range works out better than buying near the top — but this is a simple heuristic, not a guarantee.`
    };
  }
  if (score <= -2) {
    return {
      level: "red",
      text: "Looks pricey right now",
      detail: `Price is close to its recent high (only ${pctFromHigh}% below it, ${basis}). You might wait for a pullback before adding more — or hold if you're investing for the long run regardless of price.`
    };
  }
  return {
    level: "yellow",
    text: "Middle of its range",
    detail: `Price is roughly in the middle of its recent range (${basis}). No strong signal either way — a fine time to hold, and a neutral time to add.`
  };
}

function getEffectivePrice(h) {
  if (h.manualPrice != null && (h.lastPrice == null || h.priceIsManual)) return h.manualPrice;
  if (h.lastPrice != null) return h.lastPrice;
  if (h.manualPrice != null) return h.manualPrice;
  return null;
}

/* ============================================================
   NOTIFICATIONS — alert the user when a signal flips to green/red
   ============================================================ */

function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("This browser doesn't support notifications.");
    return;
  }
  Notification.requestPermission().then(perm => {
    state.settings.notificationsEnabled = perm === "granted";
    saveState();
    updateNotificationStatus();
    if (perm === "granted") {
      new Notification("Investment Dashboard", { body: "Notifications enabled — you'll be alerted when a signal changes." });
    }
  });
}

function updateNotificationStatus() {
  const el = document.getElementById("notificationStatus");
  if (!("Notification" in window)) {
    el.textContent = "Not supported in this browser.";
  } else if (Notification.permission === "granted" && state.settings.notificationsEnabled) {
    el.textContent = "✅ Enabled";
  } else if (Notification.permission === "denied") {
    el.textContent = "🚫 Blocked — enable notifications for this site in your browser settings.";
  } else {
    el.textContent = "Off";
  }
}

// Compares a holding's (or the benchmark's) new signal against the last one
// we saw, and fires a notification only on a meaningful transition — never
// on every refresh, so this can't spam the user.
function checkSignalChange(obj, label) {
  const sig = computeSignal(obj);
  const prev = obj.lastSignalLevel;
  obj.lastSignalLevel = sig.level;

  if (prev == null || prev === sig.level) return; // first look, or unchanged — stay quiet
  if (sig.level !== "green" && sig.level !== "red") return; // only alert on actionable flips

  if (state.settings.notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const icon = sig.level === "green" ? "🟢" : "🔴";
    new Notification(`${icon} ${label}: ${sig.text}`, { body: sig.detail });
  }
}

/* ============================================================
   REFRESH — pull live data for every holding
   ============================================================ */

let refreshing = false;

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  document.getElementById("refreshBtn").textContent = "↻ Refreshing…";
  const log = [];

  for (const h of state.holdings) {
    if (h.kind === "metal" && h.type === "other") {
      continue; // manual-only asset type, nothing to fetch
    }
    try {
      let data = null;
      if (h.kind === "metal") {
        data = await getMetalData(h.type);
        log.push(`✔ ${h.name || h.type}: ${data.source} succeeded`);
      } else if (h.kind === "stock") {
        data = await getStockData(h.symbol, state.settings.apiKey, log);
      }
      if (data && typeof data.price === "number") {
        h.lastPrice = data.price;
        h.lastPriceTime = Date.now();
        h.priceIsManual = false;
        h.source = data.source;
        if (data.closesHistory) h.closesHistory = data.closesHistory;
        if (data.week52High != null) h.week52High = data.week52High;
        if (data.week52Low != null) h.week52Low = data.week52Low;

        h.priceHistory = h.priceHistory || [];
        h.priceHistory.push({ t: Date.now(), p: data.price });
        if (h.priceHistory.length > 1000) h.priceHistory.shift();
      } else {
        log.push(`⚠ ${h.name || h.symbol}: all live sources failed — showing last known / manual price`);
      }
    } catch (e) {
      log.push(`✘ ${h.name || h.symbol}: unexpected error (${e.message})`);
    }

    checkSignalChange(h, h.name || h.symbol || h.type);
  }

  // Refresh the S&P 500 benchmark alongside everything else.
  try {
    const spData = await getSP500Data(log);
    if (spData) {
      state.benchmark = Object.assign({}, state.benchmark, {
        lastPrice: spData.price,
        closesHistory: spData.closesHistory || (state.benchmark && state.benchmark.closesHistory) || null,
        week52High: spData.week52High != null ? spData.week52High : (state.benchmark && state.benchmark.week52High) || null,
        week52Low: spData.week52Low != null ? spData.week52Low : (state.benchmark && state.benchmark.week52Low) || null,
        source: spData.source,
        lastUpdated: Date.now(),
        priceIsManual: false,
        manualPrice: null,
        priceHistory: state.benchmark && state.benchmark.priceHistory || []
      });
      state.benchmark.priceHistory.push({ t: Date.now(), p: spData.price });
      if (state.benchmark.priceHistory.length > 1000) state.benchmark.priceHistory.shift();
      checkSignalChange(state.benchmark, "S&P 500");
    } else {
      log.push("⚠ S&P 500: all sources failed — showing last known chart data, if any");
    }
  } catch (e) {
    log.push(`✘ S&P 500: unexpected error (${e.message})`);
  }

  saveState();
  document.getElementById("providerLog").textContent = log.length ? log.join("\n") : "Nothing to refresh — add a holding first.";
  document.getElementById("lastUpdated").textContent = "Last refreshed: " + new Date().toLocaleString();
  document.getElementById("refreshBtn").textContent = "↻ Refresh now";
  refreshing = false;
  renderAll();
}

/* ---------- Auto-refresh timer ---------- */

let autoTimer = null;
function setupAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  const ms = Number(state.settings.refreshInterval) || 0;
  if (ms > 0) {
    autoTimer = setInterval(() => {
      if (document.visibilityState === "visible") refreshAll();
    }, ms);
  }
}

/* ============================================================
   RENDERING
   ============================================================ */

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function holdingValue(h) {
  const price = getEffectivePrice(h);
  if (price == null || h.qty == null) return null;
  return price * h.qty;
}

function holdingCost(h) {
  if (h.avgCost == null || h.qty == null) return null;
  return h.avgCost * h.qty;
}

function signalBadge(sig) {
  const map = { green: "badge-green", yellow: "badge-yellow", red: "badge-red", gray: "badge-gray" };
  const icon = { green: "🟢", yellow: "🟡", red: "🔴", gray: "⚪" };
  return `<span class="badge ${map[sig.level]}" title="${sig.detail.replace(/"/g, "'")}">${icon[sig.level]} ${sig.text}</span>`;
}

function renderAll() {
  renderStockTable();
  renderMetalTable();
  renderDashboard();
}

function renderStockTable() {
  const tbody = document.querySelector("#stockTable tbody");
  const stocks = state.holdings.filter(h => h.kind === "stock");
  tbody.innerHTML = "";
  document.getElementById("stockEmptyMsg").style.display = stocks.length ? "none" : "block";

  stocks.forEach(h => {
    const price = getEffectivePrice(h);
    const value = holdingValue(h);
    const cost = holdingCost(h);
    const gl = value != null && cost != null ? value - cost : null;
    const glPct = gl != null && cost ? (gl / cost) * 100 : null;
    const sig = computeSignal(h);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${h.symbol}</strong><br><span class="muted small">${h.name || ""}</span></td>
      <td>${h.qty ?? "—"}</td>
      <td>${fmtMoney(h.avgCost)}</td>
      <td>${fmtMoney(price)}</td>
      <td>${fmtMoney(value)}</td>
      <td class="${gl >= 0 ? "gain" : "loss"}">${fmtMoney(gl)}<br><span class="small">${fmtPct(glPct)}</span></td>
      <td>${signalBadge(sig)}</td>
      <td class="muted small">${h.source || "—"}</td>
      <td>
        <button class="btn-icon" data-edit="${h.id}" title="Edit">✎</button>
        <button class="btn-icon" data-del="${h.id}" title="Delete">🗑</button>
      </td>`;
    tbody.appendChild(tr);
  });

  wireRowButtons(tbody);
}

function renderMetalTable() {
  const tbody = document.querySelector("#metalTable tbody");
  const metals = state.holdings.filter(h => h.kind === "metal");
  tbody.innerHTML = "";
  document.getElementById("metalEmptyMsg").style.display = metals.length ? "none" : "block";

  metals.forEach(h => {
    const price = getEffectivePrice(h);
    const value = holdingValue(h);
    const cost = holdingCost(h);
    const gl = value != null && cost != null ? value - cost : null;
    const sig = computeSignal(h);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${h.name || h.type}</strong></td>
      <td>${h.type}</td>
      <td>${h.qty ?? "—"}</td>
      <td>${fmtMoney(h.avgCost)}</td>
      <td>${fmtMoney(price)} ${signalBadge(sig)}</td>
      <td>${fmtMoney(value)}</td>
      <td class="${gl >= 0 ? "gain" : "loss"}">${fmtMoney(gl)}</td>
      <td class="muted small">${h.source || (h.type === "other" ? "manual" : "—")}</td>
      <td>
        <button class="btn-icon" data-edit="${h.id}" title="Edit">✎</button>
        <button class="btn-icon" data-del="${h.id}" title="Delete">🗑</button>
      </td>`;
    tbody.appendChild(tr);
  });

  wireRowButtons(tbody);
}

function wireRowButtons(container) {
  container.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => openModal(btn.dataset.edit));
  });
  container.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (confirm("Delete this holding? This can't be undone.")) {
        state.holdings = state.holdings.filter(h => h.id !== btn.dataset.del);
        saveState();
        renderAll();
      }
    });
  });
}

function renderDashboard() {
  const holdings = state.holdings;
  let totalValue = 0, totalCost = 0;
  holdings.forEach(h => {
    totalValue += holdingValue(h) || 0;
    totalCost += holdingCost(h) || 0;
  });
  const gl = totalValue - totalCost;
  const glPct = totalCost ? (gl / totalCost) * 100 : 0;

  document.getElementById("statTotalValue").textContent = fmtMoney(totalValue);
  document.getElementById("statTotalCost").textContent = fmtMoney(totalCost);
  document.getElementById("statGainLoss").textContent = fmtMoney(gl);
  document.getElementById("statGainLoss").className = "card-value " + (gl >= 0 ? "gain" : "loss");
  document.getElementById("statGainLossPct").textContent = fmtPct(glPct);
  document.getElementById("statHoldingCount").textContent = holdings.length;

  renderDonut(holdings);
  renderNeedsLook(holdings);
  renderDashboardTable(holdings);
  renderSP500Chart();
}

/* ---------- S&P 500 market timing chart ---------- */

let sp500ChartInstance = null;

function rollingAverage(arr, window) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= window) sum -= arr[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function renderSP500Chart() {
  const canvas = document.getElementById("sp500Chart");
  const sigEl = document.getElementById("sp500Signal");
  const updatedEl = document.getElementById("sp500Updated");
  const b = state.benchmark;

  if (!b || !b.closesHistory || b.closesHistory.length < 5) {
    sigEl.innerHTML = "";
    updatedEl.textContent = "Not loaded yet — click \"Refresh now\", or check Settings → Data Provider Status if this persists.";
    return;
  }

  const sig = computeSignal(b);
  sigEl.innerHTML = signalBadge(sig);
  updatedEl.textContent = "Last updated: " + (b.lastUpdated ? new Date(b.lastUpdated).toLocaleString() : "—") +
    " · source: " + (b.source || "—");

  if (typeof Chart === "undefined") {
    updatedEl.textContent += " (chart library failed to load — check your internet connection)";
    return;
  }

  const hist = b.closesHistory;
  const labels = hist.map((_, i) => i - hist.length + 1);
  const sma50 = rollingAverage(hist, 50);
  const sma200 = hist.length >= 200 ? rollingAverage(hist, 200) : null;

  const high = b.week52High || Math.max(...hist);
  const low = b.week52Low || Math.min(...hist);
  const buyThreshold = low + 0.25 * (high - low);
  const sellThreshold = high - 0.25 * (high - low);

  const datasets = [
    { label: "S&P 500", data: hist, borderColor: "#5b8def", borderWidth: 2, pointRadius: 0, tension: 0.1 },
    { label: "50-day average", data: sma50, borderColor: "#f1c40f", borderWidth: 1.5, pointRadius: 0, borderDash: [4, 4] },
    { label: "Buy zone (bottom 25%)", data: hist.map(() => buyThreshold), borderColor: "#2ecc71", borderWidth: 1, pointRadius: 0, borderDash: [6, 3] },
    { label: "Sell zone (top 25%)", data: hist.map(() => sellThreshold), borderColor: "#ff5c5c", borderWidth: 1, pointRadius: 0, borderDash: [6, 3] }
  ];
  if (sma200) {
    datasets.splice(2, 0, { label: "200-day average", data: sma200, borderColor: "#d2b4de", borderWidth: 1.5, pointRadius: 0, borderDash: [2, 2] });
  }

  if (sp500ChartInstance) sp500ChartInstance.destroy();
  sp500ChartInstance = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: "#8b93a7" }, grid: { color: "#2b3348" } },
        y: { ticks: { color: "#8b93a7" }, grid: { color: "#2b3348" } }
      },
      plugins: { legend: { labels: { color: "#e8ebf3", boxWidth: 12 } } }
    }
  });
}

const CATEGORY_COLORS = {
  stock: "#5b8def", gold: "#f1c40f", silver: "#bdc3c7",
  platinum: "#82e0aa", palladium: "#d2b4de", other: "#8b93a7"
};

function renderDonut(holdings) {
  const totals = {};
  holdings.forEach(h => {
    const cat = h.kind === "stock" ? "stock" : h.type;
    totals[cat] = (totals[cat] || 0) + (holdingValue(h) || 0);
  });
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  const svg = document.getElementById("donutSvg");
  const legend = document.getElementById("donutLegend");
  svg.innerHTML = "";
  legend.innerHTML = "";

  if (!entries.length) {
    legend.innerHTML = '<p class="muted small">No value to chart yet.</p>';
    return;
  }

  const total = entries.reduce((s, [, v]) => s + v, 0);
  let angleStart = -90;
  const cx = 100, cy = 100, r = 80, rInner = 48;

  entries.forEach(([cat, val]) => {
    const pct = val / total;
    const angleEnd = angleStart + pct * 360;
    svg.appendChild(makeDonutSlice(cx, cy, r, rInner, angleStart, angleEnd, CATEGORY_COLORS[cat] || "#5b8def"));
    angleStart = angleEnd;

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-swatch" style="background:${CATEGORY_COLORS[cat] || "#5b8def"}"></span>
      ${cat.charAt(0).toUpperCase() + cat.slice(1)} — ${fmtMoney(val)} (${(pct * 100).toFixed(1)}%)`;
    legend.appendChild(item);
  });
}

function makeDonutSlice(cx, cy, r, rInner, startDeg, endDeg, color) {
  const toRad = d => (d * Math.PI) / 180;
  const p1 = [cx + r * Math.cos(toRad(startDeg)), cy + r * Math.sin(toRad(startDeg))];
  const p2 = [cx + r * Math.cos(toRad(endDeg)), cy + r * Math.sin(toRad(endDeg))];
  const p3 = [cx + rInner * Math.cos(toRad(endDeg)), cy + rInner * Math.sin(toRad(endDeg))];
  const p4 = [cx + rInner * Math.cos(toRad(startDeg)), cy + rInner * Math.sin(toRad(startDeg))];
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  const d = `M ${p1[0]} ${p1[1]} A ${r} ${r} 0 ${largeArc} 1 ${p2[0]} ${p2[1]}
             L ${p3[0]} ${p3[1]} A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4[0]} ${p4[1]} Z`;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", color);
  return path;
}

function renderNeedsLook(holdings) {
  const el = document.getElementById("needsLookList");
  const flagged = holdings
    .map(h => ({ h, sig: computeSignal(h) }))
    .filter(x => x.sig.level === "green" || x.sig.level === "red");

  if (!flagged.length) {
    el.innerHTML = '<p class="muted small">Nothing flagged right now — either everything is mid-range, or add more holdings.</p>';
    return;
  }
  el.innerHTML = "";
  flagged.forEach(({ h, sig }) => {
    const row = document.createElement("div");
    row.className = "needs-item";
    row.innerHTML = `<span>${h.name || h.symbol || h.type}</span>${signalBadge(sig)}`;
    el.appendChild(row);
  });
}

function renderDashboardTable(holdings) {
  const tbody = document.querySelector("#dashboardTable tbody");
  tbody.innerHTML = "";
  holdings.forEach(h => {
    const price = getEffectivePrice(h);
    const value = holdingValue(h);
    const cost = holdingCost(h);
    const gl = value != null && cost != null ? value - cost : null;
    const sig = computeSignal(h);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${h.name || h.symbol || h.type}</td>
      <td>${h.kind === "stock" ? "Stock" : h.type}</td>
      <td>${fmtMoney(price)}</td>
      <td>${fmtMoney(value)}</td>
      <td class="${gl >= 0 ? "gain" : "loss"}">${fmtMoney(gl)}</td>
      <td>${signalBadge(sig)}</td>`;
    tbody.appendChild(tr);
  });
}

/* ============================================================
   MODAL — add / edit holding
   ============================================================ */

const modalOverlay = document.getElementById("modalOverlay");
const holdingForm = document.getElementById("holdingForm");

function openAddModal(kind) {
  holdingForm.reset();
  document.getElementById("holdingId").value = "";
  document.getElementById("holdingKind").value = kind;
  document.getElementById("modalTitle").textContent = kind === "stock" ? "Add Stock" : "Add Metal / Other Asset";

  document.getElementById("metalTypeRow").classList.toggle("hidden", kind !== "metal");
  document.getElementById("symbolRow").classList.toggle("hidden", kind === "metal");
  document.getElementById("manualPriceRow").classList.remove("hidden");
  document.getElementById("qtyLabel").textContent = kind === "stock" ? "Quantity (shares)" : "Quantity (oz)";
  document.getElementById("costLabel").textContent = kind === "stock" ? "Average Cost / share" : "Average Cost / oz";
  toggleManualPriceVisibility();
  modalOverlay.classList.remove("hidden");
}

function openModal(id) {
  const h = state.holdings.find(x => x.id === id);
  if (!h) return;
  document.getElementById("holdingId").value = h.id;
  document.getElementById("holdingKind").value = h.kind;
  document.getElementById("modalTitle").textContent = "Edit Holding";
  document.getElementById("metalTypeRow").classList.toggle("hidden", h.kind !== "metal");
  document.getElementById("symbolRow").classList.toggle("hidden", h.kind === "metal");
  if (h.kind === "metal") document.getElementById("metalTypeSelect").value = h.type;
  document.getElementById("symbolInput").value = h.symbol || "";
  document.getElementById("nameInput").value = h.name || "";
  document.getElementById("qtyInput").value = h.qty ?? "";
  document.getElementById("costInput").value = h.avgCost ?? "";
  document.getElementById("manualPriceInput").value = h.manualPrice ?? "";
  document.getElementById("manualHighInput").value = h.manualHigh ?? "";
  document.getElementById("manualLowInput").value = h.manualLow ?? "";
  document.getElementById("notesInput").value = h.notes || "";
  document.getElementById("qtyLabel").textContent = h.kind === "stock" ? "Quantity (shares)" : "Quantity (oz)";
  document.getElementById("costLabel").textContent = h.kind === "stock" ? "Average Cost / share" : "Average Cost / oz";
  toggleManualPriceVisibility();
  modalOverlay.classList.remove("hidden");
}

function toggleManualPriceVisibility() {
  // Manual price is always offered — it's the fallback of last resort when
  // every live source fails, and the only option for "other" assets.
  document.getElementById("manualPriceRow").classList.remove("hidden");
}

document.getElementById("metalTypeSelect").addEventListener("change", toggleManualPriceVisibility);
document.getElementById("addStockBtn").addEventListener("click", () => openAddModal("stock"));
document.getElementById("addMetalBtn").addEventListener("click", () => openAddModal("metal"));
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelFormBtn").addEventListener("click", closeModal);

function closeModal() {
  modalOverlay.classList.add("hidden");
}

modalOverlay.addEventListener("click", e => {
  if (e.target === modalOverlay) closeModal();
});

holdingForm.addEventListener("submit", e => {
  e.preventDefault();
  const kind = document.getElementById("holdingKind").value;
  const id = document.getElementById("holdingId").value || uid();
  const existing = state.holdings.find(h => h.id === id) || {};

  const holding = Object.assign({}, existing, {
    id, kind,
    type: kind === "metal" ? document.getElementById("metalTypeSelect").value : "stock",
    symbol: kind === "stock" ? document.getElementById("symbolInput").value.trim().toUpperCase() : null,
    name: document.getElementById("nameInput").value.trim(),
    qty: parseFloat(document.getElementById("qtyInput").value) || 0,
    avgCost: parseFloat(document.getElementById("costInput").value) || 0,
    notes: document.getElementById("notesInput").value.trim()
  });

  const manualVal = document.getElementById("manualPriceInput").value;
  if (manualVal !== "") {
    holding.manualPrice = parseFloat(manualVal);
    holding.priceIsManual = true;
  }
  const manualHigh = document.getElementById("manualHighInput").value;
  const manualLow = document.getElementById("manualLowInput").value;
  holding.manualHigh = manualHigh !== "" ? parseFloat(manualHigh) : (existing.manualHigh ?? null);
  holding.manualLow = manualLow !== "" ? parseFloat(manualLow) : (existing.manualLow ?? null);

  if (kind === "stock" && !holding.symbol) {
    alert("Please enter a ticker symbol.");
    return;
  }

  if (!existing.id) state.holdings.push(holding);
  else Object.assign(existing, holding);

  saveState();
  closeModal();
  renderAll();
  refreshAll(); // fetch a fresh price for the new/edited holding right away
});

/* ============================================================
   SETTINGS
   ============================================================ */

document.getElementById("refreshIntervalSelect").addEventListener("change", e => {
  state.settings.refreshInterval = Number(e.target.value);
  saveState();
  setupAutoRefresh();
});

document.getElementById("saveApiKeyBtn").addEventListener("click", () => {
  state.settings.apiKey = document.getElementById("apiKeyInput").value.trim();
  saveState();
  showToast("API key saved.");
});

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `investment-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

document.getElementById("importInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported.holdings) throw new Error("not a valid backup file");
      state = Object.assign(defaultState(), imported);
      saveState();
      renderAll();
      document.getElementById("refreshIntervalSelect").value = state.settings.refreshInterval;
      document.getElementById("apiKeyInput").value = state.settings.apiKey || "";
      showToast("Backup imported.");
    } catch (err) {
      alert("Could not read that file: " + err.message);
    }
  };
  reader.readAsText(file);
});

document.getElementById("clearAllBtn").addEventListener("click", () => {
  if (confirm("This will permanently delete all holdings and settings from this browser. Continue?")) {
    state = defaultState();
    saveState();
    renderAll();
    showToast("All data cleared.");
  }
});

document.getElementById("refreshBtn").addEventListener("click", refreshAll);
document.getElementById("enableNotificationsBtn").addEventListener("click", requestNotificationPermission);

function showToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ============================================================
   EDUCATION CONTENT — written for a total beginner
   ============================================================ */

const LESSONS = [
  {
    title: "1. What does 'investing' even mean?",
    body: `<p>Imagine you have $10. You could spend it on candy today, or you could give it to a lemonade stand that promises to grow bigger and give you more money back later. Investing is choosing to <em>not</em> spend your money right now, so it has a chance to grow into more money later.</p>
    <p>You're not guaranteed to get more back — that's the trade-off. But over long periods of time, sensible investing has historically grown people's money much faster than a piggy bank ever could.</p>`
  },
  {
    title: "2. What is a stock?",
    body: `<p>A stock is a tiny slice of ownership in a company. If a company is like a giant pizza, a share of stock is one slice of that pizza. If the company does well and the pizza gets bigger, your slice is worth more. If the company struggles, your slice is worth less.</p>
    <p>When you buy 1 share of Apple, you now own a tiny, tiny piece of Apple. You don't get to walk into their office and boss anyone around, but if Apple's value grows, your tiny piece grows too.</p>`
  },
  {
    title: "3. Why do stock prices go up and down?",
    body: `<p>Think of a school trading-card market. If everyone suddenly wants the same rare card, people will pay more for it — the price goes up. If a card turns out to be common and boring, nobody wants to pay much — the price goes down.</p>
    <p>Stock prices work the same way: they go up when more people want to buy than sell, and down when more people want to sell than buy. That "wanting" is driven by how well people think a company will do in the future.</p>`
  },
  {
    title: "4. What are gold and silver, and why do people buy them?",
    body: `<p>Gold and silver are shiny metals that people have trusted as valuable for thousands of years — way before there was money as we know it. Unlike a company, gold doesn't "grow" a business. It's valuable because:</p>
    <ul>
      <li>There's only so much of it in the world (nobody can just make more).</li>
      <li>People all over the world agree it's worth something, even during hard times.</li>
      <li>It tends to hold its value when paper money loses value (this is called "inflation").</li>
    </ul>
    <p>Many people keep a little bit of gold or silver as a kind of insurance policy for their savings, not because they expect it to shoot up in price like a stock might.</p>`
  },
  {
    title: "5. What is diversification? (Don't put all your eggs in one basket)",
    body: `<p>If you carry all your eggs in one basket and drop it, you lose every egg. If you split them into three baskets, dropping one only costs you a third.</p>
    <p>Diversification means spreading your money across different investments — some stocks, maybe some gold, maybe different companies or industries — so that if one of them has a bad day, your entire savings don't crash with it.</p>`
  },
  {
    title: "6. What is risk vs. reward?",
    body: `<p>Generally, investments that can grow a lot ("high reward") can also lose a lot ("high risk") — think of individual stocks, which can double... or drop by half. Investments like gold tend to be steadier — they usually won't make you rich fast, but they also usually won't crash overnight.</p>
    <p>There's no such thing as a "no risk, high reward" investment. If something promises that, be very careful — it's usually a scam.</p>`
  },
  {
    title: "7. What is a moving average, and why does this app use it?",
    body: `<p>A moving average is just a fancy way of saying "the average price over the last X days." If a stock's price today is a lot <em>lower</em> than its average price over the last 200 days, it might be "on sale." If it's a lot <em>higher</em>, it might be "expensive" right now compared to its own recent history.</p>
    <p>This app looks at where today's price sits compared to its recent high, recent low, and its own moving average, and turns that into a simple 🟢🟡🔴 light so you can see the situation at a glance. It's a simple hint based on the past — not a promise about the future.</p>`
  },
  {
    title: "8. What is dollar-cost averaging?",
    body: `<p>Instead of trying to guess the "perfect" moment to buy (which even professionals get wrong constantly), some people invest a fixed amount regularly — like $50 every single month, no matter what the price is doing.</p>
    <p>Some months you'll buy when prices are high, some months when they're low — but on average, this smooths things out and removes the stress of trying to time the market perfectly.</p>`
  },
  {
    title: "9. What is compounding? (The snowball effect)",
    body: `<p>Imagine rolling a small snowball down a snowy hill. At first it grows slowly. But as it gets bigger, it picks up even more snow, faster and faster, until it's huge.</p>
    <p>Compounding is like that with money: the money your investments earn can itself start earning more money. Over many years, this snowball effect is one of the most powerful tools in investing — which is why starting early (even with small amounts) matters so much more than most people realize.</p>`
  },
  {
    title: "10. Glossary — words used in this dashboard",
    body: `<ul>
      <li><strong>Ticker symbol:</strong> A short code for a stock, like AAPL for Apple.</li>
      <li><strong>Quantity:</strong> How many shares (or ounces, for metals) you own.</li>
      <li><strong>Average cost:</strong> The average price you paid per share/ounce across all your purchases.</li>
      <li><strong>Current value:</strong> What your holding is worth right now (quantity × current price).</li>
      <li><strong>Gain/Loss:</strong> The difference between what it's worth now and what you paid for it.</li>
      <li><strong>52-week high/low:</strong> The highest and lowest price over roughly the last year.</li>
      <li><strong>Moving average (SMA):</strong> The average price over a recent stretch of time (e.g. the last 50 or 200 days).</li>
      <li><strong>Allocation:</strong> How your total money is split between different types of investments.</li>
      <li><strong>Diversification:</strong> Spreading your money across different things to reduce risk.</li>
    </ul>
    <p class="muted small">Nothing in this app is financial advice — it's a set of simple, transparent rules to help you learn and think, not a promise about what will happen to any price.</p>`
  }
];

function renderLessons() {
  const container = document.getElementById("lessonList");
  const learned = JSON.parse(localStorage.getItem("invdash_learned") || "{}");
  container.innerHTML = "";
  LESSONS.forEach((lesson, i) => {
    const details = document.createElement("details");
    details.className = "lesson";
    details.innerHTML = `
      <summary>${lesson.title}</summary>
      <div class="lesson-body">
        ${lesson.body}
        <label class="lesson-check">
          <input type="checkbox" data-lesson="${i}" ${learned[i] ? "checked" : ""}> I understand this
        </label>
      </div>`;
    container.appendChild(details);
  });
  container.querySelectorAll("[data-lesson]").forEach(cb => {
    cb.addEventListener("change", () => {
      const l = JSON.parse(localStorage.getItem("invdash_learned") || "{}");
      l[cb.dataset.lesson] = cb.checked;
      localStorage.setItem("invdash_learned", JSON.stringify(l));
    });
  });
}

/* ============================================================
   AI RESEARCH — "50 years of experience" investor prompts
   Calls an AI provider directly from the browser using a key
   the user supplies themselves (bring-your-own-key). Nothing is
   proxied through any server this app controls.
   ============================================================ */

const PROMPT_TEMPLATES = {
  industry_trends: ({ industry }) =>
    `As an investor with 50 years of experience, provide a comprehensive analysis of the current market trends in the ${industry} industry. Your analysis should include identifying key growth areas, potential risks, and emerging opportunities based on current and forecasted market conditions. You should use your extensive investment experience to provide insights and recommendations for future investment strategies. Your analysis should be presented in a clear and concise report that can be understood by both industry experts and those less familiar with the industry.`,

  industry_opportunities: ({ industry }) =>
    `Leverage your 50 years of experience as an investor to identify potential investment opportunities within the ${industry} industry. Utilize your extensive knowledge and understanding of market trends, financial analysis, and risk management to assess potential opportunities. The task involves conducting comprehensive industry research, evaluating company financials, and assessing potential risks and returns. Prepare a detailed report outlining the most promising opportunities, your rationale for selection, and potential risks and mitigation strategies.`,

  news_impact: ({ news }) =>
    `As an experienced investor with 50 years of expertise, analyze and explain how the following recent news could potentially affect the market: "${news}". Leverage your deep understanding of market trends, historical data, and economic indicators to provide a comprehensive analysis. The explanation should include potential short-term and long-term impacts, the sectors that could be affected, and any possible opportunities or risks for investors. The aim is to provide a clear and insightful analysis that aids in making informed investment decisions.`,

  econ_indicator: ({ indicator, market }) =>
    `As an investor with 50 years of experience, analyze and explain the impact of the following change in an economic indicator on a market. Indicator / recent change: "${indicator}". Market: "${market}". The explanation should include an interpretation of the indicator's recent trends, their implications for different sectors, potential risks and opportunities for investors, and a prediction of future market behavior based on your analysis. Provide strategic advice on how to navigate the market under these conditions.`,

  diversification: ({ industry }) =>
    `As an investor with 50 years of experience, suggest strategies for diversifying an investment portfolio that is currently focused on ${industry}. Research potential investment opportunities in various sectors, analyze their risk and return profiles, and recommend a balanced mix of assets to reduce risk and maximize returns. The proposed strategies should be well-informed, practical, and tailored to the investor's financial goals and risk tolerance.`,

  top_risks: ({ industry }) =>
    `As an investor with 50 years of experience, identify the top 5 risks associated with investing in the ${industry} industry. Thoroughly analyze the current market trends, economic factors, regulatory environment, and potential challenges specific to this industry. Your analysis should result in a comprehensive list of the top 5 risks that an investor would face when investing in this industry. Each risk should be clearly defined and include a detailed explanation of why it is a significant concern.`,

  portfolio_risk: ({ portfolio }) =>
    `As an experienced investor with 50 years of knowledge, assess the risk profile of my investment portfolio, listed below. Analyze each asset and evaluate its associated risks, considering factors such as market volatility, liquidity risk, credit risk, and interest rate risk. Use historical context and reasonable future expectations to assess the potential performance of each asset. Provide a comprehensive report detailing your findings and recommendations for reducing risk and optimizing returns.\n\nMy portfolio:\n${portfolio}`,

  stock_analysis: ({ stock, context }) =>
    `Act as an investor with 50 years of experience. Provide a comprehensive analysis of ${stock}. This should include a thorough evaluation of the company's financial health, its competitive position in the industry, and any macroeconomic factors that could impact its performance. The analysis should also include an assessment of the stock's valuation, taking into account its projected earnings growth and other key financial metrics. Based on your analysis, provide a recommendation on whether to buy, hold, or sell the stock. Your analysis should be backed with supporting data and reasoning.${context ? `\n\nFor context, here is what I currently hold: ${context}` : ""}`
};

const RESEARCH_FIELDS = {
  industry_trends: [{ id: "riIndustry", label: "Industry", placeholder: "e.g. renewable energy" }],
  industry_opportunities: [{ id: "riIndustry", label: "Industry", placeholder: "e.g. semiconductors" }],
  news_impact: [{ id: "riNews", label: "Recent news / event", placeholder: "e.g. the Fed just cut interest rates by 0.5%", textarea: true }],
  econ_indicator: [
    { id: "riIndicator", label: "Economic indicator & recent change", placeholder: "e.g. CPI inflation rose to 4.2%" },
    { id: "riMarket", label: "Market", placeholder: "e.g. US stock market" }
  ],
  diversification: [{ id: "riIndustry", label: "Industry you're currently focused on", placeholder: "e.g. technology" }],
  top_risks: [{ id: "riIndustry", label: "Industry", placeholder: "e.g. commercial real estate" }],
  portfolio_risk: [],
  stock_analysis: [{ id: "riStock", label: "Stock ticker or company", placeholder: "e.g. AAPL" }]
};

function dominantHoldingCategory() {
  const totals = {};
  state.holdings.forEach(h => {
    const cat = h.kind === "stock" ? "stocks" : h.type;
    totals[cat] = (totals[cat] || 0) + (holdingValue(h) || 0);
  });
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : "";
}

function buildPortfolioSummary() {
  if (!state.holdings.length) return "(No holdings added to the dashboard yet.)";
  return state.holdings.map(h => {
    const price = getEffectivePrice(h);
    const value = holdingValue(h);
    const cost = holdingCost(h);
    const gl = value != null && cost != null ? value - cost : null;
    const sig = computeSignal(h);
    const label = h.kind === "stock" ? h.symbol : (h.name || h.type);
    return `- ${label} (${h.kind === "stock" ? "stock" : h.type}): qty ${h.qty}, avg cost ${fmtMoney(h.avgCost)}, ` +
      `current price ${fmtMoney(price)}, value ${fmtMoney(value)}, gain/loss ${fmtMoney(gl)}, dashboard signal: ${sig.text}`;
  }).join("\n");
}

function renderResearchInputs() {
  const type = document.getElementById("researchType").value;
  const container = document.getElementById("researchInputs");
  const fields = RESEARCH_FIELDS[type] || [];
  container.innerHTML = "";

  if (type === "portfolio_risk") {
    container.innerHTML = `<p class="muted small">This will use your ${state.holdings.length} real holding(s) from the Stocks and Metals tabs automatically — no input needed.</p>`;
    return;
  }

  fields.forEach(f => {
    const row = document.createElement("div");
    row.className = "field-row";
    let prefill = "";
    if (f.id === "riIndustry" && type === "diversification") prefill = dominantHoldingCategory();
    row.innerHTML = f.textarea
      ? `<span>${f.label}</span><textarea id="${f.id}" rows="3" placeholder="${f.placeholder}" style="background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px 10px;flex:1;min-width:220px;font-family:inherit;"></textarea>`
      : `<span>${f.label}</span><input type="text" id="${f.id}" placeholder="${f.placeholder}" value="${prefill}">`;
    container.appendChild(row);
  });
}

async function callAnthropic(prompt, key, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
  return (data.content || []).map(c => c.text || "").join("\n");
}

async function callOpenAI(prompt, key, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + key },
    body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
  return data.choices[0].message.content;
}

async function callAI(prompt) {
  const { aiProvider, aiApiKey, aiModel } = state.settings;
  if (!aiApiKey) throw new Error("No API key set. Add one below under \"AI Setup\" first.");
  const model = aiModel || (aiProvider === "anthropic" ? "claude-sonnet-5" : "gpt-4o-mini");
  return aiProvider === "openai" ? callOpenAI(prompt, aiApiKey, model) : callAnthropic(prompt, aiApiKey, model);
}

// Minimal markdown -> HTML converter (headers, bold, italics, lists, paragraphs).
// Deliberately simple — this app has no dependencies, so a full markdown
// library would be overkill for formatting an AI text response.
function mdToHtml(md) {
  const escape = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = escape(md).split("\n");
  let html = "";
  let inList = false;
  for (let line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    const listItem = line.match(/^[-*]\s+(.*)/);
    line = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");

    if (heading) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = heading[1].length + 2; // h3-h5 keeps it visually subordinate to page headers
      html += `<h${level}>${line.replace(/^#{1,3}\s+/, "")}</h${level}>`;
    } else if (listItem) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${line.replace(/^[-*]\s+/, "")}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${line}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

let lastResearchText = "";

async function generateResearch() {
  const type = document.getElementById("researchType").value;
  const statusEl = document.getElementById("researchStatus");
  const outputPanel = document.getElementById("researchOutputPanel");
  const outputEl = document.getElementById("researchOutput");
  const btn = document.getElementById("generateResearchBtn");

  const vals = {};
  (RESEARCH_FIELDS[type] || []).forEach(f => {
    const el = document.getElementById(f.id);
    vals[f.id.replace("ri", "").replace(/^./, c => c.toLowerCase())] = el ? el.value.trim() : "";
  });

  let prompt;
  if (type === "portfolio_risk") {
    prompt = PROMPT_TEMPLATES.portfolio_risk({ portfolio: buildPortfolioSummary() });
  } else if (type === "stock_analysis") {
    const stock = vals.stock;
    if (!stock) { alert("Please enter a stock ticker or company name."); return; }
    const match = state.holdings.find(h => h.kind === "stock" && h.symbol === stock.toUpperCase());
    prompt = PROMPT_TEMPLATES.stock_analysis({ stock, context: match ? buildPortfolioSummary() : "" });
  } else if (type === "econ_indicator") {
    if (!vals.indicator || !vals.market) { alert("Please fill in both fields."); return; }
    prompt = PROMPT_TEMPLATES.econ_indicator(vals);
  } else if (type === "news_impact") {
    if (!vals.news) { alert("Please describe the recent news or event."); return; }
    prompt = PROMPT_TEMPLATES.news_impact(vals);
  } else {
    if (!vals.industry) { alert("Please enter an industry."); return; }
    prompt = PROMPT_TEMPLATES[type](vals);
  }

  btn.disabled = true;
  btn.textContent = "Generating…";
  statusEl.textContent = "Contacting your configured AI provider…";
  outputPanel.classList.add("hidden");

  try {
    const text = await callAI(prompt);
    lastResearchText = text;
    outputEl.innerHTML = mdToHtml(text);
    outputPanel.classList.remove("hidden");
    statusEl.textContent = "Done. Generated " + new Date().toLocaleString() + ".";
  } catch (e) {
    statusEl.textContent = "⚠ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate Analysis";
  }
}

document.getElementById("researchType").addEventListener("change", renderResearchInputs);
document.getElementById("generateResearchBtn").addEventListener("click", generateResearch);
document.getElementById("copyResearchBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(lastResearchText).then(() => showToast("Copied to clipboard."));
});
document.getElementById("saveAiSettingsBtn").addEventListener("click", () => {
  state.settings.aiProvider = document.getElementById("aiProviderSelect").value;
  state.settings.aiModel = document.getElementById("aiModelInput").value.trim();
  state.settings.aiApiKey = document.getElementById("aiApiKeyInput").value.trim();
  saveState();
  showToast("AI settings saved.");
});
document.getElementById("aiProviderSelect").addEventListener("change", e => {
  const defaults = { anthropic: "claude-sonnet-5", openai: "gpt-4o-mini" };
  document.getElementById("aiModelInput").value = defaults[e.target.value] || "";
});

/* ============================================================
   INIT
   ============================================================ */

function init() {
  document.getElementById("refreshIntervalSelect").value = state.settings.refreshInterval;
  document.getElementById("apiKeyInput").value = state.settings.apiKey || "";
  document.getElementById("aiProviderSelect").value = state.settings.aiProvider || "anthropic";
  document.getElementById("aiModelInput").value = state.settings.aiModel || "claude-sonnet-5";
  document.getElementById("aiApiKeyInput").value = state.settings.aiApiKey || "";
  updateNotificationStatus();
  renderLessons();
  renderResearchInputs();
  renderAll();
  setupAutoRefresh();
  refreshAll(); // always fetch fresh data on load, including the S&P 500 benchmark chart
}

init();
