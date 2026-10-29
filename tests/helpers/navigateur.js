'use strict';

// Edge ou Chrome sans fenêtre, piloté par le protocole DevTools (WebSocket natif de Node 22+).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { waitFor } = require('./harness');

const CANDIDATS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const cheminNavigateur = process.env.ECRAN_NAVIGATEUR || CANDIDATS.find((p) => fs.existsSync(p));

function demarrerNavigateur() {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'ecran-navigateur-'));
  const child = spawn(cheminNavigateur, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profil,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--window-size=1920,1080', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let sortie = '';
    const minuterie = setTimeout(() => reject(new Error('Le navigateur ne donne pas son adresse DevTools.')), 20000);
    child.stderr.on('data', (chunk) => {
      sortie += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(sortie);
      if (m) {
        clearTimeout(minuterie);
        resolve({ child, profil, port: Number(new URL(m[1]).port) });
      }
    });
    child.on('exit', (code) => reject(new Error('Navigateur arrêté (code ' + code + ').')));
  });
}

function arreterNavigateur(navigateur) {
  if (!navigateur) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(navigateur.child.pid), '/T', '/F'], { stdio: 'ignore' });
    else navigateur.child.kill('SIGKILL');
  } catch {
    // déjà arrêté
  }
  fs.rmSync(navigateur.profil, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function connecter(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const enAttente = new Map();
    const evenements = [];
    let dernierId = 0;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && enAttente.has(msg.id)) {
        const attente = enAttente.get(msg.id);
        enAttente.delete(msg.id);
        if (msg.error) attente.reject(new Error(msg.error.message));
        else attente.resolve(msg.result);
      } else {
        evenements.push(msg);
      }
    });
    ws.addEventListener('error', () => reject(new Error('Connexion DevTools impossible.')));
    ws.addEventListener('open', () => resolve({
      evenements,
      send(method, params = {}) {
        dernierId += 1;
        const id = dernierId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => enAttente.set(id, { resolve: res, reject: rej }));
      },
      close() { ws.close(); }
    }));
  });
}

// Ouvre un onglet en 1920 × 1080 et rend des raccourcis pour le piloter.
async function ouvrirOnglet(navigateur) {
  const cibles = await (await fetch('http://127.0.0.1:' + navigateur.port + '/json/list')).json();
  const page = await connecter(cibles.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  async function evaluer(expression) {
    const resultat = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (resultat.exceptionDetails) throw new Error('Évaluation : ' + JSON.stringify(resultat.exceptionDetails.exception || resultat.exceptionDetails.text));
    return resultat.result.value;
  }

  async function touche(key, keyCode, fois = 1, { maintenue = 0 } = {}) {
    for (let i = 0; i < fois; i += 1) {
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      if (maintenue) {
        // Une touche tenue répète l'appui, comme la télécommande.
        const fin = Date.now() + maintenue;
        while (Date.now() < fin) {
          await new Promise((r) => setTimeout(r, 100));
          await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, autoRepeat: true });
        }
      }
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    }
  }

  // Touches de la télécommande Samsung absentes d'un clavier (Retour = 10009).
  async function toucheTV(keyCode) {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Unidentified', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Unidentified', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }

  async function aller(url, { avantChargement } = {}) {
    if (avantChargement) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: avantChargement });
    await page.send('Page.navigate', { url });
  }

  async function texte(selecteur) {
    return evaluer('(function () { var e = document.querySelector(' + JSON.stringify(selecteur) + '); return e ? e.textContent : null; })()');
  }

  async function visible(selecteur) {
    return evaluer('(function () { var e = document.querySelector(' + JSON.stringify(selecteur) + '); if (!e) return false; var s = getComputedStyle(e); return s.display !== "none" && s.visibility !== "hidden" && e.offsetParent !== null; })()');
  }

  async function capture(fichier) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(fichier, Buffer.from(data, 'base64'));
  }

  function erreursJs() {
    return page.evenements.filter((e) => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
  }

  return {
    page, evaluer, touche, toucheTV, aller, texte, visible, capture, erreursJs,
    attendre: (verif, options) => waitFor(verif, options),
    fermer: () => page.close()
  };
}

module.exports = { cheminNavigateur, demarrerNavigateur, arreterNavigateur, ouvrirOnglet };
