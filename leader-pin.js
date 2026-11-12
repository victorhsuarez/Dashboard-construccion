'use strict';
// Crea o cambia el PIN de un lider y guarda SOLO su huella (sal + PBKDF2) en lideres-pin.json.
//   node leader-pin.js SUAREZ            -> genera un PIN aleatorio y lo muestra una sola vez
//   node leader-pin.js PEREZ MiPin#2026  -> usa el PIN indicado (minimo 8 caracteres)
// Despues: node build-static.js, commit y push de lideres-pin.json y docs/.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE  = path.join(__dirname, 'lideres-pin.json');
const KEYS  = ['PEREZ', 'SUAREZ', 'VARON'];
const ITER  = 600000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const key = (process.argv[2] || '').toUpperCase();
if (KEYS.indexOf(key) < 0) { console.error('Uso: node leader-pin.js ' + KEYS.join('|') + ' [PIN]'); process.exit(1); }

let pin = process.argv[3];
let generated = false;
if (!pin) {
  generated = true;
  pin = Array.from(crypto.randomBytes(10), b => ALPHA[b % ALPHA.length]).join('');
}
if (pin.length < 8) { console.error('El PIN debe tener al menos 8 caracteres.'); process.exit(1); }

const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(pin, salt, ITER, 32, 'sha256');
const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
db[key] = { s: salt.toString('base64'), h: hash.toString('base64'), i: ITER };
fs.writeFileSync(FILE, JSON.stringify(db, null, 2) + '\n');

console.log('PIN de ' + key + ' guardado en lideres-pin.json (solo la huella).');
if (generated) console.log('PIN (se muestra una sola vez): ' + pin);
