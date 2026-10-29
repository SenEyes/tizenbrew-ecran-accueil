// Écran minimal pour les tests du chargeur : il expose l'api reçue et note les touches.
(function () {
  'use strict';
  Chargeur.declarer({
    nom: 'Écran de test',
    version: 'test',
    demarrer: function (api) {
      window.testApi = api;
      window.testTouches = [];
      var bloc = document.createElement('div');
      bloc.id = 'test-ecran';
      bloc.textContent = 'Écran de test chargé depuis ' + api.adresse;
      api.racine.appendChild(bloc);
      document.addEventListener('keydown', function (e) { window.testTouches.push(e.keyCode); });
      api.pret();
    }
  });
})();
