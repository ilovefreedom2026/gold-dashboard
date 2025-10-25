const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));

// Serve index.html
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- process handlers ---
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION', reason));
process.on('SIGINT', () => { console.log('SIGINT - exiting'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM - exiting'); process.exit(0); });

// --- in-memory cache ---
let cachedData = { gold: { update_time: '-' }, silver: { update_time: '-' }, exchange: { update_time: '-' }, coccoc: { update_time: '-' } };

// --- helper functions ---
function normalizeText(s) { return s ? String(s).replace(/[\u00A0\u200B\uFEFF\u200C\u00AD\u202F\u2060]/g, ' ').replace(/\s+/g, ' ').trim() : ''; }
function cleanDigitsOnly(s) { return s ? String(s).replace(/[^\d]/g, '') : ''; }
function extractNumericTokens(text) { return (text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d{4,})/g) || []).map(m => cleanDigitsOnly(m)).filter(t => t && t.length >= 4); }
function formatPriceFromDigits(d) { return (!d || d.length <= 3) ? (d || '-') : d.slice(0, d.length - 3) + '.' + d.slice(d.length - 3); }

// --- Puppeteer optional ---
async function renderPageWithPuppeteer(url, waitMs = 1500, timeout = 30000) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => ['image', 'stylesheet', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (waitMs) await page.waitForTimeout(waitMs);
    const content = await page.content();
    await browser.close();
    return content;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// --- Fetch helper ---
async function fetchHtmlWithOptionalRender(url, renderWait = 1800) {
  try {
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.data;
  } catch (err) {
    if (process.env.ENABLE_RENDER === '1') {
      return await renderPageWithPuppeteer(url, Number(process.env.RENDER_WAIT || renderWait));
    }
    throw err;
  }
}

// --- Scrape stubs (tạm thời: trả dữ liệu giả để Render không lỗi) ---
async function scrapeGold() {
  return {
    update_time: new Date().toLocaleString('vi-VN'),
    SJC: { mieng_buy: 98.1, mieng_sell: 98.5, nhan_buy: 97.8, nhan_sell: 98.2 },
    DOJI: { mieng_buy: 97.9, mieng_sell: 98.4, nhan_buy: 97.6, nhan_sell: 98.1 }
  };
}
async function scrapeSilver() {
  return {
    update_time: new Date().toLocaleString('vi-VN'),
    phuquy: { mieng_buy: 31.2, mieng_sell: 32.0, thoi_buy: 30.8, thoi_sell: 31.6 }
  };
}
async function scrapeExchange() {
  return {
    update_time: new Date().toLocaleString('vi-VN'),
    vcb: { mua_cash: 24700, mua_transfer: 24750, ban_ra: 25000 }
  };
}
async function scrapeCoccoc() {
  return {
    update_time: new Date().toLocaleString('vi-VN'),
    xau: 2385.25
  };
}
async function scrapeBTMH() {
  return { update_time: new Date().toLocaleString('vi-VN') };
}

// --- Orchestrator ---
async function scrapeAllOnce() {
  try {
    const [gold, silver, exchange, coccoc] = await Promise.all([
      scrapeGold().catch(() => ({ update_time: '-' })),
      scrapeSilver().catch(() => ({ update_time: '-' })),
      scrapeExchange().catch(() => ({ update_time: '-' })),
      scrapeCoccoc().catch(() => ({ update_time: '-' }))
    ]);
    cachedData = { gold, silver, exchange, coccoc };
    console.log('Cached update:', { gold: gold.update_time, exchange: exchange.update_time });
  } catch (e) {
    console.error('scrapeAllOnce error', e);
  }
}

// Initial run + cron
(async () => {
  console.log('Server starting...');
  await scrapeAllOnce();
  cron.schedule('*/1 * * * *', async () => {
    console.log('Running scheduled scrape at', new Date().toLocaleString('vi-VN'));
    await scrapeAllOnce();
  });
})();

// --- Endpoints ---
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/scrape', (req, res) => res.json(cachedData));

// --- Snapshot utils (giữ nguyên) ---
const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
function snapshotPathForDate(d) { return path.join(SNAPSHOT_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`); }
function saveSnapshotForToday(data) { try { fs.writeFileSync(snapshotPathForDate(new Date()), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.warn('snapshot save failed', e.message); } }
function loadSnapshotByDate(date) { try { if (fs.existsSync(snapshotPathForDate(date))) return JSON.parse(fs.readFileSync(snapshotPathForDate(date), 'utf8')); } catch (e) { } return null; }

// --- ✅ Fixed for Render ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on 0.0.0.0:${PORT}`);
}).on('error', err => {
  console.error('Server start error', err);
  process.exit(1);
});
