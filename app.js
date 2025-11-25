// =====================
// app.js - Full file
// Replace FINNHUB_KEY and NEWS_API_KEY with actual values
// =====================

/* CONFIG */
const CONFIG = {
    // initial quick list (we still allow searching ANY symbol)
    stocks: ['GOOGL', 'AAPL', 'MSFT', 'AMZN', 'TSLA', 'NVDA'],

    // Finnhub REST + websocket
    FINNHUB_KEY: 'd4ivcg1r01queuakp4pgd4ivcg1r01queuakp4q0', // <-- REPLACE with your Finnhub key
    FINNHUB_REST_SEARCH: 'https://finnhub.io/api/v1/search?q=',
    FINNHUB_QUOTE: 'https://finnhub.io/api/v1/quote?symbol=',
    FINNHUB_CANDLE: 'https://finnhub.io/api/v1/stock/candle', // params: symbol, resolution, from, to

    // News API (same placeholder)
    NEWS_API_KEY: 'YOUR_NEWS_API_KEY',
    NEWS_API_URL: 'https://newsapi.org/v2/everything',

    // Polling fallback
    refreshInterval: 60000, // 60s
    restFallbackInterval: 8000, // when websocket unavailable, poll every 8s
    retryAttempts: 3
};


/* STATE */
const state = {
    stockData: {},       // keyed by ticker
    selectedStock: null,
    charts: {},
    isLoading: false,
    lastUpdate: null,
    useFallback: false,
    wsConnected: false,
    wsSubscribed: new Set(),
    searchHistory: [],
    pinned: new Set()
};


/* ---------- UTILITIES ---------- */

function formatNumber(num) {
    if (!num && num !== 0) return 'N/A';
    if (num >= 1e12) return '$' + (num / 1e12).toFixed(2) + 'T';
    if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    return num.toLocaleString();
}

function calculatePrediction(historicalPrices) {
    if (!historicalPrices || historicalPrices.length < 5) return null;
    const recent = historicalPrices.slice(-10);
    const sum = recent.reduce((a, b) => a + b, 0);
    const avg = sum / recent.length;
    const trend = recent[recent.length - 1] - recent[0];
    const volatility = Math.sqrt(recent.reduce((acc, p) => acc + Math.pow(p - avg, 2), 0) / recent.length);
    const momentum = (recent.slice(-3).reduce((a, b) => a + b, 0) / 3) - avg;
    const prediction = recent[recent.length - 1] + trend * 0.3 + momentum * 0.2;
    const confidence = Math.max(50, Math.min(95, 70 - (volatility / avg) * 100));
    return {
        predictedPrice: prediction,
        confidence: confidence.toFixed(1),
        direction: prediction > recent[recent.length - 1] ? 'up' : 'down',
        volatility: volatility.toFixed(2)
    };
}


/* ---------- FINNHUB REST HELPERS ---------- */

/**
 * Search autocomplete using Finnhub
 * returns array of matches: { symbol, description, type }
 */
async function finnhubSearch(q) {
    if (!q) return [];
    const token = CONFIG.FINNHUB_KEY;
    if (!token || token === 'FINNHUB_API_KEY_HERE') return []; // placeholder, avoid calling if not set
    try {
        const res = await fetch(`${CONFIG.FINNHUB_REST_SEARCH}${encodeURIComponent(q)}&token=${token}`);
        if (!res.ok) return [];
        const json = await res.json();
        return json.result || [];
    } catch (err) {
        console.warn('Finnhub search error', err);
        return [];
    }
}

/**
 * Finnhub quote (current)
 */
async function finnhubQuote(symbol) {
    const token = CONFIG.FINNHUB_KEY;
    if (!token || token === 'FINNHUB_API_KEY_HERE') return null;
    try {
        const res = await fetch(`${CONFIG.FINNHUB_QUOTE}${encodeURIComponent(symbol)}&token=${token}`);
        if (!res.ok) throw new Error('quote failed');
        return res.json();
    } catch (err) {
        console.warn('Finnhub quote error', err);
        return null;
    }
}

