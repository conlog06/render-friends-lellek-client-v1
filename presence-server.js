// LellekPresence 2 – Freundesliste für LellekClient: Anfragen, Online-Status, Einladungen
// Start:  node presence-server.js        (Node.js 18 oder neuer, keine Pakete nötig)
// Port:   PORT (Render setzt ihn automatisch), sonst 8767.
//
// Ohne Datenbank: Jeder Launcher schickt bei jeder Meldung seine Freundesliste, offene Anfragen und
// Blockierungen mit. Der Server gleicht nur ab. Nach einem Neustart (z. B. wenn Render schläft) baut
// sich alles innerhalb einer Minute aus den Meldungen der Launcher wieder auf.
//
// Anmeldung wie bei Minecraft-Servern: Der Launcher meldet sich bei Mojang an, dieser Server prüft das
// über hasJoined – Passwörter oder Tokens des Spielers sieht der Server nie.
// Sichtbarkeit: Status und Server sieht nur, wer GEGENSEITIG befreundet ist.

const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 8767;
const VERSION = '2.0';
const ONLINE_MS = 150000;             // ohne Meldung seit 2,5 min = offline
const TOKEN_MS = 12 * 3600000;        // Anmeldung gilt 12 h
const INVITE_MS = 10 * 60000;         // Einladungen gelten 10 min
const NOTE_MS = 7 * 24 * 3600000;     // Ablehnungen/Entfernungen werden 7 Tage gemerkt
const MAX_LIST = 500;
const DEV_NOAUTH = process.env.LELLEK_DEV_NOAUTH === '1'; // nur zum lokalen Testen!

const tokens = new Map();   // token → { uuid, name, exp }
const users = new Map();    // uuid → { name, state, version, loader, server, world, since, status, note, at, friends:Set, outgoing:Set, blocked:Set }
const lastSeen = new Map(); // uuid → Zeit
const declined = new Map(); // empfänger → Map(absender → Zeit)   „hat abgelehnt“
const removed = new Map();  // ex-freund → Map(wer → Zeit)         „hat dich entfernt“
const invites = new Map();  // empfänger → [{ from, name, server, version, message, at }]
const hits = new Map();     // ip → { n, t }

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const dashed = (id) => String(id).toLowerCase().replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const uuidList = (a) => new Set((Array.isArray(a) ? a : []).filter(x => UUID_RE.test(String(x))).slice(0, MAX_LIST).map(dashed));
const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '') || null;
const STATUSES = ['online', 'away', 'dnd', 'invisible'];

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); }
function body(req) { return new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > 65536) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); }); }
function auth(req) { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const s = tokens.get(t); if (!s || s.exp < Date.now()) return null; return s; }
function mark(map, a, b) { if (!map.has(a)) map.set(a, new Map()); map.get(a).set(b, Date.now()); }
function marked(map, a, b) { const t = map.get(a)?.get(b); return t && Date.now() - t < NOTE_MS; }
function unmark(map, a, b) { map.get(a)?.delete(b); }
const isOnline = (u) => u && Date.now() - u.at < ONLINE_MS;
const mutual = (a, b) => { const ua = users.get(a), ub = users.get(b); return !!(ua && ub && ua.friends.has(b) && ub.friends.has(a)); };
const nameOf = (id) => users.get(id)?.name || null;

