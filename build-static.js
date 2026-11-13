'use strict';
// Genera docs/ (sitio estatico, solo lectura) a partir de fuente/ y una foto de los tableros de Monday.
//   Uso:  $env:ENV_PASSPHRASE='...'; node build-static.js
//   (o con MONDAY_API_TOKEN definido, o con un .env local)
// fuente/ contiene los HTML originales (con contrasenas y escritura) y NO se sube a git.
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// --reusar-foto: no consulta Monday; reutiliza la foto ya incrustada en docs/ (no necesita token).
const REUSE = process.argv.includes('--reusar-foto');
if (!REUSE && !process.env.MONDAY_API_TOKEN) {
  require('./envcrypt').loadEncryptedEnv(path.join(__dirname, '.env.enc'), process.env.ENV_PASSPHRASE);
}
const TOKEN = process.env.MONDAY_API_TOKEN;
if (!REUSE && !TOKEN) { console.error('Falta MONDAY_API_TOKEN (o ENV_PASSPHRASE para .env.enc).'); process.exit(1); }

// URL del puente (Cloudflare Worker) para ADCAR sin cuenta en Monday. Se lee de puente.json {"url":"https://..."}; si no existe, el puente queda desactivado.
let BRIDGE_URL = '';
try {
  BRIDGE_URL = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'puente.json'), 'utf8')).url || '').trim().replace(/\/+$/, '');
} catch (e) { BRIDGE_URL = ''; }
if (BRIDGE_URL && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~-]*)*$/.test(BRIDGE_URL)) { console.error('puente.json: la URL debe ser https:// sin parametros.'); process.exit(1); }

const SRC = path.join(__dirname, 'fuente');
const OUT = path.join(__dirname, 'docs');
const BOARDS = { A: '18432741374', M: '18433232131', AUS: '18432588237' };
// Lideres autorizados (correo en minusculas -> clave). Solo ellos acceden a Aprobador, edicion de Modalidad y aprobacion.
const LEADER_EMAILS = { 'victor.h.suarez@ibm.com': 'SUAREZ', 'jesus.perez1@ibm.com': 'PEREZ', 'angie.varon@ibm.com': 'VARON' };
// Cada lider tiene su propio PIN (huella en lideres-pin.json, creada con leader-pin.js). Si falta, el build se detiene.
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'lideres-pin.json'), 'utf8'));
const LEADERS = {};
Object.keys(LEADER_EMAILS).forEach(email => {
  const k = LEADER_EMAILS[email];
  if (!PINS[k]) { console.error('Falta el PIN de ' + k + '. Ejecuta: node leader-pin.js ' + k); process.exit(1); }
  LEADERS[email] = { k: k, s: PINS[k].s, h: PINS[k].h, i: PINS[k].i };
});
// Datos de Horas Extras: no se incrustan en la foto publica (solo se ven en vivo, tras validar al lider).
const HE_COLS = ['numeric_mm7mrmr6', 'text_mm7my82t', 'text_mm82xpzv', 'color_mm7mtfss', 'color_mm7mtv3w', 'timerange_mm7m57ra'];

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

// ---- Codigo inyectado (shim-template.js): foto incrustada + modo vivo con clave API del usuario
function shim(snap, stamp, toastErr) {
  const data = JSON.stringify(snap).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  const tpl = fs.readFileSync(path.join(__dirname, 'shim-template.js'), 'utf8').replace(/^\uFEFF/, '');
  const code = tpl
    .replace('__SNAP_JSON__', () => data)
    .replace('__STAMP_JSON__', () => JSON.stringify(stamp))
    .replace('__LEADERS_JSON__', () => JSON.stringify(LEADERS))
    .replace('__BRIDGE_JSON__', () => JSON.stringify(BRIDGE_URL))
    .replace('__TOAST_ERR__', () => toastErr);
  if (/__(SNAP_JSON|STAMP_JSON|TOAST_ERR|LEADERS_JSON|BRIDGE_JSON)__/.test(code)) throw new Error('Quedaron marcadores sin sustituir en shim-template.js');
  return '<script>\n' + code + '\n</script>\n';
}

