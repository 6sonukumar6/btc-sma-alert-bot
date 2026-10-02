const { fetchClosedCandles } = require("../coindcx/candles");
const { sma } = require("../indicators/sma");

/**
 * Entry-quality filters, from the golden-crossover strategy review of past
 * trades. Only the filters that can be judged AT THE MOMENT OF THE TOUCH
 * ALERT are automated here:
 *
 *   1. Slope   — the 200 SMA is sloping in the trade direction, with a
 *                visible gap (>= ~0.2% of price) between the 50 and 200.
 *   2. Location— price closed beyond BOTH averages on an impulsive candle
 *                (a body bigger than the recent average body).
 *   3. Volume  — the touch candle's volume is above its 20-candle average.
 *   4. Higher timeframe — the 1H trend agrees (1H price vs. its own,
 *                rising/falling 200 SMA).
 *   5. Range   — price isn't still stuck inside a tight recent range.
 *
 * Two filters from the original review are NOT included here, because they
 * apply AFTER entry rather than at alert time, and stay manual:
 *   6. Stop placement (swing-based / ~1.5x ATR)
 *   7. Trade management (partial at 1R, breakeven, trailing)
 */

const SLOPE_LOOKBACK = 8; // 15m candles (~2h) used to judge 200 SMA slope
const MIN_GAP_PCT = 0.002; // 0.2% of price, starting value from the review
const BODY_LOOKBACK = 10; // candles used for the "average body size" baseline
const VOLUME_LOOKBACK = 20;
const RANGE_LOOKBACK = 16; // 15m candles (~4h) used for the range-expansion check
const RANGE_BASELINE_LOOKBACK = 48; // ~12h, the "normal" range to compare against

function avg(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Filter 1: 200 SMA slope + minimum gap between the two SMAs. */
function slopeFilter(slow, fast, i, direction) {
  const slopeOk =
    direction === "up" ? slow[i] > slow[i - SLOPE_LOOKBACK] : slow[i] < slow[i - SLOPE_LOOKBACK];
  const gapPct = Math.abs(fast[i] - slow[i]) / slow[i];
  const pass = slopeOk && gapPct >= MIN_GAP_PCT;
  return { pass, detail: `200 SMA slope ${slopeOk ? "ok" : "flat/against"}, gap ${(gapPct * 100).toFixed(2)}%` };
}

/** Filter 2: price beyond both SMAs on an impulsive (larger than average) candle. */
function locationFilter(candles, fast, slow, i, direction) {
  const c = candles[i];
  const beyond = direction === "up" ? c.close > fast[i] && c.close > slow[i] : c.close < fast[i] && c.close < slow[i];

  const bodies = [];
  for (let j = i - BODY_LOOKBACK; j < i; j++) bodies.push(Math.abs(candles[j].close - candles[j].open));
  const avgBody = avg(bodies);
  const thisBody = Math.abs(c.close - c.open);
  const impulsive = thisBody > avgBody;

  const pass = beyond && impulsive;
  return { pass, detail: `beyond both SMAs: ${beyond}, body ${thisBody.toFixed(1)} vs avg ${avgBody.toFixed(1)}` };
}

/** Filter 3: entry candle volume above its 20-candle average. */
function volumeFilter(candles, i) {
  const vols = [];
  for (let j = i - VOLUME_LOOKBACK; j < i; j++) vols.push(candles[j].volume);
  const avgVol = avg(vols);
  const pass = candles[i].volume > avgVol;
  return { pass, detail: `volume ${candles[i].volume.toFixed(1)} vs 20-avg ${avgVol.toFixed(1)}` };
}

/** Filter 5: price isn't still stuck inside a tight recent range (range expansion). */
function rangeFilter(candles, i) {
  const recent = candles.slice(i - RANGE_LOOKBACK, i + 1);
  const baseline = candles.slice(i - RANGE_BASELINE_LOOKBACK, i + 1);
  const span = (arr) => Math.max(...arr.map((c) => c.high)) - Math.min(...arr.map((c) => c.low));
  const recentSpan = span(recent);
  const baselineSpan = span(baseline);
  // "expansion" = the recent range is a healthy fraction of the longer baseline range,
  // i.e. price isn't compressed into a sliver compared to its recent normal range.
  const pass = baselineSpan > 0 && recentSpan / baselineSpan >= 0.35;
  return { pass, detail: `recent range ${recentSpan.toFixed(1)} vs baseline ${baselineSpan.toFixed(1)}` };
}

/** Filter 4: 1H trend agreement (separate API call — only done when a touch actually fires). */
async function higherTimeframeFilter(pair, direction) {
  try {
    const h1 = await fetchClosedCandles(pair, "1h", 205);
    if (h1.length < 202) return { pass: null, detail: "not enough 1H history yet" };
    const closes = h1.map((c) => c.close);
    const n = closes.length;
    const sma200Now = sma(closes, 200, n - 1);
    const sma200Prev = sma(closes, 200, n - 9); // ~8h back
    const price1h = closes[n - 1];

    const trendUp = price1h > sma200Now && sma200Now > sma200Prev;
    const trendDown = price1h < sma200Now && sma200Now < sma200Prev;
    const pass = direction === "up" ? trendUp : trendDown;
    return { pass, detail: `1H price ${price1h.toFixed(1)} vs 1H 200 SMA ${sma200Now.toFixed(1)} (${trendUp ? "up" : trendDown ? "down" : "flat"})` };
  } catch (err) {
    return { pass: null, detail: `1H check failed: ${err.message}` };
  }
}

/**
 * Runs all 5 automated filters for a touch at candle index `i`.
 * `direction` is "up" for a golden-cross touch (looking for longs) or
 * "down" for a death-cross touch (looking for shorts).
 *
 * Returns { passedCount, total, results: [{ name, pass, detail }] }
 * A filter that couldn't be evaluated (pass: null) doesn't count toward
 * passedCount or total.
 */
async function runEntryFilters(pair, candles, fast, slow, i, direction) {
  const results = [
    { name: "Slope", ...slopeFilter(slow, fast, i, direction) },
    { name: "Location", ...locationFilter(candles, fast, slow, i, direction) },
    { name: "Volume", ...volumeFilter(candles, i) },
    { name: "1H Trend", ...(await higherTimeframeFilter(pair, direction)) },
    { name: "Range", ...rangeFilter(candles, i) },
  ];

  const scored = results.filter((r) => r.pass !== null);
  const passedCount = scored.filter((r) => r.pass).length;

  return { passedCount, total: scored.length, results };
}

module.exports = {
  runEntryFilters,
};
