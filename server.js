const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// --- process handlers ---
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err && (err.stack || err.message) || err));
process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION', reason && (reason.stack || reason) || reason));
process.on('SIGINT', () => { console.log('SIGINT - exiting'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM - exiting'); process.exit(0); });

// --- in-memory cache ---
let cachedData = { gold: { update_time: '-' }, silver: { update_time: '-' }, exchange: { update_time: '-' }, coccoc: { update_time: '-' } };

// --- helpers ---
function normalizeText(s) {
  if (!s) return '';
  return String(s).replace(/[\u00A0\u200B\uFEFF\u200C\u00AD\u202F\u2060]/g, ' ').replace(/\s+/g, ' ').trim();
}
function cleanDigitsOnly(s) { return s ? String(s).replace(/[^\d]/g, '') : ''; }
function formatPriceFromDigits(d) {
  if (!d) return '-';
  if (d.length <= 3) return d;
  return d.slice(0, d.length - 3) + '.' + d.slice(d.length - 3);
}

// --- Metals API integration for gold prices ---
async function scrapeGold() {
  try {
    const API_KEY = process.env.METALS_API_KEY || 'your-metals-api-key-here'; // Thay bằng API key thực
    const url = `https://metals-api.com/api/latest?access_key=${API_KEY}&base=USD&symbols=XAU,XAG,VND`;
    
    console.log('Fetching gold prices from Metals API...');
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;

    if (!data.success || !data.rates) {
      throw new Error('Metals API error: ' + (data.error?.info || 'Invalid response'));
    }

    // Giả lập giá vàng VNĐ/lượng từ giá thế giới (XAU/VND)
    const xauToVnd = data.rates.VND / data.rates.XAU; // Giá 1 oz vàng trong VNĐ
    const ozToLuong = 1.2057; // 1 oz = 1.2057 lượng
    const vndPerLuong = xauToVnd / ozToLuong / 1_000_000; // Triệu VNĐ/lượng

    // Giả lập giá mua/bán cho các brand (giả định spread 0.5-1 triệu)
    const brands = {
      SJC: { mieng_buy: (vndPerLuong - 0.5).toFixed(3), mieng_sell: vndPerLuong.toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      PNJ: { mieng_buy: (vndPerLuong - 0.6).toFixed(3), mieng_sell: (vndPerLuong + 0.1).toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      DOJI: { mieng_buy: (vndPerLuong - 0.7).toFixed(3), mieng_sell: (vndPerLuong + 0.2).toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      BTMC: { mieng_buy: (vndPerLuong - 0.8).toFixed(3), mieng_sell: (vndPerLuong + 0.3).toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      BTMH: { mieng_buy: (vndPerLuong - 0.9).toFixed(3), mieng_sell: (vndPerLuong + 0.4).toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      PHUQUY: { mieng_buy: (vndPerLuong - 0.6).toFixed(3), mieng_sell: (vndPerLuong + 0.1).toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      MIHONG: { mieng_buy: (vndPerLuong - 0.7).toFixed(3), mieng_sell: (vndPerLuong + 0.2).toFixed(3), nhan_buy: '-', nhan_sell: '-' },
      NGOCTHAM: { mieng_buy: (vndPerLuong - 0.8).toFixed(3), mieng_sell: (vndPerLuong + 0.3).toFixed(3), nhan_buy: '-', nhan_sell: '-' }
    };

    // Thêm change fields (giả lập, vì API không cung cấp change)
    Object.keys(brands).forEach(key => {
      brands[key].mieng_buy_change = '-';
      brands[key].mieng_sell_change = '-';
      brands[key].nhan_buy_change = '-';
      brands[key].nhan_sell_change = '-';
    });

    cachedData.gold = {
      brands,
      update_time: new Date(data.timestamp * 1000).toLocaleString('vi-VN')
    };
  } catch (e) {
    console.error('Metals API error:', e.message);
    cachedData.gold = {
      brands: {},
      update_time: new Date().toLocaleString('vi-VN')
    };
  }
}

// --- viewer endpoint (giữ nguyên từ code gốc) ---
const VIEWER_WHITELIST = [
  'sjc.com.vn',
  'giavang.pnj.com.vn','pnj.com.vn',
  'giavang.doji.vn','doji.vn',
  'phuquygroup.vn',
  'btmc.vn',
  'baotinmanhhai.vn',
  'mihong.vn',
  'ngoctham.com'
];

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }

app.get('/viewer', async (req, res) => {
  try {
    const url = (req.query.url || '').trim();
    const mode = (req.query.mode || 'proxy').toLowerCase();
    const height = String(req.query.height || '400').replace(/[^\d]/g,'') || '400';
    const width = String(req.query.width || '100%');
    const speed = Number(req.query.speed || 50);
    const selector = req.query.selector || '';
    const pause = Number(req.query.pause || 1000);
    const auto = req.query.auto === '0' ? false : true;

    if (!url) return res.status(400).send('Usage: /viewer?url=...&mode=iframe|proxy&height=400&width=100%&speed=50&selector=table&pause=1000&auto=1');

    let host;
    try { host = (new URL(url)).hostname.replace(/^www\./, ''); } catch (e) { return res.status(400).send('Invalid url'); }
    if (!VIEWER_WHITELIST.some(d => host === d || host.endsWith('.' + d))) return res.status(403).send('Domain not allowed');

    if (mode === 'iframe') {
      return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Viewer (iframe)</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif} .wrap{padding:8px} .frameBox{width:${escapeHtml(width)};height:${escapeHtml(height)}px;border:1px solid #ddd;overflow:auto} iframe{width:100%;height:100%;border:0}</style>
</head><body>
<div class="wrap"><div><strong>Embedded:</strong> ${escapeHtml(url)}</div>
<div class="frameBox"><iframe src="${escapeHtml(url)}" loading="lazy"></iframe></div>
<div style="font-size:12px;color:#666;margin-top:6px">Mode=iframe — cross-origin sites may block embedding. Auto-scroll only available in proxy mode.</div>
</div></body></html>`);
    }

    // Proxy mode requires scraping, which we've removed for gold
    return res.status(400).send('Proxy mode not supported with Metals API');
  } catch (err) {
    return res.status(500).send('Viewer error: ' + String(err && err.message));
  }
});

// --- API endpoints ---
app.get('/gold', (req, res) => res.json(cachedData.gold));
app.get('/silver', (req, res) => res.json(cachedData.silver));
app.get('/exchange', (req, res) => res.json(cachedData.exchange));
app.get('/coccoc', (req, res) => res.json(cachedData.coccoc));

// --- Cron to update gold prices ---
cron.schedule('*/5 * * * *', async () => {
  console.log('Running cron for Metals API at', new Date().toISOString());
  try {
    await scrapeGold();
  } catch (e) {
    console.error('Cron error:', e.message);
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));