// Enlaces a Monday: se marcan data-leader-only (ocultos salvo para lideres). Se exige el numero exacto de enlaces para detectar cambios en fuente/.
function hideMondayLinks(html, prefix, expected, label) {
  const n = html.split(prefix).length - 1;
  if (n !== expected) throw new Error('Enlaces a Monday en ' + label + ': se esperaban ' + expected + ' y hay ' + n);
  return html.split(prefix).join(prefix.replace('<a ', '<a data-leader-only '));
}
// El portal no lleva el shim completo: este mini-script muestra los enlaces solo si la clave API guardada pertenece a un lider.
function portalLeaderScript() {
  const emails = JSON.stringify(Object.keys(LEADER_EMAILS));
  return '<script>(function(){var L=' + emails + ';' +
    "var s=document.createElement('style');s.textContent='html:not(.is-leader) [data-leader-only]{display:none!important}';(document.head||document.documentElement).appendChild(s);" +
    "var t='';try{t=localStorage.getItem('monday_api_key')||sessionStorage.getItem('monday_api_key')||'';}catch(e){}" +
    'if(!t)return;' +
    "fetch('https://api.monday.com/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':t,'API-Version':'2024-01'},body:JSON.stringify({query:'{me{email}}'})})" +
    ".then(function(r){return r.json();}).then(function(j){var e=String((j.data&&j.data.me&&j.data.me.email)||'').trim().toLowerCase();if(L.indexOf(e)>-1)document.documentElement.classList.add('is-leader');}).catch(function(){});" +
    '})();</script>\n';
}

function injectShim(html, shimHtml) {
  const m = html.match(/<body[^>]*>/);
  if (!m) throw new Error('No se encontro <body>');
  return html.replace(m[0], () => m[0] + '\n' + shimHtml);
}

