// Importa um backup exportado pelo WaSeller e converte para o formato do GoSeller.
// O WaSeller guarda vários campos cifrados com CryptoJS.AES usando uma chave FIXA da
// extensão (igual para todos os usuários do WaSeller). Decifra aqui, no navegador, só
// para migrar os dados do próprio vendedor — nada sai do computador.
const WaSeller = (() => {
  const CRIPT_KEY = 'ffce211a-7b07-4d91-ba5d-c40bb4034a83'; // WaSeller 7.4.x

  // --- MD5 (necessário para a derivação de chave do OpenSSL/CryptoJS) ---
  function md5(bytes) {
    function rl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function add(a, b) { return (a + b) & 0xffffffff; }
    const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22, 5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
      4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23, 6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = []; for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const len = bytes.length;
    const withOne = new Uint8Array(((len + 8) >> 6) + 1 << 6);
    withOne.set(bytes); withOne[len] = 0x80;
    const bits = len * 8;
    withOne[withOne.length - 8] = bits & 0xff;
    withOne[withOne.length - 7] = (bits >>> 8) & 0xff;
    withOne[withOne.length - 6] = (bits >>> 16) & 0xff;
    withOne[withOne.length - 5] = (bits >>> 24) & 0xff;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < withOne.length; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = withOne[off + i*4] | (withOne[off + i*4 + 1] << 8) | (withOne[off + i*4 + 2] << 16) | (withOne[off + i*4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7*i) % 16; }
        F = add(add(add(F, A), K[i]), M[g]);
        A = D; D = C; C = B; B = add(B, rl(F, s[i]));
      }
      a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => { out[i*4] = v & 0xff; out[i*4+1] = (v>>>8)&0xff; out[i*4+2] = (v>>>16)&0xff; out[i*4+3] = (v>>>24)&0xff; });
    return out;
  }

  const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

  // EVP_BytesToKey (MD5, 1 iteração) — o padrão do CryptoJS.AES.encrypt(obj, senha)
  function derivar(passBytes, salt, keyLen, ivLen) {
    let d = new Uint8Array(0), prev = new Uint8Array(0);
    while (d.length < keyLen + ivLen) { prev = md5(concat(concat(prev, passBytes), salt)); d = concat(d, prev); }
    return { key: d.slice(0, keyLen), iv: d.slice(keyLen, keyLen + ivLen) };
  }

  const b64ToBytes = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

  async function decifrar(b64) {
    const raw = b64ToBytes(b64);
    if (String.fromCharCode(...raw.slice(0, 8)) !== 'Salted__') throw new Error('Campo fora do formato do WaSeller.');
    const salt = raw.slice(8, 16), ct = raw.slice(16);
    const pass = new TextEncoder().encode(CRIPT_KEY);
    const { key, iv } = derivar(pass, salt, 32, 16);
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, ct);
    return new TextDecoder().decode(plain);
  }
  const D = async (v) => (typeof v === 'string' ? JSON.parse(await decifrar(v)) : v);

  // Reconhece um arquivo do WaSeller (tem as ações em texto puro e campos cifrados)
  function ehBackup(j) {
    return !!(j && Array.isArray(j.respostasRapidasAcao) && typeof j.respostasRapidas === 'string' && j.respostasRapidas.startsWith('U2FsdGVkX1'));
  }

  const CORES = ['#2eb5ff', '#49d126', '#ff8c42', '#a66bff', '#ff5e8a', '#17c3b2', '#ffd23f', '#6c7a89'];
  const novoId = () => 'w' + Math.random().toString(36).slice(2, 10);
  const tokens = (t) => String(t || '').replace(/#primeiroNome/g, '{primeiro_nome}').replace(/#periodo-dia/g, '{saudacao}').replace(/#nome\b/g, '{nome}');
  const mimeDe = (u) => (String(u).match(/^data:([^;,]+)/) || [, ''])[1];

  // Converte o backup do WaSeller no formato de backup do GoSeller (versão 2).
  async function converter(j) {
    const dados = {};
    const cats = (await D(j.categoria)) || [];
    const catNome = {}; cats.forEach((c) => (catNome[c.id] = c.name));
    dados.categorias = cats.map((c) => c.name);

    const meta = (await D(j.respostasRapidas)) || [];
    const acoes = {}; (j.respostasRapidasAcao || []).forEach((r) => (acoes[r.id] = r.acao || []));
    let nMidia = 0;
    dados.respostas = meta.map((m) => {
      const etapas = [];
      for (const p of acoes[m.id] || []) {
        const pp = p.propriedades || {};
        if (p.type === 'txt') {
          etapas.push({ tipo: 'texto', texto: tokens(pp.mensagem), espera: Number(pp.aguarde ?? 2) });
        } else if (['image', 'video', 'audio', 'doc'].includes(p.type) && pp.base64) {
          const tipoMidia = p.type === 'doc' ? 'document' : p.type;
          const midiaId = p.id || novoId();
          dados['midia:' + midiaId] = pp.base64; // já é dataURL
          nMidia++;
          const et = { tipo: 'midia', tipoMidia, midiaId, espera: Number(pp.aguarde ?? 2),
            nomeArquivo: pp.base64Name || tipoMidia, mime: mimeDe(pp.base64),
            tamanho: Math.round((pp.base64.length - pp.base64.indexOf(',') - 1) * 0.75) };
          if (tipoMidia === 'audio') et.ptt = true;
          if (pp.mensagem && tipoMidia !== 'audio') et.legenda = tokens(pp.mensagem);
          etapas.push(et);
        }
        // addCRM / addLabel / removeAll* não são mensagens -> ignorados
      }
      return { id: m.id || novoId(), nome: m.titulo || 'Sem nome', atalho: '', pasta: catNome[m.categoria] || '', etapas };
    }).filter((r) => r.etapas.length);

    const tabs = (await D(j.userTabs)) || [];
    dados.abas = tabs.filter((t) => t.type === 'user').map((t, i) => ({
      id: t.id || novoId(), nome: t.tag || 'Aba ' + (i + 1), tipo: 'manual', cor: CORES[i % CORES.length],
      chats: (t.chats || []).map((c) => ({ ids: [c.id], nome: c.name || '', em: Date.now() })),
    }));

    const contatos = (await D(j.contatos)) || [];
    const nomes = {}; contatos.forEach((c) => { if (c.id && c.id.endsWith('@c.us') && c.name) nomes[c.id] = c.name; });
    dados.nomes = nomes;

    const notes = (await D(j.notes)) || [];
    notes.forEach((n) => { if (!n.text) return; const id = String(n.userID || '').includes('@') ? n.userID : n.userID + '@c.us'; dados['nota:' + id] = n.text; });

    return {
      app: 'goseller', versao: 2, em: Date.now(), origem: 'waseller',
      partes: ['respostas', 'abas', 'contatos'], dados,
      resumo: { respostas: dados.respostas.length, categorias: dados.categorias.length, midias: nMidia,
        abas: dados.abas.length, leads: dados.abas.reduce((s, a) => s + a.chats.length, 0),
        nomes: Object.keys(nomes).length, notas: notes.filter((n) => n.text).length },
    };
  }

  return { ehBackup, converter };
})();
