'use strict';

// Test de bout en bout du chargeur : la vraie page dans un Edge ou un Chrome sans fenêtre,
// face au vrai service (fausse API tizen), à un faux canal TizenBrew et à un écran de test.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { PAGE_FILE, MODULE_PATH, loadService, fakeTizen, freePort, waitFor, sleep, serveStatic } = require('./helpers/harness');
const { cheminNavigateur, demarrerNavigateur, arreterNavigateur, ouvrirOnglet } = require('./helpers/navigateur');
const { fauxTizenBrew } = require('./helpers/tizenbrew');

const ECRAN_TEST = path.join(__dirname, 'fixtures', 'ecran-test.js');

const APPS = [
  { id: 'org.tizen.netflix-app', name: 'Netflix' },
  { id: 'AAAAAAAAAA.Emby', name: 'Emby' },
  { id: 'org.tizen.tv-viewer', name: 'tv-viewer', show: false }
];

function tizenTube(portStatique) {
  return {
    fullName: 'npm/@foxreis/tizentube', appName: 'TizenTube', version: '1.15.2', name: '@foxreis/tizentube',
    appPath: 'http://127.0.0.1:' + portStatique + '/youtube-tv/', keys: ['MediaPlayPause'], moduleType: 'npm',
    packageType: 'mods', serviceFile: 'dist/service.js', mainFile: 'dist/userScript.js'
  };
}

