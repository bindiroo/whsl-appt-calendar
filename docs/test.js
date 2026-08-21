/* End-to-end checks.  node docs/test.js
   Starts its own throwaway mock server so every run begins from identical
   state — the suite books and cancels things, so a shared server would drift. */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const PORT = Number(process.env.PORT || 8799);
const B = 'http://localhost:' + PORT;
const API = B + '/api';
const shots = __dirname + '/shots/';
require('fs').mkdirSync(shots, { recursive: true });

const ADMIN = 'admin-pass-1234';
const REP = 'rep-pass-5678';
const REP_IN_PAGE = REP;

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };
const head = (m) => console.log('\n' + m);

/* Talk to the API straight from node — proves the SERVER enforces the rules,
   not just that the UI hides things. */
async function api(body) {
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body)
  });
  return r.json();
}
async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  return (await fetch(API + '?' + qs)).json();
}

let server;
async function startMock() {
  server = spawn(process.execPath, [__dirname + '/mock-server.js'], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(API + '?action=ping');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock server did not start on port ' + PORT);
}
function stopMock() { if (server) try { server.kill('SIGKILL'); } catch (e) {} }
process.on('exit', stopMock);

(async () => {
  await startMock();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const NOISE = /Failed to load resource/;

  /* Each role gets its own browser context so localStorage never bleeds. */
  async function ctxFor(token) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
    if (token) {
      await page.addInitScript((t) => localStorage.setItem('showtime_token', t), token);
    }
    return { ctx, page };
  }

  /* ================= SERVER-SIDE PERMISSION CHECKS ================= */

  head('1. Server: retailer feed carries no names or contact details');
  const pub = await apiGet({ action: 'event', id: 'surf-expo-fall-2026' });
  ok(pub.role === 'public', 'no password -> role is public');
  ok(pub.bookings.length > 0, 'retailer still sees that slots are taken (' + pub.bookings.length + ')');
  const pubBlob = JSON.stringify(pub);
  ok(!/17th Street|Tilly|Ron Jon|Hi Tech/.test(pubBlob), 'no retailer names anywhere in the payload');
  ok(!/@/.test(pubBlob), 'no email addresses anywhere in the payload');
  ok(!/cancelToken|BK-/.test(pubBlob), 'no booking ids or cancel tokens leak');
  ok(pub.bookings.every((b) => b.booked === true && !('retailer' in b)), 'booked slots are opaque');

  head('1b. Server: the events list is redacted too');
  const pubList = await apiGet({ action: 'events' });
  const pubListBlob = JSON.stringify(pubList);
  ok(!/@/.test(pubListBlob), 'no organiser contact addresses in the public events list');
  ok(pubList.events.every((e) => !e.notifyEmail && !e.replyTo), 'notifyEmail/replyTo blanked for retailers');
  const sneakArchived = await apiGet({ action: 'events', includeArchived: '1' });
  ok(!sneakArchived.events.some((e) => e.status === 'archived'),
    'retailer cannot reach archived events with includeArchived=1');
  const repList = await apiGet({ action: 'events', token: REP });
  ok(repList.events.every((e) => !e.notifyEmail), 'reps do not get organiser addresses either');
  const adminList = await apiGet({ action: 'events', token: ADMIN, includeArchived: '1' });
  ok(adminList.events.some((e) => e.status === 'archived'), 'admin CAN list archived events');
  ok(adminList.events.some((e) => !!e.notifyEmail), 'admin DOES see organiser addresses');

  head('2. Server: rep feed carries names');
  const rep = await apiGet({ action: 'event', id: 'surf-expo-fall-2026', token: REP });
  ok(rep.role === 'rep', 'rep password -> role is rep');
  ok(/17th Street/.test(JSON.stringify(rep)), 'rep sees retailer names');
  ok(!/cancelToken/.test(JSON.stringify(rep)), 'rep feed still withholds cancel tokens');

  head('3. Server: only admin may create events or block slots');
  const pubCreate = await api({ action: 'createEvent', name: 'Sneaky Show',
    days: [{ date: '2027-01-01' }], stations: [{ id: 'station-1', name: 'X' }] });
  ok(pubCreate.ok === false && /PASSWORD_REQUIRED/.test(pubCreate.error), 'retailer cannot create an event');
  const repCreate = await api({ action: 'createEvent', token: REP, name: 'Sneaky Show',
    days: [{ date: '2027-01-01' }], stations: [{ id: 'station-1', name: 'X' }] });
  ok(repCreate.ok === false && /PASSWORD_REQUIRED/.test(repCreate.error), 'rep cannot create an event either');
  const repBlock = await api({ action: 'toggleBlock', token: REP, eventId: 'surf-expo-fall-2026',
    date: '2026-09-18', stationId: 'station-1', startTime: '09:00' });
  ok(repBlock.ok === false && /PASSWORD_REQUIRED/.test(repBlock.error), 'rep cannot block slots');

  head('4. Server: cancelling respects the roles');
  const someId = rep.bookings[0].bookingId;
  const pubCancel = await api({ action: 'cancel', bookingId: someId });
  ok(pubCancel.ok === false && /PASSWORD_REQUIRED/.test(pubCancel.error),
    'retailer cannot cancel someone else by booking id');
  const repCancel = await api({ action: 'cancel', token: REP, bookingId: someId });
  ok(repCancel.ok === true, 'rep can cancel');

  head('5. Server: a retailer can cancel their own booking with the emailed token');
  const mine = await api({ action: 'book', eventId: 'surf-expo-fall-2026', date: '2026-09-18',
    stationId: 'station-3', startTime: '10:00', retailer: 'Self Serve Surf',
    contactName: 'Pat', contactEmail: 'pat@example.com' });
  ok(mine.ok === true, 'retailer books with no password');
  ok(!!mine.booking.cancelToken, 'booker is handed a private cancel token');
  const lookup = await apiGet({ action: 'lookup', cancelToken: mine.booking.cancelToken });
  ok(lookup.ok === true && lookup.booking.retailer === 'Self Serve Surf', 'token looks up their own booking');
  const selfCancel = await api({ action: 'cancel', cancelToken: mine.booking.cancelToken });
  ok(selfCancel.ok === true, 'retailer cancels their own booking, no password');
  const twice = await api({ action: 'cancel', cancelToken: mine.booking.cancelToken });
  ok(twice.ok === false, 'the same link cannot be used twice');
  const badTok = await api({ action: 'cancel', cancelToken: 'not-a-real-token' });
  ok(badTok.ok === false, 'a made-up cancel token is refused');

  head('6. Server: double-booking and blocked slots still refused');
  await api({ action: 'book', eventId: 'surf-expo-fall-2026', date: '2026-09-18',
    stationId: 'station-4', startTime: '09:00', retailer: 'First In',
    contactName: 'A', contactEmail: 'a@b.com' });
  const clash = await api({ action: 'book', eventId: 'surf-expo-fall-2026', date: '2026-09-18',
    stationId: 'station-4', startTime: '09:00', retailer: 'Second In',
    contactName: 'B', contactEmail: 'b@c.com' });
  ok(clash.ok === false && /just taken/.test(clash.error), 'second booker is turned away');
  ok(!/First In/.test(clash.error), 'the clash message does not leak who holds the slot');
  await api({ action: 'toggleBlock', token: ADMIN, eventId: 'surf-expo-fall-2026',
    date: '2026-09-18', stationId: 'station-4', startTime: '11:00' });
  const onBlock = await api({ action: 'book', eventId: 'surf-expo-fall-2026', date: '2026-09-18',
    stationId: 'station-4', startTime: '11:00', retailer: 'Nope', contactName: 'C', contactEmail: 'c@d.com' });
  ok(onBlock.ok === false && /blocked/.test(onBlock.error), 'blocked slot refuses bookings');

  /* ================= RETAILER (no password) ================= */

  head('7. Retailer view');
  const { page } = await ctxFor(null);
  await page.goto(B + '/index.html');
  await page.waitForSelector('.event-card', { timeout: 8000 });
  ok(await page.locator('[data-role-admin]').first().isHidden(), '"Create New Event" is hidden from retailers');
  await page.screenshot({ path: shots + '01-retailer-index.png', fullPage: true });

  await page.locator('.event-card').first().click();
  await page.waitForSelector('table.grid tbody tr', { timeout: 8000 });
  const anon = await page.locator('td.slot-taken.anon').count();
  ok(anon > 0, `booked slots render as anonymous (${anon})`);
  ok(await page.locator('td.slot-taken .retailer').count() === 0, 'no retailer name appears in any cell');
  const gridTxt = await page.locator('table.grid').innerText();
  ok(!/17th Street|Tilly|Hi Tech/.test(gridTxt), 'grid text contains no retailer names');
  ok(/booked/i.test(gridTxt), 'taken slots are labelled Booked');
  ok(await page.locator('#btn-admin').isHidden(), 'Manage Bookings is hidden from retailers');
  await page.screenshot({ path: shots + '02-retailer-grid.png', fullPage: true });

  head('8. Retailer can still book');
  await page.locator('td.slot-open .slot-btn').first().click();
  await page.waitForSelector('#book-modal:not([hidden])');
  await page.fill('#f-retailer', 'Ron Jon Surf Shop');
  await page.fill('#f-name', 'Dana Buyer');
  await page.fill('#f-email', 'dana@ronjon.example.com');
  await page.fill('#f-notes', 'Wants to see the new boardshort program.');
  await page.click('#book-submit');
  await page.waitForSelector('#done-modal:not([hidden])', { timeout: 8000 });
  ok(true, 'booking confirmed');
  await page.screenshot({ path: shots + '03-retailer-confirmed.png' });
  await page.click('#done-close');
  await page.waitForTimeout(700);
  ok(await page.locator('td.slot-taken .retailer').count() === 0, 'their own booking is anonymous on the grid too');

  head('9. Retailer is blocked from the admin pages');
  await page.goto(B + '/new.html');
  await page.waitForSelector('#gate:not(.hidden)', { timeout: 8000 });
  ok(await page.locator('#main').isHidden(), 'New Event form is hidden behind the gate');
  await page.screenshot({ path: shots + '04-gate.png', fullPage: true });
  await page.goto(B + '/admin.html?e=surf-expo-fall-2026');
  await page.waitForSelector('#gate:not(.hidden)', { timeout: 8000 });
  ok(await page.locator('#main').isHidden(), 'Manage page is hidden behind the gate');

  head('10. Retailer self-cancel link from their email');
  const bk = await api({ action: 'book', eventId: 'surf-expo-fall-2026', date: '2026-09-18',
    stationId: 'station-2', startTime: '15:00', retailer: 'Link Cancel Co',
    contactName: 'Sam', contactEmail: 'sam@example.com' });
  await page.goto(B + '/event.html?e=surf-expo-fall-2026&cancel=' + bk.booking.cancelToken);
  await page.waitForSelector('#selfcancel-modal:not([hidden])', { timeout: 8000 });
  ok(/Link Cancel Co/.test(await page.locator('#sc-table').innerText()), 'their own booking is shown');
  await page.screenshot({ path: shots + '05-self-cancel.png' });
  await page.click('#sc-cancel');
  await page.waitForSelector('#selfcancel-modal', { state: 'hidden', timeout: 8000 });
  ok(!/cancel=/.test(page.url()), 'the private token is scrubbed from the URL');
  const after = await apiGet({ action: 'event', id: 'surf-expo-fall-2026', token: REP });
  ok(!after.bookings.some((b) => b.retailer === 'Link Cancel Co'), 'slot is free again');

  /* ================= REP ================= */

  head('11. Rep view');
  const { page: repPage } = await ctxFor(REP);
  await repPage.goto(B + '/event.html?e=surf-expo-fall-2026');
  await repPage.waitForSelector('table.grid tbody tr', { timeout: 8000 });
  ok(await repPage.locator('#role-chip').innerText().then((t) => /rep/i.test(t)), 'header shows a Rep badge');
  ok(await repPage.locator('td.slot-taken .retailer').count() > 0, 'rep sees retailer names in cells');
  ok(await repPage.locator('td.slot-taken.anon').count() === 0, 'no anonymous cells for a rep');
  ok(await repPage.locator('[data-role-admin]').first().isHidden(), 'rep still cannot see admin nav');
  await repPage.screenshot({ path: shots + '06-rep-grid.png', fullPage: true });

  head('12. Rep can open a booking and cancel it');
  await repPage.locator('td.slot-taken .slot-btn').first().click();
  await repPage.waitForSelector('#detail-modal:not([hidden])');
  const detail = await repPage.locator('#det-table').innerText();
  ok(/@/.test(detail), 'rep sees the contact email');
  ok(!(await repPage.locator('#det-cancel-booking').isHidden()), 'rep gets a Cancel button');
  await repPage.screenshot({ path: shots + '07-rep-detail.png' });
  repPage.once('dialog', (d) => d.accept());
  await repPage.click('#det-cancel-booking');
  await repPage.waitForTimeout(1200);
  ok(await repPage.locator('#detail-modal').isHidden(), 'cancel completed');

  head('12b. A rep wandering onto an admin page keeps their rep access');
  await repPage.goto(B + '/admin.html?e=surf-expo-fall-2026');
  await repPage.waitForSelector('#gate:not(.hidden)', { timeout: 8000 });
  ok(await repPage.locator('#main').isHidden(), 'rep is stopped at the admin gate');
  ok(await repPage.evaluate(() => localStorage.getItem('showtime_token')) === REP_IN_PAGE,
    'rep password survives the visit');
  await repPage.goto(B + '/event.html?e=surf-expo-fall-2026');
  await repPage.waitForSelector('table.grid tbody tr');
  ok(await repPage.locator('td.slot-taken .retailer').count() > 0, 'still sees names afterwards');

  head('13. Rep magic link signs a fresh browser in');
  const { page: magic } = await ctxFor(null);
  await magic.goto(B + '/event.html?e=surf-expo-fall-2026&k=' + encodeURIComponent(REP));
  await magic.waitForSelector('table.grid tbody tr', { timeout: 8000 });
  ok(!/[?&]k=/.test(magic.url()), 'the password is scrubbed out of the URL');
  ok(await magic.locator('td.slot-taken .retailer').count() > 0, 'magic link grants the rep view');
  ok(await magic.evaluate(() => localStorage.getItem('showtime_token')) === REP, 'password remembered for next visit');

  /* ================= ADMIN ================= */

  head('14. Admin view');
  const { page: adminPage } = await ctxFor(ADMIN);
  await adminPage.goto(B + '/index.html');
  await adminPage.waitForSelector('.event-card', { timeout: 8000 });
  ok(!(await adminPage.locator('[data-role-admin]').first().isHidden()), 'admin sees "Create New Event"');
  ok(await adminPage.locator('#role-chip').innerText().then((t) => /admin/i.test(t)), 'header shows an Admin badge');

  await adminPage.goto(B + '/admin.html?e=surf-expo-fall-2026');
  await adminPage.waitForSelector('#rows tr td', { timeout: 8000 });
  ok(await adminPage.locator('#gate').isHidden(), 'gate opens for admin');
  ok(/filled/i.test(await adminPage.locator('#summary').innerText()), 'summary strip renders');
  ok(/@/.test(await adminPage.locator('#rows').innerText()), 'admin sees contact emails');
  await adminPage.screenshot({ path: shots + '08-admin.png', fullPage: true });

  head('15. Admin can block a slot');
  const before = await adminPage.locator('#blockgrid .slot-blocked').count();
  await adminPage.locator('#blockgrid td.slot-open .slot-btn').first().click();
  await adminPage.waitForTimeout(1300);
  ok(await adminPage.locator('#blockgrid .slot-blocked').count() === before + 1, 'slot blocked');

  head('16. Admin creates a new event');
  await adminPage.goto(B + '/new.html');
  await adminPage.waitForSelector('#main:not(.hidden)', { timeout: 8000 });
  await adminPage.fill('#f-name', 'Agenda Show Spring 2027');
  await adminPage.fill('#f-venue', 'Long Beach Convention Center');
  await adminPage.selectOption('#f-slot', '30');
  await adminPage.fill('#f-start', '2027-01-12');
  await adminPage.fill('#f-end', '2027-01-14');
  await adminPage.waitForTimeout(400);
  ok((await adminPage.locator('#days > div').count()) === 3, 'three per-day rows generated');
  ok(/total bookable slots/i.test(await adminPage.locator('#preview-body').innerText()), 'preview computes totals');
  await adminPage.screenshot({ path: shots + '09-new-event.png', fullPage: true });
  await adminPage.click('#submit');
  await adminPage.waitForURL(/event\.html\?e=/, { timeout: 8000 });
  await adminPage.waitForSelector('table.grid tbody tr');
  const nr = await adminPage.locator('table.grid tbody tr').count();
  ok(nr === 18, `30-min slots produce 18 rows (got ${nr})`);

  head('17. Signing out drops back to the retailer view');
  // Fresh context with no init script, so sign-out actually sticks.
  const { page: out } = await ctxFor(null);
  await out.goto(B + '/event.html?e=surf-expo-fall-2026&k=' + encodeURIComponent(ADMIN));
  await out.waitForSelector('table.grid tbody tr');
  ok(await out.locator('td.slot-taken .retailer').count() > 0, 'signed in as admin, names visible');
  ok(!(await out.locator('[data-role-admin]').first().isHidden()), 'admin nav visible while signed in');
  await out.click('#role-btn');                       // "Sign out"
  await out.waitForSelector('table.grid tbody tr');
  await out.waitForTimeout(400);
  ok(await out.evaluate(() => localStorage.getItem('showtime_token')) === null, 'password cleared from browser');
  ok(await out.locator('td.slot-taken .retailer').count() === 0, 'names gone after sign-out');
  ok(await out.locator('[data-role-admin]').first().isHidden(), 'admin nav gone after sign-out');
  ok(await out.locator('#role-chip').isHidden(), 'role badge gone after sign-out');

  /* ================= LAYOUT ================= */

  head('18. Mobile');
  const { page: mob } = await ctxFor(null);
  await mob.setViewportSize({ width: 390, height: 844 });
  await mob.goto(B + '/event.html?e=surf-expo-fall-2026');
  await mob.waitForSelector('table.grid tbody tr');
  const sc = await mob.locator('.grid-scroll').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  ok(sc.sw > sc.cw, 'grid scrolls horizontally rather than squashing');
  ok(await mob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'no horizontal page overflow');
  await mob.screenshot({ path: shots + '10-mobile.png', fullPage: true });

  head('19. Unconfigured API still explains itself');
  const { page: raw } = await ctxFor(null);
  await raw.route('**/config.js', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: "window.SHOWTIME_CONFIG={API_URL:'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE'};"
  }));
  await raw.goto(B + '/index.html');
  await raw.waitForSelector('#alert:not([hidden])', { timeout: 6000 });
  ok(/finish the setup/i.test(await raw.locator('#list').innerText()), 'shows setup instructions');

  head('20. Shared staff password (the shipped configuration)');
  // Boot a second mock where ADMIN and REP are the same string, exactly as
  // setup() leaves them, and confirm nothing degrades to the retailer view.
  const SHARED = 'jetty5dyol';
  const P2 = PORT + 1;
  const shared = spawn(process.execPath, [__dirname + '/mock-server.js'], {
    env: { ...process.env, PORT: String(P2), ADMIN_TOKEN: SHARED, REP_TOKEN: SHARED },
    stdio: 'ignore'
  });
  const B2 = 'http://localhost:' + P2, API2 = B2 + '/api';
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(API2 + '?action=ping')).ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    const who = await (await fetch(API2 + '?action=ping&token=' + SHARED)).json();
    ok(who.role === 'admin', 'one shared password signs you in as admin');
    const noPw = await (await fetch(API2 + '?action=event&id=surf-expo-fall-2026')).json();
    ok(noPw.role === 'public' && !/17th Street/.test(JSON.stringify(noPw)),
      'retailers with no password still see nothing but Open / Booked');
    const staff = await (await fetch(
      API2 + '?action=event&id=surf-expo-fall-2026&token=' + SHARED)).json();
    ok(/17th Street/.test(JSON.stringify(staff)), 'staff see retailer names');
    const mk = await (await fetch(API2, { method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'createEvent', token: SHARED, name: 'Shared Pw Show',
        days: [{ date: '2027-03-01' }], stations: [{ id: 'station-1', name: 'A' }] }) })).json();
    ok(mk.ok === true, 'staff can create events (the rep limit is gone by design)');
    const wrong = await (await fetch(API2 + '?action=ping&token=nope')).json();
    ok(wrong.role === 'public', 'a wrong password is still just a retailer');

    const { page: sp } = await ctxFor(null);
    await sp.goto(B2 + '/event.html?e=surf-expo-fall-2026&k=' + SHARED);
    await sp.waitForSelector('table.grid tbody tr', { timeout: 8000 });
    ok(/admin/i.test(await sp.locator('#role-chip').innerText()), 'header shows the Admin badge');
    ok(!(await sp.locator('[data-role-admin]').first().isHidden()), 'admin nav is available');
  } finally {
    try { shared.kill('SIGKILL'); } catch (e) {}
  }

  head('20b. Editing an event');
  const { page: ed } = await ctxFor(ADMIN);

  // Only admins get in.
  const { page: edPub } = await ctxFor(null);
  await edPub.goto(B + '/edit.html?e=surf-expo-fall-2026');
  await edPub.waitForSelector('#gate:not(.hidden)', { timeout: 8000 });
  ok(await edPub.locator('#main').isHidden(), 'retailer is stopped at the edit gate');
  const edRep = await api({ action: 'updateEvent', token: REP, eventId: 'surf-expo-fall-2026', name: 'Nope' });
  ok(edRep.ok === false && /PASSWORD_REQUIRED/.test(edRep.error), 'rep cannot edit an event');

  await ed.goto(B + '/edit.html?e=surf-expo-fall-2026');
  await ed.waitForSelector('#main:not(.hidden)', { timeout: 8000 });
  ok((await ed.locator('#f-name').inputValue()).includes('Surf Expo'), 'form is pre-filled');
  const stCount = await ed.locator('#stations > div').count();
  ok(stCount === 4, `four stations listed (got ${stCount})`);
  ok(/booked/i.test(await ed.locator('#stations').innerText()), 'shows which stations hold bookings');
  await ed.screenshot({ path: shots + '12-edit.png', fullPage: true });

  // Rename the event and the station that actually holds appointments.
  await ed.fill('#f-name', 'Surf Expo — Fall 2026 (Jetty)');
  const busy = ed.locator('#stations > div').nth(1).locator('.st-input');
  await busy.fill('Summer In-House / Business');
  await ed.click('#submit');
  await ed.waitForSelector('.alert-ok', { timeout: 8000 });
  const okTxt = await ed.locator('#alert').innerText();
  ok(/saved/i.test(okTxt), 'save confirms');
  ok(/\d+ existing appointments were updated/i.test(okTxt), 'reports the bookings it kept in sync: ' + okTxt.trim());

  // The rename must reach the bookings, not just the event header.
  const afterEdit = await apiGet({ action: 'event', id: 'surf-expo-fall-2026', token: ADMIN });
  ok(afterEdit.event.name === 'Surf Expo — Fall 2026 (Jetty)', 'event name changed');
  ok(afterEdit.event.stations[1].name === 'Summer In-House / Business', 'station name changed');
  ok(afterEdit.event.stations[1].id === 'station-2', 'station id was NOT changed');
  const stale = afterEdit.bookings.filter((b) => b.stationId === 'station-2'
    && b.stationName !== 'Summer In-House / Business');
  ok(stale.length === 0, 'no booking is left showing the old station name');
  ok(afterEdit.bookings.length > 0, 'and the bookings are all still attached');

  // Removing a station that still holds appointments must be refused.
  const drop = await api({
    action: 'updateEvent', token: ADMIN, eventId: 'surf-expo-fall-2026',
    stations: afterEdit.event.stations.filter((s) => s.id !== 'station-2')
  });
  ok(drop.ok === false && /still has/.test(drop.error),
    'refuses to strand appointments: ' + drop.error);
  const stillThere = await apiGet({ action: 'event', id: 'surf-expo-fall-2026', token: ADMIN });
  ok(stillThere.event.stations.length === 4, 'nothing was removed');

  // An empty station name is caught rather than silently blanking a column.
  const blank = await api({
    action: 'updateEvent', token: ADMIN, eventId: 'surf-expo-fall-2026',
    stations: [{ id: 'station-1', name: '' }]
  });
  ok(blank.ok === false, 'blank station name refused');

  // Adding a station is safe and gets a fresh id.
  const grown = await api({
    action: 'updateEvent', token: ADMIN, eventId: 'surf-expo-fall-2026',
    stations: stillThere.event.stations.concat([{ name: 'Overflow Table' }])
  });
  ok(grown.ok === true, 'a station can be added');
  const after2 = await apiGet({ action: 'event', id: 'surf-expo-fall-2026', token: ADMIN });
  ok(after2.event.stations.length === 5, 'five stations now');
  const ids = after2.event.stations.map((s) => s.id);
  ok(new Set(ids).size === ids.length, 'every station id is still unique: ' + ids.join(','));

  // The renamed event must show up correctly for a retailer too.
  const { page: seeIt } = await ctxFor(null);
  await seeIt.goto(B + '/event.html?e=surf-expo-fall-2026');
  await seeIt.waitForSelector('table.grid tbody tr', { timeout: 8000 });
  ok(/Summer In-House/.test(await seeIt.locator('table.grid thead').innerText()),
    'retailer grid shows the new station name');
  ok((await seeIt.locator('table.grid thead th').count()) === 6, 'and the added station column');

  head('21. A blocked request explains itself');
  // Simulate exactly what Cory's ad blocker did: kill the request outright.
  const { page: blk } = await ctxFor(null);
  await blk.route('**/api*', (r) => r.abort('blockedbyclient'));
  await blk.goto(B + '/event.html?e=surf-expo-fall-2026');
  await blk.waitForSelector('#alert:not([hidden])', { timeout: 8000 });
  const blkTxt = await blk.locator('#alert').innerText();
  ok(!/failed to fetch/i.test(blkTxt), 'no raw "Failed to fetch" shown to the visitor');
  ok(/ad blocker|privacy extension/i.test(blkTxt), 'names the likely cause');
  ok(/private|incognito/i.test(blkTxt), 'offers a way out');
  await blk.screenshot({ path: shots + '11-blocked.png', fullPage: true });

  // A real server-side error must still come through verbatim, not be
  // mislabelled as a blocked connection.
  const { page: srv } = await ctxFor(null);
  await srv.route('**/api*', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'Event not found: nope' })
  }));
  await srv.goto(B + '/event.html?e=nope');
  await srv.waitForSelector('#alert:not([hidden])', { timeout: 8000 });
  const srvTxt = await srv.locator('#alert').innerText();
  ok(/event not found/i.test(srvTxt), 'a real server error still shows its own message');
  ok(!/ad blocker/i.test(srvTxt), 'server errors are not mislabelled as blocked');

  head('22. No JS errors anywhere');
  ok(errors.length === 0, 'clean console' + (errors.length ? ': ' + errors.join(' | ') : ''));

  await browser.close();
  stopMock();
  console.log('\n' + (fails ? '✗ ' + fails + ' FAILURE(S)' : '✓ ALL CHECKS PASSED') + '\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { stopMock(); console.error(e); process.exit(1); });