/**
 * Finnhub candles (for last N points)
 * resolution can be '1', '5', '15', '60', 'D'
 */
async function finnhubCandles(symbol, resolution = '5', rangeMinutes = 100) {
    const token = CONFIG.FINNHUB_KEY;
    if (!token || token === 'FINNHUB_API_KEY_HERE') return null;
    try {
        const now = Math.floor(Date.now() / 1000);
        const from = now - rangeMinutes * 60;
        const url = `${CONFIG.FINNHUB_CANDLE}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${token}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('candles failed');
        const json = await res.json();
        if (json.s !== 'ok') return null;
        // build array of { time, price }
        const data = json.t.map((ts, i) => ({
            time: new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            price: json.c[i]
        }));
        return data;
    } catch (err) {
        console.warn('Finnhub candles error', err);
        return null;
    }
}

/* ---------- NEWS ---------- */
async function fetchNews(query) {
    // newsapi.org usage
    const key = CONFIG.NEWS_API_KEY;
    if (!key || key === 'YOUR_NEWS_API_KEY') {
        return [{
            title: 'News API Configuration Required',
            description: 'Please add your News API key from newsapi.org to see real-time news articles.',
            source: { name: 'System' },
            publishedAt: new Date().toISOString(),
            urlToImage: null,
            url: 'https://newsapi.org'
        }];
    }
    try {
        const url = `${CONFIG.NEWS_API_URL}?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=6&apiKey=${key}&language=en`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('news fetch failed');
        const json = await res.json();
        return json.articles && json.articles.length ? json.articles : [{
            title: 'No Recent News Found',
            description: `No recent news articles found for ${query}.`,
            source: { name: 'System' },
            publishedAt: new Date().toISOString(),
            urlToImage: null,
            url: null
        }];
    } catch (err) {
        console.error('Error fetching news:', err);
        return [{
            title: 'Error Loading News',
            description: 'Unable to fetch news at this time. Please try again later.',
            source: { name: 'System' },
            publishedAt: new Date().toISOString(),
            urlToImage: null,
            url: null
        }];
    }
}

/* ---------- RENDERING ---------- */

function updateLastUpdateTime() {
    const el = document.getElementById('lastUpdateTime');
    if (!state.lastUpdate) return;
    el.textContent = state.lastUpdate.toLocaleTimeString();
}

/**
 * Render the small search history chips and pinned list
 */
function renderHistoryAndPinned() {
    const historyRoot = document.getElementById('searchHistory');
    const pinnedRoot = document.getElementById('pinnedList');
    historyRoot.innerHTML = '';
    pinnedRoot.innerHTML = '';

    state.searchHistory.slice().reverse().slice(0, 10).forEach(symbol => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = symbol;
        chip.onclick = () => {
            document.getElementById('searchInput').value = symbol;
            handleSearchSymbol(symbol);
        };
        historyRoot.appendChild(chip);
    });

    Array.from(state.pinned).forEach(symbol => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.innerHTML = `${symbol} <i class="fas fa-thumbtack" style="margin-left:8px; color: #ffd700;"></i>`;
        chip.onclick = () => {
            document.getElementById('searchInput').value = symbol;
            handleSearchSymbol(symbol);
        };
        pinnedRoot.appendChild(chip);
    });
}

function renderNews(articles) {
    const newsContent = document.getElementById('newsContent');
    if (!articles || articles.length === 0) {
        newsContent.innerHTML = `<div class="loading-state"><p>No news available</p></div>`;
        return;
    }

    newsContent.innerHTML = articles.map((article, idx) => `
        <div class="news-article" style="animation-delay:${idx*0.05}s;">
            <div style="display:flex; gap:0.6rem;">
                ${article.urlToImage ? `<img src="${article.urlToImage}" style="width:100px;height:80px;object-fit:cover;border-radius:8px;" onerror="this.style.display='none'">` : `<div style="width:100px;height:80px;border-radius:8px;background:#0f1724;display:flex;align-items:center;justify-content:center;color:var(--text-muted)"><i class="fas fa-newspaper"></i></div>`}
                <div style="flex:1;">
                    <h4 style="font-size:0.95rem;margin-bottom:6px;">${article.title}</h4>
                    ${article.description ? `<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:6px;">${article.description}</p>` : ''}
                    <div style="font-size:0.8rem;color:var(--text-muted)">${new Date(article.publishedAt).toLocaleString()} • ${article.source.name}</div>
                    ${article.url ? `<a href="${article.url}" target="_blank" style="display:inline-block;margin-top:6px;color:var(--accent-bull);font-weight:700;">Read full article <i class="fas fa-arrow-right"></i></a>` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

/* Render stock cards */
function renderStockCards() {
    const root = document.getElementById('stockGrid');
    root.innerHTML = '';

    // add fallback warning if needed
    if (state.useFallback) {
        const warn = document.createElement('div');
        warn.style.cssText = `grid-column:1/-1;padding:1rem;border-radius:10px;background:linear-gradient(135deg, rgba(255,195,0,0.06), rgba(255,130,0,0.03));color:#ffd700;border:1px solid rgba(255,195,0,0.1);margin-bottom:0.75rem;`;
        warn.textContent = 'Using demo data. Real-time updates may not be available.';
        root.appendChild(warn);
    }

    CONFIG.stocks.forEach((ticker, idx) => {
        const data = state.stockData[ticker];
        const card = document.createElement('div');
        card.className = 'stock-card';
        card.style.animationDelay = `${idx * 0.03}s`;

        if (!data) {
            card.innerHTML = `<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading ${ticker}...</p></div>`;
        } else {
            const isPositive = data.change >= 0;
            card.innerHTML = `
                <div class="stock-header">
                    <div class="stock-info">
                        <h3>${data.ticker}</h3>
                        <p>${data.name || data.ticker}</p>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <div class="stock-badge ${isPositive ? 'positive' : 'negative'}">
                            <i class="fas fa-arrow-${isPositive ? 'up' : 'down'}"></i>
                            <span style="margin-left:6px;">${Math.abs((data.changePercent||0)).toFixed(2)}%</span>
                        </div>
                        <button class="chip" title="Pin/unpin" style="padding:6px;border-radius:6px;margin-left:6px;" data-pin="${data.ticker}">${state.pinned.has(data.ticker) ? '<i class="fas fa-thumbtack"></i>' : '<i class="far fa-thumbtack"></i>'}</button>
                    </div>
                </div>

                <div>
                    <div class="current-price" style="font-size:1.4rem;font-weight:800;color:#ffd700;">$${(data.price || 0).toFixed ? (data.price).toFixed(2) : data.price}</div>
                    <div style="color:var(--text-secondary);font-size:0.85rem;">Volume: ${formatNumber(data.volume)}</div>
                </div>

                <div class="stock-chart"><canvas id="chart-${data.ticker}"></canvas></div>

                ${data.prediction ? `
                    <div style="display:flex;justify-content:space-between;gap:12px;margin-top:8px;">
                        <div style="flex:1;">
                            <div style="font-size:0.8rem;color:var(--text-muted);">Next Target</div>
                            <div style="font-weight:800;font-family:'Courier New',monospace;color:#ffd700;">$${data.prediction.predictedPrice.toFixed(2)}</div>
                        </div>
                        <div style="flex:1;">
                            <div style="font-size:0.8rem;color:var(--text-muted);">Confidence</div>
                            <div style="font-weight:800;">${data.prediction.confidence}%</div>
                        </div>
                    </div>
                ` : ''}
            `;

            card.querySelector('[data-pin]')?.addEventListener('click', (e) => {
                const sym = e.currentTarget.getAttribute('data-pin');
                if (state.pinned.has(sym)) state.pinned.delete(sym);
                else state.pinned.add(sym);
                renderHistoryAndPinned();
                renderStockCards();
            });

            card.addEventListener('click', () => {
                handleSelectTicker(data.ticker);
            });
        }

        root.appendChild(card);

        // render chart if we have historical
        if (data && data.historicalData) {
            setTimeout(() => renderChart(data.ticker, data), 120);
        }
    });
}

/* Chart rendering */
function renderChart(ticker, data) {
    const canvas = document.getElementById(`chart-${ticker}`);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (state.charts[ticker]) {
        try { state.charts[ticker].destroy(); } catch (e) {}
    }

    const isPositive = (data.change || 0) >= 0;
    const borderColor = isPositive ? 'rgba(0,255,136,1)' : 'rgba(255,77,77,1)';
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, isPositive ? 'rgba(0,255,136,0.15)' : 'rgba(255,77,77,0.12)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');

    state.charts[ticker] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: (data.historicalData || []).map(d => d.time),
            datasets: [{
                data: (data.historicalData || []).map(d => d.price),
                borderColor,
                backgroundColor: gradient,
                fill: true,
                tension: 0.3,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => `$${ctx.parsed.y.toFixed(2)}` } }
            },
            scales: { x: { display: false }, y: { display: false } }
        }
    });
}

