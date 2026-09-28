require("dotenv").config();

module.exports = {
  // CoinDCX pair format — 'B-BTC_USDT' is BTC/USDT (perpetual futures pair).
  PAIR: process.env.PAIR || "B-BTC_USDT",

  // "futures" = CoinDCX perpetual futures candles (default, matches the futures chart)
  // "spot"    = CoinDCX spot candles
  SOURCE: (process.env.SOURCE || "futures").toLowerCase(),

  // Supported intervals: 1m, 5m, 15m, 1h, 1d
  INTERVAL: process.env.INTERVAL || "15m",

  FAST_LEN: parseInt(process.env.FAST_LEN || "50", 10),
  SLOW_LEN: parseInt(process.env.SLOW_LEN || "200", 10),

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
};