/*
 * Service du module « Écran d'accueil » (TizenBrew).
 *
 * TizenBrew exécute ce fichier dans son propre Node.js, dans un bac à sable vm,
 * et lui passe l'objet `tizen`. La page du module, servie par TizenBrew en http,
 * n'a pas cet objet : elle passe par ce service pour lister et lancer les applis.
 * Le Node de la TV peut être ancien : ce fichier reste en ES5.
 *
 * Un seul serveur, sur 127.0.0.1:8097 (joignable depuis la TV seulement) :
 *   GET  /session          jeton de la page (tiré à chaque démarrage) et infos
 *   GET  /applis           liste des applis de la TV (?recharger=1 pour la relire)   jeton exigé
 *   GET  /etat             état et journal des lancements, sans le jeton             jeton exigé
 *   POST /lancer           { id } : lance une appli présente sur la TV               jeton exigé
 *   GET  /icone?id=        icône d'une appli de la liste (balises <img>, sans en-tête Origin)
 *
 * Il n'obéit qu'à la page du module : origine de TizenBrew (http://127.0.0.1:8081)
 * et page servie par TizenBrew sous le nom du dépôt (en-tête Referer).
 * Rien n'est écrit sur la TV : tout reste en mémoire jusqu'au redémarrage de la TV.
 */
