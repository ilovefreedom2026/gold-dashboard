const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors({ origin: '*' }));

let cachedData = { 
  gold: { update_time: '-' }, 
  silver: { update_time: '-' }, 
  exchange: { update_time: '-' } 
};

cron.schedule('*/60 * * * * *', async () => {
  console.log('Running scheduled scrape at', new Date().toLocaleString('vi-VN'));
  cachedData.gold = await scrapeWithRetry(scrapeGold, 3) || { update_time: '-' };
  cachedData.silver = await scrapeWithRetry(scrapeSilver, 3) || { update_time: '-' };
  cachedData.exchange = await scrapeWithRetry(scrapeExchange, 3) || { update_time: '-' };
  console.log('Updated cached data:', JSON.stringify(cachedData, null, 2));
});

// Initial scrape on startup
setTimeout(async () => {
  console.log('Initial scrape on startup');
  cachedData.gold = await scrapeWithRetry(scrapeGold, 1) || { update_time: '-' };
  cachedData.silver = await scrapeWithRetry(scrapeSilver, 1) || { update_time: '-' };
  cachedData.exchange = await scrapeWithRetry(scrapeExchange, 1) || { update_time: '-' };
  console.log('Initial cached data:', JSON.stringify(cachedData, null, 2));
}, 3000);

app.get('/scrape', (req, res) => {
  console.log('Serving /scrape request at', new Date().toLocaleString('vi-VN'));
  console.log('Cached data:', JSON.stringify(cachedData, null, 2));
  res.json(cachedData);
});

