// LellekPresence – Online-Status für die LellekClient-Freundesliste
// Start:  node presence-server.js        (Node.js 18 oder neuer, keine Pakete nötig)
// Port:   PORT=8767 (Standard). Für Freunde im Internet: auf einem kleinen VPS laufen lassen
//         oder Port 8767 (TCP) freigeben und die Adresse in LellekClient → Optionen → Freunde eintragen.
// Anmeldung wie bei Minecraft-Servern: der Launcher meldet sich bei Mojang an, dieser Server prüft das
// über hasJoined – Passwörter oder Tokens des Spielers sieht der Server nie.

const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 8767;
const ONLINE_MS = 150000;            // ohne Meldung seit 2,5 min = offline
const TOKEN_MS = 12 * 3600000;       // Anmeldung gilt 12 h
const DEV_NOAUTH = process.env.LELLEK_DEV_NOAUTH === '1'; // nur zum lokalen Testen!

const tokens = new Map();   // token → { uuid, name, exp }
const presence = new Map(); // uuid → { name, state, version, loader, server, world, since, at }
const lastSeen = new Map(); // uuid → Zeit
const hits = new Map();     // ip → { n, t } – einfache Bremse gegen Spam

const dashed = (id) => id.replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); }
function body(req) { return new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > 8192) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); }); }
function auth(req) { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const s = tokens.get(t); if (!s || s.exp < Date.now()) return null; return s; }
const clean = (v, n) => (typeof v === 'string' ? v.replace(/[^\w.:\-\s]/g, '').slice(0, n) : null) || null;

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  const h = hits.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - h.t > 60000) { h.n = 0; h.t = Date.now(); } h.n++; hits.set(ip, h);
  if (h.n > 240) return send(res, 429, { error: 'Zu viele Anfragen' });
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && u.pathname === '/v1/auth') {
      const { name, serverId } = await body(req);
      if (!/^\w{2,16}$/.test(name || '') || !/^[a-f0-9]{1,64}$/i.test(serverId || '')) return send(res, 400, { error: 'Ungültige Anfrage' });
      let prof;
      if (DEV_NOAUTH) prof = { id: crypto.createHash('md5').update(name).digest('hex'), name };
      else {
        const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`);
        if (r.status !== 200) return send(res, 401, { error: 'Mojang-Prüfung fehlgeschlagen' });
        prof = await r.json();
      }
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, { uuid: dashed(prof.id), name: prof.name, exp: Date.now() + TOKEN_MS });
      return send(res, 200, { token, uuid: dashed(prof.id), name: prof.name });
    }
    if (u.pathname === '/v1/presence/me') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      if (req.method === 'DELETE') { presence.delete(s.uuid); lastSeen.set(s.uuid, Date.now()); return send(res, 204); }
      if (req.method === 'PUT') {
        const b = await body(req);
        presence.set(s.uuid, { name: s.name, state: b.state === 'playing' ? 'playing' : 'launcher', version: clean(b.version, 20), loader: clean(b.loader, 12), server: clean(b.server, 80), world: clean(b.world, 30), since: Number(b.since) || Date.now(), at: Date.now() });
        lastSeen.set(s.uuid, Date.now());
        return send(res, 204);
      }
    }
    if (req.method === 'GET' && u.pathname === '/v1/presence') {
      const ids = (u.searchParams.get('uuids') || '').split(',').filter(x => /^[0-9a-f-]{32,36}$/i.test(x)).slice(0, 200).map(dashed);
      const out = {};
      for (const id of ids) {
        const p = presence.get(id);
        out[id] = p && Date.now() - p.at < ONLINE_MS ? { online: true, state: p.state, version: p.version, loader: p.loader, server: p.server, world: p.world, since: p.since } : { online: false, lastSeen: lastSeen.get(id) || null };
      }
      return send(res, 200, out);
    }
    if (req.method === 'GET' && u.pathname === '/v1/stats') {
      let n = 0; for (const p of presence.values()) if (Date.now() - p.at < ONLINE_MS) n++;
      return send(res, 200, { players: n, version: '1.0' });
    }
    send(res, 404, { error: 'Nicht gefunden' });
  } catch (e) { send(res, 500, { error: 'Serverfehler' }); }
});
setInterval(() => { const now = Date.now(); for (const [t, s] of tokens) if (s.exp < now) tokens.delete(t); for (const [id, p] of presence) if (now - p.at > ONLINE_MS * 4) presence.delete(id); }, 60000);
server.listen(PORT, () => console.log(`LellekPresence läuft auf Port ${PORT}${DEV_NOAUTH ? ' (TESTMODUS ohne Mojang-Prüfung)' : ''}`));
