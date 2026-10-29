# Écran d'accueil (module TizenBrew)

Module pour TV Samsung (Tizen) avec [TizenBrew](https://github.com/reisxd/TizenBrew). Il ne contient pas d'écran : il **charge un écran d'accueil hébergé sur ton réseau local** (un NAS, un Raspberry Pi, un PC) et lui donne de quoi **lancer les applis de la TV** et **ouvrir les modules TizenBrew** (TizenTube par exemple). L'écran se modifie sur ton serveur, sans republier le module.

## Comment ça marche

- **La page** (`app/index.html`), servie par TizenBrew, demande une fois l'adresse de l'écran (gardée sur la TV), puis charge le fichier `ecran.js` de cette adresse. L'écran tourne dans la page du module.
- **Le service** (`service/service.js`) fait ce que la page ne peut pas faire : la page d'un module TizenBrew n'a pas accès à l'API `tizen`, le service, lui, la reçoit de TizenBrew. Il appelle `tizen.application.getAppsInfo()` et `tizen.application.launch()`, et sert les icônes des applis.
- **Les modules TizenBrew** s'ouvrent comme depuis le menu de TizenBrew : message « LaunchModule » sur son canal local (`ws://127.0.0.1:8081`), puis la page part vers l'adresse du module.

## Sécurité

- Le service écoute sur **127.0.0.1:8097** : rien n'est joignable depuis le réseau.
- Il n'obéit qu'à la page de ce module : origine de TizenBrew (`http://127.0.0.1:8081`) **et** page servie par TizenBrew sous le nom `tizenbrew-ecran-accueil` (en-tête Referer). Il remet alors un jeton tiré au hasard à chaque démarrage, exigé pour tout le reste.
- Il ne lance qu'une appli **présente sur la TV** (liste de `getAppsInfo`). Un refus est noté dans son état et sa raison s'affiche sur la page.
- La page n'accepte qu'une adresse d'écran **du réseau local** (10.x, 172.16 à 31.x, 192.168.x, noms en `.local`, `.lan`, `.home`, `.internal`, `.home.arpa`, ou nom court).
- Le module n'écrit rien sur la TV, sauf l'adresse de l'écran (stockage local de la page). Il n'utilise ni l'API REST de la TV, ni sa télécommande virtuelle.
- `keys` du `package.json` : les touches médias. TizenBrew les enregistre en ouvrant le module (la page ne peut pas le faire), et un module ouvert depuis l'écran, comme TizenTube, les reçoit ainsi.

## Écrire un écran

Le serveur sert un dossier qui contient au moins `ecran.js`, appelé avec un paramètre anti-cache (`ecran.js?v=…`) : une copie sur le serveur compte dès le lancement suivant. Pas besoin de CORS : la page charge l'écran par une balise `<script>`.

```js
Chargeur.declarer({
  nom: 'Mon écran',
  version: '1',
  demarrer: function (api) {
    // dessiner dans api.racine (1920 × 1080), puis :
    api.pret();
  }
});
```

| `api.` | Rôle |
|---|---|
| `racine` | Élément où dessiner, en 1920 × 1080 (mis à l'échelle de la TV) |
| `adresse`, `fichier(chemin)` | Adresse de l'écran ; adresse d'un de ses fichiers, sans cache |
| `session`, `depart` | Infos du service (version, Tizen, modèle) ; heures de démarrage (`navigation`, `page`, `service`, `ecran`, `pret`) |
| `applis(recharger, fini)` | Liste des applis de la TV : `fini(erreur, { count, visible, ms, list: [{ id, name, show, icon }] })` |
| `lancer(id, fini)` | Lance une appli de la TV : `fini(erreur, { ok, ms })` |
| `icone(id)` | Adresse de l'icône d'une appli, pour une balise `<img>` |
| `etat(fini)` | État du service : versions, délais, derniers lancements, refus |
| `modules(fini)`, `ouvrirModule(nom, fini)` | Modules de TizenBrew ; en ouvrir un par son nom complet (`npm/@foxreis/tizentube`), son nom ou son nom affiché |
| `pret()` | L'écran est affiché : le chargeur s'efface |
| `avis(texte)`, `erreur(texte)` | Message passager ; écran d'erreur du chargeur |
| `changerAdresse()`, `recharger()`, `retour()` | Saisir une autre adresse ; relancer ; revenir à TizenBrew |

Tant que l'écran n'a pas appelé `pret()`, le chargeur garde la télécommande. Ensuite, l'écran gère ses touches (flèches 37 à 40, OK 13, Retour 10009).

## Installation

1. TizenBrew doit déjà fonctionner (Host PC IP du mode développeur = `127.0.0.1`).
2. Dans TizenBrew, gestionnaire de modules, « Ajouter un Module GitHub », saisir `<compte>/tizenbrew-ecran-accueil@<version>`. La `@<version>` fige ce que sert jsDelivr.
3. Ouvrir « Écran d'accueil », saisir l'adresse de l'écran (par exemple `192.168.1.20:8080/ecran`), puis « Essayer et enregistrer ».
4. Pour l'ouvrir au démarrage de TizenBrew : réglages de TizenBrew, « Paramètres AutoLaunch », choisir ce module. Flèche Haut pendant le démarrage de TizenBrew : AutoLaunch annulé pour cette fois.

Sur l'écran d'attente du module, Haut ouvre la saisie de l'adresse et Retour revient à TizenBrew.

## Désinstallation

Gestionnaire de modules de TizenBrew, carte « Écran d'accueil », OK, puis confirmer. Redémarrer ensuite la TV : le service continue de tourner jusque-là.

## Tests

```bash
npm test
```

Node 22 ou plus récent. Les tests chargent le service exactement comme TizenBrew (bac à sable `vm`, `require`, `tizen` et `module` fournis), avec une fausse API `tizen` et un faux canal TizenBrew. La page est testée dans Edge ou Chrome sans fenêtre (chemin forçable par la variable `ECRAN_NAVIGATEUR`) ; ce test est sauté si aucun n'est trouvé.
