/* Plantilla del codigo que se inyecta en las paginas publicadas.
   build-static.js sustituye los cuatro marcadores en mayuscula (SNAP, STAMP, TOAST y LEADERS) rodeados de guiones bajos.
   Sin clave API: responde con la foto incrustada (solo lectura).
   Con clave API: consulta y escribe directo en api.monday.com desde el navegador, con los permisos de esa clave. */
/* Enlaces a Monday (data-leader-only): ocultos para todos; solo se muestran a los lideres (correo del dueno de la clave API). Es una ayuda visual, no una barrera de seguridad. */
(function () { var s = document.createElement('style'); s.textContent = 'html:not(.is-leader) [data-leader-only]{display:none!important}'; (document.head || document.documentElement).appendChild(s); })();
var __SNAP = __SNAP_JSON__;
var __STAMP = __STAMP_JSON__;
var __BRIDGE = __BRIDGE_JSON__; // URL del puente (Cloudflare Worker) o ''. Con codigo de equipo, los ADCAR escriben/leen por el puente sin ser miembros de Monday.
var __CODE_KEY = 'adcar_team_code';
var __grants = {}, __bridgeAt = 0, __bridgeBusy = null, __bridgeDirty = false;
var __LEADERS = __LEADERS_JSON__; // correo (minusculas) -> {k: PEREZ|SUAREZ|VARON, s: sal, h: huella PBKDF2 del PIN, i: iteraciones}
var __NOKEY = 'Conecta tu clave API (boton \uD83D\uDD11 abajo a la izquierda) para guardar cambios en Monday.';
var __TK_KEY = 'monday_api_key';
var __USER_KEY = 'monday_user';
var __PIN_KEY = 'monday_pin_ok';
var __state = 'snap'; // snap | live | offline | badkey

/* La clave API se guarda en localStorage: cada persona la conecta una sola vez por navegador y no se vuelve a pedir
   hasta que pulse "Desconectar" o Monday la rechace (HTTP 401). Si habia una clave en sessionStorage (version anterior) se migra. */
function __tok() {
  try {
    var t = localStorage.getItem(__TK_KEY) || '';
    if (!t) {
      t = sessionStorage.getItem(__TK_KEY) || '';
      if (t) { localStorage.setItem(__TK_KEY, t); sessionStorage.removeItem(__TK_KEY); }
    }
    return t;
  } catch (e) { return ''; }
}
function __clearTok() {
  try { localStorage.removeItem(__TK_KEY); } catch (e) {}
  try { sessionStorage.removeItem(__TK_KEY); sessionStorage.removeItem(__USER_KEY); sessionStorage.removeItem(__PIN_KEY); } catch (e) {}
}
function __roToast(m) { try { showToast(m__TOAST_ERR__); } catch (e) { alert(m); } }

function __code() { try { return localStorage.getItem(__CODE_KEY) || ''; } catch (e) { return ''; } }
function __clearCode() { try { localStorage.removeItem(__CODE_KEY); } catch (e) {} }
/* Modo puente: hay puente configurado, codigo de equipo guardado y NO hay clave personal (los lideres usan su clave directo) */
function __bridgeOn() { return !!(__BRIDGE && __code() && !__tok()); }
function __nokey() { return __BRIDGE ? 'Ingresa el c\u00f3digo de equipo (bot\u00f3n \uD83D\uDD11 abajo a la izquierda) para guardar en Monday.' : __NOKEY; }

function __statusText() {
  if (__state === 'live') return '\uD83D\uDFE2 En vivo con Monday';
  if (__state === 'offline') return '\uD83D\uDD34 Sin conexion o clave invalida';
  if (__state === 'badkey') return __BRIDGE ? '\uD83D\uDD11 C\u00f3digo o clave no v\u00e1lidos' : '\uD83D\uDD11 Clave API no valida';
  return __BRIDGE ? '\uD83D\uDD11 C\u00f3digo de equipo' : '\uD83D\uDD11 Clave API';
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

/* e.auth = la clave no es valida (se borra); e.perm = la clave es valida pero el usuario no tiene permiso (NO se borra). */
function __gqlError(j) {
  var msg = j.errors.map(function (x) { return x.message; }).join('; ');
  var e = new Error(msg);
  var codes = j.errors.map(function (x) { return (x.extensions && x.extensions.code) || ''; }).join(' ');
  if (/not authenticated|invalid.*token/i.test(msg)) e.auth = true;
  else if (/unauthori[sz]ed|permission|not allowed|forbidden/i.test(msg + ' ' + codes)) e.perm = true;
  return e;
}
function __httpError(r) {
  if (r.status === 401) { var a = new Error('Clave API no valida'); a.auth = true; return a; }
  if (r.status === 403) { var p = new Error('Monday rechazo la operacion (HTTP 403)'); p.perm = true; return p; }
  return null;
}

async function __liveQuery(query, token) {
  var r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2024-01' },
    body: JSON.stringify({ query: query })
  });
  var j = {};
  try { j = await r.json(); } catch (e) {}
  var he = __httpError(r); if (he) throw he;
  if (j.errors && j.errors.length) throw __gqlError(j);
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  return j.data;
}

