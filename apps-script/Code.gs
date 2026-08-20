/**
 * ============================================================
 *  JETTY SHOWTIME — Booking API (Google Apps Script Web App)
 * ============================================================
 *  Turns a Google Sheet into the database + API for the
 *  Showtime appointment-booking site.
 *
 *  SETUP (one time):
 *   1. Open the Google Sheet you want to use as the database.
 *   2. Extensions > Apps Script. Delete anything in Code.gs and
 *      paste this whole file in. Save.
 *   3. Run the function `setup` once (choose it in the toolbar
 *      dropdown, press Run). Approve the permissions prompt.
 *      It prints your ADMIN and REP passwords in the log —
 *      View > Logs. Write them down.
 *   4. Deploy > New deployment > type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Copy the /exec URL it gives you.
 *   5. Paste that URL into config.js in the website repo.
 *   6. Run `setSiteUrl('https://your-site.netlify.app')` so
 *      cancellation links can be included in emails.
 *
 *  RE-DEPLOY after any code change: Deploy > Manage deployments
 *  > pencil icon > Version: New version > Deploy. (The URL stays
 *  the same.)
 *
 *  ---------------------------------------------------------
 *  WHO CAN DO WHAT
 *  ---------------------------------------------------------
 *  RETAILER (no password — the plain event link)
 *    · sees every slot as either Open or Booked
 *    · never sees WHO is booked, or any contact details
 *    · can book an open slot
 *    · can cancel their OWN booking, via the private link in
 *      their confirmation email
 *
 *  REP (rep password / magic link)
 *    · sees retailer names and contact details in the grid
 *    · can book on a retailer's behalf
 *    · can cancel any booking
 *
 *  ADMIN (admin password)
 *    · everything a rep can do
 *    · create and edit events
 *    · block off slots
 *    · export bookings
 *
 *  AS SHIPPED both staff passwords are the same value, so in
 *  practice there are two tiers, not three: retailers with no
 *  password, and staff who are full admins. Set the two
 *  passwords to different values to get the rep tier back.
 *  ---------------------------------------------------------
 * ============================================================
 */

var SHEET_EVENTS = 'Events';
var SHEET_BOOKINGS = 'Bookings';
var SHEET_BLOCKS = 'Blocks';

var EVENT_COLS = [
  'event_id', 'name', 'subtitle', 'venue', 'city', 'start_date', 'end_date',
  'days_json', 'stations_json', 'slot_minutes', 'day_start', 'day_end',
  'notify_email', 'reply_to', 'status', 'created_at', 'updated_at'
];

var BOOKING_COLS = [
  'booking_id', 'event_id', 'date', 'station_id', 'station_name',
  'start_time', 'end_time', 'retailer', 'contact_name', 'contact_email',
  'phone', 'booked_by', 'notes', 'status', 'cancel_token', 'created_at', 'updated_at'
];

var BLOCK_COLS = ['block_id', 'event_id', 'date', 'station_id', 'start_time', 'reason', 'created_at'];

/*
 *  The password both staff roles start with. Change it here before running
 *  setup(), or change it later from the editor with:
 *      setPasswords('newAdminPassword', 'newRepPassword')
 *
 *  NOTE: while ADMIN and REP are the same string, anyone who signs in is an
 *  ADMIN — roleFor_ checks the admin password first. That means every rep can
 *  also create events, edit them and block slots. Give them different values
 *  if you want the rep tier to be limited again.
 */
var DEFAULT_PASSWORD = 'jetty5dyol';

var TEXT_COLS_ = {
  'Events': ['start_date', 'end_date', 'day_start', 'day_end'],
  'Bookings': ['date', 'start_time', 'end_time'],
  'Blocks': ['date', 'start_time']
};

/* ================================================================== */
/* Setup                                                              */
/* ================================================================== */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_EVENTS, EVENT_COLS);
  ensureSheet_(ss, SHEET_BOOKINGS, BOOKING_COLS);
  ensureSheet_(ss, SHEET_BLOCKS, BLOCK_COLS);

  var props = PropertiesService.getScriptProperties();
  if (!String(props.getProperty('ADMIN_TOKEN') || '').trim()) {
    props.setProperty('ADMIN_TOKEN', DEFAULT_PASSWORD);
  }
  if (!String(props.getProperty('REP_TOKEN') || '').trim()) {
    props.setProperty('REP_TOKEN', DEFAULT_PASSWORD);
  }
  showPasswords();
  return 'ok';
}

/**
 * Force both passwords back to DEFAULT_PASSWORD.
 * Use this if setup() already ran and set something else.
 */
function useDefaultPasswords() {
  return setPasswords(DEFAULT_PASSWORD, DEFAULT_PASSWORD);
}

