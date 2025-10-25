const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const cron = require('node-cron');
const puppeteer = require('puppeteer');

let data = {
  'VN-Index': { value: '-', change: '-', percent: '-', arrow: '-' },
  'HNX-Index': { value: '-', change: '-', percent: '-', arrow: '-' },
  'UPCoM-Index': { value: '-', change: '-', percent: '-', arrow: '-' },
  'VN30': { value: '-', change: '-', percent: '-', arrow: '-' },
  'BTC-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'ETH-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'BNB-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'XRP-USD': { value: '-', change: '-', percent: '-', arrow: '-' }
};

async function updateVNData() {
  let browser;
  try {
    console.log('Fetching VN data with Puppeteer...');
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto('https://liveboard.cafef.vn/', { waitUntil: 'networkidle2', timeout: 90000 });
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for dynamic content
        break;
      } catch (e) {
        console.log(`VN scrape attempt ${attempt} failed: ${e.message}`);
        if (attempt === 3) throw e;
      }
    }
    
    const html = await page.content();
    fs.writeFileSync('debug.html', html);
    console.log('Saved HTML to debug.html');
    const $ = cheerio.load(html);

    function extractIndexData(indexClass, changeClass, indexName) {
      try {
        const value = $('.' + indexClass).text().trim() || '-';
        const changePercent = $('.' + changeClass).text().trim() || '-';
        let change = '-';
        let percent = '-';
        let arrow = '-';
        if (changePercent !== '-') {
          change = changePercent.match(/[-+]?[0-9]*\.?[0-9]+(?=\s\()/)?.[0] || '-';
          percent = changePercent.match(/\(([-+]?[0-9]*\.?[0-9]+%)\)/)?.[1] || '-';
          arrow = percent !== '-' && parseFloat(percent.replace('%', '')) >= 0 ? '▲' : '▼';
        }
        data[indexName] = { value, change, percent, arrow };
        console.log(`${indexName} scraped:`, data[indexName]);
      } catch (e) {
        console.error(`Error scraping ${indexName}:`, e.message);
        data[indexName] = { value: '-', change: '-', percent: '-', arrow: '-' };
      }
    }

    extractIndexData('idx_1', 'chgidx_1', 'VN-Index');
    extractIndexData('idx_2', 'chgidx_2', 'HNX-Index');
    extractIndexData('idx_9', 'chgidx_9', 'UPCoM-Index');
    extractIndexData('idx_11', 'chgidx_11', 'VN30');
  } catch (e) {
    console.error('VN scrape error:', e.message);
    ['VN-Index', 'HNX-Index', 'UPCoM-Index', 'VN30'].forEach(key => {
      data[key] = { value: '-', change: '-', percent: '-', arrow: '-' };
    });
  } finally {
    if (browser) await browser.close();
  }
}

async function updateCryptoData() {
  try {
    console.log('Fetching crypto data...');
    const ids = 'bitcoin,ethereum,binancecoin,ripple';
    const response = await axios.get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const prices = response.data;
    console.log('CoinGecko response:', prices);

    function updateCrypto(key, id) {
      try {
        const coin = prices.find(c => c.id === id);
        if (coin && coin.current_price) {
          data[key].value = coin.current_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const changePercent = coin.price_change_percentage_24h;
          if (changePercent !== undefined && changePercent !== null) {
            const absChange = (coin.current_price * Math.abs(changePercent) / 100).toFixed(2);
            data[key].change = changePercent >= 0 ? `+${absChange}` : `-${absChange}`;
            data[key].percent = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
            data[key].arrow = changePercent >= 0 ? '▲' : '▼';
          } else {
            data[key].change = 'N/A';
            data[key].percent = 'N/A';
            data[key].arrow = '-';
          }
        } else {
          data[key] = { value: '-', change: 'N/A', percent: 'N/A', arrow: '-' };
        }
        console.log(`${key} updated:`, data[key]);
      } catch (e) {
        console.error(`Error updating ${key}:`, e.message);
        data[key] = { value: '-', change: 'N/A', percent: 'N/A', arrow: '-' };
      }
    }

    updateCrypto('BTC-USD', 'bitcoin');
    updateCrypto('ETH-USD', 'ethereum');
    updateCrypto('BNB-USD', 'binancecoin');
    updateCrypto('XRP-USD', 'ripple');
  } catch (e) {
    console.error('Crypto scrape error:', e.message);
    ['BTC-USD', 'ETH-USD', 'BNB-USD', 'XRP-USD'].forEach(key => {
      data[key] = { value: '-', change: 'N/A', percent: 'N/A', arrow: '-' };
    });
  }
}

function saveData() {
  try {
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    console.log('Data saved to data.json at', new Date().toLocaleString('vi-VN'));
  } catch (e) {
    console.error('Error saving data.json:', e.message);
  }
}

async function runUpdate() {
  console.log('Running update at', new Date().toLocaleString('vi-VN'));
  await updateVNData();
  await updateCryptoData();
  saveData();
}

cron.schedule('*/30 * * * * *', runUpdate);
runUpdate();