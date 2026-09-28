const axios = require("axios");
const config = require("../config/config");

const INTERVAL_MS = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// FUTURES (perpetual) — default source
// Official doc: CoinDCX Futures API -> "Get instrument candlesticks"
//   GET https://public.coindcx.com/market_data/candlesticks
//   params: pair=B-BTC_USDT, from=<epoch SECONDS>, to=<epoch SECONDS>,
//           resolution = '1' | '5' | '60' | '1D', pcode='f'
// 15m is not a documented resolution, so we request 5m candles and build
// 15m candles from them (3 x 5m per 15m bucket).
// ---------------------------------------------------------------------------
const FUTURES_URL = "https://public.coindcx.com/market_data/candlesticks";
const BASE_RES = { "1m": "1", "5m": "5", "15m": "5", "1h": "60", "1d": "1D" };
const BASE_MS = { "1m": 60000, "5m": 300000, "15m": 300000, "1h": 3600000, "1d": 86400000 };
const CHUNK_CANDLES = 300; // keep each request modest in size

function toMs(t) {
  const n = Number(t);
  return n < 1e11 ? n * 1000 : n; // accept seconds or milliseconds
}

function parseFuturesBody(body) {
  const arr = Array.isArray(body) ? body : body && (body.data || body.candles);
  if (!Array.isArray(arr)) {
    throw new Error("Unexpected futures candles response: " + JSON.stringify(body).slice(0, 300));
  }
  return arr.map((c) => {
    const k = {
      time: toMs(c.time !== undefined ? c.time : c.t),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume || 0),
    };
    if ([k.time, k.open, k.high, k.low, k.close].some((v) => Number.isNaN(v))) {
      throw new Error("Unexpected futures candle shape: " + JSON.stringify(c).slice(0, 300));
    }
    return k;
  });
}

async function fetchFuturesBase(pair, interval, neededBaseCandles) {
  const baseMs = BASE_MS[interval];
  const resolution = BASE_RES[interval];
  const nowSec = Math.floor(Date.now() / 1000);
  const totalSpanSec = Math.ceil((neededBaseCandles * baseMs) / 1000);
  const startSec = nowSec - totalSpanSec;
  const chunkSec = Math.floor((CHUNK_CANDLES * baseMs) / 1000);

  const byTime = new Map();
  for (let from = startSec; from < nowSec; from += chunkSec) {
    const to = Math.min(from + chunkSec, nowSec);
    const resp = await axios.get(FUTURES_URL, {
      params: { pair, from, to, resolution, pcode: "f" },
      timeout: 15000,
    });
    for (const c of parseFuturesBody(resp.data)) byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function aggregate(baseCandles, targetMs) {
  const buckets = new Map();
  for (const c of baseCandles) {
    const start = Math.floor(c.time / targetMs) * targetMs;
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close; // base candles are sorted ascending
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fetchFuturesCandles(pair, interval, limit) {
  const targetMs = INTERVAL_MS[interval];
  const baseMs = BASE_MS[interval];
  const factor = Math.round(targetMs / baseMs);
  const base = await fetchFuturesBase(pair, interval, (limit + 5) * factor);
  return factor > 1 ? aggregate(base, targetMs) : base;
}

// ---------------------------------------------------------------------------
// SPOT — optional (SOURCE=spot). CoinDCX spot candles, sorted descending.
// ---------------------------------------------------------------------------
async function fetchSpotCandles(pair, interval, limit) {
  const resp = await axios.get("https://api.coindcx.com/market_data/candles", {
    params: { pair, interval, limit: limit + 5 },
    timeout: 15000,
  });
  return resp.data.map((c) => ({
    time: Number(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

/**
 * Returns the most recent `limit` FULLY CLOSED candles, oldest -> newest.
 */
async function fetchClosedCandles(pair, interval, limit) {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) {
    throw new Error(`Unsupported interval "${interval}". Valid: ${Object.keys(INTERVAL_MS).join(", ")}`);
  }

  const raw =
    config.SOURCE === "spot"
      ? await fetchSpotCandles(pair, interval, limit)
      : await fetchFuturesCandles(pair, interval, limit);

  const now = Date.now();
  const closed = raw
    .sort((a, b) => a.time - b.time)
    .filter((c) => c.time + intervalMs <= now); // drop the still-forming candle

  return closed.slice(-limit).map((c) => ({
    openTime: c.time,
    closeTime: c.time + intervalMs,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

module.exports = {
  fetchClosedCandles,
  INTERVAL_MS,
};