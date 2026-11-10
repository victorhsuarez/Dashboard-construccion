'use strict';
// Uso:
//   node env-crypt.js encrypt   -> lee .env y genera .env.enc
//   node env-crypt.js decrypt   -> lee .env.enc y regenera .env (local)
// La passphrase se pide por consola (sin eco) o se toma de ENV_PASSPHRASE.
const fs   = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./envcrypt');

const ENV_FILE = path.join(__dirname, '.env');
const ENC_FILE = path.join(__dirname, '.env.enc');

function ask(prompt) {
  return new Promise(function (resolve) {
    if (process.env.ENV_PASSPHRASE) return resolve(process.env.ENV_PASSPHRASE);
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (s) { if (s.includes(prompt)) rl.output.write(s); };
    rl.question(prompt, function (a) { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async function main() {
  const cmd = process.argv[2];
  if (cmd !== 'encrypt' && cmd !== 'decrypt') { console.error('Uso: node env-crypt.js encrypt|decrypt'); process.exit(1); }

  const pass = await ask('Passphrase: ');
  if (!pass || pass.length < 12) { console.error('La passphrase debe tener al menos 12 caracteres.'); process.exit(1); }

  try {
    if (cmd === 'encrypt') {
      if (!fs.existsSync(ENV_FILE)) { console.error('No existe .env (copia .env.example y pon tu token).'); process.exit(1); }
      const text = fs.readFileSync(ENV_FILE, 'utf8');
      if (/your_monday_api_token_here/.test(text)) { console.error('.env aun tiene el valor de ejemplo. Pon el token real.'); process.exit(1); }
      fs.writeFileSync(ENC_FILE, encrypt(text, pass));
      console.log('OK: .env.enc generado. Puedes subirlo a git; .env NO.');
    } else {
      fs.writeFileSync(ENV_FILE, decrypt(fs.readFileSync(ENC_FILE, 'utf8'), pass));
      console.log('OK: .env regenerado desde .env.enc.');
    }
  } catch (e) {
    console.error('Error: passphrase incorrecta o archivo corrupto.');
    process.exit(1);
  }
})();