/* Monday responde 401 (clave invalida) SIN cabeceras CORS: el navegador lo ve como TypeError ("Failed to fetch"), igual que una caida de red.
   Se distingue sondeando: una peticion no-cors resuelve si api.monday.com es alcanzable (entonces el fallo fue la clave). */
async function __mondayReachable() {
  try { await fetch('https://api.monday.com/v2', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: 'x' }); return true; }
  catch (e) { return false; }
}
var __MSG_REJECTED = 'Monday rechaz\u00f3 la clave: no es v\u00e1lida, venci\u00f3 o se copi\u00f3 incompleta. Genera una nueva (avatar \u2192 Developers \u2192 My access tokens) y p\u00e9gala completa, sin espacios.';
var __MSG_NONET = 'No se pudo conectar con api.monday.com. Revisa tu red, VPN o proxy.';

function __permMsg(e) {
  return 'Tu usuario de Monday no tiene permiso para guardar este cambio (' + e.message + '). Pide acceso de edicion al tablero. No se guardo el cambio.';
}

/* ---- Puente: el ADCAR solo puede CREAR (actualizacion, HE, ausencia) y adjuntar a lo que acaba de crear; leer viene del puente ---- */
async function __bridgeFetch(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'X-Team-Code': __code() }, opts.headers || {});
  var r = await fetch(__BRIDGE + path, opts);
  var j = {};
  try { j = await r.json(); } catch (e) {}
  if (r.status === 401) { __clearCode(); __setState('badkey'); var a = new Error('C\u00f3digo de equipo no v\u00e1lido. Vuelve a ingresarlo.'); a.auth = true; throw a; }
  if (!r.ok) throw new Error(j.error || ('Puente HTTP ' + r.status));
  return j;
}
function __bridgeRefresh(force) {
  if (!force && __bridgeAt && Date.now() - __bridgeAt < 20000) return Promise.resolve();
  if (__bridgeBusy) return __bridgeBusy;
  __bridgeBusy = __bridgeFetch('/snapshot' + (__bridgeDirty ? '?fresh=1' : '')).then(function (j) {
    __SNAP = j.boards; __STAMP = j.stamp; __bridgeAt = Date.now(); __bridgeDirty = false; __bridgeBusy = null; __setState('live');
  }, function (e) {
    __bridgeBusy = null; __bridgeAt = Date.now() - 10000; // reintenta en ~10 s
    if (e instanceof TypeError) __setState('offline');
    throw e;
  });
  return __bridgeBusy;
}
async function __bridgeMq(query) {
  if (/^\s*mutation/i.test(query)) {
    var m = query.match(/create_item\s*\(\s*board_id\s*:\s*"?(\d+)"?\s*,\s*item_name\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*column_values\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (!m) throw new Error('Solo los l\u00edderes (con su clave API de Monday) pueden editar, aprobar o eliminar. No se guard\u00f3 el cambio.');
    var name, cv;
    try { name = JSON.parse(m[2]); cv = JSON.parse(JSON.parse(m[3])); } catch (e) { throw new Error('No se pudo leer la solicitud. No se guard\u00f3 el cambio.'); }
    var j;
    try { j = await __bridgeFetch('/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: m[1], name: name, column_values: cv }) }); }
    catch (e) { if (e instanceof TypeError) { __setState('offline'); throw new Error('Sin conexion con el puente. No se guard\u00f3 el cambio.'); } throw e; }
    __grants[j.create_item.id] = { board: j.board, grant: j.grant };
    __bridgeDirty = true; __bridgeAt = 0;
    __setState('live');
    return { create_item: { id: j.create_item.id } };
  }
  try { await __bridgeRefresh(); } catch (e) {} // si falla se responde con la ultima foto
  return __snapAnswer(query);
}
async function __bridgeUpload(itemId, columnId, file) {
  var g = __grants[itemId];
  if (!g) throw new Error('Solo se pueden adjuntar archivos a una solicitud creada en esta sesi\u00f3n.');
  var fd = new FormData();
  fd.append('board', g.board); fd.append('itemId', String(itemId)); fd.append('columnId', columnId); fd.append('grant', g.grant);
  fd.append('file', file, file.name);
  try { await __bridgeFetch('/upload', { method: 'POST', body: fd }); }
  catch (e) { if (e instanceof TypeError) { __setState('offline'); throw new Error('Sin conexion con el puente al subir ' + file.name); } throw e; }
  __bridgeDirty = true; __bridgeAt = 0;
  return { success: true };
}

async function mq(query) {
  query = String(query);
  var t = __tok();
  if (!t && __bridgeOn()) return __bridgeMq(query);
  if (/^\s*mutation/i.test(query)) {
    if (!t) throw new Error(__nokey());
    try { var d = await __liveQuery(query, t); __setState('live'); return d; }
    catch (e) {
      if (e.auth) { __clearTok(); __setState('badkey'); throw new Error('Clave API no valida. Vuelve a conectarla. No se guardo el cambio.'); }
      if (e.perm) { throw new Error(__permMsg(e)); }
      if (e instanceof TypeError) {
        if (await __mondayReachable()) { __setState('badkey'); throw new Error('Monday rechaz\u00f3 tu clave API. Reconecta (bot\u00f3n \uD83D\uDD11) con una clave nueva. No se guard\u00f3 el cambio.'); }
        __setState('offline'); throw new Error('Sin conexion con Monday. No se guardo el cambio.');
      }
      throw e;
    }
  }
  if (t) {
    try {
      var r = await __liveQuery(query, t); __setState('live');
      /* Clave valida pero sin acceso al tablero: Monday responde boards:[]; se usa la foto para no romper la pagina. */
      if (r && Array.isArray(r.boards) && !r.boards.length) { try { return __snapAnswer(query); } catch (x) {} }
      return r;
    }
    catch (e) {
      if (e.auth) { __clearTok(); __setState('badkey'); }
      else if (e instanceof TypeError) { __setState('offline'); }
      else if (!e.perm) { throw e; }
    }
  }
  return __snapAnswer(query);
}

async function mup(itemId, columnId, file) {
  var t = __tok();
  if (!t && __bridgeOn()) return __bridgeUpload(itemId, columnId, file);
  if (!t) throw new Error(__nokey());
  if (!/^\d+$/.test(String(itemId)) || !/^[A-Za-z0-9_]+$/.test(String(columnId))) throw new Error('Datos de archivo invalidos');
  var fd = new FormData();
  fd.append('query', 'mutation ($file: File!) { add_file_to_column(item_id: ' + itemId + ', column_id: "' + columnId + '", file: $file) { id } }');
  fd.append('variables[file]', file, file.name);
  /* La subida de archivos de Monday usa un endpoint propio: /v2/file (en /v2 no se aceptan archivos). */
  var r;
  try { r = await fetch('https://api.monday.com/v2/file', { method: 'POST', headers: { 'Authorization': t }, body: fd }); }
  catch (e) { if (e instanceof TypeError) { __setState('offline'); throw new Error('Sin conexion con Monday al subir ' + file.name); } throw e; }
  var j = {};
  try { j = await r.json(); } catch (e) {}
  var err = __httpError(r) || ((j.errors && j.errors.length) ? __gqlError(j) : null);
  if (err) {
    if (err.auth) { __clearTok(); __setState('badkey'); throw new Error('Clave API no valida. No se subio ' + file.name); }
    if (err.perm) { throw new Error('Sin permiso para subir archivos a este tablero (' + err.message + ')'); }
    throw err;
  }
  if (!r.ok) throw new Error('Monday HTTP ' + r.status);
  return { success: true };
}

/* ---- Identidad: se consulta a Monday en cada verificacion (correo del dueno de la clave) ---- */
async function __leaderRec() {
  var t = __tok();
  if (!t) return null;
  try {
    var d = await __liveQuery('{me{email}}', t);
    var email = String((d && d.me && d.me.email) || '').trim().toLowerCase();
    return (email && Object.prototype.hasOwnProperty.call(__LEADERS, email)) ? { email: email, rec: __LEADERS[email] } : null;
  } catch (e) { return null; }
}
/* Solo por correo (sin PIN): PEREZ | SUAREZ | VARON | '' */
async function __leaderKey() { var r = await __leaderRec(); return r ? r.rec.k : ''; }

/* ---- Segundo factor: PIN propio de cada lider (se compara una huella PBKDF2, el PIN no se publica) ---- */
async function __pbkdf2(pin, saltB64, iter) {
  var salt = Uint8Array.from(atob(saltB64), function (c) { return c.charCodeAt(0); });
  var km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter }, km, 256);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(bits)));
}
function __askPin(who) {
  return new Promise(function (resolve) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:100001;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#0f172a;border-radius:12px;padding:20px;width:min(380px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.3)';
    box.innerHTML = '<div style="font-size:15px;font-weight:700;margin-bottom:6px">PIN de l\u00edder</div>' +
      '<div style="font-size:12px;color:#475569;line-height:1.5;margin-bottom:10px">Escribe tu PIN personal para continuar (' + who + ').</div>';
    var inp = document.createElement('input');
    inp.type = 'password'; inp.autocomplete = 'off'; inp.placeholder = 'PIN';
    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;margin-bottom:12px';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    function b(t, bg, fg) { var x = document.createElement('button'); x.type = 'button'; x.textContent = t; x.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid #cbd5e1;font-size:12px;font-weight:600;cursor:pointer;background:' + bg + ';color:' + fg; return x; }
    var bc = b('Cancelar', '#fff', '#334155'), bo = b('Aceptar', '#0f62fe', '#fff');
    function done(v) { ov.remove(); resolve(v); }
    bc.onclick = function () { done(null); };
    bo.onclick = function () { done(inp.value); };
    inp.onkeydown = function (ev) { if (ev.key === 'Enter') done(inp.value); if (ev.key === 'Escape') done(null); };
    row.appendChild(bc); row.appendChild(bo); box.appendChild(inp); box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov); inp.focus();
  });
}
var __pinFails = 0, __pinLockUntil = 0;
/* Devuelve la clave de lider solo si el correo esta autorizado Y el PIN es correcto; si no, avisa y devuelve ''. */
async function __leaderAuth() {
  var r = await __leaderRec();
  if (!r) { __roToast('Solo los lideres autorizados pueden hacer esta accion.'); return ''; }
  var mark = r.email + '|' + r.rec.h;
  try { if (sessionStorage.getItem(__PIN_KEY) === mark) return r.rec.k; } catch (e) {}
  if (!(window.crypto && crypto.subtle)) { __roToast('Tu navegador no permite verificar el PIN (se requiere HTTPS).'); return ''; }
  if (Date.now() < __pinLockUntil) { __roToast('Demasiados intentos. Espera un minuto.'); return ''; }
  var pin = await __askPin(r.rec.k);
  if (pin === null) return '';
  var h = '';
  try { h = await __pbkdf2(pin, r.rec.s, r.rec.i); } catch (e) { __roToast('No se pudo verificar el PIN.'); return ''; }
  if (h !== r.rec.h) {
    if (++__pinFails >= 5) { __pinFails = 0; __pinLockUntil = Date.now() + 60000; }
    __roToast('PIN incorrecto.');
    return '';
  }
  __pinFails = 0;
  try { sessionStorage.setItem(__PIN_KEY, mark); } catch (e) {}
  return r.rec.k;
}

