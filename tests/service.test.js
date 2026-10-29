'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { MODULE_PATH, loadService, fakeTizen, freePort, call, waitFor } = require('./helpers/harness');

const PAGE = 'http://127.0.0.1:8081' + MODULE_PATH;
const ORIGINE = 'http://127.0.0.1:8081';
const DEPUIS_LA_PAGE = { Origin: ORIGINE, Referer: PAGE };

const DOSSIER_ICONES = fs.mkdtempSync(path.join(os.tmpdir(), 'ecran-icones-'));
const ICONE = path.join(DOSSIER_ICONES, 'netflix.png');
fs.writeFileSync(ICONE, Buffer.from('89504e470d0a1a0a', 'hex'));

const APPS = [
  { id: 'org.tizen.netflix-app', name: 'Netflix', iconPath: ICONE },
  { id: 'AAAAAAAAAA.Emby', name: 'Emby', iconPath: path.join(DOSSIER_ICONES, 'absente.png') },
  { id: 'org.tizen.tv-viewer', name: 'tv-viewer', show: false },
  { id: 'CCCCCCCCCC.Panne', name: 'Appli en panne' },
  { id: 'DDDDDDDDDD.Muette', name: 'Appli muette' },
  { id: 'EEEEEEEEEE.Ailleurs', name: 'Icône hors des dossiers permis', iconPath: '/etc/passwd.png' }
];

function nomDePage(nom) {
  return 'http://127.0.0.1:8081/module/' + encodeURIComponent(nom) + '/app/index.html';
}

