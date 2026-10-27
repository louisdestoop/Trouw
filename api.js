/* Koppeling tussen de app en de Google Sheet (via het Google Apps Script).
 * Biedt dezelfde vorm als de database van de planner: collection(...).onSnapshot, doc(id).update, add, delete.
 * Wijzigingen worden meteen getoond en daarna gebundeld naar de Sheet gestuurd. */
(function () {
  "use strict";

  function post(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // geen CORS-voorcontrole nodig
      body: JSON.stringify(body),
      redirect: "follow",
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function apiUrl() {
    var u = (window.TP_CONFIG && window.TP_CONFIG.apiUrl) || "";
    if (!/^https:\/\/script\.google\.com\//.test(u)) throw { code: "not_configured", message: "De koppeling met Google is nog niet ingesteld (config.js)." };
    return u;
  }

  window.TPApi = { post: post, apiUrl: apiUrl };

  window.createApiDb = function (opts) {
    var COLS = ["guests", "households", "budget", "tasks", "tables", "info", "questions", "orders", "menu"];
    var serverCols = null; // welke collecties het script teruggeeft (een oudere versie kent "questions" nog niet)
    var cache = { settings: {} };
    COLS.forEach(function (c) { cache[c] = []; });
    var listeners = {};
    var loaded = false, inflight = 0, queue = [], timer = null, lastJson = "", pollTimer = null, writeSeq = 0;

    function freezeCopy(o) { var c = {}; Object.keys(o).forEach(function (k) { if (k !== "id") c[k] = o[k]; }); return Object.freeze(c); }
    function snap(col) {
      var docs = cache[col].map(function (o) { var d = freezeCopy(o); return { id: o.id, exists: true, data: function () { return d; }, metadata: {} }; });
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: inflight > 0 } };
    }
    function settingsSnap() { var d = Object.assign({}, cache.settings); return { id: "settings", exists: true, data: function () { return d; } }; }
    function emit(col) {
      (listeners[col] || []).forEach(function (cb) {
        try { cb(col === "settings" ? settingsSnap() : snap(col)); } catch (e) { console.error(e); }
      });
    }
    function emitAll() { COLS.concat(["settings"]).forEach(emit); }

    function fail(res) {
      var code = res && res.error === "unauthorized" ? "unauthorized" : "unavailable";
      if (code === "unauthorized" && opts.onUnauthorized) opts.onUnauthorized();
      return { code: code, message: (res && (res.message || res.error)) || "" };
    }

    function load() {
      var seqAtStart = writeSeq;
      return post(apiUrl(), { action: "load", pin: opts.pin }).then(function (res) {
        if (!res.ok) throw fail(res);
        // tijdens of na een wijziging die later vertrok dan deze lading: niets overschrijven
        if (inflight > 0 || queue.length || seqAtStart !== writeSeq) return;
        var j = JSON.stringify(res.data);
        if (loaded && j === lastJson) return;
        lastJson = j;
        serverCols = Object.keys(res.data || {});
        COLS.forEach(function (c) { cache[c] = res.data[c] || []; });
        cache.settings = res.data.settings || {};
        loaded = true;
        emitAll();
        if (opts.onSync) opts.onSync(new Date());
      });
    }

    function flush() {
      timer = null;
      var ops = queue; queue = [];
      if (!ops.length) return;
      inflight++;
      if (opts.onBusy) opts.onBusy(true);
      post(apiUrl(), { action: "batch", pin: opts.pin, ops: ops.map(function (o) { return o.op; }) }).then(function (res) {
        inflight--;
        if (opts.onBusy) opts.onBusy(inflight > 0);
        if (!res.ok) { var err = fail(res); ops.forEach(function (o) { o.reject(err); }); lastJson = ""; load().catch(function () {}); return; }
        res.results.forEach(function (r, i) { if (r.ok) ops[i].resolve(r); else ops[i].reject({ code: "invalid_argument", message: r.error }); });
        lastJson = "";
        if (opts.onSync) opts.onSync(new Date());
      }).catch(function (e) {
        inflight--;
        if (opts.onBusy) opts.onBusy(inflight > 0);
        ops.forEach(function (o) { o.reject({ code: "unavailable", message: String(e && e.message || e) }); });
        lastJson = "";
        load().catch(function () {});
      });
    }
    function enqueue(op) {
      writeSeq++;
      return new Promise(function (resolve, reject) {
        queue.push({ op: op, resolve: resolve, reject: reject });
        if (!timer) timer = setTimeout(flush, 120);
      });
    }
    function genId() {
      var a = new Uint8Array(8); (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    }

    function docRef(col, id) {
      return {
        id: id,
        update: function (patch) {
          var o = cache[col].find(function (x) { return x.id === id; });
          if (o) Object.assign(o, patch);
          emit(col);
          return enqueue({ op: "update", col: col, id: id, patch: patch });
        },
        delete: function () {
          cache[col] = cache[col].filter(function (x) { return x.id !== id; });
          emit(col);
          return enqueue({ op: "delete", col: col, id: id });
        },
      };
    }

    var db = {
      collection: function (col) {
        var ref = {
          limit: function () { return ref; },
          orderBy: function () { return ref; },
          where: function () { return ref; },
          onSnapshot: function (cb) {
            (listeners[col] = listeners[col] || new Set()).add(cb);
            if (loaded) setTimeout(function () { cb(snap(col)); }, 0);
            return function () { listeners[col].delete(cb); };
          },
          doc: function (id) { return docRef(col, id); },
          add: function (data) {
            var id = genId();
            cache[col].push(Object.assign({ id: id }, data));
            emit(col);
            return enqueue({ op: "add", col: col, id: id, data: data }).then(function () { return docRef(col, id); });
          },
        };
        return ref;
      },
      doc: function (path) {
        if (path !== "meta/settings") throw new Error("Onbekend pad: " + path);
        return {
          onSnapshot: function (cb) {
            (listeners.settings = listeners.settings || new Set()).add(cb);
            if (loaded) setTimeout(function () { cb(settingsSnap()); }, 0);
            return function () { listeners.settings.delete(cb); };
          },
          set: function (data) {
            var changed = {};
            Object.keys(data).forEach(function (k) { if (cache.settings[k] !== data[k]) changed[k] = data[k]; });
            Object.assign(cache.settings, data);
            emit("settings");
            return enqueue({ op: "settings", data: changed });
          },
        };
      },
      load: load,
      startPolling: function (ms) {
        if (pollTimer) return;
        pollTimer = setInterval(function () { if (document.visibilityState === "visible") load().catch(function () {}); }, ms);
        document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") load().catch(function () {}); });
        window.addEventListener("focus", function () { load().catch(function () {}); });
      },
      newId: genId,
      has: function (col) { return !serverCols || serverCols.indexOf(col) >= 0; },
    };
    return db;
  };
})();
