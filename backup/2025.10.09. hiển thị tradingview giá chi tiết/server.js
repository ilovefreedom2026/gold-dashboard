const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
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
function isValidDigitsToken(t) { return Boolean(t) && t.length >= 4; }
function formatPriceFromDigits(d) {
  if (!d) return '-';
  if (d.length <= 3) return d;
  return d.slice(0, d.length - 3) + '.' + d.slice(d.length - 3);
}
function extractNumericTokens(text) {
  if (!text) return [];
  // match numbers like 138.600, 1,382,600, 138600
  const matches = text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d{4,})/g) || [];
  // normalize per-match and require at least 4 digits to avoid purity/percent tokens
  return matches.map(m => cleanDigitsOnly(m)).filter(t => t && t.length >= 4);
}

// thêm helper: tokens lớn (loại bỏ purity/percent nhỏ)
function parseLargePriceTokens(text, minDigits = 5) {
  const toks = extractNumericTokens(text || '');
  // giữ token có ít nhất minDigits chữ số và giá trị >= 1000
  return toks.filter(t => t && t.length >= minDigits && Number(t) >= 1000);
}

// --- optional Puppeteer render helper ---
async function renderPageWithPuppeteer(url, waitMs = 1500, timeout = 30000) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (e) { throw new Error('puppeteer not installed. Run: npm install puppeteer'); }
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'], headless: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image','stylesheet','font','media'].includes(rt)) req.abort(); else req.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (waitMs) await page.waitForTimeout(waitMs);
    const content = await page.content();
    await page.close();
    return content;
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

// fetch HTML with axios, fallback to render if enabled and axios fails
async function fetchHtmlWithOptionalRender(url, renderWait=1800) {
  try {
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.data;
  } catch (err) {
    if (process.env.ENABLE_RENDER === '1') {
      try {
        return await renderPageWithPuppeteer(url, Number(process.env.RENDER_WAIT || renderWait));
      } catch (e) {
        throw err;
      }
    }
    throw err;
  }
}

// --- scrapeGold: robust extraction, do not concat tokens ---
const brandNames = {
  'SJC':'SJC','PNJ':'PNJ','DOJI':'DOJI','BTMC':'BTMC','BTMH':'BTMH','PHUQUY':'PHUQUY','MIHONG':'MIHONG','NGOCTHAM':'NGOCTHAM'
};
const brandMatchers = {
  SJC:/SJC/i, PNJ:/PNJ/i, DOJI:/DOJI/i, BTMC:/Minh\s*Châu|Bảo\s*Tín\s*Minh\s*Châu/i, BTMH:/Mạnh\s*Hải/i, PHUQUY:/Phú\s*Quý|Phu\s*Quy/i, MIHONG:/Mi\s*Hồng/i, NGOCTHAM:/Ngọc\s*Thẩm|Ngoc\s*Tham/i
};

