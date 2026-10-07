/* gas-shim.js — drop-in replacement for google.script.run on Vercel.
 *
 * 1. Set API_URL below to your Apps Script web app URL (ends in /exec).
 * 2. Every HTML page loads this before its own scripts.
 * 3. Existing code such as
 *        google.script.run.withSuccessHandler(ok).withFailureHandler(bad).getDashboardData(token)
 *    keeps working unchanged.
 *
 * v2: calls are queued (max 4 at a time, so a page that fires many requests at once
 * does not overwhelm Apps Script), read-type calls are retried automatically, and when
 * Google answers with an error web page the message says what that page was.
 */
(function () {
  var API_URL = 'https://script.google.com/macros/s/AKfycbwf_pkbZKFh7ZSoI2KFT4jmnYk1ytiMBCkdeu5AoWLp_r5VNVZi1kF3LFUBq7QPAo7E/exec';
  var MAX_PARALLEL = 4;

  // URL query values, replacing the old <?= ... ?> template variables.
  window.PARAMS = {};
  new URLSearchParams(location.search).forEach(function (v, k) { window.PARAMS[k] = v; });

  // Functions that only read data are safe to repeat after a dropped connection.
  var READ_ONLY = /^(get|list|check|search|find|load|fetch|is|has|count|view|preview|export|download|lookup|verify)/i;

  var active = 0, waiting = [];
  function enqueue(job) {
    return new Promise(function (resolve, reject) {
      waiting.push({ job: job, resolve: resolve, reject: reject });
      pump();
    });
  }
  function pump() {
    while (active < MAX_PARALLEL && waiting.length) {
      (function (item) {
        active++;
        item.job().then(item.resolve, item.reject).then(function () { active--; pump(); });
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
      // text/plain avoids a CORS preflight, which Apps Script cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args })
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var out;
      try { out = JSON.parse(text); }
      catch (e) { var err = new Error(htmlReason(text)); err.transient = true; err.html = true; throw err; }
      if (!out.ok) throw new Error(out.error || 'Server error');
      return out.data;
    }, function (netErr) {
      var err = new Error('Could not reach the server (network or Google error). Please try again.');
      err.transient = true; err.network = true; throw err;
    });
  }

  function call(fn, args) {
    var readOnly = READ_ONLY.test(fn);
    var maxTries = readOnly ? 4 : 2;
    return enqueue(function () {
      var attempt = 0;
      function run() {
        return attemptOnce(fn, args).catch(function (err) {
          attempt++;
          // Writes are only repeated when Google answered with an error page (the script did not run);
          // a lost connection could mean the write already happened, so it is NOT repeated.
          var canRetry = err.transient && attempt < maxTries && (readOnly || err.html);
          if (!canRetry) throw err;
          return sleep(600 * attempt * attempt).then(run);
        });
      }
      return run();
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
          call(name, args).then(function (data) {
            if (success) success(data, userObject);
          }, function (err) {
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
    url: {
      getLocation: function (cb) {
        cb({ hash: location.hash.replace(/^#/, ''), parameter: window.PARAMS, parameters: {} });
      }
    },
    host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, origin: location.origin }
  };
})();
