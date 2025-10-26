const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin()); // Evade headless detection

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

// --- improved Puppeteer render helper with stealth and retry ---
async function renderPageWithPuppeteer(url, waitMs = 3000, timeout = 45000) {
  let browser;
  try {
    console.log(`Rendering ${url} with Puppeteer...`);
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
      timeout: timeout
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 }); // Mimic real browser
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) req.abort(); else req.continue();
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout }); // Change to networkidle2 for better load
    if (waitMs) await page.waitForTimeout(waitMs);
    const content = await page.content();
    await page.close();
    return content;
  } catch (e) {
    console.error(`Puppeteer error for ${url}:`, e.message);
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// fetch HTML with axios, fallback to render if enabled, with retry
async function fetchHtmlWithOptionalRender(url, renderWait = 3000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Fetching ${url} (attempt ${attempt})...`);
      const r = await axios.get(url, {
        timeout: 15000, // Increase timeout
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36' }
      });
      if (r.data && r.data.length > 1000) return r.data; // Check if response is meaningful
    } catch (err) {
      console.warn(`Axios failed for ${url} (attempt ${attempt}):`, err.message);
    }

    if (process.env.ENABLE_RENDER === '1') {
      try {
        return await renderPageWithPuppeteer(url, Number(process.env.RENDER_WAIT || renderWait));
      } catch (e) {
        console.warn(`Puppeteer failed for ${url} (attempt ${attempt}):`, e.message);
        if (attempt === retries) throw e;
      }
    } else if (attempt === retries) {
      throw new Error('All attempts failed');
    }
    await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between retries
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

        // fallback to vendor page if missing pair
        if (mieng_buy === '-' || mieng_sell === '-' || nhan_buy === '-' || nhan_sell === '-') {
          const vendor = await tryVendorPages(key);
          if (vendor) {
            if (mieng_buy === '-') mieng_buy = vendor.mieng_buy;
            if (mieng_sell === '-') mieng_sell = vendor.mieng_sell;
            if (nhan_buy === '-') nhan_buy = vendor.nhan_buy;
            if (nhan_sell === '-') nhan_sell = vendor.nhan_sell;
          }
        }

        brands[key] = {
          mieng_buy, mieng_sell, nhan_buy, nhan_sell,
          mieng_buy_change: '-', mieng_sell_change: '-', nhan_buy_change: '-', nhan_sell_change: '-'
        };
      } catch (e) {
        console.warn('scrapeGold error for ' + key, e && e.message);
      }
    }

    cachedData.gold = {
      brands,
      update_time: globalUpdate || new Date().toLocaleString('vi-VN')
    };
  } catch (e) {
    console.error('scrapeGold global error', e && e.message);
  }
}

// --- scrapeBTMH: special for BTMH vendor, with per-chi to millions per luong ---
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

// Cron scrape - giữ nguyên, nhưng thêm log
cron.schedule('*/5 * * * *', async () => {
  console.log('Running cron scrape at', new Date().toISOString());
  try {
    await scrapeGold(); // Giả sử scrapeAll() là scrapeGold(), điều chỉnh nếu có các scrape khác
  } catch (e) {
    console.error('Cron scrape error:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));