async function scrapeGold() {
  try {
    const brandPages = {
      SJC: 'https://giavang.org/trong-nuoc/sjc/',
      PNJ: 'https://giavang.org/trong-nuoc/pnj/',
      DOJI: 'https://giavang.org/trong-nuoc/doji/',
      BTMC: 'https://giavang.org/trong-nuoc/bao-tin-minh-chau/',
      BTMH: 'https://giavang.org/trong-nuoc/bao-tin-manh-hai/',
      PHUQUY: 'https://giavang.org/trong-nuoc/phu-quy/',
      MIHONG: 'https://giavang.org/trong-nuoc/mi-hong/',
      NGOCTHAM: 'https://giavang.org/trong-nuoc/ngoc-tham/'
    };

    const brands = {};
    let globalUpdate = null;

    for (const [key, url] of Object.entries(brandPages)) {
      try {
        const html = await fetchHtmlWithOptionalRender(url, 2000);
        const $ = cheerio.load(html);
        const bodyText = normalizeText($('body').text());

        // try to get update time from page (brand page often has "Cập nhật lúc")
        if (!globalUpdate) {
          const um = bodyText.match(/Cập nhật(?: lúc|:)?\s*([\d:\s\/]{6,})/i);
          if (um) globalUpdate = um[1].trim();
        }

        // prefer structured table/tr on brand page: find row that mentions "Miếng" or "Nhẫn"
        let mieng_buy = '-', mieng_sell = '-', nhan_buy = '-', nhan_sell = '-';

        // search rows containing 'Miếng' or 'Nhẫn' first
        $('table,tr').each((i, el) => {
          const txt = normalizeText($(el).text()).toLowerCase();
          if (txt.includes('miếng') || txt.includes('miếng vàng') || txt.includes('giá vàng miếng')) {
            const cells = $(el).find('td,th').map((i, cell) => normalizeText($(cell).text())).get();
            // look for numeric tokens in subsequent cells
            for (let ci = 0; ci < cells.length; ci++) {
              if (/miếng/i.test(cells[ci])) {
                const b = extractNumericTokens(cells[ci+1] || '')[0];
                const s = extractNumericTokens(cells[ci+2] || '')[0];
                if (b) mieng_buy = formatPriceFromDigits(b);
                if (s) mieng_sell = formatPriceFromDigits(s);
              }
            }
          }
          if (txt.includes('nhẫn')) {
            const cells = $(el).find('td,th').map((i, cell) => normalizeText($(cell).text())).get();
            for (let ci = 0; ci < cells.length; ci++) {
              if (/nhẫn/i.test(cells[ci])) {
                const b = extractNumericTokens(cells[ci+1] || '')[0];
                const s = extractNumericTokens(cells[ci+2] || '')[0];
                if (b) nhan_buy = formatPriceFromDigits(b);
                if (s) nhan_sell = formatPriceFromDigits(s);
              }
            }
          }
        });

        // fallback: narrow regex near labeled phrases on page
        if ((mieng_buy === '-' || mieng_sell === '-') && /giá vàng miếng/i.test(bodyText)) {
          const m = bodyText.match(/Giá vàng\s*Miếng[\s\S]{0,160}?(\d{1,3}[.,]\d{3})[\s\S]{0,80}?(\d{1,3}[.,]\d{3})/i);
          if (m) {
            mieng_buy = formatPriceFromDigits(cleanDigitsOnly(m[1]));
            mieng_sell = formatPriceFromDigits(cleanDigitsOnly(m[2]));
          }
        }
        if ((nhan_buy === '-' || nhan_sell === '-') && /giá vàng\s*nhẫn/i.test(bodyText)) {
          const m2 = bodyText.match(/Giá vàng\s*Nhẫn[\s\S]{0,160}?(\d{1,3}[.,]\d{3})[\s\S]{0,80}?(\d{1,3}[.,]\d{3})/i);
          if (m2) {
            nhan_buy = formatPriceFromDigits(cleanDigitsOnly(m2[1]));
            nhan_sell = formatPriceFromDigits(cleanDigitsOnly(m2[2]));
          }
        }

        // final fallback: take first two large tokens in page section
        if ((mieng_buy === '-' || mieng_sell === '-') || (nhan_buy === '-' || nhan_sell === '-')) {
          const tokens = extractNumericTokens(bodyText).filter(t => t && t.length >= 4);
          if ((mieng_buy === '-' || mieng_sell === '-') && tokens.length >= 2) {
            mieng_buy = mieng_buy === '-' ? formatPriceFromDigits(tokens[0]) : mieng_buy;
            mieng_sell = mieng_sell === '-' ? formatPriceFromDigits(tokens[1]) : mieng_sell;
          }
          if ((nhan_buy === '-' || nhan_sell === '-') && tokens.length >= 4) {
            nhan_buy = nhan_buy === '-' ? formatPriceFromDigits(tokens[2]) : nhan_buy;
            nhan_sell = nhan_sell === '-' ? formatPriceFromDigits(tokens[3]) : nhan_sell;
          }
        }

        brands[key] = {
          mieng_buy: mieng_buy,
          mieng_sell: mieng_sell,
          nhan_buy: nhan_buy,
          nhan_sell: nhan_sell,
          mieng_buy_change:'-', mieng_sell_change:'-', nhan_buy_change:'-', nhan_sell_change:'-'
        };
      } catch (e) {
        // per-brand fetch failed -> leave '-' values
        brands[key] = { mieng_buy:'-', mieng_sell:'-', nhan_buy:'-', nhan_sell:'-', mieng_buy_change:'-', mieng_sell_change:'-', nhan_buy_change:'-', nhan_sell_change:'-' };
      }
    }

    const update_time = globalUpdate || new Date().toLocaleString('vi-VN');
    return { update_time, ...brands };
  } catch (err) {
    console.error('scrapeGold error', err && (err.stack || err.message) || err);
    return { update_time: '-' };
  }
}

