// Shared helpers between the WhatsApp bar (content.js) and the panel.
// Everything is stored only on this computer (chrome.storage.local).
const VF = (() => {
  const st = chrome.storage.local;

  async function read(key, fallback) {
    const r = await st.get(key);
    return r[key] === undefined ? fallback : r[key];
  }
  const write = (key, value) => st.set({ [key]: value });
  const remove = (keys) => st.remove(keys);

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const random = (min, max) => min + Math.random() * Math.max(0, max - min);

  const DEFAULT_CONFIG = {
    nomeVendedor: '',
    // Bulk-send pace
    intervaloMin: 40, // seconds between one lead and the next
    intervaloMax: 120,
    loteTamanho: 15, // after X sends...
    pausaLoteMin: 10, // ...pause for Y to Z minutes
    pausaLoteMax: 20,
    limiteDia: 150,
    usarHorario: true,
    horaInicio: '08:00',
    horaFim: '19:00',
    dias: [1, 2, 3, 4, 5, 6], // 0 = Sunday
    simularDigitacao: true,
    maxFalhasSeguidas: 5,
    // Quick replies
    digitacaoNasRespostas: false,
    // Unsubscribe
    palavrasSair: ['sair', 'parar', 'pare', 'stop', 'descadastrar', 'nao quero mais', 'não quero mais', 'remover'],
  };

  async function config() {
    return { ...DEFAULT_CONFIG, ...(await read('config', {})) };
  }

  // ---------- Text: variations {a|b} and variables {nome} ----------
  const stripAccents = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

  function capitalize(p) {
    if (!p) return '';
    const letters = p.replace(/[^\p{L}]/gu, '');
    if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    }
    return p;
  }

  function firstName(name) {
    const parts = (name || '').split(/\s+/).filter((p) => /\p{L}/u.test(p));
    return capitalize((parts[0] || '').replace(/[^\p{L}'-]/gu, ''));
  }

  function greeting(d = new Date()) {
    const h = d.getHours();
    return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  }

  function buildText(template, data = {}) {
    let t = String(template || '');
    // Variations: {Oi|Olá|E aí} -> picks one
    for (let i = 0; i < 10 && /\{[^{}]*\|[^{}]*\}/.test(t); i++) {
      t = t.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => {
        const op = g.split('|');
        return op[Math.floor(Math.random() * op.length)];
      });
    }
    const now = new Date();
    const vars = {
      nome: (data.nome || '').trim(),
      primeiro_nome: firstName(data.nome),
      saudacao: greeting(now),
      vendedor: data.vendedor || '',
      data: now.toLocaleDateString('pt-BR'),
    };
    t = t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    // Cleans leftovers when a variable came out empty ("Olá , tudo bem?")
    return t.replace(/[ \t]+([,!?.])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '');
  }

  // ---------- Allowed hours ----------
  const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  function withinHours(cfg, d = new Date()) {
    if (!cfg.usarHorario) return true;
    if (!cfg.dias.includes(d.getDay())) return false;
    const now = d.getHours() * 60 + d.getMinutes();
    return now >= toMinutes(cfg.horaInicio) && now < toMinutes(cfg.horaFim);
  }

  const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

  async function sentToday() {
    const c = await read('enviosDia', { data: '', n: 0 });
    return c.data === today() ? c.n : 0;
  }
  async function addSentToday() {
    const n = (await sentToday()) + 1;
    await write('enviosDia', { data: today(), n });
    return n;
  }

  // ---------- Numbers ----------
  function idFromNumber(text) {
    let d = String(text || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10 || d.length === 11) d = '55' + d; // no country code -> Brazil
    if (d.length < 12 || d.length > 15) return null;
    return d + '@c.us';
  }

  function numberFromId(id) {
    const m = String(id || '').match(/^(\d+)@c\.us$/);
    if (!m) return '';
    const d = m[1];
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
      const ddd = d.slice(2, 4), rest = d.slice(4);
      return `(${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
    }
    return '+' + d;
  }

  // Unsubscribe: short message (up to 3 words) containing one of the words. E.g.: "SAIR", "pode parar"
  function askedToLeave(text, words) {
    const t = stripAccents(String(text || '').toLowerCase()).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > 3) return false;
    const withSpaces = ' ' + t + ' ';
    return words.some((p) => {
      const w = stripAccents(p.toLowerCase()).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      return w && withSpaces.includes(' ' + w + ' ');
    });
  }

  // ---------- Media ----------
  const MEDIA_TYPES = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento' };

  async function readMedia(id) {
    return read('midia:' + id, null);
  }

  // Deletes files no reply or campaign uses anymore
  async function cleanOrphanMedia() {
    const everything = await st.get(null);
    const used = new Set();
    const mark = (steps) => (steps || []).forEach((e) => e.midiaId && used.add(e.midiaId));
    (everything.respostas || []).forEach((r) => mark(r.etapas));
    Object.keys(everything).filter((k) => k.startsWith('campanha:')).forEach((k) => {
      mark(everything[k].etapas);
      (everything[k].variacoes || []).forEach(mark);
    });
    Object.values(everything.automacoes || {}).forEach((a) => (a.passos || []).forEach((p) => (p.variacoes || []).forEach(mark)));
    const orphans = Object.keys(everything).filter((k) => k.startsWith('midia:') && !used.has(k.slice(6)));
    if (orphans.length) await remove(orphans);
    return orphans.length;
  }

  const readableSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return {
    read, write, remove, newId, sleep, random, config, DEFAULT_CONFIG,
    buildText, firstName, withinHours, toMinutes, today, sentToday, addSentToday,
    idFromNumber, numberFromId, askedToLeave, stripAccents, MEDIA_TYPES, readMedia, cleanOrphanMedia,
    readableSize, esc,
  };
})();