function buildActualizaciones(html, snap, stamp) {
  html = hideMondayLinks(html, '<a href="https://ibm.monday.com/', 2, 'actualizaciones');
  html = rep(html, "const PROXY = 'http://localhost:3000';", "const PROXY = '#static';", 'PROXY');
  html = repRe(html, /const LIDER_PWDS=\{[^}]*\};/, 'const LIDER_PWDS={};', 'LIDER_PWDS');
  html = rep(html, 'async function mq(', 'async function __mq_live(', 'mq');
  html = rep(html, 'async function mup(', 'async function __mup_live(', 'mup');
  html = rep(html, 'function checkBackend(', 'function __checkBackend_live(', 'checkBackend');
  html = rep(html, 'function reqLiderPwd(', 'function __reqLiderPwd_live(', 'reqLiderPwd');
  html = rep(html, 'function reqModAuth(', 'function __reqModAuth_live(', 'reqModAuth');
  html = rep(html, 'function reqModPwd(', 'function __reqModPwd_live(', 'reqModPwd');
  html = rep(html, 'function promptModAuth(', 'function __promptModAuth_live(', 'promptModAuth');
  html = rep(html, 'async function renderMisHE(', 'async function __renderMisHE_live(', 'renderMisHE');
  // "Mis HE enviadas": abierto a todo el equipo; se identifica a la persona por su clave API (sin pedir ADCAR ni correo).
  html = rep(html, 'enviadas a Anlli Liliana Var\u00f3n</h3>', 'enviadas</h3>', 'titulo Mis HE');
  html = html.replace(/(<div id="ot-mis-queue">[\s\S]*?<button class="btn btn-s" onclick=")syncOTFromMonday\(\)(")/, (m, a, b) => a + 'renderMisHE()' + b);
  if (!/onclick="renderMisHE\(\)">\s*<svg/.test(html)) throw new Error('No se pudo cambiar el boton del panel Mis HE');
  // Las acciones de lider se habilitan por identidad en Monday (dueno de la clave API), sin contrasenas.
  const extra = `<script>
function checkBackend(){var b=document.getElementById("backendBtn");if(b){b.textContent=__statusText();b.classList.add("ok");b.onclick=__openApiModal;}}
async function __needLeader(){
  if(!__tok()){__roToast("Conecta tu clave API (boton de abajo a la izquierda) para continuar.");return "";}
  var k=await __leaderAuth();
  if(!k){return "";}
  currentLider=k;return k;
}
/* Mis HE: la persona se identifica con su clave API (me{id name email}). Se lee todo el historial de Monday (sin limite de fecha).
   Una HE es suya si:
   (a) la creo ella con su clave (creator = ella), salvo que ese creador haya registrado HE de 3 o mas ADCAR distintos
       (clave compartida/proxy), o
   (b) el nombre escrito en el campo ADCAR de la HE contiene su nombre (2 o mas palabras de su nombre/correo). */
async function renderMisHE(silent){
  var c=document.getElementById("ot-mis-queue"); if(!c) return;
  function msg(t,col){c.innerHTML='<div style="text-align:center;padding:28px;color:'+(col||'var(--muted)')+';font-size:12px;">'+t+'</div>';}
  if(!__tok()&&!__bridgeOn()){msg("Conecta tu clave API o el c\\u00f3digo de equipo (bot\\u00f3n \\ud83d\\udd11 de abajo a la izquierda) para ver tus HE.");return;}
  var norm=function(s){return (s||"").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/\\s+/g," ").trim();};
  if(silent!==true) msg("\\u23f3 Cargando\\u2026");
  try{
    /* Sin clave personal (ADCAR con codigo de equipo): se usa el nombre escrito en el campo ADCAR de la solicitud */
    var who=__tok()?((await __liveQuery("{me{id name email}}",__tok())).me||{}):{name:(document.getElementById("ot-adcar")||{}).value||""};
    if(!__tok()&&norm(who.name).split(/[^a-z]+/).filter(function(w){return w.length>1;}).length<2){msg("Escribe tu nombre completo en el campo ADCAR de la solicitud para ver tus HE.");return;}
    var email=norm(who.email), src=norm(who.name);
    if(!src||src.indexOf("@")>-1) src=email.split("@")[0];
    var toks=src.split(/[^a-z]+/).filter(function(w){return w.length>1;});
    var LM={
      PEREZ:function(w){return w.indexOf("jesus")>-1&&w.indexOf("perez")>-1;},
      SUAREZ:function(w){return w.indexOf("victor")>-1&&w.indexOf("suarez")>-1;},
      VARON:function(w){return w.indexOf("anlli")>-1&&w.indexOf("varon")>-1;}
    };
    var lead=email&&Object.prototype.hasOwnProperty.call(__LEADERS,email)?__LEADERS[email].k:"";
    var cols='column_values(ids:["'+COL.aprobador+'","'+COL.estado_apr+'","'+COL.horas_extras+'","'+COL.comentarios_he+'","'+COL.obs_manager+'"]){id text}';
    async function fetchAll(f){
      var d=await mq('{boards(ids:['+BOARD_A+']){items_page(limit:500){cursor items{id name '+f+cols+'}}}}');
      var pg=(d&&d.boards&&d.boards[0]&&d.boards[0].items_page)||{items:[]}, all=(pg.items||[]).slice(), n=0;
      while(pg.cursor&&n++<40){
        var d2=await mq('{next_items_page(limit:500,cursor:"'+pg.cursor+'"){cursor items{id name '+f+cols+'}}}');
        pg=(d2&&d2.next_items_page)||{items:[]}; all=all.concat(pg.items||[]);
      }
      return all;
    }
    var items;
    try{ items=await fetchAll("creator{id} "); }
    catch(e1){ items=await fetchAll(""); }
    var isHE=function(it){return it.name&&it.name.indexOf("HE \\u00b7")===0;};
    var byCreator={};
    items.forEach(function(it){ if(isHE(it)&&it.creator){ var k=String(it.creator.id); (byCreator[k]=byCreator[k]||{})[norm(it.name.split("\\u00b7")[1]||"")]=1; } });
    var meShared=who.id&&byCreator[String(who.id)]&&Object.keys(byCreator[String(who.id)]).length>=3;
    var mine=items.filter(function(it){
      if(!isHE(it)) return false;
      if(!meShared&&it.creator&&who.id&&String(it.creator.id)===String(who.id)) return true;
      var a=norm(it.name.split("\\u00b7")[1]||""), words=a.split(/[^a-z0-9]+/);
      if(email&&a===email) return true;
      if(lead&&LM[lead](words)) return true;
      var w2=words.filter(function(w){return w.length>1&&/^[a-z]+$/.test(w);});
      return (toks.length>=2&&toks.every(function(t){return words.indexOf(t)>-1;}))||(w2.length>=2&&w2.every(function(w){return toks.indexOf(w)>-1;}));
    }).sort(function(x,y){return String(y.name.split("\\u00b7")[2]||"").localeCompare(String(x.name.split("\\u00b7")[2]||""));});
    if(!mine.length){msg("\\ud83d\\udced No hay HE registradas a tu nombre en Monday.");return;}
    var sc={pending:"sb-pend",approved:"sb-ok",rejected:"sb-err"};
    c.innerHTML=mine.map(function(it){
      var cv={};it.column_values.forEach(function(col){cv[col.id]=col.text||"";});
      var est=cv[COL.estado_apr]||"En revisi\\u00f3n", st="pending", ne=norm(est);
      if(ne.indexOf("aprobac")>-1||ne.indexOf("aprobad")>-1) st="approved"; else if(ne.indexOf("rechazad")>-1) st="rejected";
      var p=it.name.split("\\u00b7").map(function(s){return s.trim();});
      return '<div class="req" style="margin-bottom:10px;"><div class="rh"><div><div class="rn">'+_obsEsc(p[1]||"\\u2014")+' \\u00b7 '+_obsEsc(p[2]||"\\u2014")+'</div>'+
        '<div class="rm"><strong>'+_obsEsc(cv[COL.horas_extras]||"\\u2014")+'h</strong> \\u00b7 Aprobador: '+_obsEsc(cv[COL.aprobador]||"\\u2014")+'</div></div>'+
        '<span class="sb '+sc[st]+'">'+_obsEsc(est)+'</span></div>'+
        '<div class="rr">"'+_obsEsc(cv[COL.comentarios_he]||"")+'"</div>'+
        (cv[COL.obs_manager]?'<div style="font-size:11px;color:#7c3aed;margin-top:4px;"><strong>Obs. Manager:</strong> '+_obsEsc(cv[COL.obs_manager])+'</div>':'')+'</div>';
    }).join("");
  }catch(err){msg("\\u274c Error: "+_obsEsc(err.message),"var(--danger)");}
}
setInterval(function(){try{if(!document.hidden&&otRole==="mis") renderMisHE(true);}catch(e){}},45000);
async function reqLiderPwd(r){
  var v=r?r.value:"apr";
  if(v==="mis"){setOTRole("mis");return;}
  if(await __needLeader()){setOTRole(v);}
  else{var c=document.querySelector('input[name="otr"][value="col"]');if(c)c.checked=true;setOTRole("col");}
}
document.addEventListener("DOMContentLoaded",function(){setTimeout(function(){setOTRole("col");},0);});
async function reqModAuth(){
  if(modLiderAuth){if(confirm("\\u00bfCerrar la sesi\\u00f3n de l\\u00edder?")){setModLiderAuth(false);}return;}
  if(await __needLeader()){setModLiderAuth(true);}
}
async function reqModPwd(){if(await __needLeader()){setModLiderAuth(true);openModNew();}}
async function promptModAuth(id){if(await __needLeader()){setModLiderAuth(true);openModEdit(id);}}
</script>
`;
  return injectShim(html, shim(snap, stamp, ",'err'") + extra);
}

