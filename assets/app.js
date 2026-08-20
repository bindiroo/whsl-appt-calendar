/* ============================================================
   JETTY — booking client helpers
   ============================================================ */

(function (global) {
  'use strict';

  var CFG = global.SHOWTIME_CONFIG || {};
  var API = (CFG.API_URL || '').trim();

  /* ---------------- API ---------------- */

  function apiConfigured() {
    return API && API.indexOf('PASTE_YOUR') === -1 && /^https?:\/\//.test(API);
  }

  /* ---------------- Roles ----------------
     Three levels, decided entirely by the server:
       public  — no password. Sees Open / Booked and nothing else.
       rep     — rep password. Sees retailer names, can book and cancel.
       admin   — admin password. Also creates events and blocks slots.
     The password is kept in localStorage so it's entered once per browser.
     A rep magic link (?k=...) drops it in and cleans itself out of the URL. */

  var TOKEN_KEY = 'showtime_token';
  var role = 'public';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }
  function getRole() { return role; }
  function isAdmin() { return role === 'admin'; }
  function canSeeNames() { return role === 'admin' || role === 'rep'; }
  function signOut() { setToken(''); role = 'public'; location.reload(); }

  /* A magic link puts the password in the URL. Take it, then scrub the URL so
     it isn't sitting in the address bar or in the next screenshot. */
  (function absorbMagicLink() {
    try {
      var u = new URL(location.href);
      var k = u.searchParams.get('k');
      if (k) {
        setToken(k.trim());
        u.searchParams.delete('k');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      }
    } catch (e) {}
  })();

  var NEED_RE = /^PASSWORD_REQUIRED:\s*/;
  function needsPassword(err) { return NEED_RE.test(err && err.message || ''); }
  function passwordMessage(err) {
    return String(err && err.message || '').replace(NEED_RE, '');
  }

  /* Runs fn(); if the server says a password is required, ask once and retry. */
  function withPassword(fn) {
    return fn().catch(function (err) {
      if (!needsPassword(err)) throw err;
      var t = window.prompt(passwordMessage(err), '');
      if (!t) throw err;
      setToken(t.trim());
      return fn();
    });
  }

  function get(params) {
    if (!apiConfigured()) return Promise.reject(new Error(CONFIG_MSG));
    params = Object.assign({}, params);
    if (getToken()) params.token = getToken();
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return fetch(API + '?' + qs + '&_=' + Date.now(), { method: 'GET', redirect: 'follow' })
      .then(readJson);
  }

  function post(body) {
    if (!apiConfigured()) return Promise.reject(new Error(CONFIG_MSG));
    // text/plain keeps this a "simple request" so the browser skips the
    // CORS preflight that Apps Script cannot answer.
    var payload = Object.assign({}, body);
    if (getToken()) payload.token = getToken();
    return fetch(API, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(readJson);
  }

  var CONFIG_MSG = 'This site is not connected to its Google Sheet yet. '
    + 'Open config.js in the repo and paste in your Apps Script Web App URL.';

  function readJson(res) {
    return res.text().then(function (txt) {
      var data;
      try { data = JSON.parse(txt); }
      catch (e) {
        throw new Error('The booking service returned an unexpected response. '
          + 'Make sure the Apps Script Web App is deployed with access set to "Anyone".');
      }
      if (!data.ok) throw new Error(data.error || 'Something went wrong.');
      if (data.role) { role = data.role; applyRoleToChrome(); }
      return data;
    });
  }

  /* ---------------- Time / date ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  function fromMin(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }

  function pretty12(t) {
    var p = String(t).split(':');
    var h = +p[0], ap = h >= 12 ? 'pm' : 'am', h12 = h % 12 || 12;
    return h12 + (p[1] === '00' ? '' : ':' + p[1]) + ap;
  }

  var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parseDate(d) {
    var p = String(d).split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }
  function dowName(d) { return DOW[parseDate(d).getDay()]; }
  function shortDate(d) { var dt = parseDate(d); return MON[dt.getMonth()] + ' ' + dt.getDate(); }
  function numDate(d) { var dt = parseDate(d); return (dt.getMonth() + 1) + '/' + dt.getDate(); }
  function longDate(d) { return dowName(d) + ', ' + shortDate(d); }

  function dateRange(a, b) {
    if (!a) return '';
    if (!b || a === b) return longDate(a) + ', ' + parseDate(a).getFullYear();
    var da = parseDate(a), db = parseDate(b);
    var right = da.getMonth() === db.getMonth() ? db.getDate() : (MON[db.getMonth()] + ' ' + db.getDate());
    return MON[da.getMonth()] + ' ' + da.getDate() + '–' + right + ', ' + db.getFullYear();
  }

  function slotsFor(day, event) {
    var out = [];
    var cur = toMin(day.start || event.dayStart || '09:00');
    var end = toMin(day.end || event.dayEnd || '18:00');
    var step = +event.slotMinutes || 60;
    while (cur + step <= end) { out.push(fromMin(cur)); cur += step; }
    return out;
  }

  /* ---------------- DOM ---------------- */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name) || '';
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showAlert(node, kind, msg) {
    if (!node) return;
    node.className = 'alert alert-' + kind;
    node.textContent = msg;
    node.hidden = false;
  }
  function hideAlert(node) { if (node) node.hidden = true; }

  function csv(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = c === null || c === undefined ? '' : String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function icsFor(event, b) {
    var dt = function (t) { return b.date.replace(/-/g, '') + 'T' + t.replace(':', '') + '00'; };
    var esc2 = function (s) { return String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'); };
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jetty//Appointments//EN',
      'BEGIN:VEVENT',
      'UID:' + b.bookingId + '@showtime',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
      'DTSTART;TZID=America/New_York:' + dt(b.startTime),
      'DTEND;TZID=America/New_York:' + dt(b.endTime),
      'SUMMARY:' + esc2(event.name + ' — ' + b.retailer),
      'LOCATION:' + esc2([b.stationName, event.venue, event.city].filter(Boolean).join(', ')),
      'DESCRIPTION:' + esc2('Station: ' + b.stationName + '\nContact: ' + b.contactName
        + '\nConfirmation: ' + b.bookingId),
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
  }

  function slotKey(date, stationId, time) { return date + '|' + stationId + '|' + time; }

  function indexBookings(bookings) {
    var m = {};
    (bookings || []).forEach(function (b) { m[slotKey(b.date, b.stationId, b.startTime)] = b; });
    return m;
  }

  function indexBlocks(blocks) {
    var m = {};
    (blocks || []).forEach(function (b) { m[slotKey(b.date, b.stationId, b.startTime)] = b; });
    return m;
  }

  function header(active) {
    return '<header class="site-header"><div class="wrap">'
      + '<a class="brand" href="index.html" aria-label="Jetty">'
      + '<img src="assets/brand/jetty-logo-white.png" alt="Jetty">'
      + '</a>'
      + '<nav class="header-nav">'
      + '<a href="index.html"' + (active === 'events' ? ' class="active"' : '') + '>Events</a>'
      + '<a href="new.html" data-role-admin hidden' + (active === 'new' ? ' class="active"' : '') + '>New Event</a>'
      + '<span class="role-chip" id="role-chip" hidden></span>'
      + '<button type="button" class="link-btn" id="role-btn"></button>'
      + '</nav></div></header>';
  }

  /* Show/hide admin-only and rep-only chrome, and keep the sign-in control
     honest. Runs after every API response, since that's when role changes. */
  function applyRoleToChrome() {
    document.querySelectorAll('[data-role-admin]').forEach(function (n) {
      n.hidden = role !== 'admin';
    });
    document.querySelectorAll('[data-role-names]').forEach(function (n) {
      n.hidden = !canSeeNames();
    });
    var chip = document.getElementById('role-chip');
    if (chip) {
      chip.hidden = role === 'public';
      chip.textContent = role === 'admin' ? 'Admin' : 'Rep';
      chip.className = 'role-chip' + (role === 'admin' ? ' admin' : '');
    }
    var btn = document.getElementById('role-btn');
    if (btn) {
      btn.textContent = role === 'public' ? 'Staff sign-in' : 'Sign out';
      btn.onclick = role === 'public' ? promptSignIn : signOut;
    }
  }

  /* Staff sign-in: one box, either password. The server decides which. */
  function promptSignIn() {
    var t = window.prompt(
      'Staff sign-in\n\nEnter the rep password to see who is booked, '
      + 'or the admin password for full access.', '');
    if (!t) return;
    setToken(t.trim());
    get({ action: 'ping' }).then(function (d) {
      if (d.role === 'public') {
        setToken('');
        applyRoleToChrome();
        alert('That password was not recognised.');
      } else {
        location.reload();
      }
    }).catch(function (err) { alert(err.message); });
  }

  function footer() {
    return '<footer class="site-footer"><div class="wrap">'
      + '<img src="assets/brand/otis-coin-dark.png" alt="">'
      + '<div>'
      + '<div class="tag">Draw Your Own Line&reg;</div>'
      + '<div class="est">Established 2003 &middot; www.JettyLife.com</div>'
      + '</div>'
      + '</div></footer>';
  }

  global.ST = {
    apiConfigured: apiConfigured, get: get, post: post, CONFIG_MSG: CONFIG_MSG,
    pad: pad, toMin: toMin, fromMin: fromMin, pretty12: pretty12,
    parseDate: parseDate, dowName: dowName, shortDate: shortDate, numDate: numDate,
    longDate: longDate, dateRange: dateRange, slotsFor: slotsFor,
    el: el, qs: qs, esc: esc, showAlert: showAlert, hideAlert: hideAlert,
    csv: csv, download: download, icsFor: icsFor,
    getToken: getToken, setToken: setToken, signOut: signOut,
    getRole: getRole, isAdmin: isAdmin, canSeeNames: canSeeNames,
    needsPassword: needsPassword, passwordMessage: passwordMessage,
    withPassword: withPassword, promptSignIn: promptSignIn,
    applyRoleToChrome: applyRoleToChrome,
    slotKey: slotKey, indexBookings: indexBookings, indexBlocks: indexBlocks,
    header: header, footer: footer
  };
})(window);