/* STOCK LOADING / SELECTION */

async function seedStockData(ticker) {
    // Attempt Finnhub REST quote + candles, fallback to simple placeholder
    try {
        const quote = await finnhubQuote(ticker);
        let candles = await finnhubCandles(ticker, '5', 120);
        if (!candles || candles.length === 0) {
            // fallback try different resolution
            candles = await finnhubCandles(ticker, '15', 240);
        }

        const currentPrice = (quote && quote.c) ? quote.c : (quote && quote.pc) ? quote.pc : (state.stockData[ticker]?.price || null);
        const prevClose = quote && quote.pc ? quote.pc : (state.stockData[ticker]?.previousClose || null);
        const change = currentPrice != null && prevClose != null ? (currentPrice - prevClose) : (state.stockData[ticker]?.change || 0);
        const changePercent = prevClose ? (change / prevClose) * 100 : (state.stockData[ticker]?.changePercent || 0);

        const hist = (candles && candles.length) ? candles : (state.stockData[ticker]?.historicalData || generateFallbackHistorical(currentPrice || 100));

        const prediction = calculatePrediction(hist.map(h => h.price));

        const data = {
            ticker,
            name: state.stockData[ticker]?.name || ticker,
            price: currentPrice || (state.stockData[ticker]?.price || 0),
            change,
            changePercent,
            volume: quote && quote.v ? quote.v : (state.stockData[ticker]?.volume || null),
            marketCap: state.stockData[ticker]?.marketCap || null,
            historicalData: hist,
            prediction,
            lastUpdate: new Date()
        };

        state.stockData[ticker] = data;
        state.lastUpdate = new Date();
        updateLastUpdateTime();
        return data;
    } catch (err) {
        console.warn('seedStockData fallback for', ticker, err);
        // fallback to whatever exists
        state.useFallback = true;
        if (!state.stockData[ticker]) {
            state.stockData[ticker] = {
                ticker,
                name: ticker,
                price: 100,
                change: 0,
                changePercent: 0,
                volume: 0,
                historicalData: generateFallbackHistorical(100),
                prediction: null,
                lastUpdate: new Date()
            };
        }
        return state.stockData[ticker];
    }
}

