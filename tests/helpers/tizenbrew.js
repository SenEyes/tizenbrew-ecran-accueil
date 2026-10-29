'use strict';

// Faux canal interne de TizenBrew (ws://127.0.0.1:8081 sur la TV) : un serveur WebSocket
// minimal, sans dépendance, qui répond à GetModules (4) et note LaunchModule (5).

const crypto = require('node:crypto');
const http = require('node:http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function trame(texte) {
  const data = Buffer.from(texte, 'utf8');
  let entete;
  if (data.length < 126) {
    entete = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    entete = Buffer.alloc(4);
    entete[0] = 0x81;
    entete[1] = 126;
    entete.writeUInt16BE(data.length, 2);
  } else {
    entete = Buffer.alloc(10);
    entete[0] = 0x81;
    entete[1] = 127;
    entete.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([entete, data]);
}

// `modules` : ce que GetModules renvoie ; `nulsAvant` : nombre de réponses null d'abord
// (TizenBrew répond null tant qu'il relit ses modules).
function fauxTizenBrew(port, { modules = [], nulsAvant = 0 } = {}) {
  const recus = [];
  const connexions = [];
  const sockets = [];
  let nuls = nulsAvant;
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    connexions.push({ origin: req.headers.origin || null });
    sockets.push(socket);
    let tampon = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (morceau) => {
      tampon = Buffer.concat([tampon, morceau]);
      while (tampon.length >= 2) {
        const opcode = tampon[0] & 0x0f;
        const masque = (tampon[1] & 0x80) !== 0;
        let longueur = tampon[1] & 0x7f;
        let decalage = 2;
        if (longueur === 126) {
          if (tampon.length < 4) return;
          longueur = tampon.readUInt16BE(2);
          decalage = 4;
        } else if (longueur === 127) {
          if (tampon.length < 10) return;
          longueur = Number(tampon.readBigUInt64BE(2));
          decalage = 10;
        }
        const debutMasque = decalage;
        if (masque) decalage += 4;
        if (tampon.length < decalage + longueur) return;
        let charge = tampon.subarray(decalage, decalage + longueur);
        if (masque) {
          const cle = tampon.subarray(debutMasque, debutMasque + 4);
          charge = Buffer.from(charge.map((octet, i) => octet ^ cle[i % 4]));
        }
        tampon = tampon.subarray(decalage + longueur);
        if (opcode === 8) {
          socket.end();
          return;
        }
        if (opcode !== 1) continue;
        let msg;
        try { msg = JSON.parse(charge.toString('utf8')); } catch { continue; }
        recus.push(msg);
        if (msg.type === 4) {
          if (nuls > 0) {
            nuls -= 1;
            socket.write(trame(JSON.stringify({ type: 4, payload: null })));
          } else {
            socket.write(trame(JSON.stringify({ type: 4, payload: modules })));
          }
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    recus,
    connexions,
    lancements: () => recus.filter((m) => m.type === 5).map((m) => m.payload),
    fermer: () => {
      sockets.forEach((socket) => socket.destroy());
      server.close();
    }
  })));
}

module.exports = { fauxTizenBrew };
