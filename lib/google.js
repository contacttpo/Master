// Talks to the Google Sheets API directly (no npm packages needed).
// READ-ONLY on purpose for now: the service account only asks for read access.
const crypto = require('crypto');

let tokenCache = { token: null, exp: 0 };

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function isConfigured() {
  return !!(process.env.SHEET_ID && process.env.GOOGLE_CREDENTIALS);
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signature = crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(creds.private_key);
  const jwt = header + '.' + claim + '.' + b64url(signature);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  const j = await res.json();
  if (!res.ok) throw new Error('Google sign-in failed: ' + (j.error_description || j.error || res.status));
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// Reads several tabs in ONE request. Returns { tabName: [[row], [row], ...] }.
async function getSheets(names) {
  const token = await getToken();
  const qs = names.map(n => 'ranges=' + encodeURIComponent("'" + String(n).replace(/'/g, "''") + "'")).join('&');
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + process.env.SHEET_ID +
    '/values:batchGet?' + qs +
    '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const j = await res.json();
  if (!res.ok) throw new Error('Sheets API: ' + ((j.error && j.error.message) || res.status));
  const out = {};
  (j.valueRanges || []).forEach((vr, i) => { out[names[i]] = vr.values || []; });
  return out;
}

// Names of all tabs, in the same left-to-right order as the sheet.
let titlesCache = { t: 0, v: null };
async function getSheetTitles() {
  if (titlesCache.v && Date.now() - titlesCache.t < 60000) return titlesCache.v;
  const token = await getToken();
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + process.env.SHEET_ID + '?fields=sheets.properties.title',
    { headers: { Authorization: 'Bearer ' + token } });
  const j = await res.json();
  if (!res.ok) throw new Error('Sheets API: ' + ((j.error && j.error.message) || res.status));
  const v = (j.sheets || []).map(x => x.properties.title);
  titlesCache = { t: Date.now(), v: v };
  return v;
}

// One tab; a tab that does not exist (e.g. a company nobody registered for yet) comes back as [].
async function getOneSheet(name) {
  try {
    const r = await getSheets([name]);
    return r[name] || [];
  } catch (err) {
    if (/Unable to parse range|not found|Requested entity/i.test(String(err.message))) return [];
    throw err;
  }
}

// Same rule as sheetToObjects_ in Code.gs: first row = headers, skip fully empty rows,
// a repeated header keeps its FIRST column, empty/missing cells become ''.
// dateCols: { HeaderName: true } -> a numeric date serial becomes 'yyyy-MM-dd' like Apps Script returned.
function toObjects(values, dateCols, headerOverride) {
  if (!values || values.length < 2) return [];
  const headers = headerOverride || values[0];
  return values.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null && c !== undefined))
    .map(row => {
      const o = {};
      headers.forEach((h, i) => {
        if (Object.prototype.hasOwnProperty.call(o, h)) return;
        let v = row[i];
        if (v === undefined || v === null) v = '';
        if (typeof v === 'string' && v.charAt(0) === '#') v = v.replace(SHEET_ERROR, '$1'); // '#ERROR! ()' -> '#ERROR!' like Apps Script
        if (typeof v === 'number') {
          if (dateCols === 'auto') {
            // Date-looking column names holding a date serial -> 'yyyy-MM-dd', as Apps Script returned
            if (AUTO_DATE_HEADER.test(String(h)) && v > 20000 && v < 80000) v = serialToIso(v);
          } else if (dateCols && dateCols[h]) v = serialToIso(v);
        }
        o[h] = v;
      });
      return o;
    });
}

// A cell showing a formula error: the Sheets API appends a description in brackets, Apps Script does not.
const SHEET_ERROR = /^(#[A-Z0-9\/!?]+)[\s\u00a0]*\(.*\)[\s\u00a0]*$/;
const AUTO_DATE_HEADER = /date|dob|birth|_at$|_time$|timestamp/i;

function serialToIso(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

module.exports = { isConfigured, getSheets, getOneSheet, getSheetTitles, toObjects };