/** Prints the current passwords. Run any time you forget them. */
function showPasswords() {
  var props = PropertiesService.getScriptProperties();
  var site = String(props.getProperty('SITE_URL') || '').replace(/\/+$/, '');
  var admin = props.getProperty('ADMIN_TOKEN');
  var rep = props.getProperty('REP_TOKEN');
  var lines = [
    '',
    '=========================================================',
    '  JETTY — APPOINTMENT BOOKING · passwords',
    '========================================================='
  ];
  if (admin && admin === rep) {
    lines.push('  STAFF password : ' + admin);
    lines.push('');
    lines.push('  Admin and rep are set to the same password, so anyone');
    lines.push('  who signs in gets FULL ADMIN — they can see retailer');
    lines.push('  names, cancel bookings, block slots AND create events.');
    lines.push('  Retailers still need no password and still see only');
    lines.push('  Open / Booked.');
    lines.push('');
    lines.push('  To split them apart again:');
    lines.push("    setPasswords('adminOnlyPassword', 'repPassword')");
  } else {
    lines.push('  ADMIN password : ' + admin);
    lines.push('  REP password   : ' + rep);
    lines.push('');
    lines.push('  Admin password unlocks New Event and Manage.');
    lines.push('  Rep password reveals retailer names in the grid.');
    lines.push('  Retailers need no password at all.');
  }
  lines.push('');
  if (site) {
    lines.push('  Staff magic link (share with your reps):');
    lines.push('    ' + site + '/event.html?e=<event-id>&k='
      + encodeURIComponent(rep));
  } else {
    lines.push('  Run setSiteUrl(\'https://your-site.netlify.app\') to get');
    lines.push('  a ready-made rep magic link and cancellation links in emails.');
  }
  lines.push('=========================================================');
  lines.push('');
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Change either password to something you'll remember. */
function setPasswords(adminPassword, repPassword) {
  var props = PropertiesService.getScriptProperties();
  if (adminPassword) props.setProperty('ADMIN_TOKEN', String(adminPassword).trim());
  if (repPassword) props.setProperty('REP_TOKEN', String(repPassword).trim());
  return showPasswords();
}

/** Tell the script where the website lives, for links inside emails. */
function setSiteUrl(url) {
  PropertiesService.getScriptProperties()
    .setProperty('SITE_URL', String(url || '').trim().replace(/\/+$/, ''));
  return showPasswords();
}

/** Handy if you ever want a random password instead of a chosen one. */
function makePassword_() {
  // Readable, no ambiguous characters, still ~10^13 combinations.
  var words = ['surf', 'swell', 'tide', 'reef', 'dune', 'jetty', 'shore', 'drift',
    'coast', 'break', 'lineup', 'anchor', 'salt', 'north', 'inlet', 'sandbar'];
  var pick = function () { return words[Math.floor(Math.random() * words.length)]; };
  return pick() + '-' + pick() + '-' + Math.floor(1000 + Math.random() * 9000);
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var existing = sh.getLastColumn() > 0
    ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    : [];
  var same = existing.length === cols.length && cols.every(function (c, i) { return existing[i] === c; });
  if (!same) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.getRange(1, 1, 1, cols.length)
      .setFontWeight('bold')
      .setBackground('#0F0F0F')
      .setFontColor('#F7F6F2');
    sh.setFrozenRows(1);
    // Force date/time columns to plain text. Otherwise Sheets converts
    // "2026-09-16" and "09:00" into date/time values, and a mismatch between
    // the sheet's timezone and the script's can shift a booking by a day.
    (TEXT_COLS_[name] || []).forEach(function (c) {
      var idx = cols.indexOf(c);
      if (idx >= 0) sh.getRange(2, idx + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    });
  }
  return sh;
}

function sheet_(name, cols) {
  return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), name, cols);
}

/* ================================================================== */
/* Roles                                                              */
/* ================================================================== */

function prop_(k) {
  return String(PropertiesService.getScriptProperties().getProperty(k) || '').trim();
}

/** 'admin' | 'rep' | 'public' */
function roleFor_(tok) {
  tok = String(tok || '').trim();
  if (!tok) return 'public';
  var admin = prop_('ADMIN_TOKEN');
  var rep = prop_('REP_TOKEN');
  if (admin && tok === admin) return 'admin';
  if (rep && tok === rep) return 'rep';
  return 'public';
}

/** Reps and admins see retailer names and contact details. */
function canSeeNames_(role) { return role === 'admin' || role === 'rep'; }

function requireRole_(role, allowed, what) {
  if (allowed.indexOf(role) === -1) {
    throw new Error(NEED_ + (allowed.indexOf('rep') >= 0 ? 'rep' : 'admin')
      + ' password to ' + what + '.');
  }
}

