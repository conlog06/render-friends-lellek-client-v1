// LellekPresence 2.5 – Freundesliste für LellekClient: Anfragen, Online-Status, Einladungen, Chat, Party
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
const VERSION = '2.5';
const CHAT_MS = 7 * 24 * 3600000;      // ungelesene Nachrichten bleiben 7 Tage
const PARTY_MAX = 10;
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
const inbox = new Map();    // empfänger → [{ id, from, name, text, kind, data, at }]
const parties = new Map();  // partyId → { id, leader, members: Map(uuid → { name, ready, joined }), invited: Map(uuid → { by, at }), plan, launchAt, launchId, updated }
const memberOf = new Map(); // uuid → partyId

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
  const extra = u && mutual(me, id) ? { level: u.level || null, badge: u.badge || null, party: (memberOf.get(id) && memberOf.get(id) === memberOf.get(me)) || false } : {};
  if (!u || !mutual(me, id) || !isOnline(u) || u.status === 'invisible') return { online: false, lastSeen: (u && mutual(me, id) && u.status !== 'invisible' ? lastSeen.get(id) : null) || null, name: u?.name || null, pending: !!(u && !u.friends.has(me)), ...extra };
  return { online: true, name: u.name, state: u.state, version: u.version, loader: u.loader, server: u.server, world: u.world, since: u.since, status: u.status, note: u.note, inParty: memberOf.has(id), ...extra };
}

