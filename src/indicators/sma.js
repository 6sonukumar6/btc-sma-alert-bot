/**
 * Simple Moving Average of `closes` over the last `length` values,
 * ending at (and including) `endIndexInclusive`.
 */
function sma(closes, length, endIndexInclusive) {
  let sum = 0;
  for (let i = endIndexInclusive - length + 1; i <= endIndexInclusive; i++) {
    sum += closes[i];
  }
  return sum / length;
}

module.exports = {
  sma,
};