#!/usr/bin/env node
// Converte um backup do WaSeller (.json exportado pela extensão) em um backup do GoSeller,
// pronto para ser restaurado em Configurações › Restaurar backup do GoSeller.
//
// Uso:  node waseller-para-goseller.js "<backup do waseller>.json" ["<saída>.json"]
//
// O WaSeller guarda vários campos cifrados (CryptoJS AES com uma chave fixa da extensão).
// Decifra aqui apenas para migrar os SEUS próprios dados; nada sai da máquina.

const fs = require('fs');
const crypto = require('crypto');

const CRIPT_KEY = 'ffce211a-7b07-4d91-ba5d-c40bb4034a83'; // chave fixa do WaSeller 7.4.x

// ---- decrypt compatível com CryptoJS.AES.encrypt(obj, senha) (OpenSSL "Salted__", MD5 KDF) ----
function evpKDF(pass, salt, keyLen, ivLen) {
  let d = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (d.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass, 'utf8'), salt])).digest();
    d = Buffer.concat([d, prev]);
  }
  return { key: d.slice(0, keyLen), iv: d.slice(keyLen, keyLen + ivLen) };
}
function decifrar(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.slice(0, 8).toString() !== 'Salted__') throw new Error('campo não está no formato esperado');
  const salt = raw.slice(8, 16), ct = raw.slice(16);
  const { key, iv } = evpKDF(CRIPT_KEY, salt, 32, 16);
  const dc = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([dc.update(ct), dc.final()]).toString('utf8');
}
const D = (v) => (typeof v === 'string' ? JSON.parse(decifrar(v)) : v);

// ---- helpers ----
const CORES = ['#2eb5ff', '#49d126', '#ff8c42', '#a66bff', '#ff5e8a', '#17c3b2', '#ffd23f', '#6c7a89'];
const novoId = () => 'w' + Math.random().toString(36).slice(2, 10);
function converteTokens(t) {
  return String(t || '')
    .replace(/#primeiroNome/g, '{primeiro_nome}')
    .replace(/#periodo-dia/g, '{saudacao}')
    .replace(/#nome\b/g, '{nome}');
}
const mimeDoDataUrl = (u) => (String(u).match(/^data:([^;,]+)/) || [, ''])[1];

function main() {
  const entrada = process.argv[2];
  if (!entrada) { console.error('Informe o arquivo do backup do WaSeller.'); process.exit(1); }
  const hoje = new Date().toISOString().slice(0, 10);
  const saida = process.argv[3] || entrada.replace(/\.json$/i, '') + '-GoSeller-' + hoje + '.json';

  const w = JSON.parse(fs.readFileSync(entrada, 'utf8'));
  const dados = {};
  const aviso = [];

  // categorias (id -> nome)
  const cats = D(w.categoria) || [];
  const catNome = {};
  cats.forEach((c) => (catNome[c.id] = c.name));
  dados.categorias = cats.map((c) => c.name);

  // respostas rápidas: meta (nome/categoria) + ações (os passos)
  const meta = D(w.respostasRapidas) || [];
  const acoes = {};
  (w.respostasRapidasAcao || []).forEach((r) => (acoes[r.id] = r.acao || []));
  let totalMidia = 0;
  dados.respostas = meta.map((m) => {
    const etapas = [];
    for (const p of acoes[m.id] || []) {
      const pp = p.propriedades || {};
      if (p.type === 'txt') {
        etapas.push({ tipo: 'texto', texto: converteTokens(pp.mensagem), espera: Number(pp.aguarde ?? 2) });
      } else if (['image', 'video', 'audio', 'doc'].includes(p.type) && pp.base64) {
        const tipoMidia = p.type === 'doc' ? 'document' : p.type;
        const midiaId = p.id || novoId();
        dados['midia:' + midiaId] = pp.base64; // já é dataURL
        totalMidia++;
        const et = {
          tipo: 'midia', tipoMidia, midiaId, espera: Number(pp.aguarde ?? 2),
          nomeArquivo: pp.base64Name || (tipoMidia + (p.type === 'doc' ? '' : '')),
          mime: mimeDoDataUrl(pp.base64),
          tamanho: Math.round((pp.base64.length - (pp.base64.indexOf(',') + 1)) * 0.75),
        };
        if (tipoMidia === 'audio') et.ptt = true; // WaSeller manda áudio como nota de voz
        if (pp.mensagem && tipoMidia !== 'audio') et.legenda = converteTokens(pp.mensagem);
        etapas.push(et);
      }
      // addCRM / addLabel / removeAllCRM / removeAllLabel: ações de CRM, não são mensagens -> ignoradas
    }
    return { id: m.id || novoId(), nome: m.titulo || 'Sem nome', atalho: '', pasta: catNome[m.categoria] || '', etapas };
  }).filter((r) => r.etapas.length); // descarta respostas que só tinham ações de CRM

  // abas manuais (colunas do CRM do WaSeller) com os leads de cada uma
  const tabs = D(w.userTabs) || [];
  dados.abas = tabs.filter((t) => t.type === 'user').map((t, i) => ({
    id: t.id || novoId(), nome: t.tag || 'Aba ' + (i + 1), tipo: 'manual', cor: CORES[i % CORES.length],
    chats: (t.chats || []).map((c) => ({ ids: [c.id], nome: c.name || '', em: Date.now() })),
  }));

  // nomes trocados: contatos pessoais do WaSeller
  const contatos = D(w.contatos) || [];
  const nomes = {};
  contatos.forEach((c) => { if (c.id && c.id.endsWith('@c.us') && c.name) nomes[c.id] = c.name; });
  dados.nomes = nomes;

  // anotações por contato
  const notes = D(w.notes) || [];
  notes.forEach((n) => {
    if (!n.text) return;
    const id = (n.userID || '').includes('@') ? n.userID : n.userID + '@c.us';
    dados['nota:' + id] = n.text;
  });

  const saidaObj = {
    app: 'goseller', versao: 2, em: Date.now(),
    partes: ['respostas', 'abas', 'contatos'],
    origem: 'waseller',
    dados,
  };
  fs.writeFileSync(saida, JSON.stringify(saidaObj));

  console.log('Convertido com sucesso:');
  console.log('  respostas rápidas:', dados.respostas.length, '(em', dados.categorias.length, 'categorias)');
  console.log('  arquivos (áudio/vídeo/imagem/doc):', totalMidia);
  console.log('  abas:', dados.abas.length, '| leads nas abas:', dados.abas.reduce((s, a) => s + a.chats.length, 0));
  console.log('  nomes de contatos:', Object.keys(nomes).length, '| anotações:', notes.filter((n) => n.text).length);
  console.log('  arquivo gerado:', saida);
}
main();
