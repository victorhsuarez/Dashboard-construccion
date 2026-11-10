// IBM Dashboards v2 - Deploy 2026-10-02 18:57
'use strict';

const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const rateLimit     = require('express-rate-limit');
const multer        = require('multer');
const fetch         = require('node-fetch');
const FormData      = require('form-data');
const path          = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// Si no hay token en claro, intenta descifrar .env.enc con ENV_PASSPHRASE
if (!process.env.MONDAY_API_TOKEN) {
  try { require('./envcrypt').loadEncryptedEnv(path.join(__dirname, '.env.enc'), process.env.ENV_PASSPHRASE); }
  catch (e) { console.error(JSON.stringify({ level: 'FATAL', msg: 'No se pudo descifrar .env.enc (ENV_PASSPHRASE incorrecta?)' })); process.exit(1); }
}

const REQUIRED_ENV = ['MONDAY_API_TOKEN'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) { console.error(JSON.stringify({ level: 'FATAL', msg: 'Missing required env var: '+key })); process.exit(1); }
});

const MONDAY_TOKEN    = process.env.MONDAY_API_TOKEN;
const MONDAY_API      = 'https://api.monday.com/v2';
const PORT            = parseInt(process.env.PORT || '3000', 10);
const HOST            = '0.0.0.0';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "*"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", "*"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "*"],
      fontSrc:    ["'self'", "*", "data:"],
      imgSrc:     ["'self'", "data:", "*"],
      connectSrc: ["'self'", "*"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    }
  },
  hsts: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({ origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS, methods: ['GET','POST'], allowedHeaders: ['Content-Type'] }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } }));
app.use(express.json({ limit: '1mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50*1024*1024 }, fileFilter: (_req, _file, cb) => cb(null, true) });

app.use(express.static(__dirname, { setHeaders: function(res, filePath) { if(filePath.endsWith(".html")) { res.setHeader("Content-Type","text/html; charset=utf-8"); } } }));

async function mondayRequest(query, variables) {
  variables = variables || {};
  const r = await fetch(MONDAY_API, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_TOKEN,'API-Version':'2024-01'}, body: JSON.stringify({query,variables}) });
  if (!r.ok) throw new Error('Monday API HTTP '+r.status);
  const json = await r.json();
  if (json.errors && json.errors.length > 0) throw new Error(json.errors.map(function(e){return e.message;}).join('; '));
  return json.data;
}

function log(level, msg, extra) { console.log(JSON.stringify(Object.assign({ level: level, msg: msg, ts: new Date().toISOString() }, extra||{}))); }

app.get('/api/health', function(_req, res) { res.json({ status:'ok', ts: new Date().toISOString() }); });

app.post('/api/monday/query', async function(req, res) {
  const query = req.body.query;
  const variables = req.body.variables;
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query is required.' });
  if (/monday_token|api_key|password|secret/i.test(query)) return res.status(403).json({ error: 'Forbidden.' });
  try { const data = await mondayRequest(query, variables||{}); log('info','monday_query_ok'); res.json({ data }); }
  catch (err) { log('error','monday_query_fail',{error:err.message}); res.status(502).json({ error: 'Monday API error: '+err.message }); }
});

app.post('/api/monday/upload', upload.single('file'), async function(req, res) {
  const itemId = req.body.itemId;
  const columnId = req.body.columnId;
  if (!itemId || !columnId || !req.file) return res.status(400).json({ error: 'itemId, columnId and file are required.' });
  if (!/^\d+$/.test(itemId)) return res.status(400).json({ error: 'Invalid itemId.' });
  try {
    const form = new FormData();
    const query = 'mutation ($file: File!) { add_file_to_column(item_id: '+itemId+', column_id: "'+columnId+'", file: $file) { id } }';
    form.append('query', query);
    form.append('variables', JSON.stringify({ file: null }));
    form.append('map', JSON.stringify({ file: ['variables.file'] }));
    form.append('file', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype || 'application/octet-stream' });
    const r = await fetch(MONDAY_API, { method:'POST', headers: Object.assign({ 'Authorization': MONDAY_TOKEN, 'API-Version':'2024-01' }, form.getHeaders()), body: form });
    const json = await r.json();
    if (!r.ok) throw new Error('HTTP '+r.status+': '+JSON.stringify(json));
    if (json.errors) throw new Error(json.errors.map(function(e){return e.message;}).join('; '));
    log('info','file_upload_ok',{itemId:itemId,columnId:columnId,file:req.file.originalname});
    res.json({ success: true });
  } catch (err) { log('error','file_upload_fail',{error:err.message}); res.status(502).json({ error: 'File upload failed: '+err.message }); }
});

app.use(function(err,_req,res,_next){ log('error','unhandled_error',{error:err.message}); res.status(500).json({ error:'Internal server error.' }); });

app.listen(PORT, HOST, function() {
  log('info','server_started',{host:HOST,port:PORT});
  console.log('IBM Dashboards activo en puerto '+PORT);
});
module.exports = app;