function __openApiModal() {
  var old = document.getElementById('__apiModal'); if (old) old.remove();
  var connected = !!__tok() || !!__code();
  var ov = document.createElement('div');
  ov.id = '__apiModal';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
  var box = document.createElement('div');
  box.style.cssText = 'background:#fff;color:#0f172a;border-radius:12px;padding:20px;width:min(420px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.3)';
  box.innerHTML = '<div style="font-size:15px;font-weight:700;margin-bottom:6px">Conectar con Monday</div>';
  var codeInp = null;
  if (__BRIDGE) {
    var d1 = document.createElement('div');
    d1.style.cssText = 'font-size:12px;color:#475569;line-height:1.5;margin-bottom:6px';
    d1.innerHTML = '<b>ADCAR:</b> escribe el c\u00f3digo de equipo que te dio tu l\u00edder. Con \u00e9l env\u00edas tus actualizaciones, horas extras y ausencias a Monday y ves sus datos, sin necesitar cuenta en Monday. Se guarda en este navegador y no se vuelve a pedir.';
    codeInp = document.createElement('input');
    codeInp.type = 'password'; codeInp.placeholder = 'C\u00f3digo de equipo'; codeInp.autocomplete = 'off';
    codeInp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;margin-bottom:12px';
    box.appendChild(d1); box.appendChild(codeInp);
  }
  var d2 = document.createElement('div');
  d2.style.cssText = 'font-size:12px;color:#475569;line-height:1.5;margin-bottom:10px';
  d2.innerHTML = (__BRIDGE ? '<b>L\u00edderes:</b> ' : '') + 'pega tu clave API personal de Monday ' +
    '(avatar \u2192 Developers \u2192 My access tokens). Se guarda solo en este navegador (no se vuelve a pedir; ' +
    'puedes quitarla con Desconectar) y se env\u00eda \u00fanicamente a api.monday.com. Podr\u00e1s ver y guardar cambios seg\u00fan tus permisos en Monday; ' +
    'la p\u00e1gina se actualiza sola cada 45 s.';
  box.appendChild(d2);
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
    bOff.onclick = function () { __clearTok(); __clearCode(); location.reload(); };
    row.appendChild(bOff);
  }
  row.appendChild(bCancel); row.appendChild(bOk);
  async function connect() {
    var t = inp.value.trim();
    var cd = codeInp ? codeInp.value.trim() : '';
    if (!t && !cd) { err.textContent = codeInp ? 'Escribe el c\u00f3digo de equipo o tu clave API.' : 'Escribe tu clave API.'; return; }
    bOk.disabled = true; bOk.textContent = 'Verificando\u2026'; err.textContent = '';
    if (!t) {
      try {
        var cr = await fetch(__BRIDGE + '/check', { headers: { 'X-Team-Code': cd } });
        if (cr.status === 401) { bOk.disabled = false; bOk.textContent = 'Conectar'; err.textContent = 'C\u00f3digo de equipo no v\u00e1lido.'; return; }
        if (cr.status === 429) { bOk.disabled = false; bOk.textContent = 'Conectar'; err.textContent = 'Demasiados intentos. Espera unos minutos.'; return; }
        if (!cr.ok) throw new Error('Puente HTTP ' + cr.status);
        localStorage.setItem(__CODE_KEY, cd);
        location.reload();
      } catch (e) {
        bOk.disabled = false; bOk.textContent = 'Conectar';
        err.textContent = e instanceof TypeError ? 'No se pudo conectar con el puente. Revisa tu conexi\u00f3n.' : e.message;
      }
      return;
    }
    if (!/^[\x21-\x7E]+$/.test(t)) { bOk.disabled = false; bOk.textContent = 'Conectar'; err.textContent = 'La clave tiene espacios, saltos de l\u00ednea o caracteres no v\u00e1lidos. C\u00f3piala de nuevo, completa y sin espacios.'; return; }
    try {
      await __liveQuery('{me{id}}', t);
      localStorage.setItem(__TK_KEY, t);
      location.reload();
    } catch (e) {
      bOk.disabled = false; bOk.textContent = 'Conectar';
      if (e instanceof TypeError) { err.textContent = (await __mondayReachable()) ? __MSG_REJECTED : __MSG_NONET; return; }
      err.textContent = e.auth ? 'Clave API no valida o sin permisos.' : e.message;
    }
  }
  bOk.onclick = connect;
  inp.onkeydown = function (ev) { if (ev.key === 'Enter') connect(); };
  if (codeInp) codeInp.onkeydown = function (ev) { if (ev.key === 'Enter') connect(); };
  ov.onclick = function (ev) { if (ev.target === ov) ov.remove(); };
  box.appendChild(inp); box.appendChild(err); box.appendChild(row);
  ov.appendChild(box); document.body.appendChild(ov); (codeInp || inp).focus();
}

document.addEventListener('DOMContentLoaded', function () {
  var p = document.createElement('button');
  p.id = '__apiPill'; p.type = 'button';
  p.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#0f172a;color:#fff;padding:7px 14px;border:0;border-radius:999px;font:600 11px system-ui,sans-serif;cursor:pointer;opacity:.95';
  p.onclick = __openApiModal;
  document.body.appendChild(p);
  if (__tok()) {
    __leaderKey().then(function (k) { if (k) document.documentElement.classList.add('is-leader'); });
    __state = 'live';
    __liveQuery('{me{id}}', __tok()).then(function () {
      __setState('live');
    }).catch(function (e) {
      if (e.auth) { __clearTok(); __setState('badkey'); }
      else if (e instanceof TypeError) { __mondayReachable().then(function (up) { __setState(up ? 'badkey' : 'offline'); }); } // clave rechazada (401 sin CORS) o sin red; no se borra por si fue un fallo pasajero
      else { __setState('offline'); }
    });
  } else if (__bridgeOn()) {
    __state = 'live';
    __bridgeRefresh(true).catch(function (e) { if (!e.auth) __setState('offline'); });
  }
  __setState(__state);
});
