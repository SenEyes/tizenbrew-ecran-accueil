'use strict';

// Garde-fous pour la TV de 2020 : Node ancien côté service, Chrome 69 côté page.

// Retire commentaires et chaînes pour ne chercher que dans le code.
function codeSeul(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\/[^\n]*/g, ' ');
}

const ES5_INTERDIT = [
  [/=>/, 'fonction fléchée'],
  [/\blet\s/, 'let'],
  [/\bconst\s/, 'const'],
  [/`/, 'gabarit de chaîne'],
  [/\bclass\s+[A-Za-z_$]/, 'class'],
  [/\.\.\.[A-Za-z_$[(]/, 'décomposition ...'],
  [/\basync\s+function|\bawait\s/, 'async ou await'],
  [/\?\./, 'chaînage optionnel ?.'],
  [/\?\?/, 'coalescence ??'],
  [/\.includes\(/, 'includes, absent du Node 4.4.3'],
  [/Buffer\.(from|alloc)\(/, 'Buffer.from ou Buffer.alloc, absents du Node 4.4.3'],
  [/\.pad(Start|End)\(/, 'padStart ou padEnd'],
  [/Object\.(entries|values)\(/, 'Object.entries ou Object.values'],
  [/\bfor\s*\([^;)]*\bof\b/, 'for...of']
];

const CSS_INTERDIT = [
  [/(^|[^-])\bgap\s*:/, 'gap (absent en flexbox sur Chrome 69)'],
  [/aspect-ratio/, 'aspect-ratio (TV 2023 et après)'],
  [/backdrop-filter/, 'backdrop-filter (TV 2021 et après)'],
  [/\binset\s*:/, 'inset'],
  [/clamp\(/, 'clamp()'],
  [/:focus-visible|:is\(|:where\(/, 'sélecteurs récents']
];

function infractions(source, regles) {
  return regles.filter(([motif]) => motif.test(source)).map(([, libelle]) => libelle);
}

// Découpe une liste CSS sur ses virgules, sauf celles entre parenthèses (cubic-bezier).
function decouper(liste) {
  const morceaux = [];
  let profondeur = 0;
  let courant = '';
  for (const c of liste) {
    if (c === '(') profondeur += 1;
    if (c === ')') profondeur -= 1;
    if (c === ',' && profondeur === 0) {
      morceaux.push(courant);
      courant = '';
    } else {
      courant += c;
    }
  }
  morceaux.push(courant);
  return morceaux;
}

// Règle d'animation de l'étude (§ 2) : on n'anime que transform et opacity.
function transitionsHorsRegle(css) {
  const fautes = [];
  const sansCommentaires = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /(?:^|[;{\s])(?:-webkit-)?transition(-property)?\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(sansCommentaires))) {
    decouper(m[2]).forEach((morceau) => {
      const propriete = morceau.trim().split(/\s+/)[0];
      if (!['transform', '-webkit-transform', 'opacity', 'none'].includes(propriete)) fautes.push(propriete);
    });
  }
  if (/@keyframes/.test(sansCommentaires)) fautes.push('@keyframes (animation à vérifier à la main)');
  return fautes;
}

module.exports = { codeSeul, ES5_INTERDIT, CSS_INTERDIT, infractions, transitionsHorsRegle };
