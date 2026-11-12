// Funções compartilhadas entre a barra no WhatsApp (conteudo.js) e o painel.
// Tudo fica guardado só neste computador (chrome.storage.local).
const VF = (() => {
  const st = chrome.storage.local;

  async function ler(chave, padrao) {
    const r = await st.get(chave);
    return r[chave] === undefined ? padrao : r[chave];
  }
  const gravar = (chave, valor) => st.set({ [chave]: valor });
  const apagar = (chaves) => st.remove(chaves);

  const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const aleatorio = (min, max) => min + Math.random() * Math.max(0, max - min);

  const CONFIG_PADRAO = {
    nomeVendedor: '',
    // Ritmo do envio em massa
    intervaloMin: 40, // segundos entre um lead e outro
    intervaloMax: 120,
    loteTamanho: 15, // depois de X envios...
    pausaLoteMin: 10, // ...pausa de Y a Z minutos
    pausaLoteMax: 20,
    limiteDia: 150,
    usarHorario: true,
    horaInicio: '08:00',
    horaFim: '19:00',
    dias: [1, 2, 3, 4, 5, 6], // 0 = domingo
    simularDigitacao: true,
    maxFalhasSeguidas: 5,
    // Respostas rápidas
    digitacaoNasRespostas: false,
    // Descadastro
    palavrasSair: ['sair', 'parar', 'pare', 'stop', 'descadastrar', 'nao quero mais', 'não quero mais', 'remover'],
  };

  async function config() {
    return { ...CONFIG_PADRAO, ...(await ler('config', {})) };
  }

  // ---------- Texto: variações {a|b} e variáveis {nome} ----------
  const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

  function capitalizar(p) {
    if (!p) return '';
    const letras = p.replace(/[^\p{L}]/gu, '');
    if (letras && (letras === letras.toUpperCase() || letras === letras.toLowerCase())) {
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    }
    return p;
  }

  function primeiroNome(nome) {
    const partes = (nome || '').split(/\s+/).filter((p) => /\p{L}/u.test(p));
    return capitalizar((partes[0] || '').replace(/[^\p{L}'-]/gu, ''));
  }

  function saudacao(d = new Date()) {
    const h = d.getHours();
    return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  }

  function montarTexto(modelo, dados = {}) {
    let t = String(modelo || '');
    // Variações: {Oi|Olá|E aí} -> escolhe uma
    for (let i = 0; i < 10 && /\{[^{}]*\|[^{}]*\}/.test(t); i++) {
      t = t.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => {
        const op = g.split('|');
        return op[Math.floor(Math.random() * op.length)];
      });
    }
    const agora = new Date();
    const vars = {
      nome: (dados.nome || '').trim(),
      primeiro_nome: primeiroNome(dados.nome),
      saudacao: saudacao(agora),
      vendedor: dados.vendedor || '',
      data: agora.toLocaleDateString('pt-BR'),
    };
    t = t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    // Limpa sobras quando a variável veio vazia ("Olá , tudo bem?")
    return t.replace(/[ \t]+([,!?.])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '');
  }

  // ---------- Horário permitido ----------
  const paraMin = (hhmm) => {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  function dentroDoHorario(cfg, d = new Date()) {
    if (!cfg.usarHorario) return true;
    if (!cfg.dias.includes(d.getDay())) return false;
    const agora = d.getHours() * 60 + d.getMinutes();
    return agora >= paraMin(cfg.horaInicio) && agora < paraMin(cfg.horaFim);
  }

  const hoje = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD

  async function enviosHoje() {
    const c = await ler('enviosDia', { data: '', n: 0 });
    return c.data === hoje() ? c.n : 0;
  }
  async function somarEnvioHoje() {
    const n = (await enviosHoje()) + 1;
    await gravar('enviosDia', { data: hoje(), n });
    return n;
  }

  // ---------- Números ----------
  function idDoNumero(texto) {
    let d = String(texto || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10 || d.length === 11) d = '55' + d; // sem DDI -> Brasil
    if (d.length < 12 || d.length > 15) return null;
    return d + '@c.us';
  }

  function numeroDoId(id) {
    const m = String(id || '').match(/^(\d+)@c\.us$/);
    if (!m) return '';
    const d = m[1];
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
      const ddd = d.slice(2, 4), resto = d.slice(4);
      return `(${ddd}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
    }
    return '+' + d;
  }

  // Descadastro: mensagem curtinha (até 3 palavras) que contém uma das palavras. Ex.: "SAIR", "pode parar"
  function pediuParaSair(texto, palavras) {
    const t = semAcento(String(texto || '').toLowerCase()).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > 3) return false;
    const comEspacos = ' ' + t + ' ';
    return palavras.some((p) => {
      const w = semAcento(p.toLowerCase()).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      return w && comEspacos.includes(' ' + w + ' ');
    });
  }

  // ---------- Mídias ----------
  const TIPOS_MIDIA = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento' };

  async function lerMidia(id) {
    return ler('midia:' + id, null);
  }

  // Apaga arquivos que nenhuma resposta ou campanha usa mais
  async function limparMidiasOrfas() {
    const tudo = await st.get(null);
    const usadas = new Set();
    const marcar = (etapas) => (etapas || []).forEach((e) => e.midiaId && usadas.add(e.midiaId));
    (tudo.respostas || []).forEach((r) => marcar(r.etapas));
    Object.keys(tudo).filter((k) => k.startsWith('campanha:')).forEach((k) => {
      marcar(tudo[k].etapas);
      (tudo[k].variacoes || []).forEach(marcar);
    });
    const orfas = Object.keys(tudo).filter((k) => k.startsWith('midia:') && !usadas.has(k.slice(6)));
    if (orfas.length) await apagar(orfas);
    return orfas.length;
  }

  const tamanhoLegivel = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return {
    ler, gravar, apagar, novoId, dormir, aleatorio, config, CONFIG_PADRAO,
    montarTexto, primeiroNome, dentroDoHorario, paraMin, hoje, enviosHoje, somarEnvioHoje,
    idDoNumero, numeroDoId, pediuParaSair, semAcento, TIPOS_MIDIA, lerMidia, limparMidiasOrfas,
    tamanhoLegivel, esc,
  };
})();
