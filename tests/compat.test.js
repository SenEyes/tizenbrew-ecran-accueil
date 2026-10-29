'use strict';

// Garde-fous pour la TV : Node ancien côté service, Chrome 69 côté page.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers/harness');
const { codeSeul, ES5_INTERDIT, CSS_INTERDIT, infractions, transitionsHorsRegle } = require('./helpers/compat');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const service = fs.readFileSync(path.join(ROOT, 'service', 'service.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const scriptPage = /<script>([\s\S]*)<\/script>/.exec(html)[1];
const stylePage = /<style>([\s\S]*)<\/style>/.exec(html)[1];

describe('compatibilité avec la TV de 2020', () => {
  it('le service reste en ES5', () => {
    assert.deepEqual(infractions(codeSeul(service), ES5_INTERDIT), []);
  });

  it('le script de la page reste en ES5', () => {
    assert.deepEqual(infractions(codeSeul(scriptPage), ES5_INTERDIT), []);
  });

  it('les deux scripts se compilent', () => {
    assert.doesNotThrow(() => new vm.Script(service));
    assert.doesNotThrow(() => new vm.Script(scriptPage));
  });

  it('le style évite les propriétés absentes de Chrome 69 et n\'anime que transform et opacity', () => {
    assert.deepEqual(infractions(stylePage.replace(/\/\*[\s\S]*?\*\//g, ' '), CSS_INTERDIT), []);
    assert.deepEqual(transitionsHorsRegle(stylePage), []);
  });

  it('la page ne charge rien depuis Internet', () => {
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/);
  });
});

describe('manifeste TizenBrew', () => {
  it('décrit un module « app » avec page et service présents', () => {
    assert.equal(pkg.packageType, 'app');
    assert.equal(pkg.name, 'tizenbrew-ecran-accueil');
    assert.ok(pkg.appName);
    assert.ok(fs.existsSync(path.join(ROOT, pkg.appPath)), pkg.appPath);
    assert.ok(fs.existsSync(path.join(ROOT, pkg.serviceFile)), pkg.serviceFile);
  });

  it('enregistre les touches médias, pour les modules ouverts depuis l\'écran', () => {
    assert.deepEqual(pkg.keys, ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious']);
  });

  it('page, service et manifeste portent la même version', () => {
    const version = pkg.version.replace(/\./g, '\\.');
    assert.match(service, new RegExp("var VERSION = '" + version + "';"));
    assert.match(scriptPage, new RegExp("var VERSION = '" + version + "';"));
  });

  it('le service reconnaît le nom du dépôt déclaré dans le manifeste', () => {
    assert.match(service, new RegExp("var DEPOT = '" + pkg.name + "';"));
  });
});
