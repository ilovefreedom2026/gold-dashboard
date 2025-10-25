// server.js - updated: use metals.live + fx + try giavang.org fallback to vendor prices
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

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));
app.get('/index.html', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

// safe process handlers
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err && (err.stack||err.message)||err));
process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION', reason && (reason.stack||reason.message)||reason));
process.on('SIGINT', ()=>{ console.log('SIGINT - exiting'); process.exit(0); });
process.on('SIGTERM', ()=>{ console.log('SIGTERM - exiting'); process.exit(0); });

// in-memory cache
let cachedData = { gold: { update_time: '-' }, silver: { update_time: '-' }, exchange: { update_time: '-' }, coccoc: { update_time: '-' } };

// helper utils
function normalizeText(s){ return s ? String(s).replace(/[\u00A0\u200B\uFEFF\u200C\u00AD\u202F\u2060]/g,' ').replace(/\s+/g,' ').trim() : ''; }
function cleanDigitsOnly(s){ return s ? String(s).replace(/[^\d]/g,'') : ''; }
function extractNumericTokens(text){
  if(!text) return [];
  const matches = text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d{4,})/g) || [];
  return matches.map(m => cleanDigitsOnly(m)).filter(t => t && t.length >= 4);
}
function toMillions(v){ // v: number (VND) -> triệu (float)
  if (v == null || Number.isNaN(Number(v))) return null;
  return Number(v) / 1_000_000;
}

// --- external APIs ---
const METALS_API = 'https://api.metals.live/v1/spot'; // public, gives USD/oz prices
const EXCHANGE_API = 'https://open.er-api.com/v6/latest/USD'; // gives USD->VND

// Try to fetch vendor table from giavang.org (best-effort). If fails, we'll fallback to world-based estimate.
async function tryFetchGiavang() {
  try {
    const url = 'https://giavang.org/trong-nuoc/';
    const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const $ = cheerio.load(r.data);
    const bodyText = normalizeText($('body').text());

    // We'll search tables/rows mentioning each brand and extract large numeric tokens (>=4 digits)
    const brandKeys = ['SJC','PNJ','DOJI','BTMC','BTMH','PHUQUY','MIHONG','NGOCTHAM'];
    const results = {};
    $('table, tr').each((i, el) => {
      const txt = normalizeText($(el).text());
      for (const bk of brandKeys) {
        if (new RegExp('\\b' + bk + '\\b','i').test(txt) || new RegExp(bk.replace(/[^a-zA-Z]/g,''),'i').test(txt)) {
          // extract big numeric tokens from this row
          const toks = extractNumericTokens(txt);
          if (toks && toks.length >= 2) {
            // heuristics: first token -> mua, second -> ban (may be per 'miếng' or per 'nhẫn')
            // store only if we don't already have values for this brand
            if (!results[bk]) results[bk] = { mieng_buy: '-', mieng_sell: '-', nhan_buy: '-', nhan_sell: '-' };
            // try to fill mieng and nhan where possible (best-effort)
            const first = toks[0], second = toks[1];
            if (results[bk].mieng_buy === '-') results[bk].mieng_buy = first.length>3 ? (first.length>3 ? (first.slice(0, first.length-3) + '.' + first.slice(first.length-3)) : first) : '-';
            if (results[bk].mieng_sell === '-') results[bk].mieng_sell = second.length>3 ? (second.slice(0, second.length-3) + '.' + second.slice(second.length-3)) : second;
          }
        }
      }
    });

    // convert any numeric-like strings to numbers where possible
    for (const k of Object.keys(results)) {
      for (const f of ['mieng_buy','mieng_sell','nhan_buy','nhan_sell']) {
        const v = results[k][f];
        if (v && v !== '-' && !isNaN(Number(v.replace(/\./g,'')))) {
          results[k][f] = Number(v.replace(/\./g,'')) / 1000000; // convert VND to million VND if the scraped token is full VND (heuristic)
        } else {
          results[k][f] = '-';
        }
      }
    }

    return { ok: true, results, rawText: bodyText.slice(0,2000) };
  } catch (e) {
    console.warn('tryFetchGiavang failed:', e && (e.message || e));
    return { ok: false, error: e && (e.message||e) };
  }
}

