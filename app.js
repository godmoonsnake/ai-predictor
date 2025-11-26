
// app.js - FINAL MERGED (Finnhub + StockData.org)
// NOTE: Replace CONFIG.FINNHUB_KEY and CONFIG.STOCKDATA_TOKEN and CONFIG.NEWS_API_KEY with your real keys.

const CONFIG = {
    stocks: ['GOOGL', 'AAPL', 'MSFT', 'AMZN', 'TSLA', 'NVDA'],

    // Finnhub
    FINNHUB_KEY: 'd4ivcg1r01queuakp4pgd4ivcg1r01queuakp4q0',
    FINNHUB_REST_SEARCH: 'https://finnhub.io/api/v1/search?q=',
    FINNHUB_QUOTE: 'https://finnhub.io/api/v1/quote?symbol=',
    FINNHUB_CANDLE: 'https://finnhub.io/api/v1/stock/candle',

    // StockData.org
    STOCKDATA_TOKEN: 'H9IuvBwPXRLWDdJhnia5uwDsujNk106qGLyL3yW4',
    STOCKDATA_QUOTE: 'https://api.stockdata.org/v1/data/quote',
    STOCKDATA_EOD: 'https://api.stockdata.org/v1/data/eod',
    STOCKDATA_NEWS: 'https://api.stockdata.org/v1/news/all',

    // News API (optional fallback)
    NEWS_API_KEY: '06e8ae8f37b549a5bb8727f9e46bbfc3',
    NEWS_API_URL: 'https://newsapi.org/v2/everything',

    // Intervals
    refreshInterval: 60000,
    restFallbackInterval: 8000,
    retryAttempts: 3
};

const state = {
    stockData: {},
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

/* ---------- Utilities ---------- */
function formatNumber(num) {
    if (num === null || num === undefined) return 'N/A';
    if (typeof num !== 'number') return num;
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
    const confidence = Math.max(50, Math.min(95, 70 - (volatility / (avg || 1)) * 100));
    return {
        predictedPrice: prediction,
        confidence: Number(confidence.toFixed(1)),
        direction: prediction > recent[recent.length - 1] ? 'up' : 'down',
        volatility: Number(volatility.toFixed(2))
    };
}

/* ---------- StockData.org helpers ---------- */
async function stockdataQuote(symbol) {
    try {
        const url = `${CONFIG.STOCKDATA_QUOTE}?symbols=${encodeURIComponent(symbol)}&api_token=${CONFIG.STOCKDATA_TOKEN}&key_by_ticker=true`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('stockdata quote failed');
        const json = await res.json();
        return json.data ? json.data[symbol] : null;
    } catch (e) {
        console.warn('StockData quote error', e);
        return null;
    }
}

async function stockdataEOD(symbol) {
    try {
        const url = `${CONFIG.STOCKDATA_EOD}?symbols=${encodeURIComponent(symbol)}&api_token=${CONFIG.STOCKDATA_TOKEN}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('stockdata eod failed');
        const json = await res.json();
        return json.data || [];
    } catch (e) {
        console.warn('StockData EOD error', e);
        return [];
    }
}

async function stockdataNews(symbol) {
    try {
        const url = `${CONFIG.STOCKDATA_NEWS}?symbols=${encodeURIComponent(symbol)}&filter_entities=true&limit=10&api_token=${CONFIG.STOCKDATA_TOKEN}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('stockdata news failed');
        const json = await res.json();
        return json.data || [];
    } catch (e) {
        console.warn('StockData NEWS error', e);
        return [];
    }
}

/* ---------- Finnhub helpers ---------- */
async function finnhubSearch(q) {
    if (!q) return [];
    const token = CONFIG.FINNHUB_KEY;
    if (!token) return [];
    try {
        const res = await fetch(`${CONFIG.FINNHUB_REST_SEARCH}${encodeURIComponent(q)}&token=${token}`);
        if (!res.ok) return [];
        const json = await res.json();
        return json.result || [];
    } catch (e) {
        console.warn('Finnhub search error', e);
        return [];
    }
}

async function finnhubQuote(symbol) {
    const token = CONFIG.FINNHUB_KEY;
    if (!token) return null;
    try {
        const res = await fetch(`${CONFIG.FINNHUB_QUOTE}${encodeURIComponent(symbol)}&token=${token}`);
        if (!res.ok) throw new Error('finnhub quote failed');
        return await res.json();
    } catch (e) {
        console.warn('Finnhub quote error', e);
        return null;
    }
}

async function finnhubCandles(symbol, resolution = '5', rangeMinutes = 120) {
    const token = CONFIG.FINNHUB_KEY;
    if (!token) return null;
    try {
        const now = Math.floor(Date.now() / 1000);
        const from = now - rangeMinutes * 60;
        const url = `${CONFIG.FINNHUB_CANDLE}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${token}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('finnhub candles failed');
        const json = await res.json();
        if (json.s !== 'ok') return null;
        return json.t.map((ts, i) => ({ time: new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), price: json.c[i] }));
    } catch (e) {
        console.warn('Finnhub candles error', e);
        return null;
    }
}

/* ---------- NEWS fallback (newsapi.org) ---------- */
async function fetchNewsFallback(query) {
    const key = CONFIG.NEWS_API_KEY;
    if (!key) return [];
    try {
        const url = `${CONFIG.NEWS_API_URL}?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=6&apiKey=${key}&language=en`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('news api failed');
        const json = await res.json();
        return json.articles || [];
    } catch (e) {
        console.warn('News API error', e);
        return [];
    }
}

/* ---------- Rendering helpers (minimal, safe re-use of user's DOM ids) ---------- */
function updateLastUpdateTime() {
    const el = document.getElementById('lastUpdateTime');
    if (!el) return;
    if (!state.lastUpdate) { el.textContent = ''; return; }
    el.textContent = state.lastUpdate.toLocaleTimeString();
}

function renderNews(articles) {
    const newsContent = document.getElementById('newsContent');
    if (!newsContent) return;
    if (!articles || articles.length === 0) {
        newsContent.innerHTML = `<div class="loading-state"><p>No news available</p></div>`;
        return;
    }
    newsContent.innerHTML = articles.map((article, idx) => `
        <div class="news-article" style="animation-delay:${idx*0.05}s;">
            <div style="display:flex; gap:0.6rem;">
                ${article.urlToImage ? `<img src="${article.urlToImage}" style="width:100px;height:80px;object-fit:cover;border-radius:8px;" onerror="this.style.display='none'">` : `<div style="width:100px;height:80px;border-radius:8px;background:#0f1724;display:flex;align-items:center;justify-content:center;color:var(--text-muted)"><i class="fas fa-newspaper"></i></div>`}
                <div style="flex:1;">
                    <h4 style="font-size:0.95rem;margin-bottom:6px;">${article.title || article.headline || 'Untitled'}</h4>
                    ${article.description ? `<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:6px;">${article.description}</p>` : ''}
                    <div style="font-size:0.8rem;color:var(--text-muted)">${new Date(article.publishedAt || article.published_at || Date.now()).toLocaleString()} • ${(article.source && article.source.name) || article.source || 'Unknown'}</div>
                    ${article.url ? `<a href="${article.url}" target="_blank" style="display:inline-block;margin-top:6px;color:var(--accent-bull);font-weight:700;">Read full article <i class="fas fa-arrow-right"></i></a>` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

/* ---------- Render stock cards & charts (kept compact) ---------- */
function renderHistoryAndPinned() {
    const historyRoot = document.getElementById('searchHistory');
    const pinnedRoot = document.getElementById('pinnedList');
    if (historyRoot) {
        historyRoot.innerHTML = '';
        state.searchHistory.slice().reverse().slice(0, 10).forEach(symbol => {
            const chip = document.createElement('div');
            chip.className = 'chip';
            chip.textContent = symbol;
            chip.onclick = () => { document.getElementById('searchInput').value = symbol; handleSearchSymbol(symbol); };
            historyRoot.appendChild(chip);
        });
    }
    if (pinnedRoot) {
        pinnedRoot.innerHTML = '';
        Array.from(state.pinned).forEach(symbol => {
            const chip = document.createElement('div');
            chip.className = 'chip';
            chip.innerHTML = `${symbol} <i class="fas fa-thumbtack" style="margin-left:8px; color: #ffd700;"></i>`;
            chip.onclick = () => { document.getElementById('searchInput').value = symbol; handleSearchSymbol(symbol); };
            pinnedRoot.appendChild(chip);
        });
    }
}

function renderStockCards() {
    const root = document.getElementById('stockGrid');
    if (!root) return;
    root.innerHTML = '';

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
            const isPositive = (data.change || 0) >= 0;
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
                        <button class="chip pin-btn" data-pin="${data.ticker}" title="Pin/unpin">${state.pinned.has(data.ticker) ? '<i class="fas fa-thumbtack"></i>' : '<i class="far fa-thumbtack"></i>'}</button>
                    </div>
                </div>

                <div>
                    <div class="current-price" style="font-size:1.4rem;font-weight:800;color:#ffd700;">$${(data.price || 0).toFixed ? (data.price).toFixed(2) : data.price}</div>
                    <div style="color:var(--text-secondary);font-size:0.85rem;">Volume: ${formatNumber(data.volume)}</div>
                </div>

                <div class="stock-chart"><canvas id="chart-${data.ticker}"></canvas></div>

                ${(data.prediction) ? `
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

            card.querySelector('.pin-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const sym = e.currentTarget.getAttribute('data-pin');
                if (state.pinned.has(sym)) state.pinned.delete(sym);
                else state.pinned.add(sym);
                renderHistoryAndPinned();
                renderStockCards();
            });

            card.addEventListener('click', () => { handleSelectTicker(data.ticker); });
        }

        root.appendChild(card);

        if (data && data.historicalData) {
            setTimeout(() => renderChart(data.ticker, data), 120);
        }
    });
}

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

/* ---------- Seed / Load logic (MERGED) ---------- */
function generateFallbackHistorical(currentPrice) {
    const arr = [];
    let price = currentPrice || 100;
    for (let i = 0; i < 30; i++) {
        price = price + (Math.random() - 0.5) * (currentPrice * 0.01);
        arr.push({ time: `${i}`, price: Math.max(price, 1) });
    }
    return arr;
}

async function seedStockData(ticker) {
    try {
        // 1) request both quotes in parallel
        const [fhQuote, sdQuote] = await Promise.all([
            finnhubQuote(ticker).catch(() => null),
            stockdataQuote(ticker).catch(() => null)
        ]);

        // choose freshest price: prefer StockData if it has timestamp
        let currentPrice = null;
        let prevClose = null;
        let volume = null;
        let marketCap = null;

        if (sdQuote && sdQuote.price != null) {
            currentPrice = sdQuote.price;
            prevClose = sdQuote.previous_close_price ?? sdQuote.prev_close ?? sdQuote.previous_close_price;
            volume = sdQuote.volume ?? sdQuote.v;
            marketCap = sdQuote.market_cap ?? sdQuote.market_capitalization;
        }
        if ((!currentPrice || currentPrice === 0) && fhQuote && fhQuote.c != null) {
            currentPrice = fhQuote.c;
            prevClose = prevClose || fhQuote.pc;
            volume = volume || fhQuote.v;
        }

        // 2) Intraday candles: always prefer Finnhub (if available)
        let candles = await finnhubCandles(ticker, '5', 180);
        if (!candles || candles.length === 0) {
            candles = await finnhubCandles(ticker, '15', 360);
        }
        if (!candles || candles.length === 0) {
            candles = (state.stockData[ticker]?.historicalData) || generateFallbackHistorical(currentPrice || 100);
        }

        // 3) EOD history from StockData
        const eod = await stockdataEOD(ticker).catch(() => []);
        const eodPrices = eod && eod.length ? eod.map(d => d.close).filter(v => v != null) : [];
        const prediction = eodPrices.length ? calculatePrediction(eodPrices) : calculatePrediction((candles||[]).map(c=>c.price));

        const change = (currentPrice != null && prevClose != null) ? (currentPrice - prevClose) : ((state.stockData[ticker] && state.stockData[ticker].change) || 0);
        const changePercent = prevClose ? (change / prevClose) * 100 : (state.stockData[ticker]?.changePercent || 0);

        state.stockData[ticker] = {
            ticker,
            name: state.stockData[ticker]?.name || ticker,
            price: currentPrice != null ? currentPrice : (state.stockData[ticker]?.price || 0),
            previousClose: prevClose,
            change,
            changePercent,
            volume,
            marketCap,
            historicalData: candles,
            eodHistory: eod,
            prediction,
            lastUpdate: new Date()
        };

        state.lastUpdate = new Date();
        updateLastUpdateTime();
        return state.stockData[ticker];
    } catch (err) {
        console.warn('seedStockData merged error', err);
        state.useFallback = true;
        if (!state.stockData[ticker]) {
            state.stockData[ticker] = {
                ticker,
                name: ticker,
                price: 100,
                change: 0,
                changePercent: 0,
                volume: 0,
                marketCap: null,
                historicalData: generateFallbackHistorical(100),
                prediction: null,
                lastUpdate: new Date()
            };
        }
        return state.stockData[ticker];
    }
}

/* ---------- Search & Autocomplete ---------- */
const autocompleteRoot = document.getElementById && document.getElementById('autocompleteList');
let autocompleteTimer = null;

if (document.getElementById) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', async (e) => {
            const q = e.target.value.trim();
            if (!q) { if (autocompleteRoot) autocompleteRoot.style.display = 'none'; return; }
            if (autocompleteTimer) clearTimeout(autocompleteTimer);
            autocompleteTimer = setTimeout(async () => {
                const results = await finnhubSearch(q);
                if (!results || results.length === 0) { if (autocompleteRoot) autocompleteRoot.style.display = 'none'; return; }
                if (!autocompleteRoot) return;
                autocompleteRoot.innerHTML = results.slice(0, 8).map(r => `
                    <div class="autocomplete-item" data-symbol="${r.symbol}">
                        <div>
                            <div class="symbol">${r.symbol}</div>
                            <div class="desc">${r.description || ''}</div>
                        </div>
                        <div style="color:var(--text-muted);font-size:0.85rem">${r.type || ''}</div>
                    </div>
                `).join('');
                autocompleteRoot.querySelectorAll('.autocomplete-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const sym = item.getAttribute('data-symbol');
                        const input = document.getElementById('searchInput');
                        if (input) input.value = sym;
                        if (autocompleteRoot) autocompleteRoot.style.display = 'none';
                        handleSearchSymbol(sym);
                    });
                });
                autocompleteRoot.style.display = 'block';
            }, 250);
        });
    }
}

/* ---------- WebSocket (Finnhub) ---------- */
let finnhubSocket = null;
let reconnectAttempts = 0;

function updateLiveIndicator(isLive) {
    const el = document.getElementById('liveIndicator');
    if (!el) return;
    if (isLive) { el.textContent = '• Live'; el.style.color = '#00ff88'; }
    else { el.textContent = '• Offline (polling)'; el.style.color = '#ffd700'; }
}

function setupFinnhubSocket() {
    const key = CONFIG.FINNHUB_KEY;
    if (!key || key === 'YOUR_FINNHUB_KEY') {
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
            state.wsSubscribed.forEach(sym => {
                try { finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol: sym })); } catch (e) {}
            });
        });

        finnhubSocket.addEventListener('message', (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'trade' && msg.data && msg.data.length) {
                    msg.data.forEach(tr => {
                        const symbol = tr.s;
                        const price = tr.p;
                        const ts = tr.t;
                        if (!state.stockData[symbol]) {
                            state.stockData[symbol] = { ticker: symbol, price, historicalData: [{ time: new Date(ts).toLocaleTimeString(), price }], prediction: null, change: 0, changePercent: 0, previousClose: null };
                        } else {
                            const sd = state.stockData[symbol];
                            sd.price = price;
                            sd.lastUpdate = new Date(ts);
                            const nowLabel = new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
                            const hd = sd.historicalData || [];
                            hd.push({ time: nowLabel, price });
                            if (hd.length > 80) hd.shift();
                            sd.historicalData = hd;
                            if (sd.previousClose) {
                                sd.change = sd.price - sd.previousClose;
                                sd.changePercent = sd.previousClose ? (sd.change / sd.previousClose) * 100 : 0;
                            }
                            state.stockData[symbol] = sd;
                        }
                        patchCardAndChart(symbol);
                    });
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
    setTimeout(setupFinnhubSocket, delay);
}

function subscribeToSymbol(symbol) {
    if (!symbol) return;
    state.wsSubscribed.add(symbol);
    if (finnhubSocket && state.wsConnected) {
        try { finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol })); } catch (e) {}
    }
}

function unsubscribeFromSymbol(symbol) {
    if (!symbol) return;
    state.wsSubscribed.delete(symbol);
    if (finnhubSocket && state.wsConnected) {
        try { finnhubSocket.send(JSON.stringify({ type: 'unsubscribe', symbol })); } catch (e) {}
    }
}

/* ---------- Patch UI when streaming ---------- */
function patchCardAndChart(symbol) {
    renderStockCards();
    if (state.selectedStock === symbol) renderStockDetails(symbol);
    state.lastUpdate = new Date();
    updateLastUpdateTime();
}

/* ---------- Polling fallback ---------- */
let fallbackPollTimer = null;
function startFallbackPolling() {
    if (fallbackPollTimer) clearInterval(fallbackPollTimer);
    fallbackPollTimer = setInterval(async () => {
        const targets = Array.from(new Set([...Array.from(state.pinned), ...CONFIG.stocks.slice(0, 10)]));
        for (const sym of targets) {
            try { await seedStockData(sym); } catch (e) {}
        }
        renderStockCards();
    }, CONFIG.restFallbackInterval);
}

/* ---------- Details panel ---------- */
function renderStockDetails(ticker) {
    const data = state.stockData[ticker];
    if (!data) return;
    const root = document.getElementById('detailsContent');
    if (!root) return;
    const isPositive = (data.change || 0) > 0;
    root.innerHTML = `
        <div style="margin-bottom:1rem;">
            <label style="color:var(--text-muted);font-size:0.85rem;">Current Price</label>
            <div style="font-family: 'Courier New', monospace; font-weight:800; font-size:1.8rem; color:#ffd700;">$${(data.price||0).toFixed(2)}</div>
            <div style="color:${isPositive ? '#00ff88' : '#ff6b6b'}; font-weight:700;">${isPositive ? '+' : ''}${(data.change||0).toFixed(2)} (${isPositive ? '+' : ''}${(data.changePercent||0).toFixed(2)}%)</div>
        </div>

        ${(data.prediction) ? `
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

/* ---------- Search handler ---------- */
async function handleSearchSymbol(symbol) {
    if (!symbol) return;
    symbol = symbol.toUpperCase();
    if (!state.searchHistory.includes(symbol)) {
        state.searchHistory.push(symbol);
        if (state.searchHistory.length > 50) state.searchHistory.shift();
    }
    renderHistoryAndPinned();

    if (!CONFIG.stocks.includes(symbol)) CONFIG.stocks.unshift(symbol);
    else CONFIG.stocks = [symbol, ...CONFIG.stocks.filter(s => s !== symbol)];

    await seedStockData(symbol);
    renderStockCards();
    handleSelectTicker(symbol);
}

/* ---------- Selecting ticker (details + news + subscribe) ---------- */
async function handleSelectTicker(ticker) {
    state.selectedStock = ticker;
    const detailsEl = document.getElementById('detailsSection');
    if (detailsEl) detailsEl.style.display = 'block';
    const nameEl = document.getElementById('newsCompanyName');
    if (nameEl) nameEl.textContent = ticker;

    await seedStockData(ticker);
    renderStockDetails(ticker);

    // fetch news: prefer stockdata, fallback to newsapi
    let news = await stockdataNews(ticker).catch(() => []);
    if ((!news || news.length === 0) && CONFIG.NEWS_API_KEY && CONFIG.NEWS_API_KEY !== 'YOUR_NEWS_API_KEY') {
        news = await fetchNewsFallback(ticker);
    }
    renderNews(news);

    subscribeToSymbol(ticker);
    const detailsSection = document.getElementById('detailsSection');
    if (detailsSection) detailsSection.scrollIntoView({ behavior: 'smooth' });
}

/* ---------- Bootstrapping ---------- */
async function loadAllStocks() {
    if (state.isLoading) return;
    state.isLoading = true;
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.disabled = true;
    try {
        const promises = CONFIG.stocks.map(sym => seedStockData(sym));
        await Promise.all(promises);
        renderStockCards();
    } catch (e) {
        console.error('Error loading stocks', e);
    } finally {
        state.isLoading = false;
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadAllStocks();
    setupFinnhubSocket();
    startFallbackPolling();

    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', async () => { await loadAllStocks(); });

    renderHistoryAndPinned();
    console.log('Dashboard initialized. Replace API keys in CONFIG for live data.');
});

