// Fast path for the functions that have been rewritten for the Sheets API.
// Anything else is NOT handled here: the page talks to Apps Script directly for those.
// If this endpoint is not set up or errors, it answers {fallback:true} and the page
// silently uses Apps Script instead, so it can never leave the app worse off.
const google = require('../lib/google');
const ported = require('../lib/ported');

// Answers are NOT kept between requests (so an edit you just made always shows), except rarely-changing lists.
const TTL_MS = { getBranchAndCollegeLists: 60000 };
// Newer rewrites are switched on only after /api/status?compare=1 proves them identical:
// add their names (comma separated) to the FAST_EXTRA setting in Vercel.
const NEEDS_APPROVAL = ['getBranchAndCollegeLists', 'getRegisteredStudents', 'getRoundStudents'];
function enabled(fn) {
  if (NEEDS_APPROVAL.indexOf(fn) === -1) return true;
  return String(process.env.FAST_EXTRA || '').split(',').map(x => x.trim()).indexOf(fn) !== -1;
}
const cache = new Map();            // key -> { t, v }
const inflight = new Map();         // key -> Promise (identical simultaneous calls share one read)

async function fast(fn, args) {
  const key = fn + JSON.stringify(args);
  const ttl = TTL_MS[fn] || 0;
  const hit = ttl ? cache.get(key) : null;
  if (hit && Date.now() - hit.t < ttl) return { v: hit.v, src: 'memory' };
  if (inflight.has(key)) return { v: await inflight.get(key), src: 'shared' };
  const p = ported[fn].apply(null, args);
  inflight.set(key, p);
  try {
    const v = await p;
    if (ttl) cache.set(key, { t: Date.now(), v: v });
    return { v: v, src: 'sheets' };
  } finally { inflight.delete(key); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const fn = String(body.fn || '');
  const args = Array.isArray(body.args) ? body.args : [];

  if (!Object.prototype.hasOwnProperty.call(ported, fn)) return res.status(200).json({ ok: false, fallback: true, error: 'not ported' });
  if (!enabled(fn)) return res.status(200).json({ ok: false, fallback: true, error: 'not enabled yet' });
  if (!google.isConfigured()) return res.status(200).json({ ok: false, fallback: true, error: 'gateway not configured' });

  const t0 = Date.now();
  try {
    const r = await fast(fn, args);
    const ms = Date.now() - t0;
    console.log(JSON.stringify({ fn: fn, ms: ms, src: r.src }));
    res.setHeader('X-Source', r.src);
    return res.status(200).json({ ok: true, data: r.v });
  } catch (err) {
    console.error('fast path failed', fn, err.message);
    return res.status(200).json({ ok: false, fallback: true, error: String(err.message) });
  }
};