describe('service du module', () => {
  let port;
  let svc;
  let tz;
  let jeton;

  before(async () => {
    port = await freePort();
    tz = fakeTizen(APPS, { launchFails: ['CCCCCCCCCC.Panne'], launchSilent: ['DDDDDDDDDD.Muette'] });
    svc = loadService({ tizen: tz, config: { port, iconRoots: [DOSSIER_ICONES + path.sep], launchTimeout: 300 } });
    await waitFor(() => svc.state.listening);
  });

  after(() => {
    svc.stop();
    fs.rmSync(DOSSIER_ICONES, { recursive: true, force: true });
  });

  it("n'écoute que sur la TV elle-même", () => {
    assert.equal(svc.server.address().address, '127.0.0.1');
    assert.equal(svc.isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(svc.isLoopback('192.168.1.20'), false);
  });

  it('donne le jeton à la page du module et note sa visite', async () => {
    const res = await call(port, 'GET', '/session?nav=' + (Date.now() - 900) + '&ready=' + (Date.now() - 100) + '&tries=3&waited=2100', { headers: DEPUIS_LA_PAGE });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], ORIGINE);
    assert.equal(res.json.module, 'ecran-accueil');
    assert.equal(res.json.version, svc.version);
    assert.equal(res.json.platform, '5.5');
    assert.match(res.json.token, /^[0-9a-f]{32}$/);
    jeton = res.json.token;
    assert.equal(svc.state.page.visits, 1);
    assert.equal(svc.state.page.first.tries, 3);
    assert.equal(svc.state.page.first.waitedMs, 2100);
  });

  it("refuse une autre origine, de façon lisible, et le note", async () => {
    const res = await call(port, 'GET', '/session', { headers: { Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/tv' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.youtube.com');
    assert.equal(res.json.error, 'Origine refusée (https://www.youtube.com).');
    assert.equal(res.json.token, undefined);
    const dernier = svc.state.requests.refused[svc.state.requests.refused.length - 1];
    assert.equal(dernier.origin, 'https://www.youtube.com');
    assert.equal(dernier.path, '/session');
  });

  it("refuse la page d'un autre module TizenBrew, même servie par TizenBrew", async () => {
    const autres = [
      nomDePage('gh/quelquun/autre-module@1.0.0'),
      nomDePage('gh/quelquun/tizenbrew-ecran-accueil-copie@1.0.0'),
      nomDePage('gh/quelquun/depot/tizenbrew-ecran-accueil'),
      nomDePage('npm/@a/b/tizenbrew-ecran-accueil'),
      'http://127.0.0.1:8081/tizenbrew-ui/dist/index.html',
      'http://127.0.0.1:9999' + MODULE_PATH
    ];
    for (const referer of autres) {
      const res = await call(port, 'GET', '/session', { headers: { Origin: ORIGINE, Referer: referer } });
      assert.equal(res.status, 403, referer);
      assert.match(res.json.error, /^Page refusée/, referer);
    }
    const sansReferer = await call(port, 'GET', '/session', { headers: { Origin: ORIGINE } });
    assert.equal(sansReferer.status, 403);
  });

  it('reconnaît la page du module, quel que soit le compte ou la version', () => {
    assert.equal(svc.isModulePage(nomDePage('gh/autre-compte/tizenbrew-ecran-accueil')), true);
    assert.equal(svc.isModulePage(nomDePage('gh/autre-compte/tizenbrew-ecran-accueil@abc1234')), true);
    assert.equal(svc.isModulePage(nomDePage('npm/tizenbrew-ecran-accueil@2.0.0')), true);
    assert.equal(svc.isModulePage(nomDePage('npm/@scope/tizenbrew-ecran-accueil')), true);
    assert.equal(svc.isModulePage('http://localhost:8081' + MODULE_PATH), true);
  });

  it('exige le jeton pour tout le reste', async () => {
    for (const [methode, chemin] of [['GET', '/applis'], ['GET', '/etat'], ['POST', '/lancer']]) {
      const sans = await call(port, methode, chemin, { headers: DEPUIS_LA_PAGE, body: methode === 'POST' ? { id: 'org.tizen.netflix-app' } : undefined });
      assert.equal(sans.status, 403, chemin);
      assert.equal(sans.json.error, 'Jeton absent ou faux.');
      const faux = await call(port, methode, chemin, { headers: Object.assign({ 'X-Ecran-Jeton': 'f'.repeat(32) }, DEPUIS_LA_PAGE), body: methode === 'POST' ? { id: 'org.tizen.netflix-app' } : undefined });
      assert.equal(faux.status, 403, chemin);
    }
    assert.deepEqual(tz.calls.launch, []);
  });

  it('répond au contrôle préalable du navigateur', async () => {
    const res = await call(port, 'OPTIONS', '/lancer', { headers: { Origin: ORIGINE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-ecran-jeton' } });
    assert.equal(res.status, 204);
    assert.match(res.headers['access-control-allow-headers'], /X-Ecran-Jeton/);
  });

  it('liste les applis sans toucher au champ protégé size', async () => {
    const res = await call(port, 'GET', '/applis', { headers: Object.assign({ 'X-Ecran-Jeton': jeton }, DEPUIS_LA_PAGE) });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, APPS.length);
    assert.equal(res.json.visible, APPS.length - 1);
    const netflix = res.json.list.find((a) => a.id === 'org.tizen.netflix-app');
    assert.deepEqual(netflix, { id: 'org.tizen.netflix-app', name: 'Netflix', show: true, icon: true });
    assert.equal(res.json.list.find((a) => a.id === 'EEEEEEEEEE.Ailleurs').icon, false);
    assert.equal(tz.calls.sizeTouched, false);
  });

  it("lance une appli présente, même cachée des menus, et refuse les autres", async () => {
    const entetes = Object.assign({ 'X-Ecran-Jeton': jeton }, DEPUIS_LA_PAGE);
    const ok = await call(port, 'POST', '/lancer', { headers: entetes, body: { id: 'org.tizen.tv-viewer' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    const absente = await call(port, 'POST', '/lancer', { headers: entetes, body: { id: 'com.exemple.absente' } });
    assert.equal(absente.status, 404);
    assert.equal(absente.json.error, 'Appli absente de cette TV (com.exemple.absente).');
    const panne = await call(port, 'POST', '/lancer', { headers: entetes, body: { id: 'CCCCCCCCCC.Panne' } });
    assert.equal(panne.json.ok, false);
    assert.equal(panne.json.error, 'NotFoundError : Application not found');
    const muette = await call(port, 'POST', '/lancer', { headers: entetes, body: { id: 'DDDDDDDDDD.Muette' } });
    assert.equal(muette.json.ok, false);
    assert.match(muette.json.error, /^Pas de réponse de la TV/);
    const malFormee = await call(port, 'POST', '/lancer', { headers: entetes, body: '{"id":' });
    assert.equal(malFormee.status, 400);
    assert.deepEqual(tz.calls.launch, ['org.tizen.tv-viewer', 'CCCCCCCCCC.Panne', 'DDDDDDDDDD.Muette']);
  });

  it("sert l'icône d'une appli de la liste, et rien hors des dossiers permis", async () => {
    const icone = await call(port, 'GET', '/icone?id=org.tizen.netflix-app');
    assert.equal(icone.status, 200);
    assert.equal(icone.headers['content-type'], 'image/png');
    assert.equal(icone.raw.toString('hex'), '89504e470d0a1a0a');
    assert.equal((await call(port, 'GET', '/icone?id=EEEEEEEEEE.Ailleurs')).status, 404);
    assert.equal((await call(port, 'GET', '/icone?id=inconnue')).status, 404);
    assert.equal((await call(port, 'GET', '/icone?id=AAAAAAAAAA.Emby')).status, 404);
    assert.equal(svc.state.icons.served, 1);
    assert.equal(svc.state.icons.failed, 1);
    assert.match(svc.state.icons.lastError, /^ENOENT \(AAAAAAAAAA\.Emby\)$/);
  });

  it("donne son état et le journal des lancements, sans le jeton", async () => {
    const res = await call(port, 'GET', '/etat', { headers: Object.assign({ 'X-Ecran-Jeton': jeton }, DEPUIS_LA_PAGE) });
    assert.equal(res.status, 200);
    assert.equal(res.json.module, 'ecran-accueil');
    assert.equal(res.json.apps.count, APPS.length);
    assert.equal(res.json.apps.list, undefined);
    assert.deepEqual(res.json.launches.map((l) => [l.id, l.ok]), [
      ['org.tizen.tv-viewer', true], ['com.exemple.absente', false], ['CCCCCCCCCC.Panne', false], ['DDDDDDDDDD.Muette', false]
    ]);
    assert.equal(res.json.launches[1].error, 'Appli absente de cette TV (com.exemple.absente).');
    assert.ok(res.json.requests.refused.length >= 7);
    assert.equal(res.text.includes(jeton), false);
  });

  it("signale un port déjà pris au lieu de planter", async () => {
    const occupe = http.createServer();
    const portPris = await freePort();
    await new Promise((resolve) => occupe.listen(portPris, '127.0.0.1', resolve));
    const second = loadService({ tizen: fakeTizen(APPS), config: { port: portPris } });
    try {
      await waitFor(() => second.state.error);
      assert.equal(second.state.error, 'EADDRINUSE');
      assert.equal(second.state.listening, false);
    } finally {
      second.stop();
      occupe.close();
    }
  });

  it("rapporte l'erreur de la TV quand la liste des applis est refusée", async () => {
    const autrePort = await freePort();
    const autre = loadService({ tizen: fakeTizen(APPS, { appsError: 'Lecture impossible' }), config: { port: autrePort } });
    try {
      await waitFor(() => autre.state.listening);
      const session = await call(autrePort, 'GET', '/session', { headers: DEPUIS_LA_PAGE });
      const res = await call(autrePort, 'GET', '/applis', { headers: Object.assign({ 'X-Ecran-Jeton': session.json.token }, DEPUIS_LA_PAGE) });
      assert.equal(res.json.error, 'UnknownError : Lecture impossible');
      assert.equal(res.json.count, 0);
    } finally {
      autre.stop();
    }
  });

  it('fonctionne sans objet tizen, en le disant', async () => {
    const autrePort = await freePort();
    const autre = loadService({ tizen: null, config: { port: autrePort } });
    try {
      await waitFor(() => autre.state.listening);
      assert.equal(autre.state.apps.error, "L'objet tizen est absent de ce service.");
    } finally {
      autre.stop();
    }
  });
});
