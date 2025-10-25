const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
let cached = null;
let cachedAt = 0;
const TTL = 60 * 1000 - 2000; // cache ~58s

async function fetchWorldGold() {
  // try metals.live
  try {
    const r = await fetch('https://api.metals.live/v1/spot');
    if (r.ok) {
      const j = await r.json();
      // j might be array of {symbol, price} or [{ xau: value, xag: value }]
      if (Array.isArray(j)) {
        // try objects with xau property
        for (const it of j) {
          if (it && typeof it === 'object') {
            if ('xau' in it && Number.isFinite(Number(it.xau))) return Number(it.xau);
            if ('XAU' in it && Number.isFinite(Number(it.XAU))) return Number(it.XAU);
            if ('symbol' in it && /(XAU|XAUUSD|GOLD)/i.test(it.symbol) && Number.isFinite(Number(it.price))) return Number(it.price);
            if ('name' in it && /gold/i.test(it.name) && Number.isFinite(Number(it.price))) return Number(it.price);
          }
        }
      }
    }
  } catch (e) { /* ignore */ }

  // fallback: goldprice.org JSON endpoint
  try {
    const r2 = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
    if (r2.ok) {
      const j2 = await r2.json();
      // j2.rates[0].xauPrice ?
      if (j2 && j2.items && Array.isArray(j2.items) && j2.items.length) {
        const it = j2.items[0];
        if (it && (it.xauPrice || it.xauPriceUsd)) return Number(it.xauPrice || it.xauPriceUsd);
      }
      if (j2 && j2.rates && Array.isArray(j2.rates)) {
        const r0 = j2.rates.find(x => x && (x.code === 'XAU' || /XAU/i.test(x.code)));
        if (r0 && r0.rate) return Number(r0.rate);
      }
    }
  } catch (e) { /* ignore */ }

  // last resort: return NaN
  return NaN;
}

async function fetchFxVnd() {
  try {
    const r = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=VND');
    if (r.ok) {
      const j = await r.json();
      if (j && j.rates && j.rates.VND) return Number(j.rates.VND);
    }
  } catch (e) { /* ignore */ }
  return NaN;
}

async function fetchSjcSell() {
  // best-effort scrape giavang.org (may change) — try to find SJC bán ra
  try {
    const r = await fetch('https://giavang.org/');
    if (!r.ok) throw new Error('giavang fetch failed');
    const html = await r.text();
    const $ = cheerio.load(html);
    // look for text containing SJC and a following number
    let found = null;
    $('*').each((i, el) => {
      const txt = $(el).text();
      if (!txt) return;
      if (/SJC/i.test(txt) && /(bán|bán ra|sell)/i.test(txt)) {
        const m = txt.match(/([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]+)?)/);
        if (m) { found = m[1]; return false; }
      }
    });
    if (found) {
      let norm = found.replace(/\./g,'').replace(',', '.');
      const n = Number(norm);
      if (Number.isFinite(n)) {
        // if value looks small (<100000), assume millions -> convert to VND
        return n < 100000 ? Math.round(n * 1000000) : Math.round(n);
      }
    }
  } catch (e) { /* ignore */ }
  return NaN;
}

async function scrapeAll() {
  const now = Date.now();
  if (cached && (now - cachedAt) < TTL) return cached;

  const [world, fx, sjc] = await Promise.all([
    fetchWorldGold(),
    fetchFxVnd(),
    fetchSjcSell()
  ]);

  const payload = {
    ok: true,
    updated_at: new Date().toISOString(),
    world: { xau: Number.isFinite(world) ? world : null, source: 'metals.live/goldprice fallback' },
    exchange: { vcb: { ban_ra: Number.isFinite(fx) ? fx : null }, source: 'exchangerate.host' },
    gold: { SJC: { ban_ra: Number.isFinite(sjc) ? sjc : null }, source: 'giavang.org (scrape best-effort)' }
  };

  cached = payload;
  cachedAt = Date.now();
  return payload;
}

app.get('/scrape', async (req, res) => {
  try {
    const data = await scrapeAll();
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`scrape proxy running on http://localhost:${PORT}`));