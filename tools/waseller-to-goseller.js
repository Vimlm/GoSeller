#!/usr/bin/env node
// Converts a WaSeller backup (.json exported by the extension) into a GoSeller backup,
// ready to be restored in Configurações › Restaurar backup in GoSeller.
//
// Usage:  node waseller-to-goseller.js "<waseller backup>.json" ["<output>.json"]
//
// WaSeller stores several encrypted fields (CryptoJS AES with a fixed key of the extension).
// Decrypts here only to migrate YOUR own data; nothing leaves the machine.

const fs = require('fs');
const crypto = require('crypto');

const CRIPT_KEY = 'ffce211a-7b07-4d91-ba5d-c40bb4034a83'; // fixed WaSeller 7.4.x key

// ---- decrypt compatible with CryptoJS.AES.encrypt(obj, password) (OpenSSL "Salted__", MD5 KDF) ----
function evpKDF(pass, salt, keyLen, ivLen) {
  let d = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (d.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass, 'utf8'), salt])).digest();
    d = Buffer.concat([d, prev]);
  }
  return { key: d.slice(0, keyLen), iv: d.slice(keyLen, keyLen + ivLen) };
}
function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.slice(0, 8).toString() !== 'Salted__') throw new Error('campo não está no formato esperado');
  const salt = raw.slice(8, 16), ct = raw.slice(16);
  const { key, iv } = evpKDF(CRIPT_KEY, salt, 32, 16);
  const decrypted = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decrypted.update(ct), decrypted.final()]).toString('utf8');
}
const D = (v) => (typeof v === 'string' ? JSON.parse(decrypt(v)) : v);

// ---- helpers ----
const COLORS = ['#2eb5ff', '#49d126', '#ff8c42', '#a66bff', '#ff5e8a', '#17c3b2', '#ffd23f', '#6c7a89'];
const newId = () => 'w' + Math.random().toString(36).slice(2, 10);
function convertTokens(t) {
  return String(t || '')
    .replace(/#primeiroNome/g, '{primeiro_nome}')
    .replace(/#periodo-dia/g, '{saudacao}')
    .replace(/#nome\b/g, '{nome}');
}
const mimeFromDataUrl = (u) => (String(u).match(/^data:([^;,]+)/) || [, ''])[1];

function main() {
  const entry = process.argv[2];
  if (!entry) { console.error('Informe o arquivo do backup do WaSeller.'); process.exit(1); }
  const today = new Date().toISOString().slice(0, 10);
  const output = process.argv[3] || entry.replace(/\.json$/i, '') + '-GoSeller-' + today + '.json';

  const w = JSON.parse(fs.readFileSync(entry, 'utf8'));
  const data = {};
  const notice = [];

  // categories (id -> name)
  const cats = D(w.categoria) || [];
  const categoryName = {};
  cats.forEach((c) => (categoryName[c.id] = c.name));
  data.categorias = cats.map((c) => c.name);

  // quick replies: meta (name/category) + actions (the steps)
  const meta = D(w.respostasRapidas) || [];
  const actions = {};
  (w.respostasRapidasAcao || []).forEach((r) => (actions[r.id] = r.acao || []));
  let mediaTotal = 0;
  data.respostas = meta.map((m) => {
    const steps = [];
    for (const p of actions[m.id] || []) {
      const pp = p.propriedades || {};
      if (p.type === 'txt') {
        steps.push({ tipo: 'texto', texto: convertTokens(pp.mensagem), espera: Number(pp.aguarde ?? 2) });
      } else if (['image', 'video', 'audio', 'doc'].includes(p.type) && pp.base64) {
        const mediaType = p.type === 'doc' ? 'document' : p.type;
        const mediaId = p.id || newId();
        data['midia:' + mediaId] = pp.base64; // already a dataURL
        mediaTotal++;
        const et = {
          tipo: 'midia', tipoMidia: mediaType, midiaId: mediaId, espera: Number(pp.aguarde ?? 2),
          nomeArquivo: pp.base64Name || (mediaType + (p.type === 'doc' ? '' : '')),
          mime: mimeFromDataUrl(pp.base64),
          tamanho: Math.round((pp.base64.length - (pp.base64.indexOf(',') + 1)) * 0.75),
        };
        if (mediaType === 'audio') et.ptt = true; // WaSeller sends audio as a voice note
        if (pp.mensagem && mediaType !== 'audio') et.legenda = convertTokens(pp.mensagem);
        steps.push(et);
      }
      // addCRM / addLabel / removeAllCRM / removeAllLabel: CRM actions, not messages -> ignored
    }
    return { id: m.id || newId(), nome: m.titulo || 'Sem nome', atalho: '', pasta: categoryName[m.categoria] || '', etapas: steps };
  }).filter((r) => r.etapas.length); // drops replies that only had CRM actions

  // manual tabs (WaSeller CRM columns) with each one's leads
  const tabs = D(w.userTabs) || [];
  data.abas = tabs.filter((t) => t.type === 'user').map((t, i) => ({
    id: t.id || newId(), nome: t.tag || 'Aba ' + (i + 1), tipo: 'manual', cor: COLORS[i % COLORS.length],
    chats: (t.chats || []).map((c) => ({ ids: [c.id], nome: c.name || '', em: Date.now() })),
  }));

  // renamed contacts: WaSeller personal contacts
  const contacts = D(w.contatos) || [];
  const names = {};
  contacts.forEach((c) => { if (c.id && c.id.endsWith('@c.us') && c.name) names[c.id] = c.name; });
  data.nomes = names;

  // notes per contact
  const notes = D(w.notes) || [];
  notes.forEach((n) => {
    if (!n.text) return;
    const id = (n.userID || '').includes('@') ? n.userID : n.userID + '@c.us';
    data['nota:' + id] = n.text;
  });

  const outputObj = {
    app: 'goseller', versao: 2, em: Date.now(),
    partes: ['respostas', 'abas', 'contatos'],
    origem: 'waseller',
    dados: data,
  };
  fs.writeFileSync(output, JSON.stringify(outputObj));

  console.log('Convertido com sucesso:');
  console.log('  respostas rápidas:', data.respostas.length, '(em', data.categorias.length, 'categorias)');
  console.log('  arquivos (áudio/vídeo/imagem/doc):', mediaTotal);
  console.log('  abas:', data.abas.length, '| leads nas abas:', data.abas.reduce((s, a) => s + a.chats.length, 0));
  console.log('  nomes de contatos:', Object.keys(names).length, '| anotações:', notes.filter((n) => n.text).length);
  console.log('  arquivo gerado:', output);
}
main();
