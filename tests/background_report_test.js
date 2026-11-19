// Runs the real background.js sendReport() against a local server (server/app.py), attachment included.
// Usage: node tests/background_report_test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-srv-'));
  const server = spawn('python3', [path.join(ROOT, 'server/app.py')], { env: { ...process.env, DADOS: data, ADMIN_KEY: 'adm', EVO_URL: 'http://127.0.0.1:9', WEBHOOK_SECRET: 'wh' }, stdio: 'ignore' });
  let failed = 0;
  const check = (cond, label) => (console.log(`  ${cond ? '✓' : '✗'} ${label}`), cond || failed++);
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch('http://127.0.0.1:8080/saude'); break; } catch { await sleep(100); }
    }
    // minimal chrome.* so background.js can be loaded; storage says the server is the local one
    const listeners = [];
    const chrome = {
      storage: { local: { get: async () => ({ servidor: { url: 'http://127.0.0.1:8080' } }), set: async () => {} } },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { create() {}, get: (n, cb) => cb && cb(null), onAlarm: { addListener() {} } },
      action: { onClicked: { addListener() {} } },
      tabs: { query: async () => [], sendMessage: async () => {}, update: async () => {}, create: async () => {} },
      windows: { update: async () => {} },
    };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), { chrome, fetch, Blob, console, setTimeout, clearTimeout, URL });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const msg = { tipo: 'relato', relato: { descricao: 'teste', vendedor: 'Ana', erros: ['x'], info: { versao: '9.9.9' } }, anexo: { nome: 'p.png', mime: 'image/png', tamanho: png.length, dataUrl: 'data:image/png;base64,' + png.toString('base64') } };
    const res = await new Promise((resolve) => listeners.forEach((fn) => fn(msg, {}, resolve)));
    check(res && /^[0-9A-F]{6}$/.test(res.id), 'report created: ' + JSON.stringify(res));
    const d = await (await fetch('http://127.0.0.1:8080/admin/relatos/' + res.id, { headers: { 'X-Admin-Key': 'adm' } })).json();
    check(d.descricao === 'teste' && d.info.versao === '9.9.9' && d.anexo_ok === 1, 'stored with attachment flag');
    const file = Buffer.from(await (await fetch('http://127.0.0.1:8080/admin/relatos/' + res.id + '/anexo', { headers: { 'X-Admin-Key': 'adm' } })).arrayBuffer());
    check(file.equals(png), 'attachment bytes intact');
  } finally {
    server.kill();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
