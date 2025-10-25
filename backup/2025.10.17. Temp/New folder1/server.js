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

    // vendor homepages (fallback sources you listed)
    const vendorMain = {
      SJC: ['https://sjc.com.vn/'],
      PNJ: ['https://www.giavang.pnj.com.vn/','https://www.pnj.com.vn/'],
      DOJI: ['https://giavang.doji.vn/trangchu.html','https://doji.vn/'],
      BTMC: ['https://btmc.vn/','https://baotinminhchau.com/gia-vang'],
      BTMH: ['https://www.baotinmanhhai.vn/gia-vang-hom-nay','https://baotinhmanhhai.com/'],
      PHUQUY: ['https://phuquygroup.vn/','https://giabac.phuquygroup.vn/'],
      MIHONG: ['https://www.mihong.vn/vi/gia-vang-trong-nuoc','https://mihong.vn/'],
      NGOCTHAM: ['https://ngoctham.com/bang-gia-vang/','https://ngoctham.com/']
    };

    const brands = {};
    let globalUpdate = null;

    // helper: try vendor homepages and return {mieng_buy,mieng_sell,nhan_buy,nhan_sell}
    async function tryVendorPages(key) {
      const urls = vendorMain[key] || [];
      for (const u of urls) {
        try {
          const html = await fetchHtmlWithOptionalRender(u, 2000);
          const $ = cheerio.load(html);
          const bodyText = normalizeText($('body').text());
          // quick update_time attempt
          const um = bodyText.match(/Cập nhật(?: lúc|:)?\s*([\d:\s\/\-APM]{6,})/i);
          if (um && um[1]) globalUpdate = globalUpdate || um[1].trim();

          let mieng_buy = '-', mieng_sell = '-', nhan_buy = '-', nhan_sell = '-';
          // scan sensible containers
          $('table,section,div,article').each((i, el) => {
            const txt = normalizeText($(el).text());
            const low = txt.toLowerCase();
            if (/\bvàng(?:\s+)?miếng\b/i.test(low) || /vàng miếng/i.test(low)) {
              const toks = extractNumericTokens(txt);
              if (toks && toks.length >= 2) {
                if (mieng_buy === '-') mieng_buy = formatPriceFromDigits(toks[0]);
                if (mieng_sell === '-') mieng_sell = formatPriceFromDigits(toks[1]);
              }
            }
            if (/\bnhẫn\b/i.test(low) || /vàng(?:\s+)?nhẫn\b/i.test(low)) {
              const toks = extractNumericTokens(txt);
              if (toks && toks.length >= 2) {
                if (nhan_buy === '-') nhan_buy = formatPriceFromDigits(toks[0]);
                if (nhan_sell === '-') nhan_sell = formatPriceFromDigits(toks[1]);
              }
            }
          });

          // narrow-body regex fallback on vendor page
          if ((mieng_buy === '-' || mieng_sell === '-') && /giá vàng miếng/i.test(bodyText)) {
            const m = bodyText.match(/Giá vàng\s*Miếng[\s\S]{0,200}?(\d{1,3}[.,]\d{3})[\s\S]{0,120}?(\d{1,3}[.,]\d{3})/i);
            if (m) { mieng_buy = formatPriceFromDigits(cleanDigitsOnly(m[1])); mieng_sell = formatPriceFromDigits(cleanDigitsOnly(m[2])); }
          }
          if ((nhan_buy === '-' || nhan_sell === '-') && /giá vàng\s*nhẫn/i.test(bodyText)) {
            const m2 = bodyText.match(/Giá vàng\s*Nhẫn[\s\S]{0,200}?(\d{1,3}[.,]\d{3})[\s\S]{0,120}?(\d{1,3}[.,]\d{3})/i);
            if (m2) { nhan_buy = formatPriceFromDigits(cleanDigitsOnly(m2[1])); nhan_sell = formatPriceFromDigits(cleanDigitsOnly(m2[2])); }
          }

          // accept only if vendor provides at least one trustworthy pair for the product (miếng or nhẫn)
          const hasMieng = mieng_buy !== '-' && mieng_sell !== '-';
          const hasNhan = nhan_buy !== '-' && nhan_sell !== '-';
          if (hasMieng || hasNhan) {
            return { mieng_buy, mieng_sell, nhan_buy, nhan_sell, source: u };
          }
        } catch (e) {
          // try next vendor url
        }
      }
      return null;
    }

    for (const [key, url] of Object.entries(brandPages)) {
      try {
        // prefer direct vendor scrape for BTMH (accurate unit and fresh)
        if (key === 'BTMH') {
          const btmh = await scrapeBTMH();
          if (btmh) {
            brands[key] = {
              mieng_buy: btmh.mieng_buy,
              mieng_sell: btmh.mieng_sell,
              nhan_buy: btmh.nhan_buy,
              nhan_sell: btmh.nhan_sell,
              mieng_buy_change: '-', mieng_sell_change: '-', nhan_buy_change: '-', nhan_sell_change: '-'
            };
            if (!globalUpdate && btmh.update_time) globalUpdate = btmh.update_time;
            continue;
          }
        }

        // 1) try giavang per-brand page first
        const html = await fetchHtmlWithOptionalRender(url, 2000);
        const $ = cheerio.load(html);
        const bodyText = normalizeText($('body').text());

        // attempt per-page update_time
        if (!globalUpdate) {
          const um = bodyText.match(/Cập nhật(?: lúc|:)?\s*([\d:\s\/]{6,})/i);
          if (um) globalUpdate = um[1].trim();
        }

        let mieng_buy = '-', mieng_sell = '-', nhan_buy = '-', nhan_sell = '-';

        // parse giavang per-brand structured rows first (existing logic)
        $('table,tr').each((i, el) => {
          const txt = normalizeText($(el).text()).toLowerCase();
          if (txt.includes('miếng') || txt.includes('miếng vàng') || txt.includes('giá vàng miếng')) {
            const cells = $(el).find('td,th').map((i, cell) => normalizeText($(cell).text())).get();
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

        // giavang fallbacks (narrow regex / tokens) - keep as before
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

        // decide whether giavang data is trustworthy: require at least a complete pair for the product we want
        const giavangHasMieng = mieng_buy !== '-' && mieng_sell !== '-';
        const giavangHasNhan = nhan_buy !== '-' && nhan_sell !== '-';

        if (!giavangHasMieng && !giavangHasNhan) {
          // giavang had no usable price -> try vendor homepages
          const vendorRes = await tryVendorPages(key);
          if (vendorRes) {
            // accept vendor only if it provided a trustworthy pair
            mieng_buy = vendorRes.mieng_buy || mieng_buy;
            mieng_sell = vendorRes.mieng_sell || mieng_sell;
            nhan_buy = vendorRes.nhan_buy || nhan_buy;
            nhan_sell = vendorRes.nhan_sell || nhan_sell;
          } else {
            // vendor also lacked trustworthy data -> force '-' to avoid unreliable picks
            mieng_buy = mieng_buy !== '-' ? mieng_buy : '-';
            mieng_sell = mieng_sell !== '-' ? mieng_sell : '-';
            nhan_buy = nhan_buy !== '-' ? nhan_buy : '-';
            nhan_sell = nhan_sell !== '-' ? nhan_sell : '-';
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
        // per-brand fetch failed -> leave '-' values (do NOT fall back to noisy heuristics)
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

// --- scrapeSilver: targeted extraction of "Bạc Miếng" và "Bạc Thỏi" rows (hardened matching) ---
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

    // collect candidate rows then pick best match
    const miengCandidates = [];
    const thoiCandidates = [];

    $('tr').each((i, tr) => {
      const prodText = normalizeText($(tr).find('.col-product').text() || $(tr).find('td:first').text()).toUpperCase();
      const unitText = normalizeText($(tr).find('.col-unit-value').text() || $(tr).find('.col-unit, .unit, td:nth-child(2)').text()).toUpperCase();
      const buyCells = $(tr).find('.col-buy-cell').map((i, el) => normalizeText($(el).text())).get();
      const rowText = normalizeText($(tr).text()).toUpperCase();

      // extract clean numeric tokens (as integers)
      const nums = extractNumericTokens(rowText).map(s => Number(s)).filter(n => Number.isFinite(n) && n >= 1000);

      // identify "miếng" candidate: require MIẾNG + LƯỢNG and NOT "500 LƯỢNG"
      const isMi = (prodText.includes('MIẾNG') || rowText.includes('MIẾNG')) &&
                   (/\b1\s*LƯỢNG\b/.test(prodText) || /\bLƯỢNG\b/.test(unitText) || /\bLƯỢNG\b/.test(rowText)) &&
                   !(/\b500\s*LƯỢNG\b/.test(prodText) || /\b500\s*LƯỢNG\b/.test(unitText) || /\b500\s*LƯỢNG\b/.test(rowText));

      // SỬA ĐIỀU KIỆN: chỉ nhận đúng thỏi 1kg
      const isTh = isThoi1Kg(prodText, unitText, rowText);

      if (isMi) {
        const cellsNums = buyCells.map(c => cleanDigitsOnly(c)).filter(c => c && c.length >= 4).map(n => Number(n));
        miengCandidates.push({ tr, prodText, unitText, rowText, nums, cellsNums });
      } else if (isTh) {
        const cellsNums = buyCells.map(c => cleanDigitsOnly(c)).filter(c => c && c.length >= 4).map(n => Number(n));
        thoiCandidates.push({ tr, prodText, unitText, rowText, nums, cellsNums });
      }

      // update_time extraction
      const um = rowText.match(/CẬP NHẬT(?: LÚC|:)?\s*([\d:\s\/\-APM]{6,})/i);
      if (um && um[1]) update_time = update_time === '-' ? um[1].trim() : update_time;
    });

    // helper to choose best candidate: prefer cellsNums (explicit buy/sell cells) and presence of "1 LƯỢNG"
    function pickM(candidateList) {
      if (!candidateList || !candidateList.length) return null;
      // prefer those that explicitly contain '1 LƯỢNG' in prod/unit
      const exact = candidateList.filter(c => /\b1\s*LƯỢNG\b/.test(c.prodText) || /\b1\s*LƯỢNG\b/.test(c.unitText) || /\b1\s*LƯỢNG\b/.test(c.rowText));
      const pool = exact.length ? exact : candidateList;
      // prefer rows that have explicit cell numbers
      for (const c of pool) {
        if (c.cellsNums && c.cellsNums.length >= 2 && c.cellsNums[0] >= 1000 && c.cellsNums[1] >= 1000) return { buy: c.cellsNums[0], sell: c.cellsNums[1], unit: c.unitText || 'Vnđ/Lượng' };
      }
      // fallback to nums found in row text (first two large tokens)
      for (const c of pool) {
        if (c.nums && c.nums.length >= 2) return { buy: c.nums[0], sell: c.nums[1], unit: c.unitText || 'Vnđ/Lượng' };
      }
      // last resort: any cellsNums with one token (use same for sell)
      for (const c of pool) {
        if (c.cellsNums && c.cellsNums.length >= 1 && c.cellsNums[0] >= 1000) return { buy: c.cellsNums[0], sell: c.cellsNums[1] || c.cellsNums[0], unit: c.unitText || 'Vnđ/Lượng' };
      }
      return null;
    }

    const mi = pickM(miengCandidates);
    const th = pickM(thoiCandidates);

    if (mi) { phuquy.mieng_buy = mi.buy; phuquy.mieng_sell = mi.sell; phuquy.thoi_unit = mi.unit || phuquy.thoi_unit; }
    if (th) { phuquy.thoi_buy = th.buy; phuquy.thoi_sell = th.sell; phuquy.thoi_unit = th.unit || phuquy.thoi_unit; }

    // defaults if not found
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

    // prefer yesterday, then most recent snapshot file, then explicitDate
    function loadMostRecentSnapshotBefore(date) {
      try {
        const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => /\.json$/.test(f));
        let best = null;
        for (const fn of files) {
          const m = fn.match(/^(\d{4})-(\d{2})-(\d{2})\.json$/);
          if (!m) continue;
          const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
          if (d < date && (!best || d > best)) best = d;
        }
        if (best) return loadSnapshotByDate(best);
      } catch (e) { /* ignore */ }
      return null;
    }

    let prevSnap = loadSnapshotByDate(yesterday);
    if (!prevSnap) prevSnap = loadMostRecentSnapshotBefore(today);
    if (!prevSnap) prevSnap = loadSnapshotByDate(explicitDate);

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
    if (typeof v === 'number') {
      return v > 1000 ? (v / 1_000_000) : v;
    }
    const raw = String(v).trim();

    // exact form like "140.600" or "140,600" -> triệu
    if (/^\d{1,3}[.,]\d{3}$/.test(raw)) {
      return Number(raw.replace(/,/g, '.'));
    }

    // grouped thousands like "14.060.000" or "14,060,000" -> VND -> triệu
    if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) {
      const n = Number(cleanDigitsOnly(raw));
      return Number.isFinite(n) ? (n / 1_000_000) : null;
    }

    // fallback: normalize and parse
    let s = raw.replace(/\s+/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
    if (!s) return null;
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    // heuristic: very large -> VND -> triệu
    return n >= 1000 ? (n / 1_000_000) : n;
  };

  const formatMillionStr = (m) => (m == null ? '-' : Number(m).toFixed(3));
  const fmtMillionDelta = (valMillions) => {
    if (valMillions == null) return '-';
    const sign = valMillions > 0 ? '+' : (valMillions < 0 ? '-' : '');
    return sign + Math.abs(Number(valMillions)).toFixed(3);
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

    // keys to compare
    const keys = ['mieng_buy','mieng_sell','nhan_buy','nhan_sell'];

    // normalize current/previous values to floats (triệu)
    const curVals = {};
    const prevVals = {};
    for (const key of keys) {
      curVals[key] = parseToMillions(bcur[key]);
      prevVals[key] = parseToMillions(bprev[key]);
      // also normalize displayed value in current to canonical format if parsable
      if (curVals[key] != null) bcur[key] = formatMillionStr(curVals[key]);
    }

    // compute deltas with sanity check
    for (const key of keys) {
      const cur = curVals[key];
      const prev = prevVals[key];

      const absKey = key + '_change';
      const pctKey = key + '_change_pct';

      if (prev == null) {
        bcur[absKey] = '-';
        bcur[pctKey] = '-';
        continue;
      }
      if (cur == null) {
        bcur[absKey] = '-';
        bcur[pctKey] = '-';
        continue;
      }

      const abs = cur - prev;
      const pct = prev ? (abs / prev) * 100 : null;

      // sanity: if absolute delta unexpectedly huge (> 50 triệu) mark as suspect and skip
      if (Math.abs(abs) > 50) {
        console.warn(`computeDeltas: suspicious delta for ${k}.${key} cur=${cur} prev=${prev} -> abs=${abs}. Skipping delta.`);
        bcur[absKey] = '-';
        bcur[pctKey] = '-';
        continue;
      }

      bcur[absKey] = fmtMillionDelta(abs);
      bcur[pctKey] = pct == null ? '-' : fmtPct(pct);
    }
  }

  // silver (phuquy) - compare and set deltas in millions (normalize similarly)
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
        if (prevV == null || curV == null) { curPh[outAbsKey] = '-'; curPh[outPctKey] = '-'; return; }
        const abs = curV - prevV;
        if (Math.abs(abs) > 50) { curPh[outAbsKey] = '-'; curPh[outPctKey] = '-'; return; }
        const pct = prevV ? (abs / prevV) * 100 : null;
        curPh[outAbsKey] = fmtMillionDelta(abs);
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

// thêm hàm kiểm tra "THỎI 1KG" cho silver
function isThoi1Kg(prodText, unitText, rowText) {
  // Chỉ nhận nếu có "THỎI" và có đúng "1 KG" hoặc "1KG" hoặc "1 KILO" hoặc "1KILO" hoặc "1 KILOGAM" hoặc "1 KILOGRAM"
  // và không có số khác ngoài 1 đứng trước KG/KILO/LƯỢNG
  const thoi = /THỎI/.test(prodText) || /THỎI/.test(rowText);
  // Chỉ nhận đúng "1" đứng trước đơn vị, không nhận "10", "100", "500", ...
  const oneKgPattern = /\b1\s*(KG|KILO|KILOGAM|KILOGRAM)\b/;
  const oneKg = oneKgPattern.test(unitText) || oneKgPattern.test(prodText) || oneKgPattern.test(rowText);
  // Loại bỏ nếu có số khác ngoài 1 đứng trước KG/KILO/LƯỢNG
  const notOther = !/\b([2-9]|\d{2,})\s*(KG|KILO|KILOGAM|KILOGRAM|LƯỢNG)\b/.test(prodText + ' ' + unitText + ' ' + rowText);
  return thoi && oneKg && notOther;
}

// helper: convert VND digits (string like "14060000") which is VND per "chỉ"
// -> return string "triệu" per "lượng" with 3 decimals, e.g. "140.600"
function millionsPerLuongFromVndDigits(digits) {
  if (!digits) return '-';
  const clean = cleanDigitsOnly(String(digits));
  if (!clean) return '-';
  const vndPerChi = Number(clean);
  if (!Number.isFinite(vndPerChi)) return '-';
  const vndPerLuong = vndPerChi * 10; // 1 lượng = 10 chỉ
  const millions = vndPerLuong / 1_000_000;
  return Number(millions).toFixed(3); // keep 3 decimals to match existing format
}

async function scrapeBTMH() {
  try {
    const url = 'https://www.baotinmanhhai.vn/gia-vang-hom-nay';
    const html = await fetchHtmlWithOptionalRender(url, 2000);
    const $ = cheerio.load(html);
    const bodyText = normalizeText($('body').text());

    let update_time = '-';
    const um = bodyText.match(/Cập nhật(?: lúc|:)?\s*([\d:\s\/]{6,})/i);
    if (um && um[1]) update_time = um[1].trim();

    let mieng_buy = '-', mieng_sell = '-', nhan_buy = '-', nhan_sell = '-';

    // regex cứng cho các dòng xuất hiện rõ trong bodyText
    const reMieng = /Vàng miếng\s*SJC[^\d\S\r\n]*\(.*?\)?[^\d\S\r\n]*\s*([0-9]{1,3}(?:[.,][0-9]{3})+)\s+([0-9]{1,3}(?:[.,][0-9]{3})+)/i;
    const mM = bodyText.match(reMieng);
    if (mM) {
      mieng_buy = millionsPerLuongFromVndDigits(mM[1]);
      mieng_sell = millionsPerLuongFromVndDigits(mM[2]);
    }

    const reNhan = /Nhẫn(?:[^0-9]{1,20})?ép\s*vỉ\s*Kim\s*Gia\s*Bảo[^\d\S\r\n]*\s*([0-9]{1,3}(?:[.,][0-9]{3})+)\s+([0-9]{1,3}(?:[.,][0-9]{3})+)/i;
    const mN = bodyText.match(reNhan);
    if (mN) {
      nhan_buy = millionsPerLuongFromVndDigits(mN[1]);
      nhan_sell = millionsPerLuongFromVndDigits(mN[2]);
    }

    // fallback: per-line parse (split by newlines or large whitespace blocks)
    if ((mieng_buy === '-' || mieng_sell === '-') || (nhan_buy === '-' || nhan_sell === '-')) {
      const lines = bodyText.split(/\r?\n|\s{2,}/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const toks = extractNumericTokens(line);
        if (toks && toks.length >= 2) {
          if (mieng_buy === '-' && /vàng miếng.*sjc/i.test(line)) {
            mieng_buy = millionsPerLuongFromVndDigits(toks[0]);
            mieng_sell = millionsPerLuongFromVndDigits(toks[1]);
          } else if (nhan_buy === '-' && /nhẫn.*kim gia bảo/i.test(line)) {
            nhan_buy = millionsPerLuongFromVndDigits(toks[0]);
            nhan_sell = millionsPerLuongFromVndDigits(toks[1]);
          }
        }
      }
    }

    return {
      mieng_buy: mieng_buy || '-',
      mieng_sell: mieng_sell || '-',
      nhan_buy: nhan_buy || '-',
      nhan_sell: nhan_sell || '-',
      update_time: update_time === '-' ? new Date().toLocaleString('vi-VN') : update_time
    };
  } catch (e) {
    console.warn('scrapeBTMH error', e && e.message);
    return null;
  }
}

// viewer whitelist and small proxy/iframe viewer
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
    const mode = (req.query.mode || 'proxy').toLowerCase(); // iframe | proxy
    const height = String(req.query.height || '400').replace(/[^\d]/g,'') || '400';
    const width = String(req.query.width || '100%');
    const speed = Number(req.query.speed || 50); // px per second
    const selector = req.query.selector || ''; // CSS selector inside proxied content to scroll
    const pause = Number(req.query.pause || 1000); // ms pause at bottom before restarting
    const auto = req.query.auto === '0' ? false : true; // enable auto-scroll by default

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

    // proxy mode
    const html = await fetchHtmlWithOptionalRender(url, 2000);
    const $ = cheerio.load(html);
    // strip scripts/styles to avoid executing remote JS
    $('script, style, iframe, link[rel="stylesheet"]').remove();
    $('img').each((i, img) => { $(img).attr('loading','lazy'); });
    const bodyInner = $('body').html() || $('html').html() || escapeHtml(html);

    return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Proxy viewer</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f7f7f7}
  .wrap{padding:8px}
  .contentBox{width:${escapeHtml(width)};height:${escapeHtml(height)}px;border:1px solid #ddd;overflow:auto;background:#fff;position:relative}
  .controls{margin:8px 0;font-size:13px;color:#333}
  .controls input{width:60px}
  .note{font-size:12px;color:#666;margin-top:6px}
</style>
</head><body>
<div class="wrap">
  <div><strong>Proxied:</strong> ${escapeHtml(url)}</div>
  <div class="controls">
    Auto-scroll: ${auto ? 'ON' : 'OFF'} | speed: ${speed}px/s | selector: ${escapeHtml(selector || 'auto')} | pause: ${pause}ms
  </div>
  <div class="contentBox" id="contentBox">${bodyInner}</div>
  <div class="note">Mode=proxy — scripts/styles removed. Auto-scroll works within proxied DOM only. Use &selector= to target a specific element (e.g. selector=table).</div>
</div>

<script>
(function(){
  const contentBox = document.getElementById('contentBox');
  const speed = ${Number(isFinite(speed) ? speed : 50)};
  const selector = ${JSON.stringify(selector || '')};
  const pauseMs = ${Number(isFinite(pause) ? pause : 1000)};
  const autoEnabled = ${auto ? 'true' : 'false'};

  function whenImagesLoaded(root){
    const imgs = Array.from((root || document).querySelectorAll('img'));
    if (!imgs.length) return Promise.resolve();
    return Promise.all(imgs.map(img=>{
      if (img.complete) return Promise.resolve();
      return new Promise(res=>{
        img.addEventListener('load', res, {once:true});
        img.addEventListener('error', res, {once:true});
      });
    }));
  }

  function findScrollTarget(){
    if (selector) {
      try {
        const el = contentBox.querySelector(selector);
        if (el) return el;
      } catch(e){ /* invalid selector */ }
    }
    // prefer first table or the whole contentBox scroll area
    const tbl = contentBox.querySelector('table');
    return tbl || contentBox;
  }

  let rafId = null;
  let lastTs = null;
  let paused = false;
  let targetEl = null;
  let maxScroll = 0;
  let startTop = 0;

  function startLoop(){
    if (!autoEnabled) return;
    if (!targetEl) targetEl = findScrollTarget();
    // if target is the whole contentBox, we scroll contentBox; else we scroll contentBox so that targetEl is scrolled into view
    const isSelf = (targetEl === contentBox);
    const scrollContainer = contentBox;
    // compute maxScroll for container
    maxScroll = isSelf ? (scrollContainer.scrollHeight - scrollContainer.clientHeight) : (targetEl.scrollHeight - scrollContainer.clientHeight);
    if (maxScroll <= 0) return; // nothing to scroll

    lastTs = null;
    function step(ts){
      if (paused) { lastTs = ts; rafId = requestAnimationFrame(step); return; }
      if (!lastTs) lastTs = ts;
      const dt = ts - lastTs;
      lastTs = ts;
      const dy = (speed * dt) / 1000;
      // if scrolling target element, compute new scrollTop to move target relative position
      if (isSelf) {
        scrollContainer.scrollTop = Math.min(scrollContainer.scrollTop + dy, maxScroll);
      } else {
        // compute target's offsetTop relative to container and adjust scrollTop
        const rel = targetEl.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop;
        // if target larger than container, scroll target area progressively
        const current = scrollContainer.scrollTop;
        const next = Math.min(current + dy, rel + targetEl.scrollHeight - scrollContainer.clientHeight, maxScroll);
        scrollContainer.scrollTop = next;
      }

      if ((isSelf && scrollContainer.scrollTop >= maxScroll - 0.5) || (!isSelf && scrollContainer.scrollTop >= maxScroll - 0.5)) {
        // reached bottom -> pause then reset to top
        cancelAnimationFrame(rafId);
        setTimeout(()=>{
          scrollContainer.scrollTop = 0;
          lastTs = null;
          rafId = requestAnimationFrame(step);
        }, pauseMs);
        return;
      }
      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);
  }

  function stopLoop(){ if (rafId) cancelAnimationFrame(rafId); rafId = null; lastTs = null; }

  // pause/resume on hover
  contentBox.addEventListener('mouseenter', ()=>{ paused = true; });
  contentBox.addEventListener('mouseleave', ()=>{ paused = false; });

  // init after images/styles settled
  whenImagesLoaded(contentBox).then(()=>{
    targetEl = findScrollTarget();
    // recompute on resize
    window.addEventListener('resize', ()=>{ stopLoop(); targetEl = findScrollTarget(); startLoop(); });
    if (autoEnabled) startLoop();
  }).catch(()=>{ if (autoEnabled) startLoop(); });

})();
</script>
</body></html>`);
  } catch (err) {
    return res.status(500).send('Viewer error: ' + String(err && err.message));
  }
});