async function scrapeWithRetry(scrapeFn, retries) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempting ${scrapeFn.name} (Attempt ${i + 1}/${retries})`);
      const result = await scrapeFn();
      if (result && result.update_time !== '-') {
        console.log(`${scrapeFn.name} succeeded:`, JSON.stringify(result, null, 2));
        return result;
      }
      console.log(`${scrapeFn.name} returned empty data, retrying...`);
    } catch (error) {
      console.error(`Attempt ${i + 1} failed for ${scrapeFn.name}: ${error.message}`);
      if (i === retries - 1) {
        console.log(`All ${retries} attempts failed for ${scrapeFn.name}, returning empty data`);
        return { update_time: '-' };
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return { update_time: '-' };
}

async function scrapeGold() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  try {
    console.log('Navigating to https://giavang.org/trong-nuoc/');
    await page.goto('https://giavang.org/trong-nuoc/', { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForTimeout(6000);
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      console.log('Gold page text length:', text.length);
      const timeMatch = text.match(/Cập nhật lúc (\d{2}:\d{2}:\d{2} \d{2}\/\d{2}\/\d{4})/);
      const updateTime = timeMatch ? timeMatch[1] : '-';

      const brands = {};

      // SJC Mieng and Nhan from main section
      const sjcMiengBuyMatch = text.match(/Giá vàng Miếng SJC Mua vào (\d+\.?\d*)\s*x1000đ\/lượng/);
      const sjcMiengSellMatch = text.match(/Giá vàng Miếng SJC Bán ra (\d+\.?\d*)\s*x1000đ\/lượng/);
      const sjcNhanBuyMatch = text.match(/Giá vàng Nhẫn SJC Mua vào (\d+\.?\d*)\s*x1000đ\/lượng/);
      const sjcNhanSellMatch = text.match(/Giá vàng Nhẫn SJC Bán ra (\d+\.?\d*)\s*x1000đ\/lượng/);
      console.log('SJC matches:', { miengBuy: sjcMiengBuyMatch, miengSell: sjcMiengSellMatch, nhanBuy: sjcNhanBuyMatch, nhanSell: sjcNhanSellMatch });
      brands['SJC'] = {
        mieng_buy: sjcMiengBuyMatch ? parseFloat(sjcMiengBuyMatch[1]) : '-',
        mieng_sell: sjcMiengSellMatch ? parseFloat(sjcMiengSellMatch[1]) : '-',
        nhan_buy: sjcNhanBuyMatch ? parseFloat(sjcNhanBuyMatch[1]) : '-',
        nhan_sell: sjcNhanSellMatch ? parseFloat(sjcNhanSellMatch[1]) : '-'
      };

      // Other brands from comparison table
      const lines = text.split('\n');
      const brandPatterns = [
        { key: 'DOJI', pattern: /DOJI\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn DOJI.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ },
        { key: 'PNJ', pattern: /PNJ\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn PNJ.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ },
        { key: 'PHUQUY', pattern: /Phú Quý\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn Phú Quý.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ },
        { key: 'BTMC', pattern: /Bảo Tín Minh Châu\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn BTMC.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ },
        { key: 'BTMH', pattern: /Bảo Tín Mạnh Hải\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn BTMH.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ },
        { key: 'MIHONG', pattern: /Mi Hồng\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn Mi Hồng.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ },
        { key: 'NGOCTHAM', pattern: /Ngọc Thẩm\s+(\d+\.?\d*)\s+(\d+\.?\d*)/, nhanPattern: /Vàng Nhẫn Ngọc Thẩm.*Mua vào (\d+\.?\d*).*Bán ra (\d+\.?\d*)/ }
      ];
      brandPatterns.forEach(({ key, pattern, nhanPattern }) => {
        let miengBuy = '-', miengSell = '-', nhanBuy = '-', nhanSell = '-';
        for (const line of lines) {
          const match = line.match(pattern);
          if (match) {
            miengBuy = parseFloat(match[1]);
            miengSell = parseFloat(match[2]);
          }
          const nhanMatch = line.match(nhanPattern);
          if (nhanMatch) {
            nhanBuy = parseFloat(nhanMatch[1]);
            nhanSell = parseFloat(nhanMatch[2]);
          }
        }
        brands[key] = { mieng_buy: miengBuy, mieng_sell: miengSell, nhan_buy: nhanBuy, nhan_sell: nhanSell };
      });

      console.log('Gold data parsed:', JSON.stringify({ update_time: updateTime, ...brands }, null, 2));
      return { update_time: updateTime, ...brands };
    });
    console.log('Gold data scraped:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('Gold scrape error:', error.message);
    return { update_time: '-' };
  } finally {
    await browser.close();
  }
}

async function scrapeSilver() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  try {
    console.log('Navigating to https://giabac.phuquygroup.vn/');
    await page.goto('https://giabac.phuquygroup.vn/', { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForSelector('table.table-bordered', { timeout: 45000 });
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      console.log('Silver page text length:', text.length);
      const timeMatch = text.match(/Cập nhật lần cuối (\d{2}:\d{2} \d{2}\/\d{2}\/\d{4})/);
      const updateTime = timeMatch ? timeMatch[1] : '-';

      const rows = document.querySelectorAll('table.table-bordered tbody tr');
      console.log('Silver table rows found:', rows.length);
      let miengBuy = '-', miengSell = '-', thoiBuy = '-', thoiSell = '-';
      if (rows.length >= 4) {
        const miengCells = rows[0].querySelectorAll('td');
        miengBuy = miengCells[2]?.innerText.replace(/[^\d]/g, '') || '-';
        miengSell = miengCells[3]?.innerText.replace(/[^\d]/g, '') || '-';
        const thoiCells = rows[3].querySelectorAll('td');
        thoiBuy = thoiCells[2]?.innerText.replace(/[^\d]/g, '') || '-';
        thoiSell = thoiCells[3]?.innerText.replace(/[^\d]/g, '') || '-';
      }
      const result = { update_time: updateTime, phuquy: { mieng_buy: miengBuy, mieng_sell: miengSell, thoi_buy: thoiBuy, thoi_sell: thoiSell } };
      console.log('Silver data parsed:', JSON.stringify(result, null, 2));
      return result;
    });
    console.log('Silver data scraped:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('Silver scrape error:', error.message);
    return { update_time: '-' };
  } finally {
    await browser.close();
  }
}

async function scrapeExchange() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  try {
    console.log('Navigating to https://www.vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia');
    await page.goto('https://www.vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia', { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForTimeout(7000);
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      console.log('Exchange page text length:', text.length);
      const timeMatch = text.match(/Ngày (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/);
      const updateTime = timeMatch ? timeMatch[1] : '-';

      const rows = document.querySelectorAll('table tr');
      let usdRow = null;
      for (const row of rows) {
        if (row.innerText.includes('USD')) {
          usdRow = row;
          break;
        }
      }
      const tds = usdRow ? usdRow.querySelectorAll('td') : [];
      console.log('Exchange USD row tds:', tds.length);
      if (tds.length < 5) {
        console.log('USD row incomplete');
        return { update_time: updateTime, vcb: { mua_cash: '-', mua_transfer: '-', ban_ra: '-' } };
      }

      const cleanNum = (str) => str.replace(/[^\d]/g, '') || '-';
      const muaCash = cleanNum(tds[2].innerText);
      const muaTransfer = cleanNum(tds[3].innerText);
      const banRa = cleanNum(tds[4].innerText);
      const result = { update_time: updateTime, vcb: { mua_cash: muaCash, mua_transfer: muaTransfer, ban_ra: banRa } };
      console.log('Exchange data parsed:', JSON.stringify(result, null, 2));
      return result;
    });
    console.log('Exchange data scraped:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('Exchange scrape error:', error.message);
    return { update_time: '-' };
  } finally {
    await browser.close();
  }
}

app.listen(3000, () => console.log('Proxy server running on http://localhost:3000'));