function leaveParty(uuid) {
  const p = parties.get(memberOf.get(uuid)); memberOf.delete(uuid); if (!p) return;
  p.members.delete(uuid); p.updated = Date.now();
  if (!p.members.size) { parties.delete(p.id); return; }
  if (p.leader === uuid) p.leader = [...p.members.entries()].sort((a, b) => a[1].joined - b[1].joined)[0][0];
}
function partyView(p, me) {
  if (!p) return null;
  return { id: p.id, leader: p.leader, me, plan: p.plan, launchAt: p.launchAt, launchId: p.launchId, serverTime: Date.now(),
    members: [...p.members].map(([id, m]) => { const u = users.get(id); const see = id === me || (mutual(me, id) && u?.status !== 'invisible'); return { uuid: id, name: m.name, ready: m.ready, leader: id === p.leader, online: see ? isOnline(u) : true, level: u?.level || null, playing: see ? u?.state === 'playing' : false, server: see ? (u?.server || null) : null }; }),
    invited: [...p.invited].map(([id]) => ({ uuid: id, name: users.get(id)?.name || null })) };
}
/** Neue Nachrichten (werden dabei abgeholt), eigene Party und Party-Einladungen */
function socialOf(uuid) {
  const messages = (inbox.get(uuid) || []).filter(m => Date.now() - m.at < CHAT_MS); inbox.delete(uuid);
  const partyInvites = [];
  for (const p of parties.values()) { const inv = p.invited.get(uuid); if (inv && Date.now() - inv.at < INVITE_MS && memberOf.get(uuid) !== p.id) partyInvites.push({ id: p.id, by: inv.by, byName: inv.byName, leaderName: p.members.get(p.leader)?.name || null, members: p.members.size, plan: p.plan, at: inv.at }); }
  return { messages, party: partyView(parties.get(memberOf.get(uuid)), uuid), partyInvites };
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
          level: Math.max(0, Math.min(999, Math.floor(Number(b.level) || 0))) || null, badge: clean(b.badge, 32),
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
      return send(res, 200, { friends, incoming, accepted, declined: declinedBy, removed: removedBy, invites: inv, ...(u.searchParams.get('social') === '1' ? socialOf(s.uuid) : {}) });
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

    // ---- Schnellabruf für Chat & Party (alle paar Sekunden, solange offen) ----
    if (req.method === 'GET' && u.pathname === '/v1/social') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const me = users.get(s.uuid); if (me) me.at = Math.max(me.at, Date.now() - ONLINE_MS + 60000); // hält online, ohne Status zu ändern
      return send(res, 200, socialOf(s.uuid));
    }

    // ---- Chat: Nachricht an einen Freund ----
    if (req.method === 'POST' && u.pathname === '/v1/chat/send') {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const b = await body(req); if (!UUID_RE.test(String(b.to))) return send(res, 400, { error: 'Ungültige UUID' });
      const to = dashed(b.to);
      if (!mutual(s.uuid, to)) return send(res, 403, { error: 'Nur an Freunde' });
      const text = typeof b.text === 'string' ? b.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 1000) : '';
      const kind = ['text', 'profile', 'server'].includes(b.kind) ? b.kind : 'text';
      const str = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n) : '';
      let data = null;
      if (kind === 'profile' && b.data && /^LC\d-[\w-]{4,5000}$/.test(b.data.code || '')) data = { code: b.data.code, name: str(b.data.name, 40), version: str(b.data.version, 24), loader: str(b.data.loader, 12), mods: Math.max(0, Math.min(999, Number(b.data.mods) || 0)) };
      if (kind === 'server' && b.data && str(b.data.ip, 100)) data = { ip: str(b.data.ip, 100), name: str(b.data.name, 60) };
      if (!text && !data) return send(res, 400, { error: 'Leere Nachricht' });
      const msg = { id: crypto.randomBytes(8).toString('hex'), from: s.uuid, name: s.name, text, kind: data ? kind : 'text', data, at: Date.now() };
      if (!users.get(to)?.blocked.has(s.uuid)) { const l = inbox.get(to) || []; l.push(msg); inbox.set(to, l.slice(-300)); }
      return send(res, 200, { id: msg.id, at: msg.at });
    }

    // ---- Party ----
    if (req.method === 'POST' && u.pathname.startsWith('/v1/party/')) {
      const s = auth(req); if (!s) return send(res, 401, { error: 'Nicht angemeldet' });
      const b = await body(req), act = u.pathname.slice(10);
      let party = parties.get(memberOf.get(s.uuid));
      const isLeader = party && party.leader === s.uuid;
      const touch = (p) => { p.updated = Date.now(); };
      if (act === 'create') {
        if (!party) { party = { id: crypto.randomBytes(6).toString('hex'), leader: s.uuid, members: new Map([[s.uuid, { name: s.name, ready: true, joined: Date.now() }]]), invited: new Map(), plan: null, launchAt: 0, launchId: 0, updated: Date.now() }; parties.set(party.id, party); memberOf.set(s.uuid, party.id); }
        return send(res, 200, socialOf(s.uuid));
      }
      if (act === 'join' || act === 'decline') {
        const target = parties.get(String(b.id || '')); if (!target || !target.invited.has(s.uuid)) return send(res, 404, { error: 'Einladung abgelaufen' });
        target.invited.delete(s.uuid);
        if (act === 'join') {
          if (target.members.size >= PARTY_MAX) return send(res, 409, { error: 'Party ist voll' });
          if (party && party !== target) leaveParty(s.uuid);
          target.members.set(s.uuid, { name: s.name, ready: !target.plan, joined: Date.now() }); memberOf.set(s.uuid, target.id); touch(target);
        }
        return send(res, 200, socialOf(s.uuid));
      }
      if (!party) return send(res, 404, { error: 'Du bist in keiner Party' });
      if (act === 'invite') {
        if (!UUID_RE.test(String(b.uuid))) return send(res, 400, { error: 'Ungültige UUID' });
        const id = dashed(b.uuid); if (!mutual(s.uuid, id)) return send(res, 403, { error: 'Nur Freunde können eingeladen werden' });
        if (party.members.has(id)) return send(res, 409, { error: 'Schon in der Party' });
        if (party.members.size + party.invited.size >= PARTY_MAX + 5) return send(res, 409, { error: 'Zu viele offene Einladungen' });
        if (!users.get(id)?.blocked.has(s.uuid)) party.invited.set(id, { by: s.uuid, byName: s.name, at: Date.now() });
        touch(party); return send(res, 200, socialOf(s.uuid));
      }
      if (act === 'leave') { leaveParty(s.uuid); return send(res, 200, socialOf(s.uuid)); }
      if (act === 'ready') { const m = party.members.get(s.uuid); if (m) m.ready = !!b.ready; touch(party); return send(res, 200, socialOf(s.uuid)); }
      if (!isLeader) return send(res, 403, { error: 'Nur der Party-Leiter darf das' });
      if (act === 'kick') { const id = dashed(String(b.uuid || '')); if (id !== s.uuid && party.members.has(id)) { party.members.delete(id); memberOf.delete(id); } touch(party); return send(res, 200, socialOf(s.uuid)); }
      if (act === 'promote') { const id = dashed(String(b.uuid || '')); if (party.members.has(id)) party.leader = id; touch(party); return send(res, 200, socialOf(s.uuid)); }
      if (act === 'plan') {
        const code = typeof b.code === 'string' && /^LC\d-[\w-]{4,5000}$/.test(b.code) ? b.code : null;
        party.plan = { name: clean(b.name, 40) || 'Party', code, server: clean(b.server, 80), version: clean(b.version, 20), loader: clean(b.loader, 12), mods: Math.max(0, Math.min(999, Number(b.mods) || 0)) };
        for (const [id, m] of party.members) m.ready = id === s.uuid;
        party.launchAt = 0; touch(party); return send(res, 200, socialOf(s.uuid));
      }
      if (act === 'launch') {
        if (!party.plan) return send(res, 409, { error: 'Erst Profil und Server festlegen' });
        party.launchAt = Date.now() + Math.max(3, Math.min(30, Number(b.seconds) || 8)) * 1000; party.launchId++; touch(party);
        return send(res, 200, socialOf(s.uuid));
      }
      if (act === 'cancel') { party.launchAt = 0; touch(party); return send(res, 200, socialOf(s.uuid)); }
      return send(res, 404, { error: 'Unbekannte Party-Aktion' });
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
  for (const [id, l] of inbox) { const k = l.filter(m => now - m.at < CHAT_MS); k.length ? inbox.set(id, k) : inbox.delete(id); }
  for (const p of [...parties.values()]) {
    for (const [id, inv] of p.invited) if (now - inv.at > INVITE_MS) p.invited.delete(id);
    if (p.launchAt && now - p.launchAt > 60000) p.launchAt = 0;
    for (const id of [...p.members.keys()]) { const u = users.get(id); if (!u || now - u.at > 10 * 60000) leaveParty(id); }
  }
}, 60000);

server.listen(PORT, () => console.log(`LellekPresence ${VERSION} läuft auf Port ${PORT}${DEV_NOAUTH ? ' (TESTMODUS ohne Mojang-Prüfung)' : ''}`));
