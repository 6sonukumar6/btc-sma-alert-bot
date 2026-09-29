const axios = require("axios");
const config = require("../config/config");

/**
 * Returns a simple { sendAlert(text) } client for the Telegram Bot API.
 * Messages use HTML formatting (<b>bold</b>), which is safe with characters
 * like "_" in pair names (Markdown is not).
 *
 * sendAlert resolves to true ONLY if Telegram confirmed delivery, otherwise false.
 */
function initializeTelegram() {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = config;

  async function sendAlert(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error("❌ Telegram credentials not set — message NOT sent:\n" + text);
      return false;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
      const resp = await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      if (!resp.data.ok) {
        console.error("❌ Telegram send failed:", resp.data);
        return false;
      }
      return true;
    } catch (err) {
      console.error("❌ Telegram send exception:", err.response ? err.response.data : err.message);
      return false;
    }
  }

  return { sendAlert };
}

module.exports = {
  initializeTelegram,
};