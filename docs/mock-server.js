/* Local test harness — mimics the Apps Script API so the site can be
   exercised end-to-end without deploying. Not shipped/used in production.
   Run:  node docs/mock-server.js   then open http://localhost:8787 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const db = { events: [], bookings: [], blocks: [] };
let seq = 0;
const uid = (p) => p + '-' + (++seq).toString().padStart(4, '0');

const pad = (n) => (n < 10 ? '0' : '') + n;
const toMin = (t) => { const p = String(t).split(':'); return +p[0] * 60 + (+p[1] || 0); };
const fromMin = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const slotsFor = (d, ev) => {
  const out = []; let c = toMin(d.start || ev.dayStart); const e = toMin(d.end || ev.dayEnd);
  while (c + ev.slotMinutes <= e) { out.push(fromMin(c)); c += ev.slotMinutes; }
  return out;
};

db.events.push({
  eventId: 'surf-expo-fall-2026', name: 'Surf Expo — Fall 2026',
  subtitle: 'Jetty Showroom Appointments', venue: 'Orange County Convention Center',
  city: 'Orlando, FL', startDate: '2026-09-16', endDate: '2026-09-18',
  days: [
    { date: '2026-09-16', label: 'Day 1', start: '09:00', end: '18:00' },
    { date: '2026-09-17', label: 'Day 2', start: '09:00', end: '18:00' },
    { date: '2026-09-18', label: 'Day 3', start: '09:00', end: '18:00' }
  ],
  stations: [
    { id: 'station-1', name: 'SS27 (Bouchard)', sub: '' },
    { id: 'station-2', name: 'Summer (In-House) / Business', sub: '' },
    { id: 'station-3', name: "Women's SS27 / Business", sub: '' },
    { id: 'station-4', name: 'FW27 Pre Line / Business', sub: '' }
  ],
  slotMinutes: 60, dayStart: '09:00', dayEnd: '18:00',
  notifyEmail: 'cory@jettylife.com', replyTo: 'cory@jettylife.com', status: 'active'
});

[['2026-09-16', '11:00', '17th Street'], ['2026-09-16', '13:00', 'Hi Tech'],
 ['2026-09-16', '14:00', "Tilly's"], ['2026-09-17', '12:00', 'Ron Jon']]
  .forEach(([date, t, retailer]) => db.bookings.push({
    bookingId: uid('BK'), eventId: 'surf-expo-fall-2026', date,
    stationId: 'station-2', stationName: 'Summer (In-House) / Business',
    startTime: t, endTime: fromMin(toMin(t) + 60), retailer,
    contactName: retailer + ' Buyer', contactEmail: 'buyer@example.com',
    phone: '', bookedBy: 'Imported', notes: '', status: 'confirmed',
    createdAt: '2026-08-01T12:00:00Z', cancelToken: 'seedtok-' + retailer.replace(/\W/g, '').toLowerCase()
  }));

// Defaults keep the two tiers distinct so the role tests stay meaningful.
// PW_SHARED=1 mirrors the shipped config, where both are the same string.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-pass-1234';
const REP_TOKEN = process.env.REP_TOKEN || 'rep-pass-5678';
const NEED = 'PASSWORD_REQUIRED: You need the ';

const roleFor = (tok) => {
  tok = String(tok || '').trim();
  if (tok && tok === ADMIN_TOKEN) return 'admin';
  if (tok && tok === REP_TOKEN) return 'rep';
  return 'public';
};
const canSeeNames = (role) => role === 'admin' || role === 'rep';
const requireRole = (role, allowed, what) => {
  if (!allowed.includes(role)) {
    throw new Error(NEED + (allowed.includes('rep') ? 'rep' : 'admin') + ' password to ' + what + '.');
  }
};
const publicBooking = (b) => ({
  eventId: b.eventId, date: b.date, stationId: b.stationId,
  startTime: b.startTime, endTime: b.endTime, booked: true
});

db.events.push({
  eventId: 'archived-show-2019', name: 'Archived Show 2019', subtitle: '',
  venue: '', city: '', startDate: '2019-01-10', endDate: '2019-01-11',
  days: [{ date: '2019-01-10', label: 'Day 1', start: '09:00', end: '17:00' },
         { date: '2019-01-11', label: 'Day 2', start: '09:00', end: '17:00' }],
  stations: [{ id: 'station-1', name: 'Old Station', sub: '' }],
  slotMinutes: 60, dayStart: '09:00', dayEnd: '17:00',
  notifyEmail: 'cory@jettylife.com', replyTo: 'cory@jettylife.com', status: 'archived'
});

function bundle(id, role) {
  const ev = db.events.find((e) => e.eventId === id);
  if (!ev) throw new Error('Event not found: ' + id);
  const live = db.bookings.filter((b) => b.eventId === id && b.status !== 'cancelled');
  const event = { ...ev };
  if (role !== 'admin') { event.notifyEmail = ''; event.replyTo = ''; }
  return {
    ok: true, role, event, ...(role === 'admin' ? { repToken: REP_TOKEN } : {}),
    bookings: live.map((b) => {
      if (!canSeeNames(role)) return publicBooking(b);
      const { cancelToken, ...rest } = b;
      return rest;
    }),
    blocks: db.blocks.filter((b) => b.eventId === id)
  };
}

function handle(action, body) {
  const role = roleFor(body.token);
  if (action === 'book') {
    const ev = db.events.find((e) => e.eventId === body.eventId);
    if (!ev) throw new Error('Event not found.');
    if (!body.retailer || !body.contactName || !body.contactEmail) throw new Error('Missing required field');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.contactEmail)) throw new Error('That email address does not look valid.');
    const station = ev.stations.find((s) => s.id === body.stationId);
    if (!station) throw new Error('Unknown station.');
    const day = ev.days.find((d) => d.date === body.date);
    if (!day) throw new Error('That date is not part of this event.');
    if (!slotsFor(day, ev).includes(body.startTime)) throw new Error('That time is not a valid slot for this day.');
    const clash = db.bookings.find((b) => b.eventId === body.eventId && b.date === body.date
      && b.stationId === body.stationId && b.startTime === body.startTime && b.status !== 'cancelled');
    if (clash) throw new Error('Sorry — that slot was just taken. Pick another one.');
    if (db.blocks.find((b) => b.eventId === body.eventId && b.date === body.date
      && b.stationId === body.stationId && b.startTime === body.startTime)) {
      throw new Error('That slot has been blocked off and is not bookable.');
    }
    const booking = {
      bookingId: uid('BK'), eventId: body.eventId, date: body.date, stationId: body.stationId,
      stationName: station.name, startTime: body.startTime,
      endTime: fromMin(toMin(body.startTime) + ev.slotMinutes),
      retailer: body.retailer, contactName: body.contactName, contactEmail: body.contactEmail,
      phone: body.phone || '', bookedBy: body.bookedBy || '', notes: body.notes || '',
      status: 'confirmed', createdAt: new Date().toISOString(),
      cancelToken: 'tok' + uid('')
    };
    db.bookings.push(booking);
    return { ok: true, role, booking };
  }
  if (action === 'cancel') {
    const byToken = String(body.cancelToken || '').trim();
    if (!byToken) requireRole(role, ['admin', 'rep'], 'cancel an appointment');
    const b = byToken
      ? db.bookings.find((x) => x.cancelToken === byToken)
      : db.bookings.find((x) => x.bookingId === body.bookingId);
    if (!b) throw new Error(byToken
      ? 'That cancellation link is not valid — it may already have been used.'
      : 'Booking not found.');
    if (b.status === 'cancelled') throw new Error('That appointment was already cancelled.');
    b.status = 'cancelled';
    return { ok: true, role, cancelled: b.bookingId };
  }
  if (action === 'toggleBlock') {
    requireRole(role, ['admin'], 'block slots');
    const i = db.blocks.findIndex((b) => b.eventId === body.eventId && b.date === body.date
      && b.stationId === body.stationId && b.startTime === body.startTime);
    if (i >= 0) { db.blocks.splice(i, 1); return { ok: true, blocked: false }; }
    db.blocks.push({ blockId: uid('BL'), eventId: body.eventId, date: body.date,
      stationId: body.stationId, startTime: body.startTime, reason: body.reason || 'Blocked' });
    return { ok: true, blocked: true };
  }
  if (action === 'updateEvent') {
    requireRole(role, ['admin'], 'edit an event');
    const ev = db.events.find((e) => e.eventId === body.eventId);
    if (!ev) throw new Error('Event not found.');
    if (body.name !== undefined) {
      if (!String(body.name).trim()) throw new Error('The event needs a name.');
      ev.name = String(body.name).trim();
    }
    ['subtitle', 'venue', 'city', 'notifyEmail', 'replyTo'].forEach((k) => {
      if (body[k] !== undefined) ev[k] = String(body[k]).trim();
    });
    let renamed = 0;
    if (body.stations !== undefined) {
      if (!body.stations.length) throw new Error('An event needs at least one station.');
      const prevName = {};
      ev.stations.forEach((s) => { prevName[s.id] = s.name; });
      const seen = {};
      let n = ev.stations.length;
      const stations = body.stations.map((s, i) => {
        let id = s.id || null;
        if (!id) { do { n++; id = 'station-' + n; } while (seen[id] || prevName[id]); }
        if (seen[id]) throw new Error('Two stations ended up with the same id ("' + id + '").');
        seen[id] = true;
        const name = String(s.name || '').trim();
        if (!name) throw new Error('Station ' + (i + 1) + ' needs a name.');
        return { id, name, sub: String(s.sub || '') };
      });
      const counts = {};
      db.bookings.filter((b) => b.eventId === body.eventId && b.status !== 'cancelled')
        .forEach((b) => { counts[b.stationId] = (counts[b.stationId] || 0) + 1; });
      Object.keys(counts).forEach((id) => {
        if (!seen[id]) {
          throw new Error('"' + (prevName[id] || id) + '" still has ' + counts[id]
            + ' appointment' + (counts[id] === 1 ? '' : 's') + '. Cancel or move '
            + (counts[id] === 1 ? 'it' : 'them') + ' before removing that station.');
        }
      });
      ev.stations = stations;
      const nameById = {};
      stations.forEach((s) => { nameById[s.id] = s.name; });
      db.bookings.forEach((b) => {
        if (b.eventId !== body.eventId) return;
        const want = nameById[b.stationId];
        if (want !== undefined && b.stationName !== want) { b.stationName = want; renamed++; }
      });
    }
    return { ok: true, role, eventId: body.eventId, bookingsRenamed: renamed };
  }
  if (action === 'createEvent') {
    requireRole(role, ['admin'], 'create an event');
    if (!body.name) throw new Error('Event name is required.');
    if (!body.days || !body.days.length) throw new Error('At least one event day is required.');
    if (!body.stations || !body.stations.length) throw new Error('At least one station is required.');
    const id = (body.eventId || body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    if (db.events.find((e) => e.eventId === id)) throw new Error('An event with the id "' + id + '" already exists.');
    const days = body.days.slice().sort((a, b) => a.date.localeCompare(b.date));
    db.events.push({
      eventId: id, name: body.name, subtitle: body.subtitle || '', venue: body.venue || '',
      city: body.city || '', startDate: days[0].date, endDate: days[days.length - 1].date,
      days, stations: body.stations, slotMinutes: +body.slotMinutes || 60,
      dayStart: body.dayStart || '09:00', dayEnd: body.dayEnd || '18:00',
      notifyEmail: body.notifyEmail || '', replyTo: body.replyTo || '', status: 'active'
    });
    return { ok: true, role, eventId: id };
  }
  throw new Error('Unknown action: ' + action);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === '/api') {
    if (req.method === 'GET') {
      try {
        const a = u.searchParams.get('action') || 'events';
        const role = roleFor(u.searchParams.get('token'));
        if (a === 'ping') return send({ ok: true, pong: true, role });
        if (a === 'events') {
          const wantArchived = role === 'admin' && u.searchParams.get('includeArchived') === '1';
          const evs = db.events
            .filter((e) => wantArchived || e.status !== 'archived')
            .map((e) => (role === 'admin' ? e : { ...e, notifyEmail: '', replyTo: '' }));
          return send({ ok: true, role, events: evs });
        }
        if (a === 'event') return send(bundle(u.searchParams.get('id'), role));
        if (a === 'lookup') {
          const tok = String(u.searchParams.get('cancelToken') || '').trim();
          const b = db.bookings.find((x) => x.cancelToken === tok);
          if (!b) throw new Error('That cancellation link is not valid — it may already have been used.');
          return send({ ok: true, role, booking: {
            bookingId: b.bookingId, eventId: b.eventId, date: b.date, stationName: b.stationName,
            startTime: b.startTime, endTime: b.endTime, retailer: b.retailer,
            contactName: b.contactName, status: b.status } });
        }
        throw new Error('Unknown action: ' + a);
      } catch (e) { return send({ ok: false, error: e.message }); }
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      try { const p = JSON.parse(body || '{}'); send(handle(p.action, p)); }
      catch (e) { send({ ok: false, error: e.message }); }
    });
  }
  let p = u.pathname === '/' ? '/index.html' : u.pathname;

  // Mirror the rewrites in netlify.toml so the pretty links people are
  // actually sent (/e/<id>) behave here the way they do in production.
  const REWRITES = [
    [/^\/e\/([^/]+)$/, '/event.html', 'e'],
    [/^\/manage\/([^/]+)$/, '/admin.html', 'e'],
    [/^\/edit\/([^/]+)$/, '/edit.html', 'e']
  ];
  let rewrittenParam = '';
  for (const [re, target, param] of REWRITES) {
    const m = p.match(re);
    if (m) {
      rewrittenParam = param + '=' + encodeURIComponent(decodeURIComponent(m[1]));
      // Netlify keeps any query the visitor supplied and adds the captured id.
      u.searchParams.set(param, decodeURIComponent(m[1]));
      p = target;
      break;
    }
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  let data = fs.readFileSync(f);
  if (p === '/config.js') data = Buffer.from("window.SHOWTIME_CONFIG={API_URL:'http://localhost:" + PORT + "/api',REFRESH_MS:60000};");
  // On a rewrite the browser's URL stays /e/<id>, so the page can't read ?e=
  // from it. Netlify passes the query through server-side; do the same by
  // seeding it before any other script runs.
  if (rewrittenParam) {
    data = Buffer.from(String(data).replace('<head>',
      '<head><script>history.replaceState(null,"",location.pathname+"?'
      + rewrittenParam + '");</script>'));
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(data);
}).listen(PORT, () => console.log('mock on http://localhost:' + PORT));
