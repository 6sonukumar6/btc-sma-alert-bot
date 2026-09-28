const axios = require("axios");
const config = require("../config/config");

/**
 * Returns a simple { sendAlert(text) } client for sending Telegram
 * messages via the Bot API's sendMessage endpoint. No extra Telegram
 * library needed — this is a single HTTP POST.
 */
function initializeTelegram() {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = config;

  async function sendAlert(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log("⚠️  Telegram credentials not set — message would have been:\n" + text);
      return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
      const resp = await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      });
      if (!resp.data.ok) {
        console.error("Telegram send failed:", resp.data);
      }
    } catch (err) {
      console.error("Telegram send exception:", err.response ? err.response.data : err.message);
    }
  }

  return { sendAlert };
}

module.exports = {
  initializeTelegram,
};