// --- scrapeSilver: targeted extraction of "Bạc Miếng" and "Bạc Thỏi" rows ---
async function scrapeSilver() {
  try {
    const url = 'https://banggia1.phuquygroup.vn/';
    const html = await fetchHtmlWithOptionalRender(url, 2000);
    const $ = cheerio.load(html);

    const phuquy = {
      mieng_buy: null,
      mieng_sell: null,
      thoi_buy: null,
      thoi_sell: null,
      mieng_buy_change: '-', mieng_sell_change: '-', thoi_buy_change: '-', thoi_sell_change: '-',
      thoi_unit: 'Vnđ/Kg'
    };
    let update_time = '-';

    $('tr').each((i, tr) => {
      const prod = normalizeText($(tr).find('.col-product').text());
      const unit = normalizeText($(tr).find('.col-unit-value').text());
      const buyCells = $(tr).find('.col-buy-cell').map((i, el) => normalizeText($(el).text())).get();

      if (!prod) return;

      // Bạc Miếng 999 1 Lượng (Vnđ/Lượng)
      if (/bạc miệng|bạc miếng/i.test(prod) || (/bạc/i.test(prod) && /lượng/i.test(prod) && /999/i.test(prod))) {
        if (buyCells && buyCells.length >= 2) {
          const b = cleanDigitsOnly(buyCells[0]) || '';
          const s = cleanDigitsOnly(buyCells[1]) || '';
          phuquy.mieng_buy = b ? Number(b) : phuquy.mieng_buy;
          phuquy.mieng_sell = s ? Number(s) : phuquy.mieng_sell;
        }
      }

      // Bạc Thỏi 999 1KILO (Vnđ/Kg)
      if (/bạc thỏi/i.test(prod) || (/bạc/i.test(prod) && /kilo|kg/i.test(unit))) {
        if (buyCells && buyCells.length >= 2) {
          const b = cleanDigitsOnly(buyCells[0]) || '';
          const s = cleanDigitsOnly(buyCells[1]) || '';
          phuquy.thoi_buy = b ? Number(b) : phuquy.thoi_buy;
          phuquy.thoi_sell = s ? Number(s) : phuquy.thoi_sell;
          phuquy.thoi_unit = unit || phuquy.thoi_unit;
        }
      }

      // update time if present
      const rowText = normalizeText($(tr).text());
      const um = rowText.match(/cập nhật(?: lúc|:)?\s*([\d:\s\/\-apm]{6,})/i);
      if (um && um[1]) update_time = update_time === '-' ? um[1].trim() : update_time;
    });

    // defaults
    if (phuquy.mieng_buy == null) phuquy.mieng_buy = '-';
    if (phuquy.mieng_sell == null) phuquy.mieng_sell = '-';
    if (phuquy.thoi_buy == null) phuquy.thoi_buy = '-';
    if (phuquy.thoi_sell == null) phuquy.thoi_sell = '-';

    return { update_time: update_time === '-' ? new Date().toLocaleString('vi-VN') : update_time, phuquy };
  } catch (err) {
    console.warn('scrapeSilver error', err && err.message);
    return { update_time: '-', phuquy: { mieng_buy:'-', mieng_sell:'-', thoi_buy:'-', thoi_sell:'-', mieng_buy_change:'-', mieng_sell_change:'-', thoi_buy_change:'-', thoi_sell_change:'-', thoi_unit:'Vnđ/Kg' } };
  }
}