// The client watches for this prefix to know it should prompt for a password.
var NEED_ = 'PASSWORD_REQUIRED: You need the ';

/* ================================================================== */
/* HTTP entry points                                                  */
/* ================================================================== */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var role = roleFor_(p.token);
    var action = p.action || 'events';
    if (action === 'ping') return json_({ ok: true, pong: true, role: role });
    if (action === 'events') {
      // Archived events, and the organiser's own contact addresses, are for
      // admins only. The single-event path redacts these too — keep the two
      // read paths in step.
      var evs = listEvents_(role === 'admin' && p.includeArchived === '1');
      if (role !== 'admin') {
        evs.forEach(function (ev) { ev.notifyEmail = ''; ev.replyTo = ''; });
      }
      return json_({ ok: true, role: role, events: evs });
    }
    if (action === 'event') return json_(getEventBundle_(p.id, role));
    if (action === 'lookup') return json_(lookupByToken_(p.cancelToken));
    throw new Error('Unknown action: ' + action);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Could not parse request body.' });
  }
  try {
    var action = body.action;
    var role = roleFor_(body.token);

    // Anyone can book.
    if (action === 'book') return json_(book_(body));

    // Cancelling: reps and admins may cancel anything; a retailer may cancel
    // their own booking using the private token from their confirmation email.
    if (action === 'cancel') return json_(cancel_(body, role));

    // Everything below is admin-only.
    if (action === 'updateBooking') { requireRole_(role, ['admin'], 'edit a booking'); return json_(updateBooking_(body)); }
    if (action === 'toggleBlock') { requireRole_(role, ['admin'], 'block slots'); return json_(toggleBlock_(body)); }
    if (action === 'createEvent') { requireRole_(role, ['admin'], 'create an event'); return json_(createEvent_(body)); }
    if (action === 'updateEvent') { requireRole_(role, ['admin'], 'edit an event'); return json_(updateEvent_(body)); }
    if (action === 'archiveEvent') { requireRole_(role, ['admin'], 'archive an event'); return json_(setEventStatus_(body.eventId, 'archived')); }
    if (action === 'restoreEvent') { requireRole_(role, ['admin'], 'restore an event'); return json_(setEventStatus_(body.eventId, 'active')); }

    throw new Error('Unknown action: ' + action);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================================================================== */
/* Read helpers                                                       */
/* ================================================================== */

function readAll_(name, cols) {
  var sh = sheet_(name, cols);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  return values.map(function (row, i) {
    var o = { _row: i + 2 };
    cols.forEach(function (c, ci) { o[c] = row[ci]; });
    return o;
  }).filter(function (o) { return String(o[cols[0]]).trim() !== ''; });
}

function listEvents_(includeArchived) {
  return readAll_(SHEET_EVENTS, EVENT_COLS)
    .filter(function (r) { return includeArchived || String(r.status || 'active') !== 'archived'; })
    .map(shapeEvent_)
    .sort(function (a, b) { return String(a.startDate).localeCompare(String(b.startDate)); });
}

function shapeEvent_(r) {
  return {
    eventId: String(r.event_id),
    name: String(r.name || ''),
    subtitle: String(r.subtitle || ''),
    venue: String(r.venue || ''),
    city: String(r.city || ''),
    startDate: asDateStr_(r.start_date),
    endDate: asDateStr_(r.end_date),
    days: safeJson_(r.days_json, []),
    stations: safeJson_(r.stations_json, []),
    slotMinutes: Number(r.slot_minutes) || 60,
    dayStart: asTimeStr_(r.day_start) || '09:00',
    dayEnd: asTimeStr_(r.day_end) || '18:00',
    notifyEmail: String(r.notify_email || ''),
    replyTo: String(r.reply_to || ''),
    status: String(r.status || 'active')
  };
}

function shapeBooking_(r) {
  return {
    bookingId: String(r.booking_id),
    eventId: String(r.event_id),
    date: asDateStr_(r.date),
    stationId: String(r.station_id),
    stationName: String(r.station_name || ''),
    startTime: asTimeStr_(r.start_time),
    endTime: asTimeStr_(r.end_time),
    retailer: String(r.retailer || ''),
    contactName: String(r.contact_name || ''),
    contactEmail: String(r.contact_email || ''),
    phone: String(r.phone || ''),
    bookedBy: String(r.booked_by || ''),
    notes: String(r.notes || ''),
    status: String(r.status || 'confirmed'),
    cancelToken: String(r.cancel_token || ''),
    createdAt: r.created_at ? String(r.created_at) : ''
  };
}

/**
 * What a retailer is allowed to know about someone else's booking:
 * that the slot is taken. Nothing else leaves the server.
 */
function publicBooking_(b) {
  return {
    eventId: b.eventId,
    date: b.date,
    stationId: b.stationId,
    startTime: b.startTime,
    endTime: b.endTime,
    booked: true
  };
}

function getEventBundle_(eventId, role) {
  if (!eventId) throw new Error('Missing event id.');
  var ev = findEvent_(String(eventId));
  if (!ev) throw new Error('Event not found: ' + eventId);
  var full = canSeeNames_(role);

  var bookings = readAll_(SHEET_BOOKINGS, BOOKING_COLS)
    .filter(function (r) {
      return String(r.event_id) === String(eventId) && String(r.status || 'confirmed') !== 'cancelled';
    })
    .map(function (r) {
      var b = shapeBooking_(r);
      delete b.cancelToken;               // never leaves the server in a list
      return full ? b : publicBooking_(b);
    });

  var blocks = readAll_(SHEET_BLOCKS, BLOCK_COLS)
    .filter(function (r) { return String(r.event_id) === String(eventId); })
    .map(function (r) {
      return {
        blockId: String(r.block_id),
        date: asDateStr_(r.date),
        stationId: String(r.station_id),
        startTime: asTimeStr_(r.start_time),
        reason: String(r.reason || '')
      };
    });

  var event = shapeEvent_(ev);
  if (role !== 'admin') { event.notifyEmail = ''; event.replyTo = ''; }

  return {
    ok: true, role: role, event: event, bookings: bookings, blocks: blocks,
    fetchedAt: new Date().toISOString()
  };
}

/** Used by the "cancel my appointment" link in a confirmation email. */
function lookupByToken_(cancelToken) {
  var tok = String(cancelToken || '').trim();
  if (!tok) throw new Error('Missing cancellation token.');
  var rows = readAll_(SHEET_BOOKINGS, BOOKING_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].cancel_token || '') === tok) {
      var b = shapeBooking_(rows[i]);
      return {
        ok: true,
        booking: {
          bookingId: b.bookingId, eventId: b.eventId, date: b.date,
          stationName: b.stationName, startTime: b.startTime, endTime: b.endTime,
          retailer: b.retailer, contactName: b.contactName, status: b.status
        }
      };
    }
  }
  throw new Error('That cancellation link is not valid — it may already have been used.');
}

