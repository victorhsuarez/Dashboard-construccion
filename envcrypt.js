'use strict';
// Cifrado de archivos .env: AES-256-GCM con clave derivada por scrypt desde una passphrase.
const crypto = require('crypto');
const fs     = require('fs');

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv   = crypto.randomBytes(12);
  const c    = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return JSON.stringify({
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }, null, 2);
}

function decrypt(payload, passphrase) {
  const p = JSON.parse(payload);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(p.salt, 'base64')), Buffer.from(p.iv, 'base64'));
  d.setAuthTag(Buffer.from(p.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(p.data, 'base64')), d.final()]).toString('utf8');
}

function parseEnv(text) {
  const out = {};
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
  return out;
}

// Carga .env.enc en process.env (sin pisar variables ya definidas). Devuelve true si cargó algo.
function loadEncryptedEnv(file, passphrase) {
  if (!passphrase || !fs.existsSync(file)) return false;
  const vars = parseEnv(decrypt(fs.readFileSync(file, 'utf8'), passphrase));
  Object.keys(vars).forEach(function (k) { if (process.env[k] === undefined) process.env[k] = vars[k]; });
  return true;
}

module.exports = { encrypt, decrypt, parseEnv, loadEncryptedEnv };
