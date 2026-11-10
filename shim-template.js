/* Plantilla del codigo que se inyecta en las paginas publicadas.
   build-static.js sustituye los tres marcadores en mayuscula (SNAP, STAMP y TOAST) rodeados de guiones bajos.
   Modo foto: responde con los datos incrustados. Modo vivo: consulta api.monday.com
   directamente desde el navegador con la clave API que pega el usuario (solo lectura). */
var __SNAP = __SNAP_JSON__;
var __STAMP = __STAMP_JSON__;
var __RO = 'Solo lectura: esta pagina no guarda cambios en Monday.';
var __TK_KEY = 'monday_api_key';
var __state = 'snap'; // snap | live | offline | badkey

function __tok() { try { return sessionStorage.getItem(__TK_KEY) || ''; } catch (e) { return ''; } }
function __roToast(m) { try { showToast(m__TOAST_ERR__); } catch (e) { alert(m); } }

function __statusText() {
  if (__state === 'live') return '\uD83D\uDFE2 En vivo con Monday';
  if (__state === 'offline') return '\uD83D\uDD34 Sin conexion o clave invalida \u00b7 foto al ' + __STAMP;
  if (__state === 'badkey') return '\uD83D\uDD11 Clave API no valida \u00b7 foto al ' + __STAMP;
  return '\uD83D\uDD11 Clave API \u00b7 foto al ' + __STAMP;
}
function __setState(s) {
  __state = s;
  var p = document.getElementById('__apiPill'); if (p) p.textContent = __statusText();
  var b = document.getElementById('backendBtn'); if (b) b.textContent = __statusText();
}

function __snapAnswer(query) {
  var m = query.match(/boards\(ids:\s*\[?\s*(\d+)/);
  if (!m) throw new Error('Consulta no disponible');
  var b = __SNAP[m[1]];
  if (!b) throw new Error('Tablero no incluido en la foto');
  if (/columns\s*\{/.test(query)) return { boards: [{ columns: b.columns }] };
  var lim = (query.match(/limit:\s*(\d+)/) || [])[1];
  var items = b.items.slice(0, lim ? +lim : b.items.length);
  var ids = (query.match(/column_values\(ids:\s*\[([^\]]*)\]\)/) || [])[1];
  if (ids) {
    ids = ids.split(',').map(function (s) { return s.trim().replace(/"/g, ''); });
    items = items.map(function (it) {
      return { id: it.id, name: it.name, group: it.group, column_values: it.column_values.filter(function (c) { return ids.indexOf(c.id) > -1; }) };
    });
  }
  return { boards: [{ items_page: { cursor: null, items: items } }] };
}

async function __liveQuery(query, token) {
  var r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2024-01' },
    body: JSON.stringify({ query: query })
  });
  var j = {};
  try { j = await r.json(); } catch (e) {}
  if (r.status === 401 || r.status === 403) { var a = new Error('Clave API no valida'); a.auth = true; throw a; }
  if (j.errors && j.errors.length) {
    var msg = j.errors.map(function (x) { return x.message; }).join('; ');
    var e2 = new Error(msg);
    if (/not authenticated|unauthori[sz]ed|invalid.*token/i.test(msg)) e2.auth = true;
    throw e2;
  }
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  return j.data;
}

async function mq(query) {
  query = String(query);
  if (/^\s*mutation/i.test(query)) throw new Error(__RO);
  var t = __tok();
  if (t) {
    try { var d = await __liveQuery(query, t); __setState('live'); return d; }
    catch (e) {
      if (e.auth) { try { sessionStorage.removeItem(__TK_KEY); } catch (x) {} __setState('badkey'); }
      else if (e instanceof TypeError) { __setState('offline'); }
      else { throw e; }
    }
  }
  return __snapAnswer(query);
}
async function mup() { throw new Error(__RO); }

function __openApiModal() {
  var old = document.getElementById('__apiModal'); if (old) old.remove();
  var connected = !!__tok();
  var ov = document.createElement('div');
  ov.id = '__apiModal';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
  var box = document.createElement('div');
  box.style.cssText = 'background:#fff;color:#0f172a;border-radius:12px;padding:20px;width:min(420px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.3)';
  box.innerHTML = '<div style="font-size:15px;font-weight:700;margin-bottom:6px">Conectar con Monday</div>' +
    '<div style="font-size:12px;color:#475569;line-height:1.5;margin-bottom:10px">Pega tu clave API personal de Monday ' +
    '(avatar \u2192 Developers \u2192 My access tokens). Se guarda solo en esta pesta\u00f1a del navegador, ' +
    'se env\u00eda \u00fanicamente a api.monday.com y la p\u00e1gina se actualiza sola cada 45 s. Solo lectura.</div>';
  var inp = document.createElement('input');
  inp.type = 'password'; inp.placeholder = 'Clave API de Monday'; inp.autocomplete = 'off';
  inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px';
  var err = document.createElement('div');
  err.style.cssText = 'color:#dc2626;font-size:12px;min-height:16px;margin:6px 0';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  function btn(txt, bg, fg) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
    b.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;font-size:12px;font-weight:600;cursor:pointer;background:' + bg + ';color:' + fg;
    return b;
  }
  var bCancel = btn('Cancelar', '#fff', '#334155');
  var bOk = btn('Conectar', '#0f62fe', '#fff');
  bCancel.onclick = function () { ov.remove(); };
  if (connected) {
    var bOff = btn('Desconectar', '#fee2e2', '#991b1b');
    bOff.onclick = function () { try { sessionStorage.removeItem(__TK_KEY); } catch (e) {} location.reload(); };
    row.appendChild(bOff);
  }
  row.appendChild(bCancel); row.appendChild(bOk);
  async function connect() {
    var t = inp.value.trim();
    if (!t) { err.textContent = 'Escribe tu clave API.'; return; }
    bOk.disabled = true; bOk.textContent = 'Verificando\u2026'; err.textContent = '';
    try {
      await __liveQuery('{me{name}}', t);
      sessionStorage.setItem(__TK_KEY, t);
      location.reload();
    } catch (e) {
      bOk.disabled = false; bOk.textContent = 'Conectar';
      err.textContent = e.auth ? 'Clave API no valida o sin permisos.' : (e instanceof TypeError ? 'No se pudo verificar: revisa que la clave API sea correcta y tu conexion.' : e.message);
    }
  }
  bOk.onclick = connect;
  inp.onkeydown = function (ev) { if (ev.key === 'Enter') connect(); };
  ov.onclick = function (ev) { if (ev.target === ov) ov.remove(); };
  box.appendChild(inp); box.appendChild(err); box.appendChild(row);
  ov.appendChild(box); document.body.appendChild(ov); inp.focus();
}

document.addEventListener('DOMContentLoaded', function () {
  var p = document.createElement('button');
  p.id = '__apiPill'; p.type = 'button';
  p.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#0f172a;color:#fff;padding:7px 14px;border:0;border-radius:999px;font:600 11px system-ui,sans-serif;cursor:pointer;opacity:.95';
  p.onclick = __openApiModal;
  document.body.appendChild(p);
  if (__tok()) {
    __state = 'live';
    __liveQuery('{me{name}}', __tok()).then(function () { __setState('live'); }).catch(function (e) {
      if (e.auth) { try { sessionStorage.removeItem(__TK_KEY); } catch (x) {} __setState('badkey'); } else { __setState('offline'); }
    });
  }
  __setState(__state);
});