function findEvent_(eventId) {
  var rows = readAll_(SHEET_EVENTS, EVENT_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].event_id) === String(eventId)) return rows[i];
  }
  return null;
}

/* ================================================================== */
/* Booking                                                            */
/* ================================================================== */

function book_(b) {
  var required = ['eventId', 'date', 'stationId', 'startTime', 'retailer', 'contactName', 'contactEmail'];
  required.forEach(function (k) {
    if (!b[k] || String(b[k]).trim() === '') throw new Error('Missing required field: ' + k);
  });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.contactEmail).trim())) {
    throw new Error('That email address does not look valid.');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server busy, please try again.');
  var result;
  try {
    var ev = findEvent_(String(b.eventId));
    if (!ev) throw new Error('Event not found.');
    var event = shapeEvent_(ev);

    var date = String(b.date);
    var stationId = String(b.stationId);
    var startTime = normTime_(b.startTime);

    var station = null;
    for (var i = 0; i < event.stations.length; i++) {
      if (String(event.stations[i].id) === stationId) station = event.stations[i];
    }
    if (!station) throw new Error('Unknown station.');

    var day = null;
    for (var d = 0; d < event.days.length; d++) {
      if (String(event.days[d].date) === date) day = event.days[d];
    }
    if (!day) throw new Error('That date is not part of this event.');

    var slots = buildSlots_(day, event);
    if (slots.indexOf(startTime) === -1) throw new Error('That time is not a valid slot for this day.');

    // Re-read inside the lock: this is what makes double-booking impossible.
    var taken = readAll_(SHEET_BOOKINGS, BOOKING_COLS).filter(function (r) {
      return String(r.event_id) === String(b.eventId)
        && asDateStr_(r.date) === date
        && String(r.station_id) === stationId
        && asTimeStr_(r.start_time) === startTime
        && String(r.status || 'confirmed') !== 'cancelled';
    });
    if (taken.length) {
      throw new Error('Sorry — that slot was just taken. Pick another one.');
    }

    var blocked = readAll_(SHEET_BLOCKS, BLOCK_COLS).filter(function (r) {
      return String(r.event_id) === String(b.eventId)
        && asDateStr_(r.date) === date
        && String(r.station_id) === stationId
        && asTimeStr_(r.start_time) === startTime;
    });
    if (blocked.length) throw new Error('That slot has been blocked off and is not bookable.');

    var now = new Date();
    var row = {
      booking_id: 'BK-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
      event_id: String(b.eventId),
      date: date,
      station_id: stationId,
      station_name: station.name || '',
      start_time: startTime,
      end_time: addMinutes_(startTime, event.slotMinutes),
      retailer: trim_(b.retailer),
      contact_name: trim_(b.contactName),
      contact_email: trim_(b.contactEmail),
      phone: trim_(b.phone),
      booked_by: trim_(b.bookedBy),
      notes: trim_(b.notes),
      status: 'confirmed',
      cancel_token: Utilities.getUuid().replace(/-/g, ''),
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    };
    appendRow_(SHEET_BOOKINGS, BOOKING_COLS, row);
    result = { ok: true, booking: shapeBooking_(row), _event: event };
  } finally {
    // flush BEFORE releasing: appendRow_ is buffered, and a second execution
    // that grabbed the lock before the flush would not see the new row.
    SpreadsheetApp.flush();
    lock.releaseLock();
  }

  // Mail is slow (~1s each, plus the .ics attachment). Sending it outside the
  // lock keeps everyone else's booking from queueing behind it.
  var event2 = result._event;
  delete result._event;
  try { sendBookingEmails_(event2, result.booking); }
  catch (mailErr) { Logger.log('Mail failed: ' + mailErr); }

  // The cancel token is for the confirmation email only — the booker gets it
  // back here so the "cancel" button works in the tab they just booked from.
  return result;
}

