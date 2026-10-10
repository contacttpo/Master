/* gas-shim.js v4 — drop-in replacement for google.script.run on Vercel.
 *
 * 1. Set API_URL below to your Apps Script web app URL (ends in /exec).
 * 2. Every HTML page loads this before its own scripts; existing
 *    google.script.run.withSuccessHandler(...).someFunction(...) code is unchanged.
 *
 * v4 adds a fast path (🚀 in the timing panel) for functions rewritten for Google Sheets, and reads your
 * Apps Script address from Vercel's GAS_URL setting when API_URL below is left as the placeholder.
 * v3 added:
 *  - INSTANT LOADS: the big read-only lists (dashboard, companies, master list...) are
 *    remembered on the device. Next time, the screen fills instantly from memory and is
 *    refreshed in the background a moment later. Any save/edit/delete you make clears it,
 *    so you never see your own changes missing.
 *  - A timing panel: open  <your-site>/?debug=1  once to switch it on (?debug=0 to switch off).
 *    It lists every call with how long it took, so we can see exactly what is slow.
 *  - Up to 6 calls at a time (v2 allowed 4, which could slow screens that load many things).
 */
(function () {
  var API_URL = 'PASTE_YOUR_EXEC_URL_HERE';
  var MAX_PARALLEL = 6;

  // Functions rewritten for the fast Google-Sheets path (served by /api/call on Vercel).
  // If that path is not set up or fails, the call quietly goes to Apps Script as before.
  var GATEWAY = { getDashboardData: 1, getCompanyList: 1, getBranchAndCollegeLists: 1, getRegisteredStudents: 1, getRoundStudents: 1, getRoundCounts: 1, getCompanyDetails: 1,
    getBranchViewFilters: 1, getTopPackageStudents: 1, getPlacementRate: 1, getPackageAnalytics: 1,
    getGlobalSelectionSummary: 1, getAllStudentsMaster: 1,
    getRegisteredStudentDownloadFields: 1, getRegisteredStudentEditFields: 1,
    getGDRollCallCounts: 1, getGDRollCallState: 1, getVolunteerRoundBoard: 1 };

  // Link builders that only join text together (they took ~2 s each through Apps Script). Done right here, instantly.
  var LOCAL = {
    getKioskUrl: function (sessionId) { return location.origin + '/?page=kiosk&session=' + encodeURIComponent(sessionId); },
    getVolunteerPortalUrl: function () { return location.origin + '/?page=volunteer'; },
    getRegistrationFormUrl: function (company) { return location.origin + '/?page=register&company=' + encodeURIComponent(company); },
    getTestUrl: function (company) { return location.origin + '/?page=test&company=' + encodeURIComponent(company); },
    getFeedbackFormUrl: function (company) { return location.origin + '/?page=feedback&company=' + encodeURIComponent(company); },
    getAdminAppUrl: function () { return location.origin + '/'; }
  };

  // If API_URL above is left as the placeholder, the address is read from the GAS_URL setting in
  // Vercel (via /api/config) -- so this file never has to be edited again.
  var urlPromise = null;
  function apiUrl() {
    if (API_URL.indexOf('PASTE_') !== 0) return Promise.resolve(API_URL);
    if (!urlPromise) {
      urlPromise = fetch('/api/config').then(function (r) { return r.json(); }).then(function (j) {
        if (!j.gasUrl) { var e = new Error('App is not configured yet: add GAS_URL in Vercel > Settings > Environment Variables, then Redeploy.'); e.config = true; throw e; }
        API_URL = j.gasUrl; return API_URL;
      }).catch(function (e) { urlPromise = null; if (e.config) throw e; var e2 = new Error('Could not load app settings.'); e2.config = true; throw e2; });
    }
    return urlPromise;
  }

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
    getPackageAnalytics: 1, getTopPackageStudents: 1,
    getRegisteredStudentEditFields: 1   // read on every Students window (3-6 s each); the form fields rarely change
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
  function record(fn, total, queued, src, reason) {
    log.unshift({ fn: fn, total: total, queued: queued, src: src, reason: reason });
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
      return (r.src === 'cache' ? '⚡' : (r.src === 'gw' ? '🚀' : '  ')) + r.fn.slice(0, 36).padEnd(36) + String(r.total).padStart(6) + ' ms' +
        (r.queued > 150 ? '  (waited ' + r.queued + ')' : '') + (r.src === 'retry' ? '  retried' : '') + (r.reason ? '\n      ↩ ' + String(r.reason).slice(0, 70) : '');
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
    return apiUrl().then(function (url) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
        body: JSON.stringify({ fn: fn, args: args })
      });
    }).then(function (res) { return res.text(); }).then(function (text) {
      var out;
      try { out = JSON.parse(text); }
      catch (e) { var err = new Error(htmlReason(text)); err.transient = true; err.html = true; throw err; }
      if (!out.ok) throw new Error(out.error || 'Server error');
      return out.data;
    }, function (e) {
      if (e && e.config) throw e;
      var err = new Error('Could not reach the server (network or Google error). Please try again.');
      err.transient = true; err.network = true; throw err;
    });
  }

  function viaGateway(fn, args) {
    return fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (out && out.ok) return out.data;
      throw new Error((out && out.error) || 'fallback');
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
      function viaApps() {
        return run().then(function (data) { return { data: data, ms: Date.now() - t0, queued: queued, retried: attempt > 0 }; });
      }
      if (!GATEWAY[fn]) return viaApps();
      return viaGateway(fn, args).then(function (data) {
        return { data: data, ms: Date.now() - t0, queued: queued, gw: true };
      }, function (why) {
        return viaApps().then(function (r) { r.reason = why && why.message; return r; });
      });
    });
  }

  // After any save/edit/delete, tell the fast route to forget what it just read, so the next screen is fresh.
  function purgeServer() {
    return fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: '__purge', args: [] }) })
      .then(function () {}, function () {});
  }

  var sharedReads = {};

  function call(fn, args, onData) {
    var started = Date.now();
    if (Object.prototype.hasOwnProperty.call(LOCAL, fn)) {
      var localValue = LOCAL[fn].apply(null, args);
      record(fn, 0, 0, 'cache');
      return Promise.resolve().then(function () { onData(localValue); });
    }
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

    // Identical read requests already waiting or running share ONE request (the page repeats some reads).
    // Any save clears this, so a read started after a save is never answered with data from before it.
    var readOnlyCall = READ_ONLY.test(fn);
    var dkey = readOnlyCall ? fn + ':' + JSON.stringify(args) : null;
    if (!readOnlyCall) sharedReads = {};
    var net;
    if (dkey && sharedReads[dkey]) net = sharedReads[dkey];
    else {
      net = network(fn, args);
      if (dkey) {
        sharedReads[dkey] = net;
        var forget = function () { if (sharedReads[dkey] === net) delete sharedReads[dkey]; };
        net.then(forget, forget);
      }
    }
    return net.then(function (r) {
      record(fn, r.ms + r.queued, r.queued, r.gw ? 'gw' : (r.reason ? 'fb' : (r.retried ? 'retry' : 'net')), r.reason);
      var wrote = !instant && !READ_ONLY.test(fn);
      if (instant) lsSet(key, JSON.stringify({ t: Date.now(), v: r.data }));
      else if (wrote) purgeInstant();      // any save/edit/delete: next read is fresh
      if (fn === 'checkLogin') purgeInstant();
      return (wrote ? purgeServer() : Promise.resolve()).then(function () {
        // already showed the stored copy: only call again if the fresh data is actually different
        if (shownFromCache && JSON.stringify(r.data) === cachedRaw) return;
        onData(r.data);
      });
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