function buildAusencias(html, snap, stamp) {
  html = hideMondayLinks(html, '<a href="https://ibm.monday.com/', 2, 'ausencias');
  html = repRe(html, /const APR_PASSWORD\s*=\s*'[^']*';/, "const APR_PASSWORD = '';", 'APR_PASSWORD');
  html = rep(html, 'async function mq(', 'async function __mq_live(', 'mq');
  html = rep(html, "'http://localhost:3000/api/monday/query'", "'#static'", 'url query');
  // Crear solicitud: capturar el id del item creado y subir adjuntos con la clave del usuario
  html = rep(html, 'await mq(mutation);', 'const __cr = await mq(mutation); const itemId = __cr.create_item.id;', 'create_item id');
  html = rep(html, "await fetch('http://localhost:3000/api/monday/upload', {method:'POST',body:fd});", "await mup(itemId, 'file_mm7g6w04', f);", 'upload');
  html = rep(html, 'function reqAprPwd(', 'function __reqAprPwd_live(', 'reqAprPwd');
  html = rep(html, 'async function confirmAprPwd(', 'async function __confirmAprPwd_live(', 'confirmAprPwd');
  // Solo Anlli Liliana Varon aprueba/rechaza (regla original), validado por la identidad de la clave API
  const extra = `<script>
async function reqAprPwd(action){
  if(!__tok()){__roToast("Conecta tu clave API (boton de abajo a la izquierda) para continuar.");return;}
  if((await __leaderKey())!=="VARON"){__roToast("Solo Anlli Liliana Varon puede aprobar o rechazar.");return;}
  if(!(await __leaderAuth())){return;}
  pendingAprAction=action;
  document.getElementById("aprPwdInput").value="";
  await __confirmAprPwd_live();
}
async function confirmAprPwd(){}
</script>
`;
  return injectShim(html, shim(snap, stamp, ',false') + extra);
}

