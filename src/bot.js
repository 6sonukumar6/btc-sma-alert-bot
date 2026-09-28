require("dotenv").config();

const config = require("./config/config");
const { scanMarket } = require("./scanner/crossoverScanner");
const { initializeTelegram } = require("./telegram/telegramBot");

// ============================================
// SCAN BTC ONLY AND ALERT IF NEEDED
// ============================================
async function run() {
  console.log("\n================================");
  console.log("🔎 Scanning CoinDCX (BTC)...");
  console.log("================================");

  try {
    const { alertMessages, mode, debug } = await scanMarket(config.PAIR, config.INTERVAL);

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
    if (debug.staleDropped) {
      console.log(`ℹ️ Skipped ${debug.staleDropped} stale touch alert(s) for an older crossover (a newer crossover formed since).`);
    }

    if (alertMessages.length > 0) {
      const telegram = initializeTelegram();
      for (const msg of alertMessages) {
        await telegram.sendAlert(msg);
        console.log("✅ Alert sent:\n" + msg);
      }
    } else {
      console.log("No alert this run.");
    }
  } catch (err) {
    console.error("❌ Error scanning market:", err.message);
    process.exitCode = 1;
  }
}

run();