function cancel_(b, role) {
  var byToken = String(b.cancelToken || '').trim();
  if (!byToken) {
    requireRole_(role, ['admin', 'rep'], 'cancel an appointment');
  }
  if (!b.bookingId && !byToken) throw new Error('Missing booking id.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server busy, please try again.');
  var mail = null;
  try {
    var sh = sheet_(SHEET_BOOKINGS, BOOKING_COLS);
    var rows = readAll_(SHEET_BOOKINGS, BOOKING_COLS);
    var hit = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var match = byToken
        ? String(r.cancel_token || '') === byToken
        : String(r.booking_id) === String(b.bookingId);
      if (match) { hit = r; break; }
    }
    if (!hit) throw new Error(byToken
      ? 'That cancellation link is not valid — it may already have been used.'
      : 'Booking not found.');
    if (String(hit.status || 'confirmed') === 'cancelled') {
      throw new Error('That appointment was already cancelled.');
    }
    sh.getRange(hit._row, BOOKING_COLS.indexOf('status') + 1).setValue('cancelled');
    sh.getRange(hit._row, BOOKING_COLS.indexOf('updated_at') + 1).setValue(new Date().toISOString());
    var ev = findEvent_(String(hit.event_id));
    if (ev) mail = { event: shapeEvent_(ev), booking: shapeBooking_(hit) };
    var cancelledId = String(hit.booking_id);
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
  if (mail) {
    try { sendCancelEmails_(mail.event, mail.booking); } catch (e2) { Logger.log(e2); }
  }
  return { ok: true, cancelled: cancelledId };
}