(async function main() {
  const read = f => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^\uFEFF/, '');
  let snap = {};
  let reusedStamp = null;
  if (REUSE) {
    ['dashboard_actualizaciones.html', 'dashboard_ausencias.html'].forEach(f => {
      const h = fs.readFileSync(path.join(OUT, f), 'utf8');
      const m = h.match(/^var __SNAP = (.*);\r?$/m), s = h.match(/^var __STAMP = (.*);\r?$/m);
      if (!m || !s) throw new Error('No se pudo leer la foto de docs/' + f);
      Object.assign(snap, JSON.parse(m[1]));
      reusedStamp = JSON.parse(s[1]);
    });
    Object.keys(BOARDS).forEach(k => { if (!snap[BOARDS[k]]) throw new Error('Falta el tablero ' + BOARDS[k] + ' en la foto'); });
    console.log('Foto reutilizada de docs/ (' + reusedStamp + ')');
  } else {
    for (const k of Object.keys(BOARDS)) {
      snap[BOARDS[k]] = await fetchBoard(BOARDS[k]);
      console.log('Tablero ' + BOARDS[k] + ': ' + snap[BOARDS[k]].items.length + ' items, ' + snap[BOARDS[k]].columns.length + ' columnas');
    }
  }
  // Quitar de la foto publica las HE (items "HE ...") y sus columnas
  const boardA = snap[BOARDS.A];
  boardA.items = boardA.items.filter(it => !/^HE\b/i.test(it.name));
  boardA.items.forEach(it => { it.column_values = it.column_values.filter(cv => HE_COLS.indexOf(cv.id) < 0); });
  const stamp = REUSE ? reusedStamp : new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

  const act = buildActualizaciones(read('dashboard_actualizaciones.html'), { [BOARDS.A]: snap[BOARDS.A], [BOARDS.M]: snap[BOARDS.M] }, stamp);
  const aus = buildAusencias(read('dashboard_ausencias.html'), { [BOARDS.AUS]: snap[BOARDS.AUS] }, stamp);
  const portal = injectShim(hideMondayLinks(read('index_v2.html'), '<a href="https://monday.com/', 2, 'portal'), portalLeaderScript());

  // Contrasenas del codigo fuente (se leen en ejecucion, no se guardan en este script)
  const secrets = [];
  const lp = read('dashboard_actualizaciones.html').match(/const LIDER_PWDS=\{([^}]*)\}/);
  if (lp) (lp[1].match(/'[^']+'/g) || []).forEach(s => secrets.push(s.slice(1, -1)));
  const ap = read('dashboard_ausencias.html').match(/const APR_PASSWORD\s*=\s*'([^']*)'/);
  if (ap && ap[1]) secrets.push(ap[1]);
  if (!secrets.length) throw new Error('No se encontraron contrasenas en fuente/ para verificar');

  // Verificaciones: nada de contrasenas ni del proxy local en lo publicado
  [['dashboard_actualizaciones.html', act], ['dashboard_ausencias.html', aus], ['index.html', portal]].forEach(([n, h]) => {
    if (/localhost:3000|MONDAY_API_TOKEN/.test(h)) throw new Error('Contenido sensible en ' + n);
    secrets.forEach(s => { if (h.includes(s)) throw new Error('Una contrasena aparece en ' + n); });
    if (TOKEN && h.includes(TOKEN)) throw new Error('El token aparece en ' + n);
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
