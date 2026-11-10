'use strict';
// Genera docs/ (sitio estatico, solo lectura) a partir de fuente/ y una foto de los tableros de Monday.
//   Uso:  $env:ENV_PASSPHRASE='...'; node build-static.js
//   (o con MONDAY_API_TOKEN definido, o con un .env local)
// fuente/ contiene los HTML originales (con contrasenas y escritura) y NO se sube a git.
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.MONDAY_API_TOKEN) {
  require('./envcrypt').loadEncryptedEnv(path.join(__dirname, '.env.enc'), process.env.ENV_PASSPHRASE);
}
const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) { console.error('Falta MONDAY_API_TOKEN (o ENV_PASSPHRASE para .env.enc).'); process.exit(1); }

const SRC = path.join(__dirname, 'fuente');
const OUT = path.join(__dirname, 'docs');
const BOARDS = { A: '18432741374', M: '18433232131', AUS: '18432588237' };

async function gql(query) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': '2024-01' },
    body: JSON.stringify({ query })
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error('Monday: ' + JSON.stringify(j.errors || r.status));
  return j.data;
}

const ITEM_FIELDS = 'id name group{id title} column_values{id text value}';

async function fetchBoard(id) {
  const meta = await gql('{boards(ids:[' + id + ']){columns{id title type}}}');
  const columns = meta.boards[0].columns;
  const fileCols = new Set(columns.filter(c => c.type === 'file').map(c => c.id));
  let page = (await gql('{boards(ids:[' + id + ']){items_page(limit:500){cursor items{' + ITEM_FIELDS + '}}}}')).boards[0].items_page;
  let items = page.items;
  while (page.cursor) {
    page = (await gql('{next_items_page(limit:500,cursor:"' + page.cursor + '"){cursor items{' + ITEM_FIELDS + '}}}')).next_items_page;
    items = items.concat(page.items);
  }
  // Los adjuntos no se publican: se vacian las columnas de tipo archivo.
  items.forEach(it => it.column_values.forEach(cv => { if (fileCols.has(cv.id)) { cv.text = ''; cv.value = null; } }));
  return { columns, items };
}

function rep(src, from, to, label) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('Reemplazo "' + label + '": se esperaba 1 coincidencia y hay ' + n);
  return src.replace(from, () => to);
}
function repRe(src, re, to, label) {
  if (!re.test(src)) throw new Error('Reemplazo "' + label + '": sin coincidencias');
  return src.replace(re, () => to);
}

// ---- Shim que responde las consultas de lectura con la foto y bloquea las escrituras
function shim(snap, stamp, toastErr) {
  const data = JSON.stringify(snap).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  return '<script>\n' +
    'var __SNAP=' + data + ';\n' +
    'var __STAMP=' + JSON.stringify(stamp) + ';\n' +
    'function __roToast(m){try{showToast(m' + toastErr + ');}catch(e){alert(m);}}\n' +
    'var __RO="Vista estatica de solo lectura: no se pueden guardar cambios.";\n' +
    'async function mq(query){\n' +
    '  query=String(query);\n' +
    '  if(/^\\s*mutation/i.test(query)) throw new Error(__RO);\n' +
    '  var m=query.match(/boards\\(ids:\\s*\\[?\\s*(\\d+)/); if(!m) throw new Error("Consulta no disponible en la vista estatica");\n' +
    '  var b=__SNAP[m[1]]; if(!b) throw new Error("Tablero no incluido en la foto");\n' +
    '  if(/columns\\s*\\{/.test(query)) return {boards:[{columns:b.columns}]};\n' +
    '  var lim=(query.match(/limit:\\s*(\\d+)/)||[])[1]; var items=b.items.slice(0,lim?+lim:b.items.length);\n' +
    '  var ids=(query.match(/column_values\\(ids:\\s*\\[([^\\]]*)\\]\\)/)||[])[1];\n' +
    '  if(ids){ids=ids.split(",").map(function(s){return s.trim().replace(/"/g,"");});\n' +
    '    items=items.map(function(it){return {id:it.id,name:it.name,group:it.group,column_values:it.column_values.filter(function(c){return ids.indexOf(c.id)>-1;})};});}\n' +
    '  return {boards:[{items_page:{cursor:null,items:items}}]};\n' +
    '}\n' +
    'async function mup(){ throw new Error(__RO); }\n' +
    'document.addEventListener("DOMContentLoaded",function(){\n' +
    '  var d=document.createElement("div");\n' +
    '  d.style.cssText="position:fixed;left:12px;bottom:12px;z-index:99999;background:#0f172a;color:#fff;padding:6px 12px;border-radius:999px;font:600 11px system-ui,sans-serif;opacity:.92;pointer-events:none";\n' +
    '  d.textContent="Vista estatica \\u00b7 solo lectura \\u00b7 datos al "+__STAMP; document.body.appendChild(d);\n' +
    '});\n' +
    '</script>\n';
}

function injectShim(html, shimHtml) {
  const m = html.match(/<body[^>]*>/);
  if (!m) throw new Error('No se encontro <body>');
  return html.replace(m[0], () => m[0] + '\n' + shimHtml);
}