// --- scrapeExchange: reliable API fallback + try VCB render if available ---
async function scrapeExchange() {
  try {
    // try coccoc shared finance search first
    const coccocUrl = 'https://coccoc.com/search?query=ty%20gi%20vietcombank&shared=1&share=finance';
    try {
      const html = await fetchHtmlWithOptionalRender(coccocUrl, 2000);
      const $ = cheerio.load(html);
      const body = normalizeText($('body').text());
      const re = /(?:USD|US DOLLAR)[\s\S]{0,120}?(\d{1,3}[.,]\d{2,3})[\s\S]{0,120}?(\d{1,3}[.,]\d{2,3})[\s\S]{0,120}?(\d{1,3}[.,]\d{2,3})/i;
      const m = body.match(re);
      if (m) {
        const parseRateToken = r => r ? Number(String(r).replace(/\s+/g,'').replace(/,/g,'.').replace(/[^0-9.]/g,'')) : null;
        const a = parseRateToken(m[1]), b = parseRateToken(m[2]) || a, c = parseRateToken(m[3]) || a;
        if (a !== null) return { update_time: new Date().toUTCString(), source: 'coccoc', vcb: { mua_cash: a.toFixed(3), mua_transfer: b.toFixed(3), ban_ra: c.toFixed(3) } };
      }
    } catch(e) {
      // continue to webgia fallback
    }

    // fallback: webgia
    const webgiaUrl = 'https://webgia.com/ty-gia/vietcombank/';
    try {
      const html = await fetchHtmlWithOptionalRender(webgiaUrl, 2000);
      const $ = cheerio.load(html);
      let vcb = { mua_cash: '-', mua_transfer: '-', ban_ra: '-' };
      let found = false;
      $('table').each((ti, tbl) => {
        $(tbl).find('tr').each((ri, tr) => {
          const cells = $(tr).find('td,th').map((i, el) => normalizeText($(el).text())).get();
          if (!cells || !cells.length) return;
          const joined = cells.join(' ').toUpperCase();
          if (joined.includes('USD') || joined.includes('US DOLLAR')) {
            const parseRateToken = (raw) => {
              if (!raw) return null;
              const norm = String(raw).replace(/\s+/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
              const n = parseFloat(norm);
              return Number.isFinite(n) ? n : null;
            };
            const a = parseRateToken(cells[2] || '');
            const b = parseRateToken(cells[3] || '') || a;
            const cval = parseRateToken(cells[4] || '') || a;
            if (a !== null) vcb.mua_cash = a.toFixed(3);
            if (b !== null) vcb.mua_transfer = b.toFixed(3);
            if (cval !== null) vcb.ban_ra = cval.toFixed(3);
            found = true;
            return false;
          }
        });
        if (found) return false;
      });
      if (found) return { update_time: new Date().toUTCString(), source: 'webgia', vcb };
    } catch(e) {
      // final fallback below
    }

    // final fallback: keep previous or empty
    return { update_time: '-', source: 'coccoc/webgia', vcb: { mua_cash:'-', mua_transfer:'-', ban_ra:'-' } };
  } catch (err) {
    console.warn('scrapeExchange error', err && err.message);
    return { update_time: '-', source: 'coccoc/webgia', vcb: { mua_cash:'-', mua_transfer:'-', ban_ra:'-' } };
  }
}

// --- scrapeCoccoc (unchanged lightweight) ---
async function scrapeCoccoc() {
  try {
    const url = 'https://coccoc.com/search?query=gia%20vang&shared=1&share=finance';
    const html = await fetchHtmlWithOptionalRender(url);
    const $ = cheerio.load(html);
    const body = normalizeText($('body').text());
    const regex = /(.{0,40})(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)(.{0,40})/g;
    const candidates = [];
    let m;
    while ((m = regex.exec(body)) !== null && candidates.length < 12) {
      candidates.push({ match: m[2], context: (m[1] + m[3]).trim().replace(/\s+/g, ' ') });
    }
    return { update_time: new Date().toLocaleString('vi-VN'), candidates: candidates.length ? candidates : [{ match: '-', context: '' }] };
  } catch (err) {
    console.error('scrapeCoccoc error', err && (err.stack || err.message) || err);
    return { update_time: '-' };
  }
}

// --- orchestrator ---
async function scrapeAllOnce() {
  try {
    const [gold, silver, exchange, coccoc] = await Promise.all([
      scrapeGold().catch(e=>{ console.error('gold fail', e && e.message); return { update_time: '-' }; }),
      scrapeSilver().catch(e=>{ console.error('silver fail', e && e.message); return { update_time: '-' }; }),
      scrapeExchange().catch(e=>{ console.error('exchange fail', e && e.message); return { update_time: '-' }; }),
      scrapeCoccoc().catch(e=>{ console.error('coccoc fail', e && e.message); return { update_time: '-' }; })
    ]);

    // now decide timestamps: prefer scrape success -> use local scrape time;
    // if a component failed, fallback to snapshot timestamp (if exists), else '-'
    const explicitDate = new Date('2025-10-07T00:00:00');
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate()-1);

    let prevSnap = loadSnapshotByDate(explicitDate);
    if (!prevSnap) prevSnap = loadSnapshotByDate(yesterday);

    const nowLocal = new Date().toLocaleString('vi-VN');

    const comps = { gold, silver, exchange, coccoc };
    for (const key of Object.keys(comps)) {
      const comp = comps[key];
      if (!comp) continue;
      // treat present non '-' update_time as "scraped" success
      const scrapedOk = comp.update_time && comp.update_time !== '-';
      if (scrapedOk) {
        // preserve any source timestamps if present, expose scraped time as canonical update_time
        comp.update_time_scraped = nowLocal;
        comp.update_time = nowLocal;
      } else if (prevSnap && prevSnap[key] && prevSnap[key].update_time) {
        // fallback to snapshot's saved update_time
        comp.update_time = prevSnap[key].update_time;
      } else {
        comp.update_time = '-';
      }
    }

    // compute deltas using prevSnap (may be null)
    cachedData = computeDeltas(comps, prevSnap || null);

    // save today's snapshot (includes update_time fields set above)
    saveSnapshotForToday(comps);

    console.log('Cached update:', { gold: comps.gold.update_time, exchange: comps.exchange.update_time });
  } catch (e) { console.error('scrapeAllOnce error', e && e.message); }
}

