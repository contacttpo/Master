/* gas-shim.js — drop-in replacement for google.script.run on Vercel.
 *
 * 1. Set API_URL below to your Apps Script web app URL (ends in /exec).
 * 2. In every HTML page, add before your own <script>:
 *        <script src="/gas-shim.js"></script>
 * 3. Existing code such as
 *        google.script.run.withSuccessHandler(ok).withFailureHandler(bad).getDashboardData(token)
 *    keeps working unchanged.
 * 4. Replace Apps Script template values (<?= companyName ?> etc.) with PARAMS.*
 *    (see README).
 */
(function () {
  var API_URL = 'https://script.google.com/macros/s/AKfycbwf_pkbZKFh7ZSoI2KFT4jmnYk1ytiMBCkdeu5AoWLp_r5VNVZi1kF3LFUBq7QPAo7E/exec';

  // URL query values, replacing the old <?= ... ?> template variables.
  window.PARAMS = {};
  new URLSearchParams(location.search).forEach(function (v, k) { window.PARAMS[k] = v; });

  function call(fn, args, attempt) {
    attempt = attempt || 0;
    return fetch(API_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args })
    }).then(function (res) {
      return res.json();
    }).then(function (out) {
      if (!out.ok) throw new Error(out.error || 'Server error');
      return out.data;
    }).catch(function (err) {
      // one automatic retry for a dropped connection / Apps Script hiccup
      if (attempt < 1 && (err instanceof TypeError || err instanceof SyntaxError)) {
        return new Promise(function (r) { setTimeout(r, 800); })
          .then(function () { return call(fn, args, attempt + 1); });
      }
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
