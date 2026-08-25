/* Unit checks for the pure helpers inside apps-script/Code.gs.
   These run in plain node — no Apps Script globals needed.  node docs/unit.js */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const FNS = ['normTime_', 'hour24_', 'pad_', 'toMin_', 'fromMin_', 'addMinutes_',
  'icsEsc_', 'pretty12_', 'prettyDate_', 'asDateStr_', 'slug_', 'buildSlots_'];
let code = '';
for (const f of FNS) {
  const m = src.match(new RegExp('function ' + f + '\\([\\s\\S]*?\\n}', 'm'));
  if (!m) throw new Error('helper not found in Code.gs: ' + f);
  code += m[0] + '\n';
}
eval(code);

let fails = 0;
const t = (got, want, label) => {
  const pass = got === want;
  if (!pass) fails++;
  console.log((pass ? '  PASS  ' : '  FAIL  ') + label + '  ->  ' + JSON.stringify(got)
    + (pass ? '' : '   expected ' + JSON.stringify(want)));
};

console.log('\nnormTime_ (values may be hand-typed into the sheet)');
t(normTime_('9'), '09:00', '"9"');
t(normTime_('9am'), '09:00', '"9am"');
t(normTime_('1:30 pm'), '13:30', '"1:30 pm"');
t(normTime_('5:00 PM'), '17:00', '"5:00 PM"');
t(normTime_('12:15am'), '00:15', '"12:15am"');
t(normTime_('12:15pm'), '12:15', '"12:15pm"');
t(normTime_('09:00'), '09:00', '"09:00"');
t(normTime_('17:30:00'), '17:30', '"17:30:00" (sheet time cell)');
t(normTime_(new Date(2026, 8, 16, 13, 30)), '13:30', 'Date object');

console.log('\nslot maths');
t(buildSlots_({ start: '09:00', end: '18:00' }, { slotMinutes: 60 }).join(','),
  '09:00,10:00,11:00,12:00,13:00,14:00,15:00,16:00,17:00', 'hourly 9-6 = 9 slots');
t(buildSlots_({ start: '09:00', end: '18:00' }, { slotMinutes: 30 }).length, 18, '30-min 9-6 = 18 slots');
t(buildSlots_({ start: '09:00', end: '12:00' }, { slotMinutes: 45 }).length, 4, '45-min 9-12 = 4 slots');
t(addMinutes_('17:00', 60), '18:00', 'last slot ends exactly at close');

console.log('\nformatting');
t(icsEsc_('Station: A\nContact: B'), 'Station: A\\nContact: B', 'ics newline escaped once');
t(pretty12_('13:30'), '1:30pm', '13:30');
t(pretty12_('09:00'), '9am', '09:00');
t(prettyDate_('2026-09-16'), 'Wednesday, Sep 16', 'Surf Expo day 1 is a Wednesday');
t(asDateStr_(new Date(2026, 8, 16)), '2026-09-16', 'Date -> yyyy-mm-dd');
t(slug_('Surf Expo — Fall 2026'), 'surf-expo-fall-2026', 'event id slug');

/* ---- who gets the email -------------------------------------------------
   One message: retailer in To, everyone else in Cc. Rebuilt here exactly as
   sendBookingEmails_ / sendCancelEmails_ decide it. */
for (const f of ['emailList_', 'internalRecipients_']) {
  const m = src.match(new RegExp('function ' + f + '\\([\\s\\S]*?\\n}', 'm'));
  if (!m) throw new Error('helper not found in Code.gs: ' + f);
  eval(m[0]);
}
const confirmation = (ev, bk) => {
  const msg = { to: bk.contactEmail };
  const internal = internalRecipients_(ev, bk);
  if (internal.length) msg.cc = internal.join(',');
  return msg;
};
const cancellation = (ev, bk) => {
  const internal = internalRecipients_(ev, bk);
  const msg = {};
  if (bk.contactEmail) { msg.to = bk.contactEmail; if (internal.length) msg.cc = internal.join(','); }
  else if (internal.length) { msg.to = internal.join(','); }
  else return null;
  return msg;
};
const same = (got, want, label) => t(JSON.stringify(got), JSON.stringify(want), label);

const EV = { notifyEmail: 'cory@jettylife.com, paul.harvey@jettylife.com' };

console.log('\nnotify field accepts a list');
t(emailList_('a@b.com, c@d.com').join('|'), 'a@b.com|c@d.com', 'comma separated');
t(emailList_('a@b.com;c@d.com').join('|'), 'a@b.com|c@d.com', 'semicolon separated');
t(emailList_('nope, c@d.com').join('|'), 'c@d.com', 'drops a malformed address');

console.log('\nconfirmation addressing');
same(confirmation(EV, { contactEmail: 'buyer@ronjon.com',
      bookedByEmail: 'agenc@icloud.com, Ludovic@agenccanada.com' }),
  { to: 'buyer@ronjon.com',
    cc: 'cory@jettylife.com,paul.harvey@jettylife.com,agenc@icloud.com,Ludovic@agenccanada.com' },
  'retailer addressed, staff + both agency contacts copied');
same(confirmation(EV, { contactEmail: 'buyer@shop.com', bookedByEmail: '' }),
  { to: 'buyer@shop.com', cc: 'cory@jettylife.com,paul.harvey@jettylife.com' },
  'retailer self-booked, no agency chosen');
same(confirmation(EV, { contactEmail: 'CORY@jettylife.com', bookedByEmail: '' }),
  { to: 'CORY@jettylife.com', cc: 'paul.harvey@jettylife.com' },
  'nobody is copied on their own booking');

console.log('\ncancellation addressing');
same(cancellation(EV, { contactEmail: '', bookedByEmail: '' }),
  { to: 'cory@jettylife.com,paul.harvey@jettylife.com' },
  'an imported booking with no retailer address still reaches staff');
same(cancellation({ notifyEmail: '' }, { contactEmail: '', bookedByEmail: '' }),
  null, 'nobody to tell means no send');

console.log('\n' + (fails ? '✗ ' + fails + ' FAILURE(S)' : '✓ ALL UNIT CHECKS PASSED') + '\n');
process.exit(fails ? 1 : 0);
