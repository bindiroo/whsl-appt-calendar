/**
 * ============================================================
 *  SEED — Surf Expo, Sept 16–18 2026, Orlando FL
 * ============================================================
 *  Optional. Run `seedSurfExpo` once from the Apps Script editor
 *  to create the event without touching the website form.
 *
 *  Then, if you want the appointments that are already penciled
 *  into your old Google Sheet carried over, run
 *  `seedSurfExpoBookings` too. It writes them straight into the
 *  Bookings sheet WITHOUT sending any confirmation emails.
 *  Skip it if you'd rather start from a clean grid.
 * ============================================================
 */

var SURF_EXPO_ID = 'surf-expo-fall-2026';

function seedSurfExpo() {
  var res = createEvent_({
    eventId: SURF_EXPO_ID,
    name: 'Surf Expo — Fall 2026',
    subtitle: 'Jetty Showroom Appointments',
    venue: 'Orange County Convention Center',
    city: 'Orlando, FL',
    notifyEmail: 'cory@jettylife.com',
    replyTo: 'cory@jettylife.com',
    slotMinutes: 60,
    dayStart: '09:00',
    dayEnd: '18:00',
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
    ]
  });
  Logger.log('Created event: ' + res.eventId);
  Logger.log('Booking link: <your-netlify-site>/event.html?e=' + res.eventId);
  return res;
}

/**
 * Carries over the appointments already written into the old
 * planning sheet. Silent — no emails are sent.
 * Edit / delete rows below before running if any have changed.
 */
function seedSurfExpoBookings() {
  var rows = [
    // date,        station,      time,    retailer,          contact,   email
    ['2026-09-16', 'station-2', '11:00', '17th Street', '', ''],
    ['2026-09-16', 'station-2', '13:00', 'Hi Tech', '', ''],
    ['2026-09-16', 'station-2', '14:00', "Tilly's", '', ''],
    ['2026-09-16', 'station-2', '15:00', 'BC Surf n Sport', '', ''],
    ['2026-09-16', 'station-2', '16:00', 'Quiet Storm', '', ''],
    ['2026-09-17', 'station-2', '11:00', 'Sun Diego', '', ''],
    ['2026-09-17', 'station-2', '12:00', 'Ron Jon', '', ''],
    ['2026-09-17', 'station-2', '13:00', 'Deja Vu', '', ''],
    ['2026-09-17', 'station-2', '14:00', 'Deja Vu', '', ''],
    ['2026-09-17', 'station-2', '16:00', 'Rooster Bus', '', '']
  ];

  var ev = findEvent_(SURF_EXPO_ID);
  if (!ev) throw new Error('Run seedSurfExpo() first.');
  var event = shapeEvent_(ev);
  var stationName = {};
  event.stations.forEach(function (s) { stationName[s.id] = s.name; });

  var existing = readAll_(SHEET_BOOKINGS, BOOKING_COLS);
  var taken = {};
  existing.forEach(function (r) {
    if (String(r.event_id) === SURF_EXPO_ID && String(r.status || 'confirmed') !== 'cancelled') {
      taken[asDateStr_(r.date) + '|' + r.station_id + '|' + asTimeStr_(r.start_time)] = true;
    }
  });

  var added = 0;
  var now = new Date();
  rows.forEach(function (r) {
    var key = r[0] + '|' + r[1] + '|' + r[2];
    if (taken[key]) return;
    appendRow_(SHEET_BOOKINGS, BOOKING_COLS, {
      booking_id: 'BK-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
      event_id: SURF_EXPO_ID,
      date: r[0],
      station_id: r[1],
      station_name: stationName[r[1]] || r[1],
      start_time: r[2],
      end_time: addMinutes_(r[2], event.slotMinutes),
      retailer: r[3],
      contact_name: r[4] || r[3],
      contact_email: r[5] || '',
      phone: '',
      booked_by: 'Imported from planning sheet',
      notes: '',
      status: 'confirmed',
      cancel_token: Utilities.getUuid().replace(/-/g, ''),
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    });
    added++;
  });
  Logger.log('Imported ' + added + ' appointment(s).');
  return added;
}
