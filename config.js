/* ============================================================
   JETTY — site configuration
   ------------------------------------------------------------
   The ONLY thing you need to edit here is API_URL.

   Paste the Apps Script Web App URL you got in step 4 of
   apps-script/Code.gs (it ends in /exec).

   You can edit this file straight on GitHub — Netlify will
   redeploy the site within about 30 seconds.
   ============================================================ */

window.SHOWTIME_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzsAD0H9JOpZeUn3UFmhIivOSoYZH2tPSLpxXFlzafy3kTKq3W-6ZEZY4Y13dVKBfJS/exec',

  // How often the booking grid re-checks for other people's bookings
  // while someone has the page open (milliseconds).
  REFRESH_MS: 15000
};