function generateFallbackHistorical(currentPrice) {
    const arr = [];
    let price = currentPrice || 100;
    for (let i = 0; i < 20; i++) {
        price = price + (Math.random() - 0.5) * (currentPrice * 0.01);
        arr.push({ time: `${i}`, price: Math.max(price, 1) });
    }
    return arr;
}

/* Load all configured stocks (initial grid) */
async function loadAllStocks() {
    if (state.isLoading) return;
    state.isLoading = true;
    document.getElementById('refreshBtn').disabled = true;

    try {
        const promises = CONFIG.stocks.map(sym => seedStockData(sym));
        await Promise.all(promises);
        renderStockCards();
    } catch (err) {
        console.error('Error loading stocks', err);
    } finally {
        state.isLoading = false;
        document.getElementById('refreshBtn').disabled = false;
    }
}

/* Handle selecting a ticker from card or search */
async function handleSelectTicker(ticker) {
    state.selectedStock = ticker;
    document.getElementById('detailsSection').style.display = 'block';
    document.getElementById('newsCompanyName').textContent = ticker;

    // ensure data exists and is fresh
    await seedStockData(ticker);
    renderStockDetails(ticker);

    // fetch news
    const news = await fetchNews(state.stockData[ticker].name || ticker);
    renderNews(news);

    // subscribe to WS updates for this symbol (and keep it subscribed)
    subscribeToSymbol(ticker);

    // scroll into view
    document.getElementById('detailsSection').scrollIntoView({ behavior: 'smooth' });
}