(function () {
  'use strict';

  var http = require('http');
  var fs = require('fs');
  var crypto = require('crypto');
  // url.parse : le seul analyseur d'URL des vieux Node (les Node récents l'annoncent obsolète).
  var urlLib = require('url');

  var VERSION = '0.1.0';
  var MODULE = 'ecran-accueil';
  // Seule une page que TizenBrew sert sous ce nom de dépôt obtient le jeton.
  var DEPOT = 'tizenbrew-ecran-accueil';

  // Réglages de test uniquement : ECRAN_CONFIG n'existe pas sur la TV.
  var cfg = (typeof ECRAN_CONFIG !== 'undefined' && ECRAN_CONFIG) || {};
  var PORT = cfg.port || 8097;
  var ORIGINS = ['http://127.0.0.1:8081', 'http://localhost:8081'].concat(cfg.extraOrigins || []);
  var ICON_ROOTS = cfg.iconRoots || ['/opt/', '/usr/'];
  var ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  var APPS_MAX_AGE = 5 * 60 * 1000;
  var LAUNCH_TIMEOUT = cfg.launchTimeout || 15000;
  var MAX_BODY = 4096;
  var MAX_LAUNCHES = 50;
  var MAX_REFUSED = 20;

  var hasTizen = typeof tizen !== 'undefined' && !!tizen && !!tizen.application;
  var token = crypto.randomBytes(16).toString('hex');
  var startedAt = Date.now();

  var state = {
    version: VERSION,
    startedAt: startedAt,
    // Ce Node démarre avec TizenBrew : son âge donne l'heure d'ouverture de TizenBrew.
    tizenbrewStartedAt: Math.round(startedAt - process.uptime() * 1000),
    platform: capability('http://tizen.org/feature/platform.version'),
    model: capability('http://tizen.org/system/model_name'),
    node: process.version,
    port: PORT,
    listening: false,
    error: null,
    page: null,
    // Toutes les demandes de session reçues, même refusées : dit si la page joint le service.
    requests: { session: 0, lastSessionAt: null, refused: [] },
    apps: { list: null, at: null, ms: null, error: null },
    launches: [],
    icons: { served: 0, failed: 0, lastError: null }
  };

  function capability(key) {
    try {
      return hasTizen && tizen.systeminfo ? String(tizen.systeminfo.getCapability(key)) : null;
    } catch (e) {
      return null;
    }
  }

  function describe(err) {
    if (!err) { return 'Erreur inconnue.'; }
    if (err.name || err.message) { return (err.name ? err.name + ' : ' : '') + (err.message || ''); }
    return String(err);
  }

  /* ---------- Qui appelle ---------- */

  function cleanAddress(address) {
    var a = String(address || '');
    return a.indexOf('::ffff:') === 0 ? a.slice(7) : a;
  }

  function isLoopback(address) {
    var a = cleanAddress(address);
    return a === '::1' || /^127\./.test(a);
  }

  // Adresse attendue : http://127.0.0.1:8081/module/<nom encodé>/app/..., où le nom décodé vaut
  // gh/<compte>/tizenbrew-ecran-accueil, npm/tizenbrew-ecran-accueil ou npm/@<scope>/tizenbrew-ecran-accueil,
  // suivi ou non de @<version>.
  function isModulePage(referer) {
    var parsed = urlLib.parse(String(referer || ''));
    if (!parsed.protocol || !parsed.host || ORIGINS.indexOf(parsed.protocol + '//' + parsed.host) === -1) { return false; }
    var parts = String(parsed.pathname || '').split('/');
    if (parts.length < 5 || parts[0] !== '' || parts[1] !== 'module' || parts[3] !== 'app') { return false; }
    var name;
    try { name = decodeURIComponent(parts[2]); } catch (e) { return false; }
    var s = name.replace(/@[^\/@]*$/, '').split('/');
    if (s[0] === 'gh') { return s.length === 3 && s[1] !== '' && s[2] === DEPOT; }
    if (s[0] === 'npm') { return (s.length === 2 && s[1] === DEPOT) || (s.length === 3 && /^@./.test(s[1]) && s[2] === DEPOT); }
    return false;
  }

  /* ---------- Applis ---------- */

  // Lecture champ par champ : `size` exige un privilège que TizenBrew n'a pas, on n'y touche pas.
  function field(info, name) {
    try { return info[name]; } catch (e) { return undefined; }
  }

  function toApp(info) {
    return {
      id: String(field(info, 'id') || ''),
      name: String(field(info, 'name') || ''),
      show: field(info, 'show') !== false,
      iconPath: String(field(info, 'iconPath') || '')
    };
  }

  var waitingForApps = [];

  // getAppsInfo prend environ 3 s sur une TV de 2020 : une seule lecture à la fois, gardée 5 min.
  function loadApps(force, done) {
    var apps = state.apps;
    if (!force && apps.list && Date.now() - apps.at < APPS_MAX_AGE) { return done(); }
    waitingForApps.push(done);
    if (waitingForApps.length > 1) { return; }
    var t0 = Date.now();
    function finish(list, error) {
      apps.ms = Date.now() - t0;
      apps.at = Date.now();
      if (list) { apps.list = list; apps.error = null; } else { apps.error = error; }
      var callbacks = waitingForApps;
      waitingForApps = [];
      callbacks.forEach(function (callback) { callback(); });
    }
    if (!hasTizen) { return finish(null, "L'objet tizen est absent de ce service."); }
    try {
      tizen.application.getAppsInfo(function (infos) {
        var list = [];
        for (var i = 0; i < infos.length; i++) { list.push(toApp(infos[i])); }
        finish(list, null);
      }, function (err) {
        finish(null, describe(err));
      });
    } catch (e) {
      finish(null, describe(e));
    }
  }

  function findApp(id) {
    var list = state.apps.list || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function journal(entry) {
    state.launches.push(entry);
    if (state.launches.length > MAX_LAUNCHES) { state.launches.shift(); }
  }

  function launchApp(id, done) {
    var app = findApp(id);
    if (!app) {
      var error = 'Appli absente de cette TV (' + id + ').';
      journal({ id: id, name: null, at: Date.now(), ms: 0, ok: false, error: error });
      return done(404, { ok: false, error: error });
    }
    var t0 = Date.now();
    var entry = { id: app.id, name: app.name, at: t0, ms: null, ok: null, error: null };
    journal(entry);
    var timer = null;
    function settle(ok, error) {
      if (entry.ok !== null) { return; }
      if (timer) { clearTimeout(timer); }
      entry.ms = Date.now() - t0;
      entry.ok = ok;
      entry.error = error || null;
      done(200, { ok: ok, ms: entry.ms, error: entry.error });
    }
    if (!hasTizen) { return settle(false, "L'objet tizen est absent de ce service."); }
    timer = setTimeout(function () {
      settle(false, 'Pas de réponse de la TV après ' + Math.round(LAUNCH_TIMEOUT / 1000) + ' s.');
    }, LAUNCH_TIMEOUT);
    try {
      tizen.application.launch(app.id, function () { settle(true); }, function (err) { settle(false, describe(err)); });
    } catch (e) {
      settle(false, describe(e));
    }
  }

  function iconFile(iconPath) {
    var p = String(iconPath || '');
    if (p.indexOf('file://') === 0) { p = p.slice(7); }
    if (!p || p.indexOf('..') !== -1) { return null; }
    var ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (!ICON_TYPES[ext]) { return null; }
    for (var i = 0; i < ICON_ROOTS.length; i++) {
      if (p.indexOf(ICON_ROOTS[i]) === 0) { return p; }
    }
    return null;
  }

  function serveIcon(id, res) {
    loadApps(false, function () {
      var app = findApp(String(id || ''));
      var file = app ? iconFile(app.iconPath) : null;
      if (!file) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      var type = ICON_TYPES[file.slice(file.lastIndexOf('.')).toLowerCase()];
      var stream = fs.createReadStream(file);
      stream.on('error', function (e) {
        state.icons.failed += 1;
        state.icons.lastError = (e.code || describe(e)) + ' (' + app.id + ')';
        if (!res.headersSent) { res.writeHead(404, { 'Cache-Control': 'no-store' }); }
        res.end();
      });
      stream.on('open', function () {
        state.icons.served += 1;
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
        stream.pipe(res);
      });
    });
  }

  /* ---------- État ---------- */

  function recordPage(query) {
    var now = Date.now();
    function plausible(value) { return isFinite(value) && value > 0 && Math.abs(now - value) < 86400000; }
    var nav = Number(query.nav);
    var ready = Number(query.ready);
    var tries = Number(query.tries);
    var waited = Number(query.waited);
    var visit = {
      navigationStart: plausible(nav) ? nav : null,
      readyAt: plausible(ready) ? ready : now,
      seenAt: now,
      tries: isFinite(tries) && tries > 0 ? tries : null,
      waitedMs: isFinite(waited) && waited >= 0 && waited < 86400000 ? waited : null
    };
    if (!state.page) {
      state.page = { first: visit, last: visit, visits: 1 };
    } else {
      state.page.last = visit;
      state.page.visits += 1;
    }
  }

  function appsSummary(withList) {
    var list = state.apps.list || [];
    var visible = 0;
    for (var i = 0; i < list.length; i++) { if (list[i].show) { visible += 1; } }
    var summary = { count: list.length, visible: visible, ms: state.apps.ms, at: state.apps.at, error: state.apps.error };
    if (withList) {
      summary.list = list.map(function (a) {
        return { id: a.id, name: a.name, show: a.show, icon: !!iconFile(a.iconPath) };
      });
    }
    return summary;
  }

  function info() {
    return {
      module: MODULE, version: VERSION, startedAt: state.startedAt, tizenbrewStartedAt: state.tizenbrewStartedAt,
      platform: state.platform, model: state.model, node: state.node, port: state.port
    };
  }

  function report() {
    var r = info();
    r.generatedAt = Date.now();
    r.page = state.page;
    r.requests = state.requests;
    r.apps = appsSummary(false);
    r.launches = state.launches;
    r.icons = state.icons;
    return r;
  }

  /* ---------- HTTP ---------- */

  function send(res, status, data, headers) {
    var h = headers || {};
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Cache-Control'] = 'no-store';
    res.writeHead(status, h);
    res.end(JSON.stringify(data));
  }

  function readJson(req, done) {
    var body = '';
    var tooLarge = false;
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', function () {
      if (tooLarge) { return; }
      var data = null;
      try { data = body ? JSON.parse(body) : {}; } catch (e) { data = null; }
      done(data);
    });
  }

  // Refus noté dans l'état, et lisible par la page : sans en-tête CORS,
  // le navigateur ne montrerait qu'une erreur réseau, comme un service arrêté.
  function refuse(req, res, reason) {
    var origin = req.headers.origin;
    state.requests.refused.push({
      at: Date.now(), reason: reason, origin: origin || null, referer: req.headers.referer || null,
      remote: cleanAddress(req.socket.remoteAddress), method: req.method, path: urlLib.parse(req.url).pathname
    });
    if (state.requests.refused.length > MAX_REFUSED) { state.requests.refused.shift(); }
    send(res, 403, { error: reason + '.' }, origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {});
  }

  function handle(req, res) {
    var parsed = urlLib.parse(req.url, true);
    var path = parsed.pathname;
    var origin = req.headers.origin;
    if (path === '/session') {
      state.requests.session += 1;
      state.requests.lastSessionAt = Date.now();
    }
    if (!isLoopback(req.socket.remoteAddress)) { return refuse(req, res, 'Réservé à la TV'); }

    // Les icônes sont chargées par des balises <img>, sans en-tête Origin.
    if (req.method === 'GET' && path === '/icone') { return serveIcon(parsed.query.id, res); }

    if (ORIGINS.indexOf(origin) === -1) { return refuse(req, res, 'Origine refusée (' + (origin || 'aucune') + ')'); }
    var cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };

    if (req.method === 'OPTIONS') {
      cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      cors['Access-Control-Allow-Headers'] = 'Content-Type, X-Ecran-Jeton';
      cors['Access-Control-Max-Age'] = '600';
      res.writeHead(204, cors);
      return res.end();
    }
    if (!isModulePage(req.headers.referer)) { return refuse(req, res, 'Page refusée : seule la page du module ' + DEPOT + ' est servie'); }

    if (req.method === 'GET' && path === '/session') {
      recordPage(parsed.query);
      var data = info();
      data.token = token;
      return send(res, 200, data, cors);
    }
    if (req.headers['x-ecran-jeton'] !== token) { return refuse(req, res, 'Jeton absent ou faux'); }

    if (req.method === 'GET' && path === '/applis') {
      return loadApps(parsed.query.recharger === '1', function () { send(res, 200, appsSummary(true), cors); });
    }
    if (req.method === 'GET' && path === '/etat') {
      return loadApps(false, function () { send(res, 200, report(), cors); });
    }
    if (req.method === 'POST' && path === '/lancer') {
      return readJson(req, function (body) {
        if (!body || typeof body.id !== 'string') { return send(res, 400, { error: 'Requête mal formée.' }, cors); }
        loadApps(false, function () {
          launchApp(body.id, function (status, payload) { send(res, status, payload, cors); });
        });
      });
    }
    send(res, 404, { error: 'Introuvable.' }, cors);
  }

  /* ---------- Démarrage ---------- */

  var server = http.createServer(handle);
  server.on('error', function (e) {
    state.listening = false;
    state.error = e.code || describe(e);
  });
  server.listen(PORT, '127.0.0.1', function () { state.listening = true; });

  loadApps(false, function () {});

  // Pour les tests ; TizenBrew ne lit pas module.exports.
  if (typeof module !== 'undefined' && module) {
    module.exports = {
      version: VERSION,
      state: state,
      isLoopback: isLoopback,
      isModulePage: isModulePage,
      iconFile: iconFile,
      server: server,
      stop: function () { server.close(); }
    };
  }
})();