function updateBooking_(b) {
  if (!b.bookingId) throw new Error('Missing booking id.');
  var editable = {
    retailer: 'retailer', contactName: 'contact_name', contactEmail: 'contact_email',
    phone: 'phone', bookedBy: 'booked_by', notes: 'notes'
  };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server busy, please try again.');
  try {
    var sh = sheet_(SHEET_BOOKINGS, BOOKING_COLS);
    var rows = readAll_(SHEET_BOOKINGS, BOOKING_COLS);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].booking_id) === String(b.bookingId)) {
        Object.keys(editable).forEach(function (k) {
          if (b[k] !== undefined) {
            sh.getRange(rows[i]._row, BOOKING_COLS.indexOf(editable[k]) + 1).setValue(trim_(b[k]));
          }
        });
        sh.getRange(rows[i]._row, BOOKING_COLS.indexOf('updated_at') + 1).setValue(new Date().toISOString());
        return { ok: true, bookingId: String(b.bookingId) };
      }
    }
    throw new Error('Booking not found.');
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function toggleBlock_(b) {
  if (!b.eventId || !b.date || !b.stationId || !b.startTime) throw new Error('Missing block fields.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server busy, please try again.');
  try {
    var sh = sheet_(SHEET_BLOCKS, BLOCK_COLS);
    var startTime = normTime_(b.startTime);
    var rows = readAll_(SHEET_BLOCKS, BLOCK_COLS);
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      if (String(r.event_id) === String(b.eventId) && asDateStr_(r.date) === String(b.date)
        && String(r.station_id) === String(b.stationId) && asTimeStr_(r.start_time) === startTime) {
        sh.deleteRow(r._row);
        return { ok: true, blocked: false };
      }
    }
    appendRow_(SHEET_BLOCKS, BLOCK_COLS, {
      block_id: 'BL-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
      event_id: String(b.eventId),
      date: String(b.date),
      station_id: String(b.stationId),
      start_time: startTime,
      reason: trim_(b.reason),
      created_at: new Date().toISOString()
    });
    return { ok: true, blocked: true };
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/* ================================================================== */
/* Events                                                             */
/* ================================================================== */

function createEvent_(b) {
  if (!b.name) throw new Error('Event name is required.');
  if (!b.days || !b.days.length) throw new Error('At least one event day is required.');
  if (!b.stations || !b.stations.length) throw new Error('At least one station is required.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server busy, please try again.');
  try {
    var id = b.eventId ? slug_(b.eventId) : uniqueEventId_(slug_(b.name));
    if (findEvent_(id)) throw new Error('An event with the id "' + id + '" already exists.');

    var days = b.days.map(function (d, i) {
      return {
        date: String(d.date),
        label: d.label || ('Day ' + (i + 1)),
        start: normTime_(d.start || b.dayStart || '09:00'),
        end: normTime_(d.end || b.dayEnd || '18:00')
      };
    }).sort(function (a, c) { return a.date.localeCompare(c.date); });

    var stations = b.stations.map(function (s, i) {
      return {
        id: s.id ? slug_(s.id) : ('station-' + (i + 1)),
        name: String(s.name || ('Station ' + (i + 1))),
        sub: String(s.sub || '')
      };
    });

    var now = new Date();
    appendRow_(SHEET_EVENTS, EVENT_COLS, {
      event_id: id,
      name: trim_(b.name),
      subtitle: trim_(b.subtitle),
      venue: trim_(b.venue),
      city: trim_(b.city),
      start_date: days[0].date,
      end_date: days[days.length - 1].date,
      days_json: JSON.stringify(days),
      stations_json: JSON.stringify(stations),
      slot_minutes: Number(b.slotMinutes) || 60,
      day_start: normTime_(b.dayStart || days[0].start),
      day_end: normTime_(b.dayEnd || days[0].end),
      notify_email: trim_(b.notifyEmail),
      reply_to: trim_(b.replyTo),
      status: 'active',
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    });
    return { ok: true, eventId: id };
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function updateEvent_(b) {
  if (!b.eventId) throw new Error('Missing event id.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Server busy, please try again.');
  try {
    var sh = sheet_(SHEET_EVENTS, EVENT_COLS);
    var rows = readAll_(SHEET_EVENTS, EVENT_COLS);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].event_id) !== String(b.eventId)) continue;
      var set = function (col, val) { sh.getRange(rows[i]._row, EVENT_COLS.indexOf(col) + 1).setValue(val); };
      if (b.name !== undefined) set('name', trim_(b.name));
      if (b.subtitle !== undefined) set('subtitle', trim_(b.subtitle));
      if (b.venue !== undefined) set('venue', trim_(b.venue));
      if (b.city !== undefined) set('city', trim_(b.city));
      if (b.notifyEmail !== undefined) set('notify_email', trim_(b.notifyEmail));
      if (b.replyTo !== undefined) set('reply_to', trim_(b.replyTo));
      if (b.slotMinutes !== undefined) set('slot_minutes', Number(b.slotMinutes) || 60);
      if (b.stations !== undefined) set('stations_json', JSON.stringify(b.stations));
      if (b.days !== undefined) {
        var days = b.days.slice().sort(function (a, c) { return String(a.date).localeCompare(String(c.date)); });
        set('days_json', JSON.stringify(days));
        set('start_date', days[0].date);
        set('end_date', days[days.length - 1].date);
      }
      set('updated_at', new Date().toISOString());
      return { ok: true, eventId: String(b.eventId) };
    }
    throw new Error('Event not found.');
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function setEventStatus_(eventId, status) {
  if (!eventId) throw new Error('Missing event id.');
  var sh = sheet_(SHEET_EVENTS, EVENT_COLS);
  var rows = readAll_(SHEET_EVENTS, EVENT_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].event_id) === String(eventId)) {
      sh.getRange(rows[i]._row, EVENT_COLS.indexOf('status') + 1).setValue(status);
      return { ok: true, eventId: String(eventId), status: status };
    }
  }
  throw new Error('Event not found.');
}

/* ================================================================== */
/* Email                                                              */
/* ================================================================== */