function renderStockDetails(ticker) {
    const data = state.stockData[ticker];
    if (!data) return;
    const root = document.getElementById('detailsContent');

    const isPositive = data.change > 0;
    root.innerHTML = `
        <div style="margin-bottom:1rem;">
            <label style="color:var(--text-muted);font-size:0.85rem;">Current Price</label>
            <div style="font-family: 'Courier New', monospace; font-weight:800; font-size:1.8rem; color:#ffd700;">$${(data.price||0).toFixed(2)}</div>
            <div style="color:${isPositive ? '#00ff88' : '#ff6b6b'}; font-weight:700;">${isPositive ? '+' : ''}${(data.change||0).toFixed(2)} (${isPositive ? '+' : ''}${(data.changePercent||0).toFixed(2)}%)</div>
        </div>

        ${data.prediction ? `
        <div style="margin-bottom:1rem; padding:0.75rem; border-radius:8px; background:linear-gradient(135deg, rgba(0,255,136,0.03), rgba(58,134,255,0.02));">
            <label style="color:var(--text-muted);">AI Prediction</label>
            <div style="font-weight:800; font-family:'Courier New', monospace; font-size:1.4rem; color:#ffd700;">$${data.prediction.predictedPrice.toFixed(2)}</div>
            <div style="display:flex;gap:12px;margin-top:6px;">
                <div><small style="color:var(--text-muted)">Confidence</small><div style="font-weight:700">${data.prediction.confidence}%</div></div>
                <div><small style="color:var(--text-muted)">Direction</small><div style="font-weight:700">${data.prediction.direction}</div></div>
            </div>
        </div>` : ''}

        <div style="display:flex;gap:12px;margin-bottom:8px;">
            <div style="flex:1;background:rgba(255,255,255,0.02);padding:8px;border-radius:8px;"><small style="color:var(--text-muted)">Volume</small><div style="font-weight:800">${formatNumber(data.volume)}</div></div>
            <div style="flex:1;background:rgba(255,255,255,0.02);padding:8px;border-radius:8px;"><small style="color:var(--text-muted)">Market Cap</small><div style="font-weight:800">${formatNumber(data.marketCap)}</div></div>
        </div>
    `;
}

/* ---------- SEARCH & AUTOCOMPLETE ---------- */

const autocompleteRoot = document.getElementById('autocompleteList');
let autocompleteTimer = null;

