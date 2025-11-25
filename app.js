// =====================
// app.js — Using StockData.org for FULL data (Price + Historical + News)
// =====================

/* CONFIG */
const CONFIG = {
    stocks: ['AAPL', 'TSLA', 'MSFT', 'GOOGL'],  // initial list

    // StockData.org config
    STOCKDATA_TOKEN: 'H9IuvBwPXRLWDdJhnia5uwDsujNk106qGLyL3yW4',  // your token
    STOCKDATA_QUOTE_URL: 'https://api.stockdata.org/v1/data/quote',
    STOCKDATA_EOD_URL: 'https://api.stockdata.org/v1/data/eod',
    STOCKDATA_NEWS_URL: 'https://api.stockdata.org/v1/news/all',

    // Polling config
    refreshInterval: 60000,       // 1 min refresh
    historicalDays: 365           // how many days of history to fetch
};

/* STATE */
const state = {
    stockData: {},      // { symbol: { quote, history, news } }
    isLoading: false
};

/* UTILITIES */
function formatNumber(num) {
    if (num == null) return 'N/A';
    return num.toLocaleString();
}

/* ---------- STOCKDATA.ORG HELPERS ---------- */

/** Fetch quote for one or more symbols */
async function fetchQuote(symbols) {
    const url = new URL(CONFIG.STOCKDATA_QUOTE_URL);
    url.searchParams.set('api_token', CONFIG.STOCKDATA_TOKEN);
    url.searchParams.set('symbols', symbols.join(','));
    // you can optionally use key_by_ticker = true
    url.searchParams.set('key_by_ticker', 'true');

    const res = await fetch(url);
    if (!res.ok) {
        console.error('Error fetching quote', await res.text());
        return null;
    }
    const json = await res.json();
    return json.data;  // keyed by ticker
}

/** Fetch historical EOD data */
async function fetchHistorical(symbol) {
    const url = new URL(CONFIG.STOCKDATA_EOD_URL);
    url.searchParams.set('api_token', CONFIG.STOCKDATA_TOKEN);
    url.searchParams.set('symbols', symbol);
    // you can set date_from, date_to if you want a range
    // For simplicity: fetch last year
    // Here we don't set those, so get default or full history

    const res = await fetch(url);
    if (!res.ok) {
        console.error('Error fetching historical', await res.text());
        return null;
    }
    const json = await res.json();
    return json.data;  // array of { date, open, high, low, close, ... }
}

/** Fetch news for a symbol */
async function fetchNews(symbol) {
    const url = new URL(CONFIG.STOCKDATA_NEWS_URL);
    url.searchParams.set('api_token', CONFIG.STOCKDATA_TOKEN);
    url.searchParams.set('symbols', symbol);
    // optional: you can set `filter_entities=true` to only get relevant entity articles
    url.searchParams.set('filter_entities', 'true');
    url.searchParams.set('limit', '10');

    const res = await fetch(url);
    if (!res.ok) {
        console.error('Error fetching news', await res.text());
        return null;
    }
    const json = await res.json();
    return json.data;  // list of articles
}

/* ---------- RENDERING ---------- */

async function loadStock(symbol) {
    // fetch quote, historical, news in parallel
    const [quoteData, historyData, newsData] = await Promise.all([
        fetchQuote([symbol]),
        fetchHistorical(symbol),
        fetchNews(symbol)
    ]);

    const quote = quoteData ? quoteData[symbol] : null;

    state.stockData[symbol] = {
        symbol,
        quote,
        history: historyData,
        news: newsData
    };
}

/** Renders a simple card — you can extend as you want */
function renderStocks() {
    const root = document.getElementById('stockGrid');
    root.innerHTML = '';

    Object.values(state.stockData).forEach(stock => {
        const div = document.createElement('div');
        div.className = 'stock-card';

        const price = stock.quote ? stock.quote.price : 'N/A';
        const high = stock.quote ? stock.quote.day_high : 'N/A';
        const low = stock.quote ? stock.quote.day_low : 'N/A';
        const prevClose = stock.quote ? stock.quote.previous_close_price : 'N/A';

        div.innerHTML = `
            <h3>${stock.symbol}</h3>
            <p>Price: ${price}</p>
            <p>High: ${high} / Low: ${low}</p>
            <p>Prev Close: ${prevClose}</p>
            <button data-symbol="${stock.symbol}" class="btn-news">Show News</button>
        `;

        const btn = div.querySelector('.btn-news');
        btn.addEventListener('click', () => {
            showNews(stock.symbol);
        });

        root.appendChild(div);
    });
}

function showNews(symbol) {
    const newsRoot = document.getElementById('newsContent');
    newsRoot.innerHTML = '';

    const newsList = state.stockData[symbol]?.news;
    if (!newsList) {
        newsRoot.innerHTML = `<p>No news</p>`;
        return;
    }

    newsList.forEach(article => {
        const a = document.createElement('a');
        a.href = article.url;
        a.target = '_blank';
        a.textContent = article.title;
        newsRoot.appendChild(a);
        newsRoot.appendChild(document.createElement('br'));
    });
}

/* ---------- BOOTSTRAP ---------- */

async function loadAll() {
    state.isLoading = true;
    for (const sym of CONFIG.stocks) {
        await loadStock(sym);
    }
    state.isLoading = false;
    renderStocks();
}

document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    setInterval(loadAll, CONFIG.refreshInterval);
});

