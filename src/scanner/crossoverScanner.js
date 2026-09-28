const { fetchClosedCandles, INTERVAL_MS } = require("../coindcx/candles");
const { sma } = require("../indicators/sma");
const { loadState, saveState } = require("../storage/alertStore");
const config = require("../config/config");

// Minimum extra candles fetched beyond the slow SMA length (60 x 15m = 15h).
const MIN_CATCH_UP_CANDLES = 60;
// Upper limit on how far back the bot will catch up (700 x 15m = ~7 days).
const MAX_CATCH_UP_CANDLES = 700;

function formatIST(ms) {
  return (
    new Date(ms).toLocaleString("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

/**
 * Two modes, derived from saved state:
 *
 *  WAIT_TOUCH  (a crossover happened, no touch alert sent yet)
 *      -> each new candle is checked for the FIRST touch of the 50 SMA.
 *         A "touch" is EITHER the candle's high-low range containing the 50 SMA,
 *         OR the price jumping straight through the 50 SMA between two candles
 *         (previous close on one side, this close on the other).
 *
 *  WAIT_CROSS  (touch alert already sent for the latest crossover, or none seen yet)
 *      -> touch checks are PAUSED; only "has a new crossover formed?" is checked.
 *
 * MISSED RUNS: every closed candle since the last successful run is processed in
 * order, and the look-back window automatically grows to cover the whole gap. So
 * a touch that happened while no scheduled run was executing is still detected on
 * the next run and sent as a clearly-labelled LATE alert.
 *
 * Returns: { alertMessages: string[], mode: string, debug: {...} }
 */
async function scanMarket(pair = config.PAIR, interval = config.INTERVAL) {
  const { FAST_LEN, SLOW_LEN } = config;
  const intervalMs = INTERVAL_MS[interval];
  const nowMs = Date.now();

  const state = loadState();

  // How many candles did we miss since the last processed candle?
  const missed =
    state.lastCandleTime == null ? 0 : Math.ceil((nowMs - state.lastCandleTime) / intervalMs);
  const catchUp = Math.min(Math.max(missed + 5, MIN_CATCH_UP_CANDLES), MAX_CATCH_UP_CANDLES);
  const limit = SLOW_LEN + catchUp;

  const candles = await fetchClosedCandles(pair, interval, limit);

  if (candles.length < SLOW_LEN + 2) {
    return {
      alertMessages: [],
      mode: "n/a",
      debug: { warning: `Not enough candles yet (${candles.length}) for a ${SLOW_LEN}-period SMA.` },
    };
  }

  const closes = candles.map((c) => c.close);
  const n = closes.length;

  const fast = new Array(n);
  const slow = new Array(n);
  for (let i = SLOW_LEN - 1; i < n; i++) {
    fast[i] = sma(closes, FAST_LEN, i);
    slow[i] = sma(closes, SLOW_LEN, i);
  }

  const latestIdx = n - 1;
  const latest = candles[latestIdx];

  // Which candles are new since the last run?
  let startIdx;
  if (state.lastCandleTime == null) {
    startIdx = latestIdx; // first ever run: only the newest candle, never history
  } else {
    startIdx = candles.findIndex((c) => c.closeTime > state.lastCandleTime);
    if (startIdx === -1) startIdx = n; // nothing new
  }
  startIdx = Math.max(startIdx, SLOW_LEN);

  const gapWarning =
    state.lastCandleTime != null && missed > MAX_CATCH_UP_CANDLES
      ? `Gap of ~${missed} candles exceeds the ${MAX_CATCH_UP_CANDLES}-candle catch-up limit; older candles could not be re-checked.`
      : null;

  const alertMessages = [];
  let staleDropped = 0; // alerts for superseded (older) crossovers that were discarded

  for (let i = startIdx; i < n; i++) {
    const c = candles[i];

    const wasBelow = fast[i - 1] < slow[i - 1];
    const isAbove = fast[i] > slow[i];
    const wasAbove = fast[i - 1] > slow[i - 1];
    const isBelow = fast[i] < slow[i];

    // 1) Always watch for a NEW crossover (in both modes).
    //    A newer crossover REPLACES the older one: any touch alert that was queued
    //    in this same catch-up run for the OLDER crossover is stale, so drop it.
    if (wasBelow && isAbove) {
      staleDropped += alertMessages.length;
      alertMessages.length = 0;
      state.lastCross = "golden";
      state.touchedSinceCross = false; // -> WAIT_TOUCH
      continue;
    }
    if (wasAbove && isBelow) {
      staleDropped += alertMessages.length;
      alertMessages.length = 0;
      state.lastCross = "death";
      state.touchedSinceCross = false; // -> WAIT_TOUCH
      continue;
    }

    // 2) Touch check runs ONLY in WAIT_TOUCH mode. In WAIT_CROSS mode it is paused.
    if (state.lastCross && !state.touchedSinceCross) {
      const inRange = c.low <= fast[i] && fast[i] <= c.high;

      const sidePrev = Math.sign(candles[i - 1].close - fast[i - 1]);
      const sideNow = Math.sign(c.close - fast[i]);
      const brokeThrough = sidePrev !== 0 && sideNow !== 0 && sidePrev !== sideNow;

      if (inRange || brokeThrough) {
        const direction = state.lastCross === "golden" ? "support" : "resistance";
        const how = inRange ? "touched" : "broke through";
        const isLate = nowMs - c.closeTime > 2 * intervalMs;

        let msg =
          `🎯 *Price ${how} 50 SMA* on ${pair} (${interval})\n` +
          `First retest since the ${state.lastCross === "golden" ? "Golden" : "Death"} Cross — acting as ${direction}\n` +
          `50 SMA: $${fast[i].toLocaleString(undefined, { maximumFractionDigits: 2 })}\n` +
          `Price: $${c.close.toLocaleString()}\n` +
          `Time: ${formatIST(c.closeTime)}`;

        if (isLate) {
          msg +=
            `\n\n⏱ *Late alert* — this happened at the time above but was only detected now ` +
            `(${formatIST(nowMs)}) because a scheduled run was missed.`;
        }

        alertMessages.push(msg);
        state.touchedSinceCross = true; // -> WAIT_CROSS (touch checks paused)
      }
    }
  }

  state.lastCandleTime = latest.closeTime;
  saveState(state);

  const mode =
    state.lastCross && !state.touchedSinceCross
      ? `WAIT_TOUCH (after ${state.lastCross} cross)`
      : "WAIT_CROSS (touch checks paused until next crossover)";

  return {
    alertMessages,
    mode,
    debug: {
      pair,
      interval,
      price: latest.close,
      sma50: fast[latestIdx],
      sma200: slow[latestIdx],
      candleCloseIST: formatIST(latest.closeTime),
      candlesProcessed: Math.max(0, n - startIdx),
      gapWarning,
      staleDropped,
    },
  };
}

module.exports = {
  scanMarket,
};