// Open  /api/status  to see if everything is connected.
// Open  /api/status?compare=1  to run each rewritten function on BOTH Google Sheets (new) and
// Apps Script (old), check the answers are identical, and see how long each took.
const google = require('../lib/google');
const ported = require('../lib/ported');
const { toObjects } = require('../lib/google');

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

async function viaGas(fn, args) {
  const t0 = Date.now();
  const r = await fetch(process.env.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: fn, args: args || [] }) });
  const text = await r.text();
  let out; try { out = JSON.parse(text); } catch (e) { throw new Error('Apps Script returned a web page, not data'); }
  if (!out.ok) throw new Error(out.error);
  return { v: out.data, ms: Date.now() - t0 };
}

// Test cases: every function with no inputs, plus per-company ones for the first few companies.
async function buildCases(n) {
  const cases = [['getDashboardData', []], ['getCompanyList', []], ['getBranchAndCollegeLists', []],
    ['getBranchViewFilters', []], ['getTopPackageStudents', []], ['getPlacementRate', []], ['getPackageAnalytics', []],
    ['getGlobalSelectionSummary', []], ['getAllStudentsMaster', []]];
  const dash = await ported.getDashboardData();
  const names = dash.data.map(c => c.Company_Name).filter(Boolean).slice(0, n);
  const rounds = toObjects((await google.getSheets(['Process_Tracking']))['Process_Tracking']);
  names.forEach(co => {
    cases.push(['getRegisteredStudents', [co]]);
    cases.push(['getRoundCounts', [co]]);
    cases.push(['getCompanyDetails', [co]]);
    const first = rounds.filter(r => String(r.Company_Name).trim() === String(co).trim())[0];
    if (first) cases.push(['getRoundStudents', [co, first.Round_Name]]);
  });
  return cases;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const report = {
    version: 'v9-shared-reads-and-retry',
    GAS_URL_set: !!process.env.GAS_URL,
    SHEET_ID_set: !!process.env.SHEET_ID,
    GOOGLE_CREDENTIALS_set: !!process.env.GOOGLE_CREDENTIALS,
    FAST_EXTRA_now: process.env.FAST_EXTRA || '(empty)',
    ready: google.isConfigured()
  };
  if (!google.isConfigured()) report.next = 'Add SHEET_ID and GOOGLE_CREDENTIALS in Vercel > Settings > Environment Variables, then Redeploy.';
  else if (!process.env.GAS_URL) report.next = 'Add GAS_URL (your Apps Script /exec address) in Vercel > Settings > Environment Variables, then Redeploy.';

  if (q.compare === '1' && google.isConfigured() && process.env.GAS_URL) {
    const n = Math.max(1, Math.min(4, parseInt(q.n || '2', 10) || 2));
    let cases;
    try { cases = await buildCases(n); if (q.only) cases = cases.filter(c => c[0] === q.only); } catch (err) { report.error = String(err.message); return res.status(200).json(report); }
    const results = await Promise.all(cases.map(async ([fn, args]) => {
      const row = { fn: fn, args: args };
      try {
        const t0 = Date.now();
        const mine = await ported[fn].apply(null, args);
        row.new_ms = Date.now() - t0;
        const old = await viaGas(fn, args);
        row.old_ms = old.ms;
        row.identical = stable(mine) === stable(old.v);
        if (!row.identical) row.differences = firstDiffs(mine, old.v);
      } catch (err) { row.error = String(err.message); }
      return row;
    }));
    report.compare = results;
    const byFn = {};
    results.forEach(r => { byFn[r.fn] = (byFn[r.fn] === false) ? false : (r.identical === true); });
    const ok = Object.keys(byFn).filter(f => byFn[f]);
    const bad = Object.keys(byFn).filter(f => !byFn[f]);
    report.safe_to_enable = ok.join(',');
    report.NOT_identical = bad.join(',') || 'none';
    report.how_to_enable = 'In Vercel > Settings > Environment Variables set FAST_EXTRA = ' + (ok.filter(f => ['getBranchAndCollegeLists', 'getRegisteredStudents', 'getRoundStudents', 'getRoundCounts', 'getCompanyDetails', 'getBranchViewFilters', 'getTopPackageStudents', 'getPlacementRate', 'getPackageAnalytics', 'getGlobalSelectionSummary', 'getAllStudentsMaster'].indexOf(f) !== -1).join(',') || '(nothing yet)') + ' then Redeploy.';
  }
  res.status(200).json(report);
};
