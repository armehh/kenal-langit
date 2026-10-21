require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BBOX = 'lamin=0.8&lomin=99.5&lamax=7.4&lomax=119.5'; // Malaysian airspace
const DATA_FILE = path.join(__dirname, 'data', 'leaderboard.json');

app.set('trust proxy', 1); // Render sits behind a proxy; this makes req.ip the real visitor IP
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Flights: proxy OpenSky with a short cache ----------
let cache = { t: 0, data: [] };
let token = { value: null, exp: 0 };

// Optional: OpenSky OAuth2 client credentials give higher rate limits than anonymous access.
async function getToken() {
  const { OPENSKY_CLIENT_ID: id, OPENSKY_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) return null;
  if (token.value && Date.now() < token.exp) return token.value;
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in - 30) * 1000 };
  return token.value;
}

app.get('/api/flights', async (req, res) => {
  if (Date.now() - cache.t < 15000) return res.json({ source: 'cache', flights: cache.data });
  try {
    const headers = {};
    try { const tk = await getToken(); if (tk) headers.Authorization = `Bearer ${tk}`; } catch (e) { /* fall back to anonymous */ }
    const r = await fetch(`https://opensky-network.org/api/states/all?${BBOX}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('opensky ' + r.status);
    const d = await r.json();
    const flights = (d.states || [])
      .filter(s => s[5] != null && s[6] != null && !s[8]) // has position, airborne
      .map(s => ({
        icao: s[0],
        cs: (s[1] || '').trim(),
        country: s[2],
        lat: s[6],
        lng: s[5],
        alt: s[13] ?? s[7],
        vel: s[9],
        hdg: s[10] || 0,
        vr: s[11],
      }));
    cache = { t: Date.now(), data: flights };
    res.json({ source: 'opensky', flights });
  } catch (e) {
    console.warn('Flights error:', e.message);
    res.json({ source: 'stale', flights: cache.data }); // frontend shows sample data if empty
  }
});

// ---------- Leaderboard: JSON file storage ----------
const LEVELS = ['easy', 'med', 'hard'];
const readBoard = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } };
const lastPost = new Map();

app.get('/api/leaderboard', (req, res) => {
  res.json(readBoard().sort((a, b) => b.score - a.score).slice(0, 10));
});

app.post('/api/leaderboard', (req, res) => {
  const ip = req.ip;
  if (Date.now() - (lastPost.get(ip) || 0) < 10000) return res.status(429).json({ error: 'Too fast' });
  const { name, score, level, mode } = req.body || {};
  const clean = typeof name === 'string' ? name.replace(/[<>]/g, '').trim().slice(0, 20) : '';
  // Max score for a 10-question round with a full streak is well under 300.
  if (!clean || !Number.isInteger(score) || score < 0 || score > 300 || !LEVELS.includes(level) || ![1, 2].includes(mode)) {
    return res.status(400).json({ error: 'Invalid entry' });
  }
  lastPost.set(ip, Date.now());
  const board = readBoard();
  board.push({ name: clean, score, level, mode, date: new Date().toISOString() });
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(board.sort((a, b) => b.score - a.score).slice(0, 100)));
  res.status(201).json({ ok: true });
});

app.listen(PORT, () => console.log(`KenalLangit running at http://localhost:${PORT}`));