/** Status eines Freundes aus Sicht von `me` – nur bei gegenseitiger Freundschaft */
function viewOf(me, id) {
  const u = users.get(id);
  if (!u || !mutual(me, id) || !isOnline(u) || u.status === 'invisible') return { online: false, lastSeen: (u && mutual(me, id) && u.status !== 'invisible' ? lastSeen.get(id) : null) || null, name: u?.name || null, pending: !!(u && !u.friends.has(me)) };
  return { online: true, name: u.name, state: u.state, version: u.version, loader: u.loader, server: u.server, world: u.world, since: u.since, status: u.status, note: u.note };
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const h = hits.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - h.t > 60000) { h.n = 0; h.t = Date.now(); } h.n++; hits.set(ip, h);
  if (h.n > 300) return send(res, 429, { error: 'Zu viele Anfragen' });
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE' }); return res.end(); }
  const u = new URL(req.url, 'http://x');
  try {
    // ---- Status der Anlage ----
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/health' || u.pathname === '/v1/stats')) {
      let n = 0; for (const x of users.values()) if (isOnline(x) && x.status !== 'invisible') n++;
      return send(res, 200, { ok: true, service: 'LellekPresence', version: VERSION, players: n });
    }

    // ---- Anmeldung (Mojang hasJoined) ----
    if (req.method === 'POST' && u.pathname === '/v1/auth') {
      const { name, serverId } = await body(req);
      if (!/^\w{2,16}$/.test(name || '') || !/^[a-f0-9]{1,64}$/i.test(serverId || '')) return send(res, 400, { error: 'Ungültige Anfrage' });
      let prof;
      if (DEV_NOAUTH) prof = { id: crypto.createHash('md5').update(name.toLowerCase()).digest('hex'), name };
      else {
        const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`);
        if (r.status !== 200) return send(res, 401, { error: 'Mojang-Prüfung fehlgeschlagen' });
        prof = await r.json();
      }
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, { uuid: dashed(prof.id), name: prof.name, exp: Date.now() + TOKEN_MS });
      return send(res, 200, { token, uuid: dashed(prof.id), name: prof.name });
    }

    // ---- Eigene Meldung: Status + Listen ----
    if (u.pathname === '/v1/presence/me') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      if (req.method === 'DELETE') { const me = users.get(s.uuid); if (me) me.at = 0; lastSeen.set(s.uuid, Date.now()); return send(res, 204); }
      if (req.method === 'PUT') {
        const b = await body(req);
        const prev = users.get(s.uuid);
        const me = {
          name: s.name, state: b.state === 'playing' ? 'playing' : 'launcher',
          version: clean(b.version, 20), loader: clean(b.loader, 12), server: clean(b.server, 80), world: clean(b.world, 30),
          since: Number(b.since) || Date.now(), status: STATUSES.includes(b.status) ? b.status : 'online', note: clean(b.note, 80), at: Date.now(),
          // Ältere Launcher schicken keine Listen → bisherige behalten
          friends: Array.isArray(b.friends) ? uuidList(b.friends) : (prev?.friends || new Set()),
          outgoing: Array.isArray(b.outgoing) ? uuidList(b.outgoing) : (prev?.outgoing || new Set()),
          blocked: Array.isArray(b.blocked) ? uuidList(b.blocked) : (prev?.blocked || new Set()),
        };
        me.friends.delete(s.uuid); me.outgoing.delete(s.uuid);
        users.set(s.uuid, me);
        if (me.status !== 'invisible') lastSeen.set(s.uuid, Date.now());
        return send(res, 204);
      }
    }

    // ---- Alles für die Freundesliste in einem Abruf ----
    if (req.method === 'GET' && u.pathname === '/v1/friends') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const me = users.get(s.uuid); if (!me) return send(res, 409, { error: 'Erst Status melden' });
      const friends = {}; for (const id of me.friends) friends[id] = viewOf(s.uuid, id);
      const incoming = [], accepted = [], declinedBy = [], removedBy = [];
      for (const [id, x] of users) {
        if (id === s.uuid) continue;
        if (x.outgoing.has(s.uuid) && !me.friends.has(id) && !me.blocked.has(id) && !x.blocked.has(s.uuid) && !marked(declined, s.uuid, id)) incoming.push({ uuid: id, name: x.name, at: x.at });
      }
      for (const id of me.outgoing) {
        const x = users.get(id);
        if (x && x.friends.has(s.uuid)) accepted.push({ uuid: id, name: x.name });
        else if (marked(declined, id, s.uuid)) declinedBy.push({ uuid: id, name: nameOf(id) });
      }
      for (const [id] of removed.get(s.uuid) || []) if (marked(removed, s.uuid, id) && me.friends.has(id)) removedBy.push({ uuid: id, name: nameOf(id) });
      const inv = (invites.get(s.uuid) || []).filter(i => Date.now() - i.at < INVITE_MS && mutual(s.uuid, i.from));
      invites.delete(s.uuid);
      return send(res, 200, { friends, incoming, accepted, declined: declinedBy, removed: removedBy, invites: inv });
    }

    // ---- Anfrage beantworten ----
    if (req.method === 'POST' && u.pathname === '/v1/friends/respond') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const b = await body(req); if (!UUID_RE.test(String(b.uuid))) return send(res, 400, { error: 'Ungültige UUID' });
      const id = dashed(b.uuid), me = users.get(s.uuid);
      if (b.accept) { if (me) me.friends.add(id); unmark(declined, s.uuid, id); unmark(removed, s.uuid, id); unmark(removed, id, s.uuid); }
      else mark(declined, s.uuid, id);
      return send(res, 204);
    }

    // ---- Freund entfernen ----
    if (req.method === 'POST' && u.pathname === '/v1/friends/remove') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const b = await body(req); if (!UUID_RE.test(String(b.uuid))) return send(res, 400, { error: 'Ungültige UUID' });
      const id = dashed(b.uuid), me = users.get(s.uuid);
      if (me) { me.friends.delete(id); me.outgoing.delete(id); }
      mark(removed, id, s.uuid);
      return send(res, 204);
    }

    // ---- Einladung schicken ----
    if (req.method === 'POST' && u.pathname === '/v1/friends/invite') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const b = await body(req); if (!UUID_RE.test(String(b.uuid))) return send(res, 400, { error: 'Ungültige UUID' });
      const id = dashed(b.uuid), me = users.get(s.uuid);
      if (!mutual(s.uuid, id)) return send(res, 403, { error: 'Ihr seid (noch) keine Freunde' });
      if (users.get(id)?.blocked.has(s.uuid)) return send(res, 204);
      const list = (invites.get(id) || []).filter(i => i.from !== s.uuid && Date.now() - i.at < INVITE_MS).slice(-19);
      list.push({ from: s.uuid, name: s.name, server: clean(b.server, 80) || me?.server || null, version: clean(b.version, 20) || me?.version || null, message: clean(b.message, 120), at: Date.now() });
      invites.set(id, list);
      return send(res, 204);
    }

    // ---- Alter Abruf (LellekClient bis 2.1): aus Datenschutzgründen ohne Inhalt ----
    if (req.method === 'GET' && u.pathname === '/v1/presence') {
      const out = {}; for (const id of (u.searchParams.get('uuids') || '').split(',')) if (UUID_RE.test(id)) out[dashed(id)] = { online: false, lastSeen: null, updateRequired: true };
      return send(res, 200, out);
    }

    send(res, 404, { error: 'Nicht gefunden' });
  } catch (e) { send(res, 500, { error: 'Serverfehler' }); }
});

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of tokens) if (s.exp < now) tokens.delete(t);
  for (const [id, x] of users) if (now - x.at > 3 * 24 * 3600000) users.delete(id);
  for (const map of [declined, removed]) for (const [a, m] of map) { for (const [b, t] of m) if (now - t > NOTE_MS) m.delete(b); if (!m.size) map.delete(a); }
  for (const [id, l] of invites) { const k = l.filter(i => now - i.at < INVITE_MS); k.length ? invites.set(id, k) : invites.delete(id); }
  for (const [ip, h] of hits) if (now - h.t > 120000) hits.delete(ip);
}, 60000);

server.listen(PORT, () => console.log(`LellekPresence ${VERSION} läuft auf Port ${PORT}${DEV_NOAUTH ? ' (TESTMODUS ohne Mojang-Prüfung)' : ''}`));
