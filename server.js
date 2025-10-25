// ===============================
//  GOLD DASHBOARD SERVER (API)
// ===============================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// --- App setup ---
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));

// Serve index.html
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- Process Handlers ---
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION', reason));
process.on('SIGINT', () => { console.log('SIGINT - exiting'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM - exiting'); process.exit(0); });

// --- Cache ---
let cachedData = { gold: { update_time: '-' }, exchange: { update_time: '-' } };

// --- API Endpoints ---
const METALS_API = "https://api.metals.live/v1/spot";
const EXCHANGE_API = "https://open.er-api.com/v6/latest/USD";

// --- Scraper (API-based, no puppeteer) ---
async function scrapeGold() {
  try {
    const metals = await axios.get(METALS_API, { timeout: 15000 });
    const rates = await axios.get(EXCHANGE_API, { timeout: 15000 });

    const goldData = metals.data.find(i => i.gold);
    const silverData = metals.data.find(i => i.silver);
    const usdVnd = rates.data.rates.VND;

    // Quy đổi 1 ounce = 0.82945 lượng
    const goldVndPerLuong = (goldData.gold / 0.82945) * usdVnd / 1_000_000;

    return {
      update_time: new Date().toLocaleString('vi-VN'),
      gold_usd_per_oz: goldData.gold,
      silver_usd_per_oz: silverData.silver,
      usd_vnd: usdVnd,
      gold_vnd_per_luong: Number(goldVndPerLuong.toFixed(2))
    };
  } catch (e) {
    console.error("scrapeGold error:", e.message);
    return { update_time: '-', error: e.message };
  }
}

async function scrapeExchange() {
  try {
    const res = await axios.get(EXCHANGE_API);
    return {
      update_time: new Date().toLocaleString('vi-VN'),
      usd_vnd: res.data.rates.VND
    };
  } catch (e) {
    console.error("scrapeExchange error:", e.message);
    return { update_time: '-', error: e.message };
  }
}

// --- Scrape orchestrator ---
async function scrapeAllOnce() {
  try {
    const [gold, exchange] = await Promise.all([
      scrapeGold().catch(() => ({ update_time: '-' })),
      scrapeExchange().catch(() => ({ update_time: '-' }))
    ]);
    cachedData = { gold, exchange };
    console.log('✅ Cached update:', {
      gold: gold?.update_time || '-',
      exchange: exchange?.update_time || '-'
    });
  } catch (e) {
    console.error('scrapeAllOnce error', e);
  }
}

// --- Run immediately & schedule every 5 mins ---
(async () => {
  console.log('Server starting...');
  await scrapeAllOnce();
  cron.schedule('*/5 * * * *', async () => {
    console.log('⏰ Running scheduled scrape at', new Date().toLocaleString('vi-VN'));
    await scrapeAllOnce();
  });
})();

// --- API routes ---
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/scrape', (req, res) => res.json(cachedData));

// --- Snapshot utilities (optional) ---
const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
function snapshotPathForDate(d) {
  return path.join(SNAPSHOT_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`);
}
function saveSnapshotForToday(data) {
  try { fs.writeFileSync(snapshotPathForDate(new Date()), JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.warn('snapshot save failed', e.message); }
}

// --- Listen for Render ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on 0.0.0.0:${PORT}`);
});