// Main orchestrator: get world gold + fx, try giavang, build vendor list with fallback to estimate
async function scrapeAllOnce() {
  try {
    // get world metals and fx in parallel
    const [metalsRes, fxRes] = await Promise.allSettled([
      axios.get(METALS_API, { timeout: 15000 }),
      axios.get(EXCHANGE_API, { timeout: 15000 })
    ]);

    let worldXau = null, worldXag = null, usdVnd = null;
    if (metalsRes.status === 'fulfilled' && Array.isArray(metalsRes.value.data)) {
      // find first object containing gold or xau
      for (const item of metalsRes.value.data) {
        if (item && typeof item === 'object') {
          if ('xau' in item) worldXau = Number(item.xau);
          if ('gold' in item) worldXau = Number(item.gold);
          if ('silver' in item) worldXag = Number(item.silver);
          if (worldXau && worldXag) break;
        }
      }
      // fallback: some responses use 'xau': price
      if (!worldXau && metalsRes.value.data[0] && (metalsRes.value.data[0].xau || metalsRes.value.data[0].gold)) {
        worldXau = Number(metalsRes.value.data[0].xau || metalsRes.value.data[0].gold);
      }
    }

    if (fxRes.status === 'fulfilled' && fxRes.value.data && fxRes.value.data.rates && fxRes.value.data.rates.VND) {
      usdVnd = Number(fxRes.value.data.rates.VND);
    }

    // compute conversion: 1 oz -> lượng: 1 oz ≈ 0.82945 lượng
    let goldVndPerLuong = null;
    let goldVndPerLuong_mil = null;
    if (worldXau && usdVnd) {
      const vndPerOunce = worldXau * usdVnd;
      const vndPerLuong = vndPerOunce / 0.82945;
      goldVndPerLuong = Math.round(vndPerLuong); // VND
      goldVndPerLuong_mil = Number((vndPerLuong / 1_000_000).toFixed(3)); // triệu
    }

    // try to get vendor prices from giavang
    const giavang = await tryFetchGiavang();

    // vendor list keys we show in UI
    const vendorKeys = ['SJC','PNJ','DOJI','BTMC','BTMH','PHUQUY','MIHONG','NGOCTHAM'];
    const vendors = {};
    for (const k of vendorKeys) {
      if (giavang.ok && giavang.results && giavang.results[k]) {
        // use scraped vendor values if present (mieng_sell numeric) else fallback to estimate
        const r = giavang.results[k];
        vendors[k] = {
          mieng_buy: (r.mieng_buy && r.mieng_buy !== '-') ? r.mieng_buy : '-',
          mieng_sell: (r.mieng_sell && r.mieng_sell !== '-') ? r.mieng_sell : '-',
          nhan_buy: (r.nhan_buy && r.nhan_buy !== '-') ? r.nhan_buy : '-',
          nhan_sell: (r.nhan_sell && r.nhan_sell !== '-') ? r.nhan_sell : '-',
          estimate_from_world_mil: goldVndPerLuong_mil // may be null
        };
      } else {
        vendors[k] = {
          mieng_buy: '-',
          mieng_sell: '-',
          nhan_buy: '-',
          nhan_sell: '-',
          estimate_from_world_mil: goldVndPerLuong_mil
        };
      }
    }

    // silver minimal (we'll use world silver if available)
    const phuquy = {
      mieng_buy: '-',
      mieng_sell: '-',
      thoi_buy: '-',
      thoi_sell: '-',
      estimate_from_world_mil: null
    };
    if (worldXag && usdVnd) {
      // world silver is USD/oz -> convert to VND/kg roughly (note: 1 oz = 31.1035 g => 1 kg = 32.1507 oz)
      const vndPerOunceAg = worldXag * usdVnd;
      const vndPerKg = vndPerOunceAg * 32.1507;
      phuquy.thoi_buy = '-';
      phuquy.thoi_sell = '-';
      phuquy.estimate_from_world_mil = Number((vndPerKg / 1_000_000).toFixed(3));
    }

    // build response
    const nowLocal = new Date().toLocaleString('vi-VN');
    cachedData = {
      gold: {
        update_time: nowLocal,
        world: {
          xau_usd_per_oz: worldXau || '-',
          xag_usd_per_oz: worldXag || '-',
          usd_vnd: usdVnd || '-',
          gold_vnd_per_luong: goldVndPerLuong || '-',
          gold_vnd_per_luong_mil: goldVndPerLuong_mil || '-'
        },
        vendors
      },
      silver: { update_time: nowLocal, phuquy },
      exchange: { update_time: nowLocal, vcb: { mua_cash: '-', mua_transfer: '-', ban_ra: (usdVnd ? Math.round(usdVnd) : '-') } },
      coccoc: { update_time: nowLocal, xau: worldXau || '-' }
    };

    console.log('Cached update:', { gold: cachedData.gold.update_time, world_xau: worldXau, usd_vnd: usdVnd });
    return cachedData;
  } catch (err) {
    console.error('scrapeAllOnce error', err && (err.stack||err.message)||err);
    // keep previous cachedData but update times
    cachedData.gold.update_time = new Date().toLocaleString('vi-VN');
    return cachedData;
  }
}

// initial + cron (every 1 minute)
(async () => {
  console.log('Server starting...');
  await scrapeAllOnce();
  cron.schedule('*/1 * * * *', async () => {
    console.log('Running scheduled scrape at', new Date().toLocaleString('vi-VN'));
    await scrapeAllOnce();
  });
})();

// endpoints
app.get('/health', (req,res) => res.json({ status:'ok', time: new Date().toISOString() }));
app.get('/scrape', (req,res) => res.json(cachedData));

// listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on 0.0.0.0:${PORT}`));
