const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, "..", "..", "data");
const STATE_FILE = path.join(STATE_DIR, "state.json");

function defaultState() {
  return {
    // "golden" | "death" | null
    lastCross: null,
    lastCandleTime: null,
    touchedSinceCross: false,
  };
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (e) {
      // fall through to default on any parse error
    }
  }
  return defaultState();
}

function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

module.exports = {
  loadState,
  saveState,
};