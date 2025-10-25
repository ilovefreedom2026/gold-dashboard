const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// serve static files (so index.html can be opened via http://localhost:3000/)
app.use(express.static(__dirname));

// --- snapshot / delta helpers ---
const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');

function parseNumber(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '' || s === '-') return NaN;
  const cleaned = s.replace(/[^\d\.,-]/g, '').replace(/,/g, '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}
function fmtNumber(n, decimals = 3) {
  if (!Number.isFinite(n)) return '0.000';
  const abs = Math.abs(n).toFixed(decimals);
  return (n > 0 ? '+' : (n < 0 ? '-' : '')) + abs;
}
function fmtPct(delta, base) {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base === 0) return '0.00%';
  return ((delta / base) * 100).toFixed(2) + '%';
}
function listSnapshotFiles() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return [];
    return fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json')).sort();
  } catch (e) { return []; }
}
function loadSnapshot(filename) {
  try {
    const p = path.join(SNAPSHOT_DIR, filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}
function computeDeltas(latest, prev) {
  if (!latest || !latest.gold) return latest;
  const out = JSON.parse(JSON.stringify(latest));
  const brandKeys = Object.keys(latest.gold).filter(k => !['update_time','update_time_scraped'].includes(k));
  brandKeys.forEach(brand => {
    const cur = latest.gold[brand] || {};
    const prv = (prev && prev.gold && prev.gold[brand]) ? prev.gold[brand] : null;
    ['mieng_buy','nhan_buy'].forEach(key => {
      const curVal = parseNumber(cur[key]);
      const prevVal = prv ? parseNumber(prv[key]) : NaN;
      const delta = Number.isFinite(curVal) && Number.isFinite(prevVal) ? (curVal - prevVal) : NaN;
      out.gold[brand][key + '_change'] = Number.isFinite(delta) ? fmtNumber(delta, 3) : '0.000';
      out.gold[brand][key + '_change_pct'] = Number.isFinite(delta) && Number.isFinite(prevVal) && prevVal !== 0 ? fmtPct(delta, prevVal) : '0.00%';
    });
    ['mieng_sell','nhan_sell'].forEach(k => {
      if (!out.gold[brand][k + '_change']) out.gold[brand][k + '_change'] = (cur && cur[k + '_change']) ? cur[k + '_change'] : '0.000';
      if (!out.gold[brand][k + '_change_pct']) out.gold[brand][k + '_change_pct'] = (cur && cur[k + '_change_pct']) ? cur[k + '_change_pct'] : '0.00%';
    });
  });
  if (latest.silver && prev && prev.silver) {
    const curS = latest.silver.phuquy || {};
    const prevS = prev.silver.phuquy || {};
    ['mieng_buy','mieng_sell','thoi_buy','thoi_sell'].forEach(k => {
      const curVal = parseNumber(curS[k]);
      const prevVal = parseNumber(prevS[k]);
      const delta = Number.isFinite(curVal) && Number.isFinite(prevVal) ? (curVal - prevVal) : NaN;
      if (!out.silver) out.silver = latest.silver;
      out.silver.phuquy[k + '_change'] = Number.isFinite(delta) ? fmtNumber(delta, 3) : '0.000';
      out.silver.phuquy[k + '_change_pct'] = Number.isFinite(delta) && Number.isFinite(prevVal) && prevVal !== 0 ? fmtPct(delta, prevVal) : '0.00%';
    });
  }
  return out;
}

// routes
app.get('/snapshots/latest-with-deltas', (req, res) => {
  const files = listSnapshotFiles();
  if (!files.length) return res.status(404).json({ success: false, error: 'no_snapshots' });
  const latestFile = files[files.length - 1];
  const prevFile = files.length > 1 ? files[files.length - 2] : null;
  const latest = loadSnapshot(latestFile);
  const prev = prevFile ? loadSnapshot(prevFile) : null;
  const result = computeDeltas(latest, prev);
  return res.json({ success: true, latestFile, prevFile, data: result });
});

// backward-compatible endpoint used by frontend
app.get('/scrape', (req, res) => {
  const files = listSnapshotFiles();
  if (!files.length) return res.status(404).json({ success: false, error: 'no_snapshots' });
  const latestFile = files[files.length - 1];
  const prevFile = files.length > 1 ? files[files.length - 2] : null;
  const latest = loadSnapshot(latestFile);
  const prev = prevFile ? loadSnapshot(prevFile) : null;
  const result = computeDeltas(latest, prev);
  return res.json(result);
});

// optionally keep telegram proxy (if you added before) - leave existing implementation if needed

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server running on http://localhost:${PORT}`));