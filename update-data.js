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
  'VCB': { value: '-', change: '-', percent: '-', arrow: '-' },
  'VHM': { value: '-', change: '-', percent: '-', arrow: '-' },
  'VIC': { value: '-', change: '-', percent: '-', arrow: '-' },
  'BID': { value: '-', change: '-', percent: '-', arrow: '-' },
  'CTG': { value: '-', change: '-', percent: '-', arrow: '-' },
  'TCB': { value: '-', change: '-', percent: '-', arrow: '-' },
  'GAS': { value: '-', change: '-', percent: '-', arrow: '-' },
  'HPG': { value: '-', change: '-', percent: '-', arrow: '-' },
  'FPT': { value: '-', change: '-', percent: '-', arrow: '-' },
  'VNM': { value: '-', change: '-', percent: '-', arrow: '-' },
  'BTC-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'ETH-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'BNB-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'XRP-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'USDT-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'SOL-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'USDC-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'STETH-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'TRX-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'DOGE-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'ADA-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'LINK-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'XLM-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'HYPE-USD': { value: '-', change: '-', percent: '-', arrow: '-' },
  'BCH-USD': { value: '-', change: '-', percent: '-', arrow: '-' }
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
        const rawValue = $('.' + indexClass).text().trim();
        console.log(`${indexName} raw value:`, rawValue);
        const valueNum = parseFloat(rawValue.replace(/[^0-9.-]+/g, ''));
        const value = isNaN(valueNum) ? '-' : valueNum.toFixed(2);
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

async function updateStockData() {
  let browser;
  try {
    console.log('Fetching stock data with Puppeteer...');
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto('https://liveboard.cafef.vn/', { waitUntil: 'networkidle2', timeout: 90000 });
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds for dynamic content
        break;
      } catch (e) {
        console.log(`Stock scrape attempt ${attempt} failed: ${e.message}`);
        if (attempt === 3) throw e;
      }
    }
    
    const html = await page.content();
    fs.writeFileSync('debug_stock.html', html);
    console.log('Saved stock HTML to debug_stock.html');
    const $ = cheerio.load(html);

    const stocks = ['VCB', 'VHM', 'VIC', 'BID', 'CTG', 'TCB', 'GAS', 'HPG', 'FPT', 'VNM'];

    stocks.forEach(stock => {
      try {
        const valueElem = $(`#${stock}_l`).first();
        const changeElem = $(`#${stock}_k_1`).first();
        const referenceElem = $(`#${stock}_b`).first();

        const rawValue = valueElem.text().trim();
        console.log(`${stock} raw value:`, rawValue);
        const valueNum = parseFloat(rawValue.replace(/[^0-9.-]+/g, ''));
        const value = isNaN(valueNum) ? '-' : valueNum.toFixed(2);

        let change = changeElem.text().trim() || '-';
        const rawReference = referenceElem.text().trim();
        const referenceNum = parseFloat(rawReference.replace(/[^0-9.-]+/g, ''));
        const reference = isNaN(referenceNum) ? '-' : referenceNum.toFixed(2);

        let percent = '-';
        if (value !== '-' && reference !== '-') {
          const currentPrice = parseFloat(value);
          const referencePrice = parseFloat(reference);
          if (!isNaN(currentPrice) && !isNaN(referencePrice) && referencePrice !== 0) {
            const percentChange = ((currentPrice - referencePrice) / referencePrice * 100).toFixed(2);
            percent = (percentChange >= 0 ? '+' : '') + percentChange + '%';
          }
        }

        const changeClass = changeElem.attr('class') || '';
        let arrow = '-';
        if (changeClass.includes('red')) {
          arrow = '▼';
          if (change !== '-' && !change.startsWith('-')) change = '-' + change;
        } else if (changeClass.includes('green')) {
          arrow = '▲';
          if (change !== '-' && !change.startsWith('+')) change = '+' + change;
        } else if (changeClass.includes('neutral')) {
          arrow = '-';
        }

        data[stock] = { value, change, percent, arrow };
        console.log(`${stock} scraped:`, data[stock]);
      } catch (e) {
        console.error(`Error scraping ${stock}:`, e.message);
        data[stock] = { value: '-', change: '-', percent: '-', arrow: '-' };
      }
    });
  } catch (e) {
    console.error('Stock scrape error:', e.message);
    const stocks = ['VCB', 'VHM', 'VIC', 'BID', 'CTG', 'TCB', 'GAS', 'HPG', 'FPT', 'VNM'];
    stocks.forEach(key => {
      data[key] = { value: '-', change: '-', percent: '-', arrow: '-' };
    });
  } finally {
    if (browser) await browser.close();
  }
}

async function updateCryptoData() {
  try {
    console.log('Fetching crypto data...');
    const ids = 'bitcoin,ethereum,binancecoin,ripple,tether,solana,usd-coin,staked-ether,tron,dogecoin,cardano,chainlink,stellar,hyperliquid,bitcoin-cash';
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
          data[key].value = parseFloat(coin.current_price).toFixed(2);
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
    updateCrypto('USDT-USD', 'tether');
    updateCrypto('SOL-USD', 'solana');
    updateCrypto('USDC-USD', 'usd-coin');
    updateCrypto('STETH-USD', 'staked-ether');
    updateCrypto('TRX-USD', 'tron');
    updateCrypto('DOGE-USD', 'dogecoin');
    updateCrypto('ADA-USD', 'cardano');
    updateCrypto('LINK-USD', 'chainlink');
    updateCrypto('XLM-USD', 'stellar');
    updateCrypto('HYPE-USD', 'hyperliquid');
    updateCrypto('BCH-USD', 'bitcoin-cash');
  } catch (e) {
    console.error('Crypto scrape error:', e.message);
    const cryptoKeys = ['BTC-USD', 'ETH-USD', 'BNB-USD', 'XRP-USD', 'USDT-USD', 'SOL-USD', 'USDC-USD', 'STETH-USD', 'TRX-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'XLM-USD', 'HYPE-USD', 'BCH-USD'];
    cryptoKeys.forEach(key => {
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
  await updateStockData();
  await updateCryptoData();
  saveData();
}

cron.schedule('*/30 * * * * *', runUpdate);
runUpdate();