function cancelLink_(booking) {
  var site = prop_('SITE_URL');
  if (!site || !booking.cancelToken) return '';
  return site + '/event.html?e=' + encodeURIComponent(booking.eventId)
    + '&cancel=' + encodeURIComponent(booking.cancelToken);
}

function sendBookingEmails_(event, booking) {
  var when = prettyDate_(booking.date) + ' at ' + pretty12_(booking.startTime) + '–' + pretty12_(booking.endTime);
  var where = [event.venue, event.city].filter(Boolean).join(' · ');
  var subject = 'Confirmed: ' + booking.retailer + ' — ' + prettyDate_(booking.date) + ' ' + pretty12_(booking.startTime);
  var link = cancelLink_(booking);

  var html = ''
    + '<div style="font-family:Helvetica,Arial,sans-serif;color:#0F0F0F;max-width:520px">'
    + '<div style="background:#0F0F0F;color:#F7F6F2;padding:20px 24px">'
    + '<div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#C4A067">Appointment confirmed</div>'
    + '<div style="font-size:24px;font-weight:800;margin-top:6px">' + esc_(event.name) + '</div>'
    + '</div>'
    + '<div style="padding:24px;background:#F7F6F2">'
    + '<table style="width:100%;border-collapse:collapse;font-size:15px">'
    + row_('When', when)
    + row_('Station', booking.stationName)
    + (where ? row_('Where', where) : '')
    + row_('Retailer', booking.retailer)
    + row_('Contact', booking.contactName + (booking.phone ? ' · ' + booking.phone : ''))
    + (booking.bookedBy ? row_('Booked by', booking.bookedBy) : '')
    + (booking.notes ? row_('Notes', booking.notes) : '')
    + row_('Confirmation', booking.bookingId)
    + '</table>'
    + (link
      ? '<p style="margin-top:24px"><a href="' + esc_(link) + '" style="display:inline-block;'
        + 'background:#0F0F0F;color:#F7F6F2;text-decoration:none;padding:11px 20px;border-radius:4px;'
        + 'font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase">'
        + 'Cancel this appointment</a></p>'
        + '<p style="font-size:12px;color:#8A8A8A;margin-top:8px">This link only affects your own appointment. '
        + 'Keep it private.</p>'
      : '<p style="font-size:13px;color:#5A5A5A;margin-top:22px">Need to change or cancel? Reply to this email.</p>')
    + '<p style="font-size:12px;color:#8A8A8A;margin-top:22px;letter-spacing:.08em;text-transform:uppercase">Draw Your Own Line&reg;</p>'
    + '</div></div>';

  var plain = 'APPOINTMENT CONFIRMED\n\n'
    + event.name + '\n' + when + '\n' + booking.stationName + '\n'
    + (where ? where + '\n' : '')
    + '\nRetailer: ' + booking.retailer
    + '\nContact: ' + booking.contactName + (booking.phone ? ' (' + booking.phone + ')' : '')
    + (booking.bookedBy ? '\nBooked by: ' + booking.bookedBy : '')
    + (booking.notes ? '\nNotes: ' + booking.notes : '')
    + '\nConfirmation: ' + booking.bookingId
    + (link ? '\n\nCancel this appointment:\n' + link : '\n\nNeed to change or cancel? Reply to this email.');

  var ics = buildIcs_(event, booking);
  var base = {
    body: plain,
    htmlBody: html,
    name: event.name + ' Appointments',
    attachments: [Utilities.newBlob(ics, 'text/calendar', 'appointment.ics')]
  };
  if (event.replyTo) base.replyTo = event.replyTo;

  MailApp.sendEmail(Object.assign({ to: booking.contactEmail, subject: subject }, base));

  if (event.notifyEmail) {
    // Your copy doesn't need the retailer's private cancel link.
    var mine = Object.assign({}, base);
    mine.htmlBody = html.replace(/<p style="margin-top:24px">[\s\S]*?<\/p>\s*<p style="font-size:12px;color:#8A8A8A;margin-top:8px">[\s\S]*?<\/p>/, '');
    mine.body = plain.split('\n\nCancel this appointment:')[0];
    MailApp.sendEmail(Object.assign({
      to: event.notifyEmail,
      subject: 'New booking: ' + booking.retailer + ' — ' + booking.stationName
        + ' — ' + prettyDate_(booking.date) + ' ' + pretty12_(booking.startTime)
    }, mine));
  }
}