// Service imité, pour les cas qu'un vrai service ne produit pas (autre version, autre module).
function fauxService(port, session) {
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Ecran-Jeton' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    if (req.url.indexOf('/session') === 0) return res.end(JSON.stringify(session));
    res.end(JSON.stringify({ count: 0, visible: 0, list: [] }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

describe('chargeur, dans un vrai navigateur', { skip: cheminNavigateur ? false : 'aucun navigateur Chromium trouvé' }, () => {
  let navigateur;
  let onglet;
  let statique;
  let portStatique;
  let portService;
  let portTB;
  let svc;
  let tz;
  let tb;
  const autres = [];

  const origine = () => 'http://127.0.0.1:' + portStatique;
  const urlPage = (service = portService) => origine() + MODULE_PATH + '?service=http://127.0.0.1:' + service + '&tizenbrew=ws://127.0.0.1:' + portTB;
  // Pendant un rechargement, l'évaluation peut échouer : on réessaie.
  const lire = async (expression) => {
    try { return await onglet.evaluer(expression); } catch { return null; }
  };
  const texte = (id) => lire("(document.getElementById('" + id + "') || {}).textContent");
  const visible = (id) => lire("(function () { var e = document.getElementById('" + id + "'); return !!e && e.offsetParent !== null; })()");

  async function poserAdresse(adresse) {
    await onglet.aller(origine() + '/vide.html');
    await waitFor(async () => (await lire('location.pathname')) === '/vide.html');
    await onglet.evaluer(adresse === null ? 'localStorage.clear(), true'
      : "localStorage.setItem('ecran-accueil.adresse', " + JSON.stringify(adresse) + '), true');
  }

  async function saisir(valeur) {
    await onglet.evaluer("document.getElementById('saisie').value = '', true");
    await onglet.touche('ArrowUp', 38, 4);
    await onglet.touche('Enter', 13);
    await onglet.page.send('Input.insertText', { text: valeur });
    await onglet.touche('Enter', 13);
    await onglet.touche('Enter', 13);
  }

  before(async () => {
    portStatique = await freePort();
    portService = await freePort();
    portTB = await freePort();
    statique = await serveStatic(portStatique, {
      [MODULE_PATH]: PAGE_FILE,
      '/vide.html': { type: 'text/html; charset=utf-8', body: '<!DOCTYPE html><title>vide</title>' },
      '/ecran-test/ecran.js': ECRAN_TEST,
      '/spa/ecran.js': { type: 'text/html; charset=utf-8', body: '<!DOCTYPE html><html><body>Autre appli</body></html>' },
      '/muet/ecran.js': { type: 'application/javascript', body: 'window.ecranMuet = true;' },
      '/plante/ecran.js': { type: 'application/javascript', body: "Chargeur.declarer({ nom: 'x', version: '1', demarrer: function () { throw new Error('panne simulée'); } });" },
      '/youtube-tv/': { type: 'text/html; charset=utf-8', body: '<!DOCTYPE html><title>Faux YouTube</title><p id="yt">YouTube TV</p>' }
    });
    tz = fakeTizen(APPS);
    svc = loadService({ tizen: tz, config: { port: portService, extraOrigins: [origine()] } });
    tb = await fauxTizenBrew(portTB, { modules: [tizenTube(portStatique)], nulsAvant: 1 });
    navigateur = await demarrerNavigateur();
    onglet = await ouvrirOnglet(navigateur);
    await waitFor(() => svc.state.listening);
  });

  after(() => {
    if (onglet) onglet.fermer();
    arreterNavigateur(navigateur);
    if (statique) statique.close();
    if (svc) svc.stop();
    if (tb) tb.fermer();
    autres.forEach((a) => a.close ? a.close() : a.stop());
  });

  it("demande l'adresse de l'écran au premier lancement", async () => {
    await poserAdresse(null);
    await onglet.aller(urlPage());
    await waitFor(() => visible('reglage'));
    assert.equal(await visible('btn-annuler'), false);
    assert.equal(await lire("document.getElementById('saisie').className"), 'focus');
  });

  it('refuse une adresse hors du réseau local', async () => {
    await saisir('exemple.com/ecran');
    await waitFor(async () => /réseau local/.test(await texte('reglage-message')));
    assert.equal(await texte('reglage-message'), 'Seules les adresses du réseau local sont acceptées (par exemple 192.168.x.x).');
  });

  it("refuse ce qui n'est pas un écran : page de repli d'un site, script muet, fichier absent", async () => {
    await saisir('127.0.0.1:' + portStatique + '/spa');
    await waitFor(async () => /ne déclare pas d'écran/.test(await texte('reglage-message')));
    await saisir('127.0.0.1:' + portStatique + '/muet/');
    await waitFor(async () => /muet\/ ne déclare pas d'écran/.test(await texte('reglage-message')));
    await saisir('127.0.0.1:' + portStatique + '/absent');
    await waitFor(async () => (await texte('reglage-message')) === "Aucun écran à l'adresse " + origine() + '/absent/, ou NAS injoignable.');
    assert.equal(await lire("localStorage.getItem('ecran-accueil.adresse')"), null);
  });

  it("enregistre une adresse locale puis démarre l'écran", async () => {
    await saisir('127.0.0.1:' + portStatique + '/ecran-test');
    await waitFor(async () => !!(await lire("!!document.getElementById('test-ecran')")), { timeout: 10000 });
    assert.equal(await lire("localStorage.getItem('ecran-accueil.adresse')"), origine() + '/ecran-test/');
    assert.equal(await visible('chargeur'), false);
    const infos = await onglet.evaluer('({ module: testApi.session.module, version: testApi.session.version, jeton: testApi.session.token, adresse: testApi.adresse, pret: testApi.depart.pret > testApi.depart.page, fichier: testApi.fichier("ecran.css") })');
    assert.equal(infos.module, 'ecran-accueil');
    assert.equal(infos.version, svc.version);
    assert.equal(infos.jeton, undefined);
    assert.equal(infos.adresse, origine() + '/ecran-test/');
    assert.equal(infos.pret, true);
    assert.match(infos.fichier, new RegExp('^' + origine() + '/ecran-test/ecran\\.css\\?v=\\d+$'));
  });

  it("donne à l'écran la liste des applis, leur lancement et leurs icônes", async () => {
    const applis = await onglet.evaluer('new Promise(function (r) { testApi.applis(false, function (e, d) { r({ e: e, ids: d.list.map(function (a) { return a.id; }) }); }); })');
    assert.equal(applis.e, null);
    assert.deepEqual(applis.ids, APPS.map((a) => a.id));
    const lance = await onglet.evaluer("new Promise(function (r) { testApi.lancer('org.tizen.netflix-app', function (e, d) { r({ e: e, ok: d && d.ok }); }); })");
    assert.deepEqual(lance, { e: null, ok: true });
    assert.deepEqual(tz.calls.launch, ['org.tizen.netflix-app']);
    const absente = await onglet.evaluer("new Promise(function (r) { testApi.lancer('com.exemple.absente', function (e) { r(e); }); })");
    assert.equal(absente, 'Appli absente de cette TV (com.exemple.absente).');
    assert.equal(await onglet.evaluer("testApi.icone('org.tizen.netflix-app')"), 'http://127.0.0.1:' + portService + '/icone?id=org.tizen.netflix-app');
    const etat = await onglet.evaluer('new Promise(function (r) { testApi.etat(function (e, d) { r(d.launches.length); }); })');
    assert.equal(etat, 2);
  });

  it("passe la télécommande à l'écran une fois affiché", async () => {
    await onglet.touche('ArrowDown', 40);
    await onglet.touche('Enter', 13);
    assert.deepEqual(await onglet.evaluer('testTouches'), [40, 13]);
  });

  it('ouvre un module TizenBrew comme son propre menu', async () => {
    const debut = tb.recus.length;
    await onglet.evaluer("testApi.ouvrirModule('TizenTube'), true");
    await waitFor(async () => (await lire('location.pathname')) === '/youtube-tv/', { timeout: 10000 });
    const recus = tb.recus.slice(debut);
    assert.ok(recus.filter((m) => m.type === 4).length >= 2, 'GetModules redemandé après un null');
    assert.deepEqual(tb.lancements(), [tizenTube(portStatique)]);
  });

  it("dit clairement que l'écran manque sur le NAS, et propose de changer l'adresse", async () => {
    await poserAdresse(origine() + '/absent/');
    await onglet.aller(urlPage());
    await waitFor(() => visible('erreur'));
    assert.equal(await texte('erreur-texte'), "Aucun écran à l'adresse " + origine() + '/absent/, ou NAS injoignable.');
    assert.equal(await texte('btn-reessayer'), 'Réessayer');
    await onglet.touche('ArrowRight', 39);
    await onglet.touche('Enter', 13);
    await waitFor(() => visible('reglage'));
    assert.equal(await visible('btn-annuler'), true);
    assert.equal(await lire("document.getElementById('saisie').value"), origine() + '/absent/');
  });

  it("dit quand l'écran plante au démarrage", async () => {
    await poserAdresse(origine() + '/plante/');
    await onglet.aller(urlPage());
    await waitFor(() => visible('erreur'));
    assert.equal(await texte('erreur-texte'), "L'écran a planté au démarrage : panne simulée.");
  });

  it("attend le service quand il démarre après la page, et laisse changer l'adresse pendant l'attente", async () => {
    const portRetard = await freePort();
    await poserAdresse(origine() + '/ecran-test/');
    await onglet.aller(urlPage(portRetard));
    await sleep(1500);
    assert.equal(await visible('attente'), true);
    assert.match(await texte('etape-service'), /^(Démarrage du service du module…|Attente du service du module : \d+,\d s, \d+ essais…)$/);
    await onglet.touche('ArrowUp', 38);
    await waitFor(() => visible('reglage'));
    await onglet.toucheTV(10009);
    await waitFor(() => visible('attente'));
    const retard = loadService({ tizen: fakeTizen(APPS), config: { port: portRetard, extraOrigins: [origine()] } });
    autres.push(retard);
    await waitFor(async () => !!(await lire("!!document.getElementById('test-ecran')")), { timeout: 10000 });
    assert.ok(retard.state.page.first.tries >= 2, 'essais : ' + retard.state.page.first.tries);
    assert.ok(retard.state.page.first.waitedMs >= 1000, 'attente : ' + retard.state.page.first.waitedMs);
  });

  it('affiche la raison quand le service refuse la page, sans insister', async () => {
    const portStrict = await freePort();
    const strict = loadService({ tizen: fakeTizen(APPS), config: { port: portStrict } });
    autres.push(strict);
    await waitFor(() => strict.state.listening);
    await poserAdresse(origine() + '/ecran-test/');
    await onglet.aller(urlPage(portStrict));
    await waitFor(() => visible('erreur'));
    assert.match(await texte('erreur-texte'), /^Origine refusée \(http:\/\/127\.0\.0\.1:\d+\)\. Relance le module/);
    await sleep(2500);
    assert.equal(strict.state.requests.session, 1);
  });

  it("prévient quand le service en mémoire n'est pas de la même version", async () => {
    const portAncien = await freePort();
    autres.push(await fauxService(portAncien, { module: 'ecran-accueil', version: '9.9.9', token: 'x' }));
    await poserAdresse(origine() + '/ecran-test/');
    await onglet.aller(urlPage(portAncien));
    await waitFor(() => visible('avis'), { timeout: 10000 });
    assert.equal(await texte('avis'), 'Service du module en version 9.9.9, page en 0.1.0 : redémarre la TV pour finir la mise à jour.');
  });

  it("refuse le service d'un autre module installé sur le même port", async () => {
    const portAutre = await freePort();
    autres.push(await fauxService(portAutre, { module: 'diagnostic-applis-tv', version: '0.1.1', token: 'x' }));
    await poserAdresse(origine() + '/ecran-test/');
    await onglet.aller(urlPage(portAutre));
    await waitFor(() => visible('erreur'));
    assert.match(await texte('erreur-texte'), /répond pour un autre module \(diagnostic-applis-tv\)\. Redémarre la TV/);
  });

  it("ne lève aucune erreur JavaScript, hormis la page de repli chargée exprès comme script", () => {
    const erreurs = onglet.erreursJs().filter((e) => !(e.params.exceptionDetails && /\/spa\/ecran\.js/.test(e.params.exceptionDetails.url || '')));
    assert.deepEqual(erreurs, []);
  });
});
