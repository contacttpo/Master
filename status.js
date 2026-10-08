// Open  /api/status  to see if everything is connected.
// Open  /api/status?compare=1  to run each rewritten function on BOTH Google Sheets (new) and
// Apps Script (old), check the answers are identical, and see how long each took.
const google = require('../lib/google');
const ported = require('../lib/ported');

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function firstDiffs(a, b) {
  const out = [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push('length differs: new=' + a.length + ' old=' + b.length);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < 4; i++) {
      if (stable(a[i]) !== stable(b[i])) {
        if (a[i] && b[i] && typeof a[i] === 'object') {
          const keys = new Set(Object.keys(a[i]).concat(Object.keys(b[i])));
          keys.forEach(k => { if (out.length < 4 && stable(a[i][k]) !== stable(b[i][k])) out.push('item ' + i + ' field ' + k + ': new=' + stable(a[i][k]).slice(0, 60) + ' old=' + stable(b[i][k]).slice(0, 60)); });
        } else out.push('item ' + i + ': new=' + stable(a[i]).slice(0, 60) + ' old=' + stable(b[i]).slice(0, 60));
      }
    }
  } else if (a && b && typeof a === 'object') {
    Object.keys(Object.assign({}, a, b)).forEach(k => { if (out.length < 4 && stable(a[k]) !== stable(b[k])) out.push('field ' + k); });
    if (a.data !== undefined && b.data !== undefined) return firstDiffs(a.data, b.data);
  }
  return out;
}

async function viaGas(fn) {
  const t0 = Date.now();
  const r = await fetch(process.env.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: fn, args: [] }) });
  const text = await r.text();
  let out; try { out = JSON.parse(text); } catch (e) { throw new Error('Apps Script returned a web page, not data'); }
  if (!out.ok) throw new Error(out.error);
  return { v: out.data, ms: Date.now() - t0 };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const report = {
    GAS_URL_set: !!process.env.GAS_URL,
    SHEET_ID_set: !!process.env.SHEET_ID,
    GOOGLE_CREDENTIALS_set: !!process.env.GOOGLE_CREDENTIALS,
    ready: google.isConfigured()
  };
  if (!google.isConfigured()) report.next = 'Add SHEET_ID and GOOGLE_CREDENTIALS in Vercel > Settings > Environment Variables, then Redeploy.';
  else if (!process.env.GAS_URL) report.next = 'Add GAS_URL (your Apps Script /exec address) in Vercel > Settings > Environment Variables, then Redeploy.';

  if (req.query && req.query.compare === '1' && google.isConfigured()) {
    report.compare = {};
    for (const fn of Object.keys(ported)) {
      try {
        const t0 = Date.now();
        const mine = await ported[fn]();
        const msNew = Date.now() - t0;
        const row = { new_ms: msNew };
        if (process.env.GAS_URL) {
          const old = await viaGas(fn);
          row.old_ms = old.ms;
          row.identical = stable(mine) === stable(old.v);
          if (!row.identical) row.differences = firstDiffs(mine, old.v);
        }
        report.compare[fn] = row;
      } catch (err) { report.compare[fn] = { error: String(err.message) }; }
    }
  }
  res.status(200).json(report);
};
