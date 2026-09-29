require("dotenv").config();

const config = require("./config/config");
const { scanMarket } = require("./scanner/crossoverScanner");
const { saveState } = require("./storage/alertStore");
const { initializeTelegram } = require("./telegram/telegramBot");

// ============================================
// SCAN BTC ONLY AND ALERT IF NEEDED
// ============================================
async function run() {
  console.log("\n================================");
  console.log("🔎 Scanning CoinDCX (BTC)...");
  console.log("================================");

  try {
    const { alertMessages, newState, mode, debug } = await scanMarket(config.PAIR, config.INTERVAL);

    if (debug.warning) {
      console.log("⚠️ " + debug.warning);
      return;
    }

    console.log(
      `Checked ${debug.pair} ${config.INTERVAL} | ` +
        `price=${debug.price} fast(${config.FAST_LEN})=${debug.sma50} slow(${config.SLOW_LEN})=${debug.sma200} ` +
        `candleClose(IST)=${debug.candleCloseIST} | new candles processed=${debug.candlesProcessed}`
    );
    console.log(`Mode: ${mode}`);
    if (debug.gapWarning) console.log("⚠️ " + debug.gapWarning);

    let allDelivered = true;

    if (alertMessages.length > 0) {
      const telegram = initializeTelegram();
      for (const msg of alertMessages) {
        const ok = await telegram.sendAlert(msg);
        if (ok) {
          console.log("✅ Alert delivered to Telegram:\n" + msg);
        } else {
          allDelivered = false;
          console.error("❌ Alert NOT delivered — will retry on the next run.");
          break;
        }
      }
    } else {
      console.log("No alert this run.");
    }

    if (allDelivered) {
      saveState(newState);
    } else {
      // State is deliberately not saved, so the same candles are re-checked and
      // the alert is retried next run. Fail the run so it shows red in Actions.
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("❌ Error scanning market:", err.message);
    process.exitCode = 1;
  }
}

run();