// initial + cron
(async () => {
  console.log('Server starting...');
  await scrapeAllOnce();
  cron.schedule('*/1 * * * *', async () => {
    console.log('Running scheduled scrape at', new Date().toLocaleString('vi-VN'));
    await scrapeAllOnce();
  });
})();

// --- endpoints ---
app.get('/health', (req,res) => res.json({ status:'ok', pid: process.pid, time: new Date().toISOString() }));
app.get('/scrape', (req,res) => res.json(cachedData));
app.get('/debug-gold-render', async (req,res) => {
  try {
    const html = await fetchHtmlWithOptionalRender('https://giavang.org/trong-nuoc/');
    const $ = cheerio.load(html);
    res.json({ success:true, rendered: process.env.ENABLE_RENDER==='1', update_time: new Date().toLocaleString('vi-VN'), body: normalizeText($('body').text()).slice(0,20000) });
  } catch (e) { res.json({ success:false, error: String(e && e.message) }); }
});
app.get('/debug-vendor', async (req,res) => {
  try {
    const site = (req.query.site || '').toUpperCase();
    const urlParam = req.query.url;
    const vendorCandidates = {
      PNJ: ['https://www.pnj.com.vn/gia-vang','https://www.pnj.com.vn'],
      DOJI: ['https://www.doji.vn/gia-vang','https://doji.vn'],
      BTMC: ['https://baotinminhchau.com/gia-vang','https://baotinminhchau.com']
    };
    const urls = urlParam ? [urlParam] : (vendorCandidates[site] || []);
    if (!urls.length) return res.json({ success:false, error:'Unknown site key or missing url param. Use ?site=PNJ|DOJI|BTMC or ?url=...' });
    const results = [];
    for (const u of urls) {
      try {
        const html = await fetchHtmlWithOptionalRender(u);
        results.push({ url:u, ok:true, bodyText: normalizeText(cheerio.load(html)('body').text()).slice(0,20000) });
      } catch (e) {
        results.push({ url:u, ok:false, error: String(e && e.message) });
      }
    }
    res.json({ success:true, update_time: new Date().toLocaleString('vi-VN'), results });
  } catch (e) { res.json({ success:false, error: String(e && e.message) }); }
});

// Debug endpoint: show matched rows, cells, tokens (INSERT THIS)
app.get('/debug-parse', async (req, res) => {
  try {
    const url = 'https://giavang.org/trong-nuoc/';
    const html = await fetchHtmlWithOptionalRender(url);
    const $ = cheerio.load(html);
    const rowsInfo = {};

    $('table').each((ti, tbl) => {
      $(tbl).find('tr').each((ri, tr) => {
        const cells = $(tr).find('th,td').map((i, el) => normalizeText($(el).text())).get();
        if (!cells || !cells.length) return;
        for (const key of Object.keys(brandMatchers)) {
          for (let i = 0; i < cells.length; i++) {
            if (brandMatchers[key].test(cells[i])) {
              const tokensPerCell = cells.map(c => extractNumericTokens(c));
              const largeTokensPerCell = tokensPerCell.map(arr => (arr||[]).filter(t => t && t.length >= 4));
              const rowHtml = $(tr).html() || '';
              rowsInfo[key] = rowsInfo[key] || [];
              rowsInfo[key].push({
                rowIndex: ri,
                brandCellIndex: i,
                cells,
                tokensPerCell,
                largeTokensPerCell,
                rowHtml: rowHtml.slice(0, 4000)
              });
              break;
            }
          }
        }
      });
    });

    // also include small windows around "nhẫn" occurrences
    const body = normalizeText($('body').text());
    const nhanWindows = {};
    for (const key of Object.keys(brandMatchers)) {
      const re = new RegExp('.{0,200}(' + brandMatchers[key].source + ')[\\s\\S]{0,200}nhẫn|nhẫn[\\s\\S]{0,200}(' + brandMatchers[key].source + ').{0,200}', 'i');
      const m = body.match(re);
      nhanWindows[key] = m ? m[0].slice(0,400) : null;
    }

    res.json({ success:true, rendered: process.env.ENABLE_RENDER==='1', rowsInfo, nhanWindows });
  } catch (e) {
    res.json({ success:false, error: String(e && e.message) });
  }
});

// start server
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, HOST, () => console.log(`Proxy server running on http://${HOST}:${PORT}`)).on('error', err => { console.error('Server start error', err && (err.stack || err.message) || err); process.exit(1); });

const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function snapshotPathForDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return path.join(SNAPSHOT_DIR, `${y}-${m}-${day}.json`);
}

function saveSnapshotForToday(data) {
  const p = snapshotPathForDate(new Date());
  try { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); } catch(e){ console.warn('snapshot save failed', e && e.message); }
}

function loadSnapshotByDate(date) {
  const p = snapshotPathForDate(date);
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p,'utf8')); } catch(e){ console.warn('snapshot load failed', e && e.message); }
  return null;
}

