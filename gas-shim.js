/* gas-shim.js v3 — drop-in replacement for google.script.run on Vercel.
 *
 * 1. Set API_URL below to your Apps Script web app URL (ends in /exec).
 * 2. Every HTML page loads this before its own scripts; existing
 *    google.script.run.withSuccessHandler(...).someFunction(...) code is unchanged.
 *
 * v3 adds:
 *  - INSTANT LOADS: the big read-only lists (dashboard, companies, master list...) are
 *    remembered on the device. Next time, the screen fills instantly from memory and is
 *    refreshed in the background a moment later. Any save/edit/delete you make clears it,
 *    so you never see your own changes missing.
 *  - A timing panel: open  <your-site>/?debug=1  once to switch it on (?debug=0 to switch off).
 *    It lists every call with how long it took, so we can see exactly what is slow.
 *  - Up to 6 calls at a time (v2 allowed 4, which could slow screens that load many things).
 */
(function () {
  var API_URL = 'https://script.google.com/macros/s/AKfycbwf_pkbZKFh7ZSoI2KFT4jmnYk1ytiMBCkdeu5AoWLp_r5VNVZi1kF3LFUBq7QPAo7E/exec';
  var MAX_PARALLEL = 6;

  window.PARAMS = {};
  new URLSearchParams(location.search).forEach(function (v, k) { window.PARAMS[k] = v; });

  // ---- storage helpers (never throw) ----
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  if (window.PARAMS.debug === '1') lsSet('gas:debug', '1');
  if (window.PARAMS.debug === '0') lsDel('gas:debug');
  var DEBUG = lsGet('gas:debug') === '1';

  // Read-only functions that are safe to repeat after a dropped connection.
  var READ_ONLY = /^(get|list|check|search|find|load|fetch|is|has|count|view|preview|export|download|lookup|verify)/i;
  // Big, slow-changing lists that load instantly from the device copy, then refresh quietly.
  var INSTANT = {
    getDashboardData: 1, getCompanyList: 1, getAllStudentsMaster: 1, getBranchAndCollegeLists: 1,
    getBranchViewFilters: 1, getGlobalSelectionSummary: 1, getPlacementRate: 1,
    getPackageAnalytics: 1, getTopPackageStudents: 1
  };
  var INSTANT_MAX_AGE = 24 * 3600 * 1000;

  function cacheKey(fn, args) { return 'gas:c:' + fn + ':' + JSON.stringify(args); }
  function purgeInstant() {
    try {
      var del = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('gas:c:') === 0) del.push(k);
      }
      del.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }

  // ---- timing panel ----
  var log = [];
  var panel = null;
  function record(fn, total, queued, src) {
    log.unshift({ fn: fn, total: total, queued: queued, src: src });
    if (log.length > 25) log.pop();
    if (DEBUG) drawPanel();
  }
  function drawPanel() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;left:6px;bottom:70px;z-index:99999;max-width:92vw;max-height:40vh;overflow:auto;' +
        'background:rgba(15,23,42,.92);color:#e2e8f0;font:11px/1.45 monospace;padding:6px 8px;border-radius:8px;white-space:pre;';
      panel.onclick = function () { panel.style.display = 'none'; };
      document.body.appendChild(panel);
    }
    panel.style.display = 'block';
    panel.textContent = 'tap to hide · ?debug=0 to turn off\n' + log.map(function (r) {
      return (r.src === 'cache' ? '⚡' : '  ') + r.fn.slice(0, 28).padEnd(28) + String(r.total).padStart(6) + ' ms' +
        (r.queued > 150 ? '  (waited ' + r.queued + ')' : '') + (r.src === 'retry' ? '  retried' : '');
    }).join('\n');
  }

  // ---- queue ----
  var active = 0, waiting = [];
  function enqueue(job) {
    return new Promise(function (resolve, reject) {
      waiting.push({ job: job, resolve: resolve, reject: reject, at: Date.now() });
      pump();
    });
  }
  function pump() {
    while (active < MAX_PARALLEL && waiting.length) {
      (function (item) {
        active++;
        item.job(Date.now() - item.at).then(item.resolve, item.reject).then(function () { active--; pump(); });
      })(waiting.shift());
    }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function htmlReason(text) {
    var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    var t = (m ? m[1] : text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 140);
    return 'The server returned a web page instead of data' + (t ? ' (' + t + ')' : '') + '. Please try again.';
  }

  function attemptOnce(fn, args) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
      body: JSON.stringify({ fn: fn, args: args })
    }).then(function (res) { return res.text(); }).then(function (text) {
      var out;
      try { out = JSON.parse(text); }
      catch (e) { var err = new Error(htmlReason(text)); err.transient = true; err.html = true; throw err; }
      if (!out.ok) throw new Error(out.error || 'Server error');
      return out.data;
    }, function () {
      var err = new Error('Could not reach the server (network or Google error). Please try again.');
      err.transient = true; err.network = true; throw err;
    });
  }

  // returns Promise<{data, ms, queued, retried}>
  function network(fn, args) {
    var readOnly = READ_ONLY.test(fn);
    var maxTries = readOnly ? 4 : 2;
    return enqueue(function (queued) {
      var t0 = Date.now(), attempt = 0;
      function run() {
        return attemptOnce(fn, args).catch(function (err) {
          attempt++;
          // Writes are repeated only when Google returned an error page (script did not run).
          var canRetry = err.transient && attempt < maxTries && (readOnly || err.html);
          if (!canRetry) throw err;
          return sleep(600 * attempt * attempt).then(run);
        });
      }
      return run().then(function (data) { return { data: data, ms: Date.now() - t0, queued: queued, retried: attempt > 0 }; });
    });
  }

  function call(fn, args, onData) {
    var started = Date.now();
    var instant = INSTANT[fn] === 1;
    var key = instant ? cacheKey(fn, args) : null;
    var shownFromCache = false, cachedRaw = null;

    if (instant) {
      var raw = lsGet(key);
      if (raw) {
        try {
          var e = JSON.parse(raw);
          if (Date.now() - e.t < INSTANT_MAX_AGE) {
            cachedRaw = JSON.stringify(e.v);
            shownFromCache = true;
            record(fn, Date.now() - started, 0, 'cache');
            setTimeout(function () { onData(e.v); }, 0);
          }
        } catch (x) {}
      }
    }

    return network(fn, args).then(function (r) {
      record(fn, r.ms + r.queued, r.queued, r.retried ? 'retry' : 'net');
      if (instant) lsSet(key, JSON.stringify({ t: Date.now(), v: r.data }));
      else if (!READ_ONLY.test(fn)) purgeInstant();      // any save/edit/delete: next read is fresh
      if (fn === 'checkLogin') purgeInstant();
      // already showed the stored copy: only call again if the fresh data is actually different
      if (shownFromCache && JSON.stringify(r.data) === cachedRaw) return;
      onData(r.data);
    }, function (err) {
      if (shownFromCache) return; // stored copy is already on screen; stay quiet
      throw err;
    });
  }

  function runner(success, failure, userObject) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, failure, userObject); };
        if (name === 'withFailureHandler') return function (f) { return runner(success, f, userObject); };
        if (name === 'withUserObject') return function (o) { return runner(success, failure, o); };
        if (typeof name !== 'string' || name === 'then') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          call(name, args, function (data) { if (success) success(data, userObject); })
            .then(null, function (err) {
              if (failure) failure(err, userObject);
              else console.error('[' + name + ']', err);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = {
    run: runner(null, null, undefined),
    url: { getLocation: function (cb) { cb({ hash: location.hash.replace(/^#/, ''), parameter: window.PARAMS, parameters: {} }); } },
    host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, origin: location.origin }
  };
  if (DEBUG) window.addEventListener('load', function () { drawPanel(); });
})();