document.getElementById('searchInput').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if (!q) { autocompleteRoot.style.display = 'none'; return; }
    // debounce
    if (autocompleteTimer) clearTimeout(autocompleteTimer);
    autocompleteTimer = setTimeout(async () => {
        const results = await finnhubSearch(q);
        if (!results || results.length === 0) { autocompleteRoot.style.display = 'none'; return; }
        autocompleteRoot.innerHTML = results.slice(0, 8).map(r => `
            <div class="autocomplete-item" data-symbol="${r.symbol}">
                <div>
                    <div class="symbol">${r.symbol}</div>
                    <div class="desc">${r.description || ''}</div>
                </div>
                <div style="color:var(--text-muted);font-size:0.85rem">${r.type || ''}</div>
            </div>
        `).join('');
        // attach click handlers
        autocompleteRoot.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
                const sym = item.getAttribute('data-symbol');
                document.getElementById('searchInput').value = sym;
                autocompleteRoot.style.display = 'none';
                handleSearchSymbol(sym);
            });
        });
        autocompleteRoot.style.display = 'block';
    }, 250);
});

document.addEventListener('click', (e) => {
    if (!document.getElementById('searchBoxRoot').contains(e.target)) {
        autocompleteRoot.style.display = 'none';
    }
});

document.getElementById('searchBtn').addEventListener('click', () => {
    const q = document.getElementById('searchInput').value.trim().toUpperCase();
    if (!q) return;
    handleSearchSymbol(q);
});

document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const q = document.getElementById('searchInput').value.trim().toUpperCase();
        if (!q) return;
        handleSearchSymbol(q);
    }
});

async function handleSearchSymbol(symbol) {
    // add to history
    if (!state.searchHistory.includes(symbol)) {
        state.searchHistory.push(symbol);
        if (state.searchHistory.length > 50) state.searchHistory.shift();
    }
    renderHistoryAndPinned();

    // If not in configured list, add at the top
    if (!CONFIG.stocks.includes(symbol)) {
        CONFIG.stocks.unshift(symbol);
    } else {
        // move to front for visibility
        CONFIG.stocks = [symbol, ...CONFIG.stocks.filter(s => s !== symbol)];
    }

    // fetch / seed data
    await seedStockData(symbol);
    renderStockCards();
    handleSelectTicker(symbol);
}

/* ---------- WEBSOCKET (Finnhub) ---------- */

let finnhubSocket = null;
let reconnectAttempts = 0;

function setupFinnhubSocket() {
    const key = CONFIG.FINNHUB_KEY;
    if (!key || key === 'FINNHUB_API_KEY_HERE') {
        console.warn('Finnhub key not set. WebSocket disabled.');
        updateLiveIndicator(false);
        return;
    }
    try {
        finnhubSocket = new WebSocket(`wss://ws.finnhub.io?token=${key}`);

        finnhubSocket.addEventListener('open', () => {
            console.log('Finnhub WS connected');
            state.wsConnected = true;
            reconnectAttempts = 0;
            updateLiveIndicator(true);

            // resubscribe to current set
            state.wsSubscribed.forEach(sym => {
                try { finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol: sym })); } catch (e) {}
            });
        });

        finnhubSocket.addEventListener('message', (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                // msg example: {type:'trade',data:[{s:'AAPL',p:324.23,t:159...}]}
                if (msg.type === 'trade' && msg.data && msg.data.length > 0) {
                    msg.data.forEach(tr => {
                        const symbol = tr.s;
                        const price = tr.p;
                        const ts = tr.t;
                        // update local state.price
                        if (!state.stockData[symbol]) {
                            // create minimal placeholder
                            state.stockData[symbol] = { ticker: symbol, price, historicalData: [{ time: new Date(ts).toLocaleTimeString(), price }], prediction: null, change: 0, changePercent: 0 };
                        } else {
                            // patch price & push into historicalData
                            const sd = state.stockData[symbol];
                            sd.price = price;
                            sd.lastUpdate = new Date(ts);
                            // push last point
                            const nowLabel = new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
                            const hd = sd.historicalData || [];
                            hd.push({ time: nowLabel, price });
                            if (hd.length > 40) hd.shift();
                            sd.historicalData = hd;
                            // recompute change if previous close available
                            if (sd.previousClose) {
                                sd.change = sd.price - sd.previousClose;
                                sd.changePercent = sd.previousClose ? (sd.change / sd.previousClose) * 100 : 0;
                            }
                            state.stockData[symbol] = sd;
                        }
                        // update UI for that card & chart
                        patchCardAndChart(symbol);
                    });
                } else if (msg.type === 'ping') {
                    // ignore
                }
            } catch (err) {
                console.error('WS parse error', err);
            }
        });

        finnhubSocket.addEventListener('close', () => {
            console.warn('Finnhub WS closed');
            state.wsConnected = false;
            updateLiveIndicator(false);
            tryReconnectFinnhub();
        });

        finnhubSocket.addEventListener('error', (err) => {
            console.error('Finnhub WS error', err);
            state.wsConnected = false;
            updateLiveIndicator(false);
            tryReconnectFinnhub();
        });

    } catch (err) {
        console.error('Failed to initialize Finnhub WS', err);
        updateLiveIndicator(false);
    }
}

function tryReconnectFinnhub() {
    reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
    setTimeout(() => {
        console.log('Reconnecting Finnhub WS attempt', reconnectAttempts);
        setupFinnhubSocket();
    }, delay);
}

function subscribeToSymbol(symbol) {
    if (!symbol) return;
    state.wsSubscribed.add(symbol);
    if (finnhubSocket && state.wsConnected) {
        try { finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol })); } catch (e) { console.warn('subscribe send failed', e); }
    }
}

/* Unsubscribe (optional) */
function unsubscribeFromSymbol(symbol) {
    if (!symbol) return;
    state.wsSubscribed.delete(symbol);
    if (finnhubSocket && state.wsConnected) {
        try { finnhubSocket.send(JSON.stringify({ type: 'unsubscribe', symbol })); } catch (e) { console.warn('unsubscribe send failed', e); }
    }
}

function updateLiveIndicator(isLive) {
    const el = document.getElementById('liveIndicator');
    if (!el) return;
    if (isLive) {
        el.textContent = '• Live';
        el.style.color = '#00ff88';
    } else {
        el.textContent = '• Offline (polling)';
        el.style.color = '#ffd700';
    }
}

/* Patch a single card/chart when trades stream in */
function patchCardAndChart(symbol) {
    // re-render card if present
    renderStockCards();
    // re-render details panel if selected
    if (state.selectedStock === symbol) {
        renderStockDetails(symbol);
    }
    // update last update time
    state.lastUpdate = new Date();
    updateLastUpdateTime();
}

/* ---------- POLLING / FALLBACK ---------- */

let fallbackPollTimer = null;
function startFallbackPolling() {
    if (fallbackPollTimer) clearInterval(fallbackPollTimer);
    fallbackPollTimer = setInterval(async () => {
        // poll only pinned + visible stocks to reduce load
        const targets = Array.from(new Set([...Array.from(state.pinned), ...CONFIG.stocks.slice(0, 10)]));
        for (const sym of targets) {
            try { await seedStockData(sym); } catch (e) {}
        }
        renderStockCards();
    }, CONFIG.restFallbackInterval);
}

/* ---------- BOOTSTRAP ---------- */

document.addEventListener('DOMContentLoaded', async () => {
    // initial seed from preconfigured stocks
    await loadAllStocks();

    // init ws and fallback
    setupFinnhubSocket();
    startFallbackPolling();

    // event listeners
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadAllStocks();
    });

    // render history/pinned initially
    renderHistoryAndPinned();

    console.log('Initialized dashboard. Replace FINNHUB_KEY & NEWS_API_KEY in app.js for live functionality.');
});


/* ---------- EXTRA NOTES ----------
 - Replace CONFIG.FINNHUB_KEY with your Finnhub key.
 - Replace CONFIG.NEWS_API_KEY with your NewsAPI key for articles.
 - Finnhub websocket provides trade updates. REST endpoints are used for candlesticks & quotes.
 - The code gracefully degrades if keys are placeholders (autocomplete / ws disabled).
 ----------------------------------- */