// --- replace computeDeltas: parse values to "triệu" (millions) robustly and format delta with 3 decimals ---
function computeDeltas(current, previous) {
  if (!previous) return current; // no changes

  // helper: parse value (string or number) -> millions (float)
  const parseToMillions = (v) => {
    if (v === '-' || v == null) return null;
    // if already a number
    if (typeof v === 'number') {
      // treat large numbers as Vnđ and convert to millions
      return v > 1000 ? (v / 1_000_000) : v;
    }
    // string: normalize
    let s = String(v).trim().replace(/\s+/g, '');
    s = s.replace(/,/g, '.'); // unify decimal
    // remove any non-digit/dot
    s = s.replace(/[^0-9.]/g, '');
    if (!s) return null;
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    // if parsed number looks like Vnđ (big integer) convert to millions
    return n > 1000 ? (n / 1_000_000) : n;
  };

  const fmtMillion = (valMillions) => {
    if (valMillions == null) return '-';
    const sign = valMillions > 0 ? '+' : (valMillions < 0 ? '-' : '');
    return (sign + Math.abs(Number(valMillions)).toFixed(3));
  };

  const fmtPct = (pct) => {
    if (pct == null) return '-';
    const sign = pct > 0 ? '+' : (pct < 0 ? '-' : '');
    return sign + Math.abs(Number(pct)).toFixed(2) + '%';
  };

  const brands = current.gold || {};
  const prevBrands = previous.gold || {};

  for (const k of Object.keys(brands)) {
    const bcur = brands[k];
    const bprev = prevBrands[k] || {};

    const getCur = (key) => parseToMillions(bcur[key]);
    const getPrev = (key) => parseToMillions(bprev[key]);

    // mieng buy
    const cur_mb = getCur('mieng_buy');
    const prev_mb = getPrev('mieng_buy');
    if (prev_mb == null) { bcur.mieng_buy_change = '-'; bcur.mieng_buy_change_pct = '-'; }
    else {
      const abs = (cur_mb || 0) - (prev_mb || 0);
      const pct = prev_mb ? (abs / prev_mb) * 100 : null;
      bcur.mieng_buy_change = fmtMillion(abs);
      bcur.mieng_buy_change_pct = pct == null ? '-' : fmtPct(pct);
    }

    // mieng sell
    const cur_ms = getCur('mieng_sell');
    const prev_ms = getPrev('mieng_sell');
    if (prev_ms == null) { bcur.mieng_sell_change = '-'; bcur.mieng_sell_change_pct = '-'; }
    else {
      const abs = (cur_ms || 0) - (prev_ms || 0);
      const pct = prev_ms ? (abs / prev_ms) * 100 : null;
      bcur.mieng_sell_change = fmtMillion(abs);
      bcur.mieng_sell_change_pct = pct == null ? '-' : fmtPct(pct);
    }

    // nhan buy
    const cur_nb = getCur('nhan_buy');
    const prev_nb = getPrev('nhan_buy');
    if (prev_nb == null) { bcur.nhan_buy_change = '-'; bcur.nhan_buy_change_pct = '-'; }
    else {
      const abs = (cur_nb || 0) - (prev_nb || 0);
      const pct = prev_nb ? (abs / prev_nb) * 100 : null;
      bcur.nhan_buy_change = fmtMillion(abs);
      bcur.nhan_buy_change_pct = pct == null ? '-' : fmtPct(pct);
    }

    // nhan sell
    const cur_ns = getCur('nhan_sell');
    const prev_ns = getPrev('nhan_sell');
    if (prev_ns == null) { bcur.nhan_sell_change = '-'; bcur.nhan_sell_change_pct = '-'; }
    else {
      const abs = (cur_ns || 0) - (prev_ns || 0);
      const pct = prev_ns ? (abs / prev_ns) * 100 : null;
      bcur.nhan_sell_change = fmtMillion(abs);
      bcur.nhan_sell_change_pct = pct == null ? '-' : fmtPct(pct);
    }
  }

  // silver (phuquy) - compare and set deltas in millions
  try {
    const curPh = current.silver && current.silver.phuquy;
    const prevPh = previous.silver && previous.silver.phuquy;
    if (curPh && prevPh) {
      const p2m = (v) => {
        if (v === '-' || v == null) return null;
        if (typeof v === 'number') return v > 1000 ? (v / 1_000_000) : v;
        let s = String(v).replace(/\s+/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
        const n = parseFloat(s);
        return isNaN(n) ? null : (n > 1000 ? n/1_000_000 : n);
      };
      const cmpSet = (curKey, prevKey, outAbsKey, outPctKey) => {
        const curV = p2m(curPh[curKey]);
        const prevV = p2m(prevPh[prevKey]);
        if (prevV == null) { curPh[outAbsKey] = '-'; curPh[outPctKey] = '-'; return; }
        const abs = (curV || 0) - (prevV || 0);
        const pct = prevV ? (abs / prevV) * 100 : null;
        curPh[outAbsKey] = fmtMillion(abs);
        curPh[outPctKey] = pct == null ? '-' : fmtPct(pct);
      };
      cmpSet('mieng_buy','mieng_buy','mieng_buy_change','mieng_buy_change_pct');
      cmpSet('mieng_sell','mieng_sell','mieng_sell_change','mieng_sell_change_pct');
      cmpSet('thoi_buy','thoi_buy','thoi_buy_change','thoi_buy_change_pct');
      cmpSet('thoi_sell','thoi_sell','thoi_sell_change','thoi_sell_change_pct');
    }
  } catch(e) { /* non-fatal */ }

  return current;
}