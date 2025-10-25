const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const app = express();
const PORT = process.env.PORT || 3000;
// SOURCE_URL: nơi thực tế bạn đang lấy dữ liệu gốc (cấu hình bằng biến môi trường hoặc sửa trực tiếp)
const SOURCE_URL = process.env.SOURCE_URL || 'https://example.com/raw-scrape-json';

// list các thương hiệu vàng cần kiểm tra (đặt tên keys giống dữ liệu nguồn)
const GOLD_KEYS = ['SJC','DOJI','PNJ','BTMC','BTMH','PHUQUY','MIHONG','NGOCTHAM'];

function parseNumberFromServer(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s || s === '-' || s.toLowerCase() === 'nan') return NaN;
  // remove non numeric except dot and minus, replace comma -> dot
  const cleaned = s.replace(/\./g, '') /* remove thousand dots if any */.replace(/,/g, '.').replace(/[^\d\.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// choose best "change" field from a brand object
function getBrandChangeNum(b) {
  if (!b || typeof b !== 'object') return NaN;
  const candidates = [
    b.mieng_buy_change, b.nhan_buy_change,
    b.mieng_change, b.nhan_change,
    b.change, b.delta, b.delta_pct
  ];
  for (const c of candidates) {
    const n = parseNumberFromServer(c);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function sanitizeBrandToDash(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const keysToDash = [
    'mieng_buy','mieng_sell','mieng_buy_change','mieng_change',
    'nhan_buy','nhan_sell','nhan_buy_change','nhan_change',
    'change','value'
  ];
  for (const k of keysToDash) {
    if (k in obj) obj[k] = '-';
  }
  // if none of expected keys exist, replace whole object with '-' (conservative)
  const hasAny = keysToDash.some(k => k in obj);
  if (!hasAny) return '-';
  return obj;
}

async function fetchSourceOnce() {
  const res = await fetch(SOURCE_URL, { method: 'GET', headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Source fetch failed ${res.status}`);
  const j = await res.json();
  return j;
}

// validate one scrape result; returns list of brands failing validation
function validateGoldSet(data) {
  const failures = [];
  for (const key of GOLD_KEYS) {
    const bObj = data.gold?.[key];
    const bVal = getBrandChangeNum(bObj);
    // collect others
    const others = [];
    for (const k of GOLD_KEYS) {
      if (k === key) continue;
      const v = getBrandChangeNum(data.gold?.[k]);
      if (Number.isFinite(v)) others.push(v);
    }
    // if not enough others, skip validation for this brand
    if (!Number.isFinite(bVal) || others.length < 4) continue;
    const avg = others.reduce((s,x)=>s+x,0) / others.length;
    const denom = (Math.abs(avg) > 1e-9) ? Math.abs(avg) : (Math.abs(bVal) > 1e-9 ? Math.abs(bVal) : 1);
    const rel = Math.abs(bVal - avg) / denom;
    if (!Number.isFinite(rel) || rel > 0.5) failures.push(key);
  }
  return failures;
}

// validated scrape with retries; if brand still failing after retries, sanitize it
async function validatedScrape(maxAttempts = 3) {
  let lastData = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let data;
    try {
      data = await fetchSourceOnce();
    } catch (err) {
      // if source fetch totally fails, propagate on final attempt
      lastData = data || lastData;
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    lastData = data;
    const failures = validateGoldSet(data);
    if (failures.length === 0) {
      // all good
      return data;
    }
    // if still attempts left, retry
    if (attempt < maxAttempts) {
      console.warn(`Validation failed for ${failures.join(',')} on attempt ${attempt}, retrying...`);
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }
    // last attempt and still failures -> sanitize those brands
    console.warn(`Validation still failed after ${maxAttempts} attempts for: ${failures.join(',')}. Sanitizing.`);
    for (const bad of failures) {
      if (lastData && lastData.gold && lastData.gold[bad]) {
        lastData.gold[bad] = sanitizeBrandToDash(lastData.gold[bad]);
      } else if (lastData && lastData.gold) {
        lastData.gold[bad] = '-';
      }
    }
    return lastData;
  }
  return lastData;
}

app.get('/scrape', async (req, res) => {
  try {
    const out = await validatedScrape(3); // initial + 2 retries
    res.json(out);
  } catch (err) {
    console.error('Proxy /scrape error:', err && err.message);
    res.status(500).json({ error: err.message || 'scrape failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT} -> source ${SOURCE_URL}`);
});