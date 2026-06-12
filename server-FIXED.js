/**
 * Site Analytics Server
 * Збирає події від tracker.js, зберігає у файл data/events.jsonl,
 * надає API для дашборду.
 *
 * Запуск: node server.js
 * Порт: process.env.PORT || 3000
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'events.jsonl');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '');

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'application/json', limit: '1mb' })); // для sendBeacon (Blob)
app.use('/static', express.static(path.join(__dirname, 'public')));

// CORS — щоб трекер з іншого домену міг слати дані
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Прийом подій ----
app.post('/collect', (req, res) => {
  let event = req.body;
  if (typeof event === 'string') {
    try { event = JSON.parse(event); } catch (e) { return res.sendStatus(400); }
  }
  if (!event || !event.type) return res.sendStatus(400);

  event.received_at = Date.now();
  fs.appendFile(DATA_FILE, JSON.stringify(event) + '\n', () => {});
  res.sendStatus(204);
});

// ---- Допоміжне: читання всіх подій ----
function loadEvents(filterSite, filterUrl) {
  const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(e => e &&
    (!filterSite || e.site === filterSite) &&
    (!filterUrl || e.url === filterUrl)
  );
}

// ---- API: список сторінок із базовою статистикою ----
app.get('/api/pages', (req, res) => {
  const events = loadEvents(req.query.site);
  const pages = {};
  events.forEach(e => {
    const key = e.url || '/';
    if (!pages[key]) pages[key] = { url: key, pageviews: 0, sessions: new Set(), exits: [] };
    if (e.type === 'pageview') {
      pages[key].pageviews++;
      pages[key].sessions.add(e.session);
    }
    if (e.type === 'exit') pages[key].exits.push(e);
  });

  const result = Object.values(pages).map(p => {
    const avgTime = p.exits.length
      ? p.exits.reduce((s, e) => s + (e.time_on_page_ms || 0), 0) / p.exits.length
      : 0;
    const avgScroll = p.exits.length
      ? p.exits.reduce((s, e) => s + (e.max_scroll_pct || 0), 0) / p.exits.length
      : 0;
    return {
      url: p.url,
      pageviews: p.pageviews,
      unique_sessions: p.sessions.size,
      avg_time_on_page_sec: Math.round(avgTime / 100) / 10,
      avg_scroll_depth_pct: Math.round(avgScroll)
    };
  }).sort((a, b) => b.pageviews - a.pageviews);

  res.json(result);
});

// ---- API: дані для heatmap кліків/руху на конкретній сторінці ----
app.get('/api/heatmap', (req, res) => {
  const { site, url, type } = req.query; // type = click | move
  const events = loadEvents(site, url).filter(e => e.type === (type || 'click'));
  const points = events.map(e => ({
    x_pct: e.x_pct, y_pct: e.y_pct, selector: e.selector, rage: e.rage || false
  }));
  res.json({ count: points.length, points });
});

// ---- API: воронка глибини скролу ----
app.get('/api/scroll-funnel', (req, res) => {
  const { site, url } = req.query;
  const events = loadEvents(site, url).filter(e => e.type === 'scroll_depth');
  const marks = [25, 50, 75, 90, 100];
  const counts = {};
  marks.forEach(m => counts[m] = 0);
  events.forEach(e => { if (counts[e.depth] !== undefined) counts[e.depth]++; });

  const pageviews = loadEvents(site, url).filter(e => e.type === 'pageview').length;

  res.json({
    pageviews,
    funnel: marks.map(m => ({
      depth_pct: m,
      sessions_reached: counts[m],
      pct_of_visitors: pageviews ? Math.round((counts[m] / pageviews) * 100) : 0
    }))
  });
});

// ---- API: топ кліків по елементах (де клікають найчастіше) ----
app.get('/api/top-elements', (req, res) => {
  const { site, url } = req.query;
  const events = loadEvents(site, url).filter(e => e.type === 'click');
  const counts = {};
  events.forEach(e => {
    const key = e.selector + (e.text ? ` "${e.text}"` : '');
    counts[key] = counts[key] || { selector: key, clicks: 0, rage_clicks: 0 };
    counts[key].clicks++;
    if (e.rage) counts[key].rage_clicks++;
  });
  res.json(Object.values(counts).sort((a, b) => b.clicks - a.clicks).slice(0, 30));
});

// ---- API: список унікальних URL для випадаючого списку у дашборді ----
app.get('/api/urls', (req, res) => {
  const events = loadEvents(req.query.site).filter(e => e.type === 'pageview');
  const urls = [...new Set(events.map(e => e.url))];
  res.json(urls);
});

// ---- Roзкидання дашборду ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Analytics server: http://localhost:${PORT}`);
  console.log(`Tracker script:  http://localhost:${PORT}/static/tracker.js`);
});