function sendCancelEmails_(event, booking) {
  var subject = 'Cancelled: ' + booking.retailer + ' — ' + prettyDate_(booking.date) + ' ' + pretty12_(booking.startTime);
  var html = '<div style="font-family:Helvetica,Arial,sans-serif;color:#0F0F0F">'
    + '<p>This appointment has been cancelled and the slot is open again.</p>'
    + '<table style="border-collapse:collapse;font-size:15px">'
    + row_('Event', event.name)
    + row_('When', prettyDate_(booking.date) + ' at ' + pretty12_(booking.startTime))
    + row_('Station', booking.stationName)
    + row_('Retailer', booking.retailer)
    + row_('Confirmation', booking.bookingId)
    + '</table></div>';
  var plain = 'APPOINTMENT CANCELLED\n\nThis slot is open again.\n\n'
    + event.name + '\n' + prettyDate_(booking.date) + ' at ' + pretty12_(booking.startTime) + '\n'
    + booking.stationName + '\nRetailer: ' + booking.retailer
    + '\nConfirmation: ' + booking.bookingId;
  var to = [booking.contactEmail, event.notifyEmail].filter(Boolean).join(',');
  if (to) MailApp.sendEmail({
    to: to, subject: subject, body: plain, htmlBody: html,
    name: event.name + ' Appointments'
  });
}

function row_(k, v) {
  return '<tr><td style="padding:7px 14px 7px 0;color:#5A5A5A;white-space:nowrap;vertical-align:top">'
    + esc_(k) + '</td><td style="padding:7px 0;font-weight:600">' + esc_(v) + '</td></tr>';
}

function buildIcs_(event, booking) {
  var dt = function (t) { return booking.date.replace(/-/g, '') + 'T' + t.replace(':', '') + '00'; };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jetty//Appointments//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + booking.bookingId + '@showtime',
    'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
    'DTSTART;TZID=America/New_York:' + dt(booking.startTime),
    'DTEND;TZID=America/New_York:' + dt(booking.endTime),
    'SUMMARY:' + icsEsc_(event.name + ' — ' + booking.retailer),
    'LOCATION:' + icsEsc_([booking.stationName, event.venue, event.city].filter(Boolean).join(', ')),
    'DESCRIPTION:' + icsEsc_('Station: ' + booking.stationName + '\nContact: ' + booking.contactName
      + (booking.bookedBy ? '\nBooked by: ' + booking.bookedBy : '')
      + (booking.notes ? '\nNotes: ' + booking.notes : '')
      + '\nConfirmation: ' + booking.bookingId),
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}

/* ================================================================== */
/* Utils                                                              */
/* ================================================================== */

function appendRow_(name, cols, obj) {
  var sh = sheet_(name, cols);
  sh.appendRow(cols.map(function (c) { return obj[c] !== undefined ? obj[c] : ''; }));
}

function buildSlots_(day, event) {
  var out = [];
  var cur = toMin_(day.start || event.dayStart);
  var end = toMin_(day.end || event.dayEnd);
  var step = Number(event.slotMinutes) || 60;
  while (cur + step <= end) { out.push(fromMin_(cur)); cur += step; }
  return out;
}

function toMin_(t) { var p = normTime_(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function fromMin_(m) { return pad_(Math.floor(m / 60)) + ':' + pad_(m % 60); }
function addMinutes_(t, m) { return fromMin_(toMin_(t) + Number(m)); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function trim_(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function normTime_(t) {
  if (t instanceof Date) return pad_(t.getHours()) + ':' + pad_(t.getMinutes());
  var s = String(t || '').trim();
  var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (m) return pad_(hour24_(m[1], m[3])) + ':' + m[2];
  m = s.match(/^(\d{1,2})\s*(am|pm)?$/i);
  if (m) return pad_(hour24_(m[1], m[2])) + ':00';
  return s;
}

function hour24_(h, ampm) {
  h = Number(h);
  if (ampm && /pm/i.test(ampm) && h < 12) h += 12;
  if (ampm && /am/i.test(ampm) && h === 12) h = 0;
  return h;
}

function asTimeStr_(v) { return normTime_(v); }

function asDateStr_(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + pad_(v.getMonth() + 1) + '-' + pad_(v.getDate());
  }
  return String(v || '').trim();
}

function safeJson_(v, fallback) {
  try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); }
  catch (e) { return fallback; }
}

function slug_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function uniqueEventId_(base) {
  var id = base || 'event';
  var n = 2;
  while (findEvent_(id)) { id = base + '-' + n; n++; }
  return id;
}

function pretty12_(t) {
  var p = normTime_(t).split(':');
  var h = Number(p[0]); var ap = h >= 12 ? 'pm' : 'am';
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + (p[1] === '00' ? '' : ':' + p[1]) + ap;
}

function prettyDate_(d) {
  var p = String(d).split('-');
  var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[dt.getDay()] + ', ' + mons[dt.getMonth()] + ' ' + dt.getDate();
}

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function icsEsc_(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