function buildActualizaciones(html, snap, stamp) {
  html = rep(html, "const PROXY = 'http://localhost:3000';", "const PROXY = '#static';", 'PROXY');
  html = repRe(html, /const LIDER_PWDS=\{[^}]*\};/, 'const LIDER_PWDS={};', 'LIDER_PWDS');
  html = rep(html, 'async function mq(', 'async function __mq_live(', 'mq');
  html = rep(html, 'async function mup(', 'async function __mup_live(', 'mup');
  html = rep(html, 'function checkBackend(', 'function __checkBackend_live(', 'checkBackend');
  html = rep(html, 'function reqLiderPwd(', 'function __reqLiderPwd_live(', 'reqLiderPwd');
  html = rep(html, 'function reqModAuth(', 'function __reqModAuth_live(', 'reqModAuth');
  html = rep(html, 'function reqModPwd(', 'function __reqModPwd_live(', 'reqModPwd');
  html = rep(html, 'function promptModAuth(', 'function __promptModAuth_live(', 'promptModAuth');
  const extra =
    '<script>\n' +
    'function checkBackend(){var b=document.getElementById("backendBtn");if(b){b.textContent="Datos al "+__STAMP;b.classList.add("ok");}}\n' +
    'function reqLiderPwd(r){var v=r?r.value:"apr";\n' +
    '  if(v==="mis"){__roToast("\\"Mis HE\\" requiere sesion de lider y no esta disponible en la vista estatica.");\n' +
    '    var c=document.querySelector(\'input[name="otr"][value="col"]\');if(c)c.checked=true;setOTRole("col");return;}\n' +
    '  setOTRole("apr");}\n' +
    'function reqModAuth(){__roToast("Vista de solo lectura: el acceso de lider esta deshabilitado.");}\n' +
    'function reqModPwd(){__roToast(__RO);}\n' +
    'function promptModAuth(){__roToast(__RO);}\n' +
    '</script>\n';
  return injectShim(html, shim(snap, stamp, ",'err'") + extra);
}

function buildAusencias(html, snap, stamp) {
  html = repRe(html, /const APR_PASSWORD\s*=\s*'[^']*';/, "const APR_PASSWORD = '';", 'APR_PASSWORD');
  html = rep(html, 'async function mq(', 'async function __mq_live(', 'mq');
  html = rep(html, "'http://localhost:3000/api/monday/query'", "'#static'", 'url query');
  html = rep(html, "'http://localhost:3000/api/monday/upload'", "'#static'", 'url upload');
  html = rep(html, 'function reqAprPwd(', 'function __reqAprPwd_live(', 'reqAprPwd');
  html = rep(html, 'async function confirmAprPwd(', 'async function __confirmAprPwd_live(', 'confirmAprPwd');
  const extra =
    '<script>\n' +
    'function reqAprPwd(){__roToast(__RO);}\n' +
    'async function confirmAprPwd(){__roToast(__RO);}\n' +
    '</script>\n';
  return injectShim(html, shim(snap, stamp, ',false') + extra);
}

(async function main() {
  const read = f => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^\uFEFF/, '');
  const snap = {};
  for (const k of Object.keys(BOARDS)) {
    snap[BOARDS[k]] = await fetchBoard(BOARDS[k]);
    console.log('Tablero ' + BOARDS[k] + ': ' + snap[BOARDS[k]].items.length + ' items, ' + snap[BOARDS[k]].columns.length + ' columnas');
  }
  const stamp = new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

  const act = buildActualizaciones(read('dashboard_actualizaciones.html'), { [BOARDS.A]: snap[BOARDS.A], [BOARDS.M]: snap[BOARDS.M] }, stamp);
  const aus = buildAusencias(read('dashboard_ausencias.html'), { [BOARDS.AUS]: snap[BOARDS.AUS] }, stamp);
  const portal = read('index_v2.html');

  // Contrasenas del codigo fuente (se leen en ejecucion, no se guardan en este script)
  const secrets = [];
  const lp = read('dashboard_actualizaciones.html').match(/const LIDER_PWDS=\{([^}]*)\}/);
  if (lp) (lp[1].match(/'[^']+'/g) || []).forEach(s => secrets.push(s.slice(1, -1)));
  const ap = read('dashboard_ausencias.html').match(/const APR_PASSWORD\s*=\s*'([^']*)'/);
  if (ap && ap[1]) secrets.push(ap[1]);
  if (!secrets.length) throw new Error('No se encontraron contrasenas en fuente/ para verificar');

  // Verificaciones: nada de contrasenas ni del proxy local en lo publicado
  [['dashboard_actualizaciones.html', act], ['dashboard_ausencias.html', aus], ['index.html', portal]].forEach(([n, h]) => {
    if (/localhost:3000|onrender\.com|MONDAY_API_TOKEN/.test(h)) throw new Error('Contenido sensible en ' + n);
    secrets.forEach(s => { if (h.includes(s)) throw new Error('Una contrasena aparece en ' + n); });
    if (h.includes(TOKEN)) throw new Error('El token aparece en ' + n);
  });

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'dashboard_actualizaciones.html'), act);
  fs.writeFileSync(path.join(OUT, 'dashboard_ausencias.html'), aus);
  fs.writeFileSync(path.join(OUT, 'index.html'), portal);
  fs.writeFileSync(path.join(OUT, 'index_v2.html'), portal);
  fs.copyFileSync(path.join(SRC, 'favicon.ico'), path.join(OUT, 'favicon.ico'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log('OK: docs/ generado (datos al ' + stamp + ')');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
