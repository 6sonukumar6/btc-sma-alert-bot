const { fetchClosedCandles } = require("../coindcx/candles");
const { sma } = require("../indicators/sma");

/**
 * Entry-quality filters, matching the "Filters 1 to 7" printable guide.
 * Filters 1-6 can be judged AT THE MOMENT OF THE TOUCH ALERT and are
 * automated here:
 *
 *   1. Slope       — the 200 line is sloping in the trade direction
 *                     (rising for a buy, falling for a sell). Flat = fail.
 *   2. Gap         — the space between the 50 and 200 lines is at least
 *                     0.2% of price (e.g. ~170 points at 84,000).
 *   3. Strong close— one 15m candle closes beyond BOTH lines, with a body
 *                     bigger than the last few candles. Not the cross candle.
 *   4. Volume      — the entry candle's volume is above its 20-period
 *                     average.
 *   5. 1H trend    — the 1-hour chart agrees: buy only if 1H price and its
 *                     200 average point up, sell only if both point down.
 *   6. Breakout    — price isn't still stuck sideways in a tight range; it
 *                     must have broken out of one first.
 *
 * Filter 7 (Safe stop — beyond the last swing high/low, or ~1.5x ATR) is
 * NOT automated here. It's where you place your stop after entering, not
 * something to judge at alert time, so it stays manual.
 */

const SLOPE_LOOKBACK = 8; // 15m candles (~2h) used to judge 200-line slope
const MIN_GAP_PCT = 0.002; // 0.2% of price, your starting value
const BODY_LOOKBACK = 10; // candles used for the "average body size" baseline
const VOLUME_LOOKBACK = 20;
const RANGE_LOOKBACK = 16; // 15m candles (~4h) used for the breakout check
const RANGE_BASELINE_LOOKBACK = 48; // ~12h, the "normal" range to compare against

function avg(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Filter 1: 200 line slope only (no gap check here — that's filter 2). */
function slopeFilter(slow, i, direction) {
  const risingOrFalling =
    direction === "up" ? slow[i] > slow[i - SLOPE_LOOKBACK] : slow[i] < slow[i - SLOPE_LOOKBACK];
  return { pass: risingOrFalling, detail: `200 line ${risingOrFalling ? "sloping with trade" : "flat/against"}` };
}

/** Filter 2: gap between the 50 and 200 lines, as a % of price. */
function gapFilter(candles, fast, slow, i) {
  const gapPct = Math.abs(fast[i] - slow[i]) / candles[i].close;
  const pass = gapPct >= MIN_GAP_PCT;
  return { pass, detail: `gap ${(gapPct * 100).toFixed(2)}% of price (need ${(MIN_GAP_PCT * 100).toFixed(1)}%+)` };
}

/** Filter 3: strong close — beyond both lines, on an impulsive (bigger-than-average) candle. */
function strongCloseFilter(candles, fast, slow, i, direction) {
  const c = candles[i];
  const beyond = direction === "up" ? c.close > fast[i] && c.close > slow[i] : c.close < fast[i] && c.close < slow[i];

  const bodies = [];
  for (let j = i - BODY_LOOKBACK; j < i; j++) bodies.push(Math.abs(candles[j].close - candles[j].open));
  const avgBody = avg(bodies);
  const thisBody = Math.abs(c.close - c.open);
  const impulsive = thisBody > avgBody;

  const pass = beyond && impulsive;
  return { pass, detail: `beyond both lines: ${beyond}, body ${thisBody.toFixed(1)} vs avg ${avgBody.toFixed(1)}` };
}

/** Filter 4: entry candle volume above its 20-candle average. */
function volumeFilter(candles, i) {
  const vols = [];
  for (let j = i - VOLUME_LOOKBACK; j < i; j++) vols.push(candles[j].volume);
  const avgVol = avg(vols);
  const pass = candles[i].volume > avgVol;
  return { pass, detail: `volume ${candles[i].volume.toFixed(1)} vs 20-avg ${avgVol.toFixed(1)}` };
}

/** Filter 6: breakout — price isn't still stuck inside a tight recent range. */
function breakoutFilter(candles, i) {
  const recent = candles.slice(i - RANGE_LOOKBACK, i + 1);
  const baseline = candles.slice(i - RANGE_BASELINE_LOOKBACK, i + 1);
  const span = (arr) => Math.max(...arr.map((c) => c.high)) - Math.min(...arr.map((c) => c.low));
  const recentSpan = span(recent);
  const baselineSpan = span(baseline);
  const pass = baselineSpan > 0 && recentSpan / baselineSpan >= 0.35;
  return { pass, detail: `recent range ${recentSpan.toFixed(1)} vs baseline ${baselineSpan.toFixed(1)}` };
}

/** Filter 5: 1H trend agreement (separate API call — only done when a touch actually fires). */
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
    return {
      pass,
      detail: `1H price ${price1h.toFixed(1)} vs 1H 200 avg ${sma200Now.toFixed(1)} (${trendUp ? "up" : trendDown ? "down" : "flat"})`,
    };
  } catch (err) {
    return { pass: null, detail: `1H check failed: ${err.message}` };
  }
}

/**
 * Runs filters 1-6 for a touch at candle index `i`.
 * `direction` is "up" for a golden-cross touch (looking for buys) or
 * "down" for a death-cross touch (looking for sells).
 *
 * Returns { passedCount, total, results: [{ name, pass, detail }] }
 * A filter that couldn't be evaluated (pass: null) doesn't count toward
 * passedCount or total.
 */
async function runEntryFilters(pair, candles, fast, slow, i, direction) {
  const results = [
    { name: "Slope", ...slopeFilter(slow, i, direction) },
    { name: "Gap", ...gapFilter(candles, fast, slow, i) },
    { name: "Strong close", ...strongCloseFilter(candles, fast, slow, i, direction) },
    { name: "Volume", ...volumeFilter(candles, i) },
    { name: "1H trend", ...(await higherTimeframeFilter(pair, direction)) },
    { name: "Breakout", ...breakoutFilter(candles, i) },
  ];

  const scored = results.filter((r) => r.pass !== null);
  const passedCount = scored.filter((r) => r.pass).length;

  return { passedCount, total: scored.length, results };
}

module.exports = {
  runEntryFilters,
};
