// VendaFlow dentro do WhatsApp Web: barra de abas, trilho de ícones, painel lateral e motor do envio em massa.
(() => {
  if (window.top !== window) return;
  const CANAL = 'vendaflow';
  const ORIGEM = location.origin;
  const MEU_TOKEN = VF.novoId(); // identifica esta aba (evita 2 abas enviando ao mesmo tempo)
  const esc = VF.esc;

  // =====================================================================
  // Conversa com a página (pagina.js)
  // =====================================================================
  const pendentes = new Map();
  let seq = 0;

  function rpc(fn, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const limite = setTimeout(() => {
        pendentes.delete(id);
        reject(new Error('O WhatsApp não respondeu a tempo (' + fn + ')'));
      }, 180000);
      pendentes.set(id, { resolve, reject, limite });
      window.postMessage({ canal: CANAL, de: 'extensao', id, fn, args }, ORIGEM);
    });
  }

  let estadoWA = { logado: false };
  let chatAtual = null;

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.canal !== CANAL || d.de !== 'pagina') return;
    if (d.id && pendentes.has(d.id)) {
      const p = pendentes.get(d.id);
      pendentes.delete(d.id);
      clearTimeout(p.limite);
      return d.erro ? p.reject(new Error(d.erro)) : p.resolve(d.resultado);
    }
    if (d.tipo !== 'evento') return;
    if (d.evento === 'estado') {
      estadoWA = d.estado || estadoWA;
      if (estadoWA.logado) carregarEtiquetas();
    } else if (d.evento === 'chatAtivo') {
      chatAtual = d.chat;
      if (secaoAtual === 'contato') desenharLateral();
    } else if (d.evento === 'mensagem') {
      tratarMensagemRecebida(d).catch((e) => console.warn('[VendaFlow]', e));
    }
  });

  // =====================================================================
  // Envio de uma sequência (texto, áudio, vídeo...) para um contato
  // =====================================================================
  async function enviarEtapas(chatId, etapas, dados, opcoes = {}) {
    const digitacao = !!opcoes.digitacao;
    for (let i = 0; i < (etapas || []).length; i++) {
      const e = etapas[i];
      if (i > 0) await VF.dormir(Math.max(0, Number(e.espera ?? 2)) * 1000);
      if (e.tipo === 'texto') {
        const texto = VF.montarTexto(e.texto, dados);
        if (!texto.trim()) continue;
        const ms = digitacao ? Math.min(9000, 1200 + texto.length * 45) * VF.aleatorio(0.8, 1.2) : 0;
        await rpc('enviarTexto', chatId, texto, { digitandoMs: Math.round(ms) });
      } else {
        const dataUrl = await VF.lerMidia(e.midiaId);
        if (!dataUrl) throw new Error('Arquivo não encontrado: ' + (e.nomeArquivo || 'mídia'));
        let ms = 0;
        if (digitacao) ms = e.tipoMidia === 'audio' && e.ptt ? Math.min(15000, (e.duracao || 5) * 1000) : 2500;
        await rpc('enviarArquivo', chatId, dataUrl, {
          tipo: e.tipoMidia,
          legenda: VF.montarTexto(e.legenda || '', dados),
          nomeArquivo: e.nomeArquivo,
          mime: e.mime,
          ptt: !!e.ptt,
          digitandoMs: Math.round(ms),
        });
      }
    }
  }

  // =====================================================================
  // Dados
  // =====================================================================
  let abas = [];
  let respostas = [];
  let etiquetas = [];
  let abaSelecionada = 'todas';

  const idsDaAba = (aba) => [...new Set((aba.chats || []).flatMap((c) => c.ids))];
  const abaTem = (aba, ids) => (aba.chats || []).some((c) => c.ids.some((x) => ids.includes(x)));

  async function alterarAba(abaId, ids, nome, incluir) {
    const lista = await VF.ler('abas', []);
    const aba = lista.find((a) => a.id === abaId);
    if (!aba) return;
    aba.chats = (aba.chats || []).filter((c) => !c.ids.some((x) => ids.includes(x)));
    if (incluir) aba.chats.push({ ids, nome: nome || '', em: Date.now() });
    await VF.gravar('abas', lista);
  }

  async function equivalentes(id) {
    try {
      return await rpc('equivalentes', id);
    } catch (e) {
      return [id];
    }
  }

  async function carregarEtiquetas() {
    try {
      etiquetas = await rpc('etiquetas');
      await VF.gravar('etiquetasCache', etiquetas);
      desenharPilulas();
    } catch (e) { /* ainda carregando */ }
  }

  async function selecionarAba(id) {
    abaSelecionada = id;
    desenharPilulas();
    try {
      if (id === 'todas') return await rpc('filtrarLista', 'all');
      const aba = abas.find((a) => a.id === id);
      if (!aba) return selecionarAba('todas');
      if (aba.tipo === 'etiqueta') return await rpc('filtrarLista', 'labels', String(aba.etiquetaId));
      const ids = idsDaAba(aba);
      await rpc('filtrarLista', 'custom', ids.length ? ids : ['0@c.us']);
      if (!ids.length) avisar(`A aba "${aba.nome}" está vazia. Abra uma conversa e marque a aba no ícone 👤 Contato.`);
    } catch (e) {
      avisar('Não consegui filtrar: ' + e.message, 'erro');
    }
  }

  // =====================================================================
  // Ícones
  // =====================================================================
  const IC = {
    raio: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    aviao: '<svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    funil: '<svg viewBox="0 0 24 24"><path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/></svg>',
    usuario: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
    proibido: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg>',
    engrenagem: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    fechar: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    olho: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    enviar: '<svg viewBox="0 0 24 24"><path d="M4 4l17 8-17 8 3.5-8z"/><path d="M7.5 12H13"/></svg>',
    mais: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    pastaMais: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>',
    lista: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    texto: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
    document: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/></svg>',
    sequencia: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/></svg>',
    categoria: '<svg viewBox="0 0 24 24"><path d="M12 3 7 11h10z"/><circle cx="17" cy="17" r="4"/><rect x="3" y="13" width="8" height="8" rx="1"/></svg>',
    seta: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    voltar: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    pausa: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
    mais2: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    lupa: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  };

  // =====================================================================
  // Estrutura da interface
  // =====================================================================
  document.documentElement.classList.add('vf-ativo');
  const host = document.createElement('div');
  host.id = 'vf-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  document.documentElement.appendChild(host);
  const raiz = host.attachShadow({ mode: 'open' });

  const SECOES = [
    ['contato', 'usuario', 'Contato aberto (abas e etiquetas)'],
    ['respostas', 'raio', 'Respostas rápidas'],
    ['envio', 'aviao', 'Envio em massa'],
    ['abas', 'funil', 'Abas'],
    ['naoperturbe', 'proibido', 'Não perturbe'],
    ['config', 'engrenagem', 'Configurações'],
  ];

  raiz.innerHTML = `
    <header class="topo">
      <button class="logo" data-abrir="respostas" title="VendaFlow">${IC.raio}</button>
      <div class="pilulas" id="pilulas"></div>
      <button class="icone-btn" id="novaAba" title="Criar nova aba">${IC.pastaMais}</button>
      <button class="icone-btn" data-abrir="abas" title="Organizar abas">${IC.lista}</button>
      <button class="status-envio parado" id="statusEnvio">${IC.aviao}<span>Envio em massa</span></button>
    </header>
    <nav class="trilho" id="trilho">
      ${SECOES.map(([s, ic, dica], i) => `<button class="icone-btn" data-abrir="${s}" data-dica="${dica}">${IC[ic]}</button>${i === 0 || i === 3 ? '<div class="separador"></div>' : ''}`).join('')}
      <div class="base">v${chrome.runtime.getManifest().version}</div>
    </nav>
    <aside class="lateral oculto" id="lateral">
      <div class="lat-abas">
        ${SECOES.map(([s, ic, dica]) => `<button class="icone-btn" data-abrir="${s}" title="${dica}">${IC[ic]}</button>`).join('')}
        <button class="icone-btn fechar" id="fechar" title="Fechar">${IC.fechar}</button>
      </div>
      <div class="lat-corpo" id="corpo"></div>
      <div class="lat-rodape oculto" id="rodape"></div>
    </aside>
    <button class="raio oculto" id="raio" title="Respostas rápidas">${IC.raio}</button>
    <div class="pop oculto" id="pop"></div>
    <div class="sugestoes oculto" id="sugestoes"></div>
    <div class="avisos" id="avisos"></div>`;

  const $ = (s) => raiz.querySelector(s);
  const $$ = (s) => [...raiz.querySelectorAll(s)];

  // Estilos (constructable stylesheet: não esbarra na política de segurança do WhatsApp)
  fetch(chrome.runtime.getURL('src/ui.css'))
    .then((r) => r.text())
    .then((css) => {
      const folha = new CSSStyleSheet();
      folha.replaceSync(css);
      raiz.adoptedStyleSheets = [folha];
    })
    .catch((e) => console.warn('[VendaFlow] CSS', e));

  // Tema claro/escuro igual ao do WhatsApp
  function conferirTema() {
    const escuro = document.body && (document.body.classList.contains('dark') || document.documentElement.classList.contains('dark'));
    host.classList.toggle('escuro', !!escuro);
  }
  conferirTema();
  setInterval(conferirTema, 3000);

  function avisar(texto, tipo = 'info', ms = 5000) {
    const el = document.createElement('div');
    el.className = 'aviso ' + tipo;
    el.textContent = texto;
    $('#avisos').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ---- Menu "..." (popover) ----
  function abrirPop(botao, itens) {
    const pop = $('#pop');
    pop.innerHTML = itens.map((it, i) => `<button data-i="${i}" class="${it.perigo ? 'perigo' : ''}">${it.texto}</button>`).join('');
    pop.classList.remove('oculto');
    const r = botao.getBoundingClientRect();
    const larg = pop.offsetWidth || 200;
    pop.style.left = Math.max(8, Math.min(r.right - larg, window.innerWidth - larg - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + 'px';
    pop.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      fecharPop();
      itens[Number(b.dataset.i)].acao();
    };
  }
  const fecharPop = () => $('#pop').classList.add('oculto');
  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes($('#pop'))) fecharPop();
  }, true);
  raiz.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes($('#pop'))) fecharPop();
  });

  // =====================================================================
  // Painel lateral
  // =====================================================================
  let secaoAtual = null;
  let visao = null; // sub-tela: 'editar:<id>', 'nova', 'campanha:<id>'...
  const estadoUI = { busca: '', filtroTipo: 'tudo', fechadas: new Set(), previa: new Set(), filtroContatos: 'todos' };

  function abrirLateral(secao, novaVisao = null) {
    if (secaoAtual === secao && !novaVisao && !$('#lateral').classList.contains('oculto') && visao === null) return fecharLateral();
    secaoAtual = secao;
    visao = novaVisao;
    $('#lateral').classList.remove('oculto');
    document.documentElement.style.setProperty('--vf-direita', '380px');
    $$('[data-abrir]').forEach((b) => b.classList.toggle('ativo', b.dataset.abrir === secao && !b.classList.contains('logo')));
    desenharLateral();
  }
  function fecharLateral() {
    secaoAtual = null;
    visao = null;
    $('#lateral').classList.add('oculto');
    document.documentElement.style.setProperty('--vf-direita', '0px');
    $$('[data-abrir]').forEach((b) => b.classList.remove('ativo'));
  }
  function irPara(novaVisao) {
    visao = novaVisao;
    desenharLateral();
    $('#corpo').scrollTop = 0;
  }

  raiz.addEventListener('click', (e) => {
    const b = e.target.closest('[data-abrir]');
    if (b) abrirLateral(b.dataset.abrir);
  });
  $('#fechar').addEventListener('click', fecharLateral);
  $('#raio').addEventListener('click', () => abrirLateral('respostas'));

  function rodape(html) {
    const r = $('#rodape');
    r.innerHTML = html || '';
    r.classList.toggle('oculto', !html);
  }

  const telas = {};
  async function desenharLateral() {
    if (!secaoAtual) return;
    rodape('');
    const corpo = $('#corpo');
    corpo.onclick = corpo.onchange = corpo.oninput = null; // tira os ouvintes da tela anterior
    try {
      await telas[secaoAtual](corpo);
    } catch (e) {
      $('#corpo').innerHTML = `<div class="alerta">Erro: ${esc(e.message)}</div>`;
    }
  }

  // Telas com formulário não são redesenhadas sozinhas (para não apagar o que a pessoa está digitando)
  const telaComFormulario = () =>
    (secaoAtual === 'respostas' && visao) || (secaoAtual === 'envio' && visao && (visao === 'nova' || visao.startsWith('duplicar:'))) || secaoAtual === 'config' || (secaoAtual === 'abas');

  // =====================================================================
  // TELA: Contato aberto
  // =====================================================================
  telas.contato = async (corpo) => {
    try {
      chatAtual = (await rpc('chatAtivo')) || null;
    } catch (e) { /* usa o último */ }
    if (!chatAtual || chatAtual.grupo) {
      corpo.innerHTML = `<div class="lat-titulo"><h2>Contato</h2></div><div class="vazio">Abra uma conversa (que não seja grupo) para colocar o lead em abas, etiquetas e anotar coisas sobre ele.</div>`;
      return;
    }
    const ids = await equivalentes(chatAtual.id);
    const chaveNota = 'nota:' + (ids.find((x) => x.endsWith('@c.us')) || ids[0]);
    const nota = await VF.ler(chaveNota, '');
    const numero = VF.numeroDoId(ids.find((x) => x.endsWith('@c.us'))) || chatAtual.numero || '';
    const manuais = abas.filter((a) => a.tipo !== 'etiqueta');
    corpo.innerHTML = `
      <div class="perfil"><div class="avatar">${esc((VF.primeiroNome(chatAtual.nome) || '?').charAt(0))}</div>
        <div><b>${esc(chatAtual.nome || numero || 'Contato')}</b><div class="dica">${esc(numero)}</div></div></div>
      <div class="secao-t">Abas</div>
      ${manuais.length ? manuais.map((a) => `<label class="check"><input type="checkbox" data-aba="${esc(a.id)}" ${abaTem(a, ids) ? 'checked' : ''}><span class="pilula-mini" style="color:${esc(a.cor)}">●</span> ${esc(a.nome)}</label>`).join('') : '<div class="dica">Nenhuma aba manual. Crie no ícone de pasta lá em cima.</div>'}
      <div class="secao-t">Etiquetas do WhatsApp</div>
      ${etiquetas.length ? etiquetas.map((t) => `<label class="check"><input type="checkbox" data-etq="${esc(t.id)}" ${chatAtual.etiquetas.includes(t.id) ? 'checked' : ''}><span style="color:${esc(t.cor)}">●</span> ${esc(t.nome)}</label>`).join('') : '<div class="dica">Nenhuma etiqueta encontrada.</div>'}
      <div class="secao-t">Anotações</div>
      <textarea id="nota" placeholder="Ex.: interessado no técnico em enfermagem, retornar sexta">${esc(nota)}</textarea>
      <div class="dica" id="notaSalva"></div>`;
    corpo.onchange = async (e) => {
      const cx = e.target;
      try {
        if (cx.dataset.aba) await alterarAba(cx.dataset.aba, ids, chatAtual.nome, cx.checked);
        if (cx.dataset.etq) {
          await rpc('etiquetar', [chatAtual.id], [{ labelId: cx.dataset.etq, type: cx.checked ? 'add' : 'remove' }]);
          carregarEtiquetas();
        }
      } catch (er) {
        cx.checked = !cx.checked;
        avisar('Não deu certo: ' + er.message, 'erro');
      }
    };
    let t;
    corpo.querySelector('#nota').oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await VF.gravar(chaveNota, e.target.value);
        const s = corpo.querySelector('#notaSalva');
        if (s) s.textContent = 'Salvo ✓';
      }, 500);
    };
  };

  // =====================================================================
  // TELA: Respostas rápidas
  // =====================================================================
  const tipoDaResposta = (r) => {
    const tipos = [...new Set(r.etapas.map((e) => (e.tipo === 'texto' ? 'texto' : e.tipoMidia)))];
    if (tipos.length === 1) return tipos[0];
    return tipos.find((t) => t !== 'texto') || 'texto';
  };
  const temSoTexto = (r) => r.etapas.length === 1 && r.etapas[0].tipo === 'texto';
  const resumoResposta = (r) => r.etapas.map((e) => (e.tipo === 'texto' ? e.texto : '[' + (VF.TIPOS_MIDIA[e.tipoMidia] || 'Arquivo') + ']')).join(' · ');

  async function usarResposta(r, modo) {
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return avisar(e.message, 'erro');
    }
    if (!chat) return avisar('Abra uma conversa primeiro.');
    const cfg = await VF.config();
    const dados = { nome: chat.nome, vendedor: cfg.nomeVendedor };
    try {
      if (modo === 'colar' && temSoTexto(r)) {
        await rpc('colarTexto', VF.montarTexto(r.etapas[0].texto, dados), chat.id);
      } else {
        await enviarEtapas(chat.id, r.etapas, dados, { digitacao: cfg.digitacaoNasRespostas });
      }
      const lista = await VF.ler('respostas', []);
      const x = lista.find((y) => y.id === r.id);
      if (x) {
        x.usos = (x.usos || 0) + 1;
        await VF.gravar('respostas', lista);
      }
    } catch (e) {
      avisar('Não consegui enviar: ' + e.message, 'erro');
    }
  }

  telas.respostas = async (corpo) => {
    if (visao && visao.startsWith('editar:')) return telaEditarResposta(corpo, visao.slice(7));
    const filtros = [['tudo', 'Tudo'], ['texto', 'Texto'], ['audio', 'Áudio'], ['image', 'Imagem'], ['video', 'Vídeo'], ['document', 'Arquivo'], ['usadas', 'Mais usadas']];
    corpo.innerHTML = `
      <div class="busca"><label>${IC.lupa}<input id="busca" placeholder="Pesquisar resposta rápida" value="${esc(estadoUI.busca)}"></label>
        <button class="icone-btn" id="nova" title="Nova resposta" style="background:var(--verde);color:#fff">${IC.mais2}</button></div>
      <div class="chips">${filtros.map(([v, t]) => `<button class="chip ${estadoUI.filtroTipo === v ? 'ativo' : ''}" data-filtro="${v}">${t}</button>`).join('')}</div>
      <div id="listaResp"></div>
      <div class="dica" style="margin-top:12px">💡 Na conversa, digite <code>/</code> + atalho para usar sem tirar a mão do teclado.</div>`;
    const desenharLista = () => {
      const f = VF.semAcento(estadoUI.busca.toLowerCase());
      let lista = respostas.filter((r) => !f || VF.semAcento((r.nome + ' ' + (r.atalho || '') + ' ' + (r.pasta || '') + ' ' + resumoResposta(r)).toLowerCase()).includes(f));
      if (estadoUI.filtroTipo === 'usadas') lista = lista.filter((r) => r.usos).sort((a, b) => b.usos - a.usos).slice(0, 15);
      else if (estadoUI.filtroTipo !== 'tudo') lista = lista.filter((r) => r.etapas.some((e) => (e.tipo === 'texto' ? 'texto' : e.tipoMidia) === estadoUI.filtroTipo));
      const alvo = corpo.querySelector('#listaResp');
      if (!respostas.length) {
        alvo.innerHTML = `<div class="vazio">Você ainda não tem respostas rápidas.<br><br><button class="btn" data-nova>+ Criar a primeira</button></div>`;
        return;
      }
      if (!lista.length) return (alvo.innerHTML = '<div class="vazio">Nada encontrado.</div>');
      const pastas = {};
      lista.forEach((r) => (pastas[r.pasta || 'Sem categoria'] ||= []).push(r));
      // Muitas categorias: começam fechadas (só a primeira aberta), como no modelo
      if (!estadoUI.iniciouCategorias) {
        estadoUI.iniciouCategorias = true;
        const todas = [...new Set(respostas.map((r) => r.pasta || 'Sem categoria'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        if (todas.length > 3) todas.slice(1).forEach((p) => estadoUI.fechadas.add(p));
      }
      const nomes = estadoUI.filtroTipo === 'usadas' ? Object.keys(pastas) : Object.keys(pastas).sort((a, b) => a.localeCompare(b, 'pt-BR'));
      alvo.innerHTML = nomes
        .map((p) => {
          const aberta = f || !estadoUI.fechadas.has(p);
          return `<div class="categoria ${aberta ? 'aberta' : ''}">
            <button class="cat-topo" data-pasta="${esc(p)}"><span class="cat-icone">${IC.categoria}</span><span class="cat-nome">${esc(p)}</span><span class="qtd">${pastas[p].length}</span><span class="seta">${IC.seta}</span></button>
            ${aberta ? pastas[p].map((r) => htmlItemResposta(r)).join('') : ''}</div>`;
        })
        .join('');
    };
    desenharLista();
    corpo.querySelector('#busca').oninput = (e) => {
      estadoUI.busca = e.target.value;
      desenharLista();
    };
    corpo.querySelector('#busca').focus();
    corpo.onclick = (e) => {
      const alvo = e.target.closest('button');
      if (!alvo) return;
      if (alvo.id === 'nova' || alvo.hasAttribute('data-nova')) return irPara('editar:nova');
      if (alvo.dataset.filtro) {
        estadoUI.filtroTipo = alvo.dataset.filtro;
        corpo.querySelectorAll('[data-filtro]').forEach((c) => c.classList.toggle('ativo', c === alvo));
        return desenharLista();
      }
      if (alvo.dataset.pasta !== undefined) {
        const p = alvo.dataset.pasta;
        estadoUI.fechadas.has(p) ? estadoUI.fechadas.delete(p) : estadoUI.fechadas.add(p);
        return desenharLista();
      }
      const r = respostas.find((x) => x.id === alvo.closest('[data-resp]')?.dataset.resp);
      if (!r) return;
      if (alvo.dataset.acao === 'enviar') return usarResposta(r, 'enviar');
      if (alvo.dataset.acao === 'ver') {
        estadoUI.previa.has(r.id) ? estadoUI.previa.delete(r.id) : estadoUI.previa.add(r.id);
        return desenharLista();
      }
      if (alvo.dataset.acao === 'mais') {
        abrirPop(alvo, [
          ...(temSoTexto(r) ? [{ texto: '📝 Colar no campo (para editar)', acao: () => usarResposta(r, 'colar') }] : []),
          { texto: '✏️ Editar', acao: () => irPara('editar:' + r.id) },
          { texto: '📄 Duplicar', acao: () => duplicarResposta(r) },
          { texto: '🗑️ Excluir', perigo: true, acao: () => excluirResposta(r) },
        ]);
      }
    };
  };

  function htmlItemResposta(r) {
    const aberta = estadoUI.previa.has(r.id);
    const previa = aberta
      ? `<div class="previa-resp">${r.etapas
          .map((e) =>
            e.tipo === 'texto'
              ? `<div class="bolha">${esc(e.texto)}</div>`
              : `<div class="arq">${{ audio: '🎤', video: '🎬', image: '🖼️', document: '📄' }[e.tipoMidia]} ${esc(e.nomeArquivo || VF.TIPOS_MIDIA[e.tipoMidia])}${e.legenda ? ' — ' + esc(e.legenda).slice(0, 80) : ''}</div>`
          )
          .join('')}</div>`
      : '';
    return `<div data-resp="${esc(r.id)}"><div class="item">
      <span class="tipo">${IC[r.etapas.length > 1 ? 'sequencia' : tipoDaResposta(r)] || IC.texto}</span>
      <span class="nome" title="${esc(resumoResposta(r)).slice(0, 300)}">${esc(r.nome)}${r.atalho ? `<code>/${esc(r.atalho)}</code>` : ''}</span>
      <button class="icone-btn" data-acao="mais" title="Mais opções">${IC.mais}</button>
      <button class="icone-btn" data-acao="ver" title="Ver conteúdo">${IC.olho}</button>
      <button class="icone-btn enviar" data-acao="enviar" title="Enviar na conversa aberta">${IC.enviar}</button>
    </div>${previa}</div>`;
  }

  async function duplicarResposta(r) {
    const lista = await VF.ler('respostas', []);
    lista.push({ ...JSON.parse(JSON.stringify(r)), id: VF.novoId(), nome: r.nome + ' (cópia)', atalho: '', usos: 0 });
    await VF.gravar('respostas', lista);
  }
  async function excluirResposta(r) {
    if (!confirm(`Excluir a resposta "${r.nome}"?`)) return;
    await VF.gravar('respostas', (await VF.ler('respostas', [])).filter((x) => x.id !== r.id));
    VF.limparMidiasOrfas();
  }

  function telaEditarResposta(corpo, id) {
    const r = respostas.find((x) => x.id === id) || { id: VF.novoId(), nome: '', atalho: '', pasta: '', etapas: [{ tipo: 'texto', texto: '', espera: 2 }] };
    const pastas = [...new Set(respostas.map((x) => x.pasta).filter(Boolean))];
    corpo.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${id === 'nova' ? 'Nova resposta' : 'Editar resposta'}</h2></div>
      <label class="campo">Nome<input type="text" id="nome" value="${esc(r.nome)}" placeholder="Ex.: 1 - Olá / qual seu nome"></label>
      <div class="duas">
        <label class="campo">Categoria<input type="text" id="pasta" list="vfPastas" value="${esc(r.pasta || '')}" placeholder="Ex.: Técnico em Informática">
          <datalist id="vfPastas">${pastas.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
        <label class="campo">Atalho<input type="text" id="atalho" value="${esc(r.atalho || '')}" placeholder="ola"></label>
      </div>
      <div class="secao-t">O que enviar</div>
      <div id="etapas"></div>`;
    rodape(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="salvar">Salvar</button>`);
    const editor = EditorEtapas(corpo.querySelector('#etapas'), r.etapas, null, { semPrevia: true });
    corpo.querySelector('#voltar').onclick = () => irPara(null);
    $('#teste').onclick = async () => {
      const erro = editor.validar();
      if (erro) return avisar(erro, 'erro');
      try {
        await enviarParaMim(editor.valor());
        avisar('Enviado para o seu próprio número. Confira em "Mensagens para mim".', 'ok');
      } catch (e) {
        avisar(e.message, 'erro');
      }
    };
    $('#salvar').onclick = async () => {
      const nome = corpo.querySelector('#nome').value.trim();
      const atalho = corpo.querySelector('#atalho').value.trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
      if (!nome) return avisar('Dê um nome para a resposta.', 'erro');
      const erro = editor.validar();
      if (erro) return avisar(erro, 'erro');
      if (!editor.valor().length) return avisar('Adicione pelo menos uma mensagem.', 'erro');
      const lista = await VF.ler('respostas', []);
      if (atalho && lista.some((x) => x.atalho === atalho && x.id !== r.id)) return avisar(`Já existe uma resposta com o atalho /${atalho}.`, 'erro');
      const nova = { ...r, nome, atalho, pasta: corpo.querySelector('#pasta').value.trim(), etapas: editor.valor() };
      const i = lista.findIndex((x) => x.id === r.id);
      if (i >= 0) lista[i] = nova;
      else lista.push(nova);
      await VF.gravar('respostas', lista);
      respostas = lista;
      avisar('Resposta salva.', 'ok');
      irPara(null);
    };
  }

  async function enviarParaMim(etapas) {
    const eu = await rpc('meuId');
    if (!eu) throw new Error('Não achei o seu número.');
    const cfg = await VF.config();
    await enviarEtapas(eu, etapas, { nome: 'Maria Teste', vendedor: cfg.nomeVendedor }, { digitacao: false });
  }

  // =====================================================================
  // TELA: Envio em massa
  // =====================================================================
  const NOME_STATUS = { ativa: 'Enviando', pausada: 'Pausada', concluida: 'Concluída', cancelada: 'Cancelada' };
  const NOME_CONTATO = { pendente: 'Na fila', enviando: 'Enviando', enviado: 'Enviado', falhou: 'Falhou', pulado: 'Pulado' };

  async function lerCampanhas() {
    const ids = await VF.ler('campanhas', []);
    const r = await chrome.storage.local.get(ids.map((id) => 'campanha:' + id));
    return ids.map((id) => r['campanha:' + id]).filter(Boolean);
  }

  function contar(c) {
    const n = { total: c.contatos.length, enviado: 0, falhou: 0, pulado: 0, pendente: 0, respondeu: 0 };
    c.contatos.forEach((x) => {
      n[x.status === 'enviando' ? 'pendente' : x.status]++;
      if (x.respondeu) n.respondeu++;
    });
    n.feitos = n.total - n.pendente;
    return n;
  }

  async function mudarStatus(id, status) {
    const c = await VF.ler('campanha:' + id);
    c.status = status;
    c.motivo = '';
    await VF.gravar('campanha:' + id, c);
    if (status === 'ativa') setTimeout(passoDoMotor, 300);
  }

  telas.envio = async (corpo) => {
    if (visao === 'nova' || (visao && visao.startsWith('duplicar:'))) return telaNovaCampanha(corpo, visao.startsWith('duplicar:') ? visao.slice(9) : null);
    if (visao && visao.startsWith('campanha:')) return telaCampanha(corpo, visao.slice(9));
    const [campanhas, cfg, hojeN] = await Promise.all([lerCampanhas(), VF.config(), VF.enviosHoje()]);
    const ordem = campanhas.reverse();
    corpo.innerHTML = `
      <div class="lat-titulo"><h2>Envio em massa</h2><span class="dica">Hoje: <b>${hojeN}</b>/${cfg.limiteDia}</span></div>
      <button class="btn" id="nova" style="width:100%;margin-bottom:12px">${IC.mais2} Nova campanha</button>
      ${statusAtual.tipo !== 'parado' ? `<div class="ok-box">${esc(textoStatus())}</div>` : ''}
      ${
        ordem.length
          ? ordem
              .map((c) => {
                const n = contar(c);
                const pct = n.total ? Math.round((n.feitos / n.total) * 100) : 0;
                return `<div class="cartao" data-camp="${esc(c.id)}" style="cursor:pointer">
                  <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(c.nome)}</b><span class="etq ${c.status}">${NOME_STATUS[c.status]}</span></div>
                  <div class="progresso"><div style="width:${pct}%"></div></div>
                  <div class="dica">${n.feitos}/${n.total} · ✅ ${n.enviado} · 💬 ${n.respondeu} · ⏭ ${n.pulado} · ❌ ${n.falhou}</div>
                  ${c.motivo && c.status === 'pausada' ? `<div class="dica" style="color:var(--vermelho)">${esc(c.motivo)}</div>` : ''}
                </div>`;
              })
              .join('')
          : `<div class="vazio">Nenhuma campanha ainda.<br>Crie uma para mandar mensagem para vários leads, devagar e em segundo plano.</div>`
      }
      <div class="dica">Ritmo: ${cfg.intervaloMin}–${cfg.intervaloMax}s entre leads, pausa a cada ${cfg.loteTamanho}${cfg.usarHorario ? `, das ${cfg.horaInicio} às ${cfg.horaFim}` : ''}. <button class="link" data-abrir="config">mudar</button></div>`;
    corpo.onclick = (e) => {
      if (e.target.closest('#nova')) return irPara('nova');
      const c = e.target.closest('[data-camp]');
      if (c) irPara('campanha:' + c.dataset.camp);
    };
  };

  async function telaCampanha(corpo, id) {
    const c = await VF.ler('campanha:' + id);
    if (!c) return irPara(null);
    const n = contar(c);
    const pct = n.total ? Math.round((n.feitos / n.total) * 100) : 0;
    const f = estadoUI.filtroContatos;
    const visiveis = c.contatos.filter((x) => f === 'todos' || (f === 'respondeu' ? x.respondeu : x.status === f));
    const aindaNaoEnviou = c.status === 'concluida' && n.enviado === 0;
    corpo.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${esc(c.nome)}</h2><span class="etq ${c.status}">${NOME_STATUS[c.status]}</span></div>
      ${c.motivo && c.status === 'pausada' ? `<div class="alerta">${esc(c.motivo)}</div>` : ''}
      ${aindaNaoEnviou ? `<div class="alerta">Nenhuma mensagem foi enviada. Veja abaixo o motivo de cada contato (coluna da direita).</div>` : ''}
      ${c.status === 'ativa' && c.id === statusAtual.campanhaId ? `<div class="ok-box">${esc(textoStatus())}</div>` : ''}
      <div class="progresso"><div style="width:${pct}%"></div></div>
      <div class="numeros">
        <div><b>${n.enviado}</b><span>enviados</span></div><div><b>${n.respondeu}</b><span>responderam</span></div>
        <div><b>${n.pendente}</b><span>na fila</span></div><div><b>${n.pulado + n.falhou}</b><span>pulados/falhas</span></div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">
        ${c.status === 'ativa' ? `<button class="btn sec peq" data-acao="pausar">${IC.pausa} Pausar</button>` : ''}
        ${c.status === 'pausada' ? `<button class="btn peq" data-acao="retomar">${IC.play} Retomar</button>` : ''}
        ${n.falhou + n.pulado && c.status !== 'cancelada' ? '<button class="btn sec peq" data-acao="refazer">Tentar de novo pulados/falhas</button>' : ''}
        <button class="btn sec peq" data-acao="duplicar">Duplicar</button>
        <button class="btn sec peq" data-acao="csv">Planilha</button>
        ${['ativa', 'pausada'].includes(c.status) ? '<button class="btn perigo peq" data-acao="cancelar">Cancelar</button>' : '<button class="btn perigo peq" data-acao="excluir">Excluir</button>'}
      </div>
      <div class="chips">${['todos', 'pendente', 'enviado', 'respondeu', 'pulado', 'falhou']
        .map((x) => `<button class="chip ${f === x ? 'ativo' : ''}" data-fc="${x}">${x === 'todos' ? 'Todos' : x === 'respondeu' ? 'Responderam' : NOME_CONTATO[x]}</button>`)
        .join('')}</div>
      <div>${visiveis
        .slice(0, 500)
        .map(
          (x) => `<div class="contato-linha"><div class="cresce"><div>${esc(x.nome || VF.numeroDoId(x.id) || x.id.split('@')[0])}${x.respondeu ? ' 💬' : ''}</div>
            ${x.erro ? `<small>${esc(x.erro)}</small>` : x.em ? `<small>${new Date(x.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>` : ''}</div>
            <span class="etq ${x.status}">${NOME_CONTATO[x.status] || x.status}</span></div>`
        )
        .join('') || '<div class="vazio">Ninguém aqui.</div>'}</div>`;
    corpo.onclick = async (e) => {
      if (e.target.closest('#voltar')) return irPara(null);
      const fc = e.target.closest('[data-fc]');
      if (fc) {
        estadoUI.filtroContatos = fc.dataset.fc;
        return desenharLateral();
      }
      const acao = e.target.closest('[data-acao]')?.dataset.acao;
      if (!acao) return;
      if (acao === 'pausar') await mudarStatus(id, 'pausada');
      if (acao === 'retomar') await mudarStatus(id, 'ativa');
      if (acao === 'cancelar' && confirm('Cancelar a campanha? Quem ainda não recebeu não vai receber.')) await mudarStatus(id, 'cancelada');
      if (acao === 'refazer') {
        const atual = await VF.ler('campanha:' + id);
        atual.contatos.forEach((x) => ['falhou', 'pulado'].includes(x.status) && x.erro !== 'Número sem WhatsApp' && !/não receber/.test(x.erro || '') && Object.assign(x, { status: 'pendente', erro: '', ignorarRecente: true }));
        atual.status = 'ativa';
        atual.motivo = '';
        await VF.gravar('campanha:' + id, atual);
        avisar('Voltaram para a fila e o envio recomeçou.', 'ok');
      }
      if (acao === 'duplicar') return irPara('duplicar:' + id);
      if (acao === 'csv') return baixarCSV(c);
      if (acao === 'excluir' && confirm('Excluir a campanha e o histórico dela?')) {
        await VF.apagar('campanha:' + id);
        await VF.gravar('campanhas', (await VF.ler('campanhas', [])).filter((x) => x !== id));
        VF.limparMidiasOrfas();
        return irPara(null);
      }
      desenharLateral();
    };
  }

  function baixarCSV(c) {
    const linhas = [['nome', 'numero', 'situacao', 'respondeu', 'quando', 'observacao']];
    c.contatos.forEach((x) =>
      linhas.push([x.nome || '', (x.id.match(/^(\d+)@c\.us$/) || [])[1] || x.id, NOME_CONTATO[x.status] || x.status, x.respondeu ? 'sim' : '', x.em ? new Date(x.em).toLocaleString('pt-BR') : '', x.erro || ''])
    );
    const csv = '﻿' + linhas.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `campanha-${c.nome.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
  }

  async function telaNovaCampanha(corpo, idBase) {
    const base = idBase ? await VF.ler('campanha:' + idBase) : null;
    const cfg = await VF.config();
    const manuais = abas.filter((a) => a.tipo !== 'etiqueta');
    const opAbas = (vazio) => `<option value="">${vazio}</option>` + manuais.map((a) => `<option value="${esc(a.id)}">${esc(a.nome)} (${(a.chats || []).length})</option>`).join('');
    const opEtiq = (vazio) => `<option value="">${vazio}</option>` + etiquetas.map((e) => `<option value="${esc(e.id)}">${esc(e.nome)} (${e.total})</option>`).join('');
    const checksEtiq = (nome) =>
      etiquetas.length ? etiquetas.map((e) => `<label class="check"><input type="checkbox" name="${nome}" value="${esc(e.id)}"><span style="color:${esc(e.cor)}">●</span> ${esc(e.nome)}</label>`).join('') : '<div class="dica">Nenhuma etiqueta.</div>';

    corpo.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>Nova campanha</h2></div>
      <label class="campo">Nome da campanha<input type="text" id="nome" placeholder="Ex.: Black November – leads de outubro" value="${esc(base ? base.nome + ' (2)' : '')}"></label>

      <div class="cartao"><h3><span class="passo">1</span>Para quem?</h3>
        <select id="origem">
          <option value="etiqueta">Quem tem uma etiqueta</option>
          <option value="aba">Quem está em uma aba</option>
          <option value="todas">Todas as conversas</option>
          <option value="lista">Colar uma lista de números</option>
        </select>
        <div style="margin-top:8px">
          <select id="origemEtiqueta" data-o="etiqueta">${opEtiq('Escolha a etiqueta…')}</select>
          <select id="origemAba" data-o="aba" class="oculto">${opAbas('Escolha a aba…')}</select>
          <textarea id="origemLista" data-o="lista" class="oculto" placeholder="Um número por linha (pode ter o nome depois de ; )&#10;11999998888;Maria&#10;21988887777;João"></textarea>
        </div>
        <div id="publico" class="dica" style="margin-top:8px"></div>
      </div>

      <div class="cartao"><h3><span class="passo">2</span>O que enviar?</h3>
        <select id="usarResp" style="margin-bottom:10px"><option value="">✍️ Escrever aqui</option>${respostas.map((r) => `<option value="${esc(r.id)}">⚡ ${esc((r.pasta ? r.pasta + ' › ' : '') + r.nome)}</option>`).join('')}</select>
        <div id="etapas"></div>
        <div class="dica" style="margin-top:8px">Dica: <code>{Oi|Olá|E aí}</code> sorteia uma opção para cada lead e <code>{primeiro_nome}</code> coloca o nome. Isso ajuda a evitar bloqueio.</div>
      </div>

      <details class="cartao"><summary>Mais opções (etiquetas, abas e filtros)</summary>
        <div class="secao-t">Depois de enviar, colocar etiqueta</div>${checksEtiq('addEtiq')}
        <div class="secao-t">Depois de enviar, tirar etiqueta</div>${checksEtiq('remEtiq')}
        <div class="duas" style="margin-top:10px">
          <label class="campo">Depois de enviar, pôr na aba<select id="addAba">${opAbas('—')}</select></label>
          <label class="campo">Depois de enviar, tirar da aba<select id="remAba">${opAbas('—')}</select></label>
        </div>
        <div class="duas">
          <label class="campo">Se responder, pôr na aba<select id="respAba">${opAbas('—')}</select></label>
          <label class="campo">Se responder, pôr etiqueta<select id="respEtiq">${opEtiq('—')}</select></label>
        </div>
        <div class="secao-t">Filtros</div>
        <div class="duas">
          <label class="campo">Última conversa há pelo menos<input type="number" id="minDias" min="0" placeholder="dias"></label>
          <label class="campo">Última conversa há no máximo<input type="number" id="maxDias" min="0" placeholder="dias"></label>
        </div>
        <label class="campo">Pular quem conversou com você nas últimas (horas)<input type="number" id="recente" min="0" value="${base ? base.pularRecenteHoras || 0 : 0}"><small>0 = não pular ninguém. Use para não mandar campanha para quem está em atendimento agora.</small></label>
        <div class="secao-t">Não enviar para quem tem a etiqueta</div>${checksEtiq('exclEtiq')}
      </details>
      <div id="estimativa" class="dica"></div>`;
    rodape(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="criar">${IC.play} Começar envio</button>`);

    const editor = EditorEtapas(corpo.querySelector('#etapas'), base ? base.etapas : [{ tipo: 'texto', texto: '', espera: 2 }], null, { semPrevia: true });
    const q = (s) => corpo.querySelector(s);
    const qq = (s) => [...corpo.querySelectorAll(s)];
    let publico = null;

    if (base) {
      const a = base.acoes || {};
      q('#addAba').value = a.addAba || '';
      q('#remAba').value = a.removerAba || '';
      (a.addEtiquetas || []).forEach((v) => qq('input[name=addEtiq]').find((x) => x.value === v)?.click());
      (a.removerEtiquetas || []).forEach((v) => qq('input[name=remEtiq]').find((x) => x.value === v)?.click());
      q('#respAba').value = (base.aoResponder || {}).addAba || '';
      q('#respEtiq').value = (base.aoResponder || {}).addEtiqueta || '';
      if (base.origem) {
        q('#origem').value = base.origem.tipo;
        if (base.origem.tipo === 'aba') q('#origemAba').value = base.origem.valor || '';
        if (base.origem.tipo === 'etiqueta') q('#origemEtiqueta').value = base.origem.valor || '';
      }
    } else if (!etiquetas.length) {
      q('#origem').value = manuais.length ? 'aba' : 'lista';
    }

    async function montarPublico() {
      const origem = q('#origem').value;
      const minDias = Number(q('#minDias').value) || 0;
      const maxDias = Number(q('#maxDias').value) || 0;
      const excl = qq('input[name=exclEtiq]:checked').map((x) => x.value);
      const naoPerturbe = await VF.ler('naoPerturbe', []);
      const bloqueados = new Set(naoPerturbe.flatMap((n) => n.ids));
      let candidatos = [];
      let chats = null;
      if (origem === 'etiqueta' && !q('#origemEtiqueta').value) return null;
      if (origem === 'aba' && !q('#origemAba').value) return null;
      if (origem === 'lista' && !q('#origemLista').value.trim()) return null;
      const precisaWA = origem === 'etiqueta' || origem === 'todas' || minDias || maxDias || excl.length;
      if (precisaWA) chats = await rpc('listarChats', origem === 'etiqueta' ? { etiqueta: q('#origemEtiqueta').value } : {});

      let invalidos = 0;
      if (origem === 'aba') {
        const aba = abas.find((a) => a.id === q('#origemAba').value);
        const mapa = new Map((chats || []).map((c) => [c.id, c]));
        candidatos = (aba.chats || []).map((c) => {
          const info = c.ids.map((x) => mapa.get(x)).find(Boolean);
          return { id: c.ids.find((x) => x.endsWith('@c.us')) || c.ids[0], ids: c.ids, nome: (info && info.nome) || c.nome, t: info ? info.t : 0, etiquetas: info ? info.etiquetas : [], semInfo: !info };
        });
      } else if (origem === 'etiqueta' || origem === 'todas') {
        candidatos = chats.map((c) => ({ ...c, ids: [c.id] }));
      } else {
        for (const l of q('#origemLista').value.split('\n').map((x) => x.trim()).filter(Boolean)) {
          const [num, ...resto] = l.split(/[;,\t]/);
          const id = VF.idDoNumero(num);
          if (!id) invalidos++;
          else candidatos.push({ id, ids: [id], nome: resto.join(' ').trim(), t: 0, etiquetas: [], lista: true });
        }
      }
      const agora = Date.now();
      const vistos = new Set();
      const contatos = [];
      const fora = { bloqueados: 0, filtro: 0, repetidos: 0, invalidos };
      for (const c of candidatos) {
        if (c.ids.some((x) => vistos.has(x))) { fora.repetidos++; continue; }
        c.ids.forEach((x) => vistos.add(x));
        if (c.ids.some((x) => bloqueados.has(x))) { fora.bloqueados++; continue; }
        const dias = c.t ? (agora - c.t * 1000) / 86400000 : null;
        if (!c.lista && !c.semInfo) {
          if (minDias && dias !== null && dias < minDias) { fora.filtro++; continue; }
          if (maxDias && (dias === null || dias > maxDias)) { fora.filtro++; continue; }
          if (excl.length && c.etiquetas.some((e) => excl.includes(e))) { fora.filtro++; continue; }
        }
        contatos.push({ id: c.id, ids: c.ids, nome: c.nome || '', status: 'pendente', verificado: !c.lista });
      }
      return { contatos, fora };
    }

    function estimar(qtd) {
      const medioSeg = (cfg.intervaloMin + cfg.intervaloMax) / 2 + 10;
      const pausas = Math.floor(qtd / cfg.loteTamanho) * ((cfg.pausaLoteMin + cfg.pausaLoteMax) / 2) * 60;
      const horas = (qtd * medioSeg + pausas) / 3600;
      const dias = Math.ceil(qtd / cfg.limiteDia);
      return `⏱ Leva cerca de ${horas < 1 ? Math.max(1, Math.round(horas * 60)) + ' min' : horas.toFixed(1).replace('.', ',') + ' h'}${dias > 1 ? ` (${dias} dias, pelo limite de ${cfg.limiteDia}/dia)` : ''}. Pode continuar usando o WhatsApp normalmente.`;
    }

    let timer;
    async function atualizarPublico() {
      const origem = q('#origem').value;
      qq('[data-o]').forEach((el) => el.classList.toggle('oculto', el.dataset.o !== origem));
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const alvo = q('#publico');
        alvo.textContent = 'Contando…';
        try {
          publico = await montarPublico();
          if (!publico) {
            alvo.textContent = '';
            q('#estimativa').textContent = '';
            return;
          }
          const fora = publico.fora;
          const motivos = [fora.bloqueados && `${fora.bloqueados} no Não perturbe`, fora.filtro && `${fora.filtro} pelos filtros`, fora.repetidos && `${fora.repetidos} repetidos`, fora.invalidos && `${fora.invalidos} números inválidos`].filter(Boolean);
          const nomes = publico.contatos.slice(0, 5).map((c) => c.nome || VF.numeroDoId(c.id) || c.id.split('@')[0]);
          alvo.innerHTML = `<b style="color:var(--verde-txt);font-size:14px">👥 ${publico.contatos.length} lead(s) vão receber</b>
            ${nomes.length ? `<div>${esc(nomes.join(', '))}${publico.contatos.length > 5 ? '…' : ''}</div>` : ''}${motivos.length ? `<div>Fora: ${motivos.join(', ')}</div>` : ''}`;
          q('#estimativa').textContent = publico.contatos.length ? estimar(publico.contatos.length) : '';
        } catch (e) {
          publico = null;
          alvo.innerHTML = `<span style="color:var(--vermelho)">${esc(e.message)}</span>`;
        }
      }, 400);
    }
    corpo.oninput = corpo.onchange = (e) => {
      if (e.target.closest('#etapas') || e.target.id === 'nome' || e.target.id === 'usarResp') return;
      if (['addAba', 'remAba', 'respAba', 'respEtiq', 'recente'].includes(e.target.id) || ['addEtiq', 'remEtiq'].includes(e.target.name)) return;
      atualizarPublico();
    };
    q('#usarResp').onchange = (e) => {
      const r = respostas.find((x) => x.id === e.target.value);
      if (r) editor.definir(r.etapas);
    };
    q('#voltar').onclick = () => irPara(null);
    atualizarPublico();

    $('#teste').onclick = async () => {
      const erro = editor.validar();
      if (erro) return avisar(erro, 'erro');
      try {
        await enviarParaMim(editor.valor());
        avisar('Teste enviado para você (com o nome "Maria Teste").', 'ok');
      } catch (e) {
        avisar(e.message, 'erro');
      }
    };
    $('#criar').onclick = async () => {
      const nome = q('#nome').value.trim() || 'Campanha ' + new Date().toLocaleDateString('pt-BR');
      if (!publico) return avisar('Escolha para quem enviar (passo 1).', 'erro');
      if (!publico.contatos.length) return avisar('Ninguém para receber com essas opções.', 'erro');
      const erro = editor.validar();
      if (erro) return avisar(erro, 'erro');
      const etapas = editor.valor();
      const acoes = {
        addAba: q('#addAba').value,
        removerAba: q('#remAba').value,
        addEtiquetas: qq('input[name=addEtiq]:checked').map((x) => x.value),
        removerEtiquetas: qq('input[name=remEtiq]:checked').map((x) => x.value),
      };
      const temAcao = acoes.addAba || acoes.removerAba || acoes.addEtiquetas.length || acoes.removerEtiquetas.length;
      if (!etapas.length && !temAcao) return avisar('Coloque o que enviar (passo 2).', 'erro');
      if (!confirm(`Começar a enviar para ${publico.contatos.length} lead(s)?\n\nO envio é lento de propósito (${cfg.intervaloMin}–${cfg.intervaloMax}s entre cada um) e segue em segundo plano.`)) return;
      const origem = q('#origem').value;
      const c = {
        id: VF.novoId(),
        nome,
        criadaEm: Date.now(),
        status: 'ativa',
        motivo: '',
        origem: { tipo: origem, valor: origem === 'aba' ? q('#origemAba').value : origem === 'etiqueta' ? q('#origemEtiqueta').value : '' },
        etapas,
        acoes,
        aoResponder: { addAba: q('#respAba').value, addEtiqueta: q('#respEtiq').value },
        pularRecenteHoras: Number(q('#recente').value) || 0,
        contatos: publico.contatos,
      };
      await VF.gravar('campanha:' + c.id, c);
      await VF.gravar('campanhas', [...(await VF.ler('campanhas', [])), c.id]);
      // A primeira mensagem sai logo (não espera o intervalo de uma campanha anterior)
      const motor = await VF.ler('motor', { proximoEm: 0, noLote: 0, falhasSeguidas: 0 });
      const outraAtiva = (await lerCampanhas()).some((x) => x.status === 'ativa' && x.id !== c.id);
      if (!outraAtiva) await VF.gravar('motor', { ...motor, proximoEm: 0 });
      avisar('Campanha criada! A primeira mensagem sai em instantes.', 'ok');
      irPara('campanha:' + c.id);
      setTimeout(passoDoMotor, 300);
    };
  }

  // =====================================================================
  // TELA: Abas
  // =====================================================================
  const CORES = ['#25d366', '#34b7f1', '#f5a623', '#e91e63', '#9c27b0', '#ff5722', '#607d8b', '#00bfa5'];

  telas.abas = async (corpo) => {
    corpo.innerHTML = `
      <div class="lat-titulo"><h2>Abas</h2><button class="btn peq" id="nova">${IC.mais2} Nova aba</button></div>
      <div class="dica" style="margin-bottom:10px">As abas aparecem no topo e filtram a lista de conversas.
        <b>Manual</b>: você coloca o lead (ícone 👤 com a conversa aberta). <b>Etiqueta</b>: mostra quem tem a etiqueta.</div>
      ${
        abas.length
          ? abas
              .map(
                (a, i) => `<div class="cartao" data-id="${esc(a.id)}">
            <div class="linha-aba" style="border:0;padding:0">
              <input type="color" data-campo="cor" value="${esc(a.cor || '#25d366')}">
              <input type="text" data-campo="nome" value="${esc(a.nome)}">
              <button class="icone-btn" data-mover="-1" ${i === 0 ? 'disabled' : ''} title="Para a esquerda" style="transform:rotate(90deg)">${IC.seta}</button>
              <button class="icone-btn" data-mover="1" ${i === abas.length - 1 ? 'disabled' : ''} title="Para a direita" style="transform:rotate(-90deg)">${IC.seta}</button>
              <button class="icone-btn" data-del title="Excluir">${IC.fechar}</button>
            </div>
            <div class="duas" style="margin-top:8px">
              <select data-campo="tipo"><option value="manual" ${a.tipo !== 'etiqueta' ? 'selected' : ''}>Manual</option><option value="etiqueta" ${a.tipo === 'etiqueta' ? 'selected' : ''}>Etiqueta</option></select>
              ${
                a.tipo === 'etiqueta'
                  ? `<select data-campo="etiquetaId"><option value="">Escolha…</option>${etiquetas.map((e) => `<option value="${esc(e.id)}" ${String(a.etiquetaId) === e.id ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')}</select>`
                  : `<span class="dica" style="align-self:center">${(a.chats || []).length} lead(s)</span>`
              }
            </div>
            ${
              a.tipo !== 'etiqueta' && (a.chats || []).length
                ? `<details><summary>Ver leads</summary>${a.chats
                    .map((c, j) => `<div class="contato-linha"><div class="cresce">${esc(c.nome || VF.numeroDoId(c.ids.find((x) => x.endsWith('@c.us'))) || c.ids[0])}</div><button class="link" data-tirar="${j}">tirar</button></div>`)
                    .join('')}</details>`
                : ''
            }</div>`
              )
              .join('')
          : '<div class="vazio">Nenhuma aba ainda.</div>'
      }`;
    const salvar = async () => VF.gravar('abas', abas);
    corpo.onchange = async (e) => {
      const caixa = e.target.closest('[data-id]');
      const campo = e.target.dataset.campo;
      if (!caixa || !campo) return;
      const a = abas.find((x) => x.id === caixa.dataset.id);
      a[campo] = e.target.value;
      await salvar();
      if (campo === 'tipo') desenharLateral();
    };
    corpo.onclick = async (e) => {
      if (e.target.closest('#nova')) {
        abas.push({ id: VF.novoId(), nome: 'Nova aba', cor: CORES[abas.length % CORES.length], tipo: 'manual', chats: [] });
        await salvar();
        await desenharLateral();
        const campos = corpo.querySelectorAll('input[data-campo=nome]');
        campos[campos.length - 1]?.select();
        return;
      }
      const caixa = e.target.closest('[data-id]');
      if (!caixa) return;
      const i = abas.findIndex((x) => x.id === caixa.dataset.id);
      if (e.target.closest('[data-del]')) {
        if (!confirm(`Excluir a aba "${abas[i].nome}"? Os leads continuam no WhatsApp.`)) return;
        abas.splice(i, 1);
      } else if (e.target.closest('[data-mover]')) {
        const j = i + Number(e.target.closest('[data-mover]').dataset.mover);
        [abas[i], abas[j]] = [abas[j], abas[i]];
      } else if (e.target.closest('[data-tirar]')) {
        abas[i].chats.splice(Number(e.target.closest('[data-tirar]').dataset.tirar), 1);
      } else return;
      await salvar();
      desenharLateral();
    };
  };

  // =====================================================================
  // TELA: Não perturbe
  // =====================================================================
  telas.naoperturbe = async (corpo) => {
    const lista = await VF.ler('naoPerturbe', []);
    const cfg = await VF.config();
    corpo.innerHTML = `
      <div class="lat-titulo"><h2>Não perturbe</h2></div>
      <div class="dica" style="margin-bottom:10px">Quem está aqui nunca recebe envio em massa. Entra sozinho quando responde só com: ${cfg.palavrasSair.slice(0, 5).map((p) => `<code>${esc(p)}</code>`).join(' ')}…</div>
      <div class="busca" style="margin-bottom:12px"><label><input id="num" placeholder="Adicionar número, ex.: 11999998888"></label><button class="btn" id="add">Adicionar</button></div>
      ${
        lista.length
          ? lista
              .map(
                (n, i) => `<div class="contato-linha"><div class="cresce"><div>${esc(n.nome || VF.numeroDoId(n.ids.find((x) => x.endsWith('@c.us'))) || n.ids[0])}</div>
            <small>${n.texto ? 'Respondeu "' + esc(n.texto) + '" · ' : ''}${new Date(n.em).toLocaleDateString('pt-BR')}</small></div><button class="link" data-i="${i}">remover</button></div>`
              )
              .join('')
          : '<div class="vazio">Ninguém na lista.</div>'
      }`;
    corpo.onclick = async (e) => {
      if (e.target.closest('#add')) {
        const id = VF.idDoNumero(corpo.querySelector('#num').value);
        if (!id) return avisar('Número inválido.', 'erro');
        lista.push({ ids: [id, id.replace(/^55(\d\d)9(\d{8})@/, '55$1$2@')], nome: '', texto: '', em: Date.now() });
      } else if (e.target.closest('[data-i]')) {
        if (!confirm('Remover da lista? Ele volta a poder receber envios em massa.')) return;
        lista.splice(Number(e.target.closest('[data-i]').dataset.i), 1);
      } else return;
      await VF.gravar('naoPerturbe', lista);
      desenharLateral();
    };
  };

  // =====================================================================
  // TELA: Configurações (+ backup)
  // =====================================================================
  telas.config = async (corpo) => {
    const c = await VF.config();
    const dias = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
    const num = (id, rot, min = 1) => `<label class="campo">${rot}<input type="number" id="${id}" min="${min}" value="${c[id]}"></label>`;
    corpo.innerHTML = `
      <div class="lat-titulo"><h2>Configurações</h2></div>
      <label class="campo">Seu nome<input type="text" id="nomeVendedor" value="${esc(c.nomeVendedor)}" placeholder="Ex.: Victor"><small>Vai no lugar de {vendedor}.</small></label>
      <div class="secao-t">Ritmo do envio em massa</div>
      <div class="duas">${num('intervaloMin', 'Espera mín. (seg)', 5)}${num('intervaloMax', 'Espera máx. (seg)', 5)}</div>
      <div class="duas">${num('loteTamanho', 'Pausa longa a cada')}${num('limiteDia', 'Limite por dia')}</div>
      <div class="duas">${num('pausaLoteMin', 'Pausa longa mín. (min)')}${num('pausaLoteMax', 'Pausa longa máx. (min)')}</div>
      ${num('maxFalhasSeguidas', 'Pausar a campanha após X falhas seguidas')}
      <label class="check"><input type="checkbox" id="simularDigitacao" ${c.simularDigitacao ? 'checked' : ''}> Mostrar "digitando…" / "gravando áudio…" antes</label>
      <div class="secao-t">Horário</div>
      <label class="check"><input type="checkbox" id="usarHorario" ${c.usarHorario ? 'checked' : ''}> Só enviar neste horário</label>
      <div class="duas"><label class="campo">Das<input type="time" id="horaInicio" value="${c.horaInicio}"></label><label class="campo">Até<input type="time" id="horaFim" value="${c.horaFim}"></label></div>
      <div class="chips">${dias.map((d, i) => `<label class="check" style="padding:0 6px 0 0"><input type="checkbox" name="dia" value="${i}" ${c.dias.includes(i) ? 'checked' : ''}>${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][i]}</label>`).join('')}</div>
      <div class="secao-t">Respostas rápidas</div>
      <label class="check"><input type="checkbox" id="digitacaoNasRespostas" ${c.digitacaoNasRespostas ? 'checked' : ''}> Mostrar "digitando…" antes (fica mais lento)</label>
      <div class="secao-t">Descadastro</div>
      <label class="campo">Palavras (separe por vírgula)<input type="text" id="palavrasSair" value="${esc(c.palavrasSair.join(', '))}"></label>
      <div class="secao-t">Backup</div>
      <div class="dica" style="margin-bottom:8px">Tudo fica só neste computador. Baixe um backup para não perder ou para levar a outro computador.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sec peq" id="baixar">Baixar backup</button>
        <label class="btn sec peq" style="cursor:pointer">Restaurar backup<input type="file" id="restaurar" accept=".json" class="oculto"></label></div>`;
    rodape(`<button class="btn" id="salvar">Salvar configurações</button>`);
    const q = (s) => corpo.querySelector(s);
    $('#salvar').onclick = async () => {
      const n = (id) => Math.max(0, Number(q('#' + id).value) || 0);
      const novo = {
        nomeVendedor: q('#nomeVendedor').value.trim(),
        intervaloMin: Math.max(5, n('intervaloMin')),
        intervaloMax: Math.max(5, n('intervaloMax')),
        loteTamanho: Math.max(1, n('loteTamanho')),
        pausaLoteMin: Math.max(1, n('pausaLoteMin')),
        pausaLoteMax: Math.max(1, n('pausaLoteMax')),
        limiteDia: Math.max(1, n('limiteDia')),
        maxFalhasSeguidas: Math.max(1, n('maxFalhasSeguidas')),
        simularDigitacao: q('#simularDigitacao').checked,
        usarHorario: q('#usarHorario').checked,
        horaInicio: q('#horaInicio').value || '08:00',
        horaFim: q('#horaFim').value || '19:00',
        dias: [...corpo.querySelectorAll('input[name=dia]:checked')].map((x) => Number(x.value)),
        digitacaoNasRespostas: q('#digitacaoNasRespostas').checked,
        palavrasSair: q('#palavrasSair').value.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (novo.intervaloMax < novo.intervaloMin) [novo.intervaloMin, novo.intervaloMax] = [novo.intervaloMax, novo.intervaloMin];
      if (novo.pausaLoteMax < novo.pausaLoteMin) [novo.pausaLoteMin, novo.pausaLoteMax] = [novo.pausaLoteMax, novo.pausaLoteMin];
      if (novo.usarHorario && !novo.dias.length) return avisar('Marque pelo menos um dia.', 'erro');
      if (novo.usarHorario && VF.paraMin(novo.horaFim) <= VF.paraMin(novo.horaInicio)) return avisar('O horário final precisa ser depois do inicial.', 'erro');
      await VF.gravar('config', novo);
      avisar('Configurações salvas.', 'ok');
    };
    q('#baixar').onclick = async () => {
      const tudo = await chrome.storage.local.get(null);
      delete tudo.motorTrava;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'vendaflow', versao: 1, em: Date.now(), dados: tudo })], { type: 'application/json' }));
      a.download = `vendaflow-backup-${VF.hoje()}.json`;
      a.click();
    };
    q('#restaurar').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (j.app !== 'vendaflow' || !j.dados) throw new Error('Este arquivo não é um backup do VendaFlow.');
        if (!confirm('Substituir tudo deste computador pelo backup?')) return;
        await chrome.storage.local.clear();
        await chrome.storage.local.set(j.dados);
        avisar('Backup restaurado.', 'ok');
        desenharLateral();
      } catch (er) {
        avisar(er.message, 'erro');
      }
    };
  };

  // =====================================================================
  // Barra superior: pílulas das abas
  // =====================================================================
  function contagemAba(aba) {
    if (aba.tipo === 'etiqueta') {
      const et = etiquetas.find((x) => x.id === String(aba.etiquetaId));
      return et ? et.total : null;
    }
    return (aba.chats || []).length;
  }

  function desenharPilulas() {
    const html = [`<button class="pilula sem-conta ${abaSelecionada === 'todas' ? 'ativa' : ''}" data-aba="todas">Todas</button>`];
    for (const a of abas) {
      const n = contagemAba(a);
      html.push(
        `<button class="pilula ${n === null ? 'sem-conta' : ''} ${abaSelecionada === a.id ? 'ativa' : ''}" data-aba="${esc(a.id)}" title="${a.tipo === 'etiqueta' ? 'Aba ligada a uma etiqueta' : 'Aba manual'}">` +
          `<span class="cor" style="background:${esc(a.cor || '#25d366')}"></span>${esc(a.nome)}${n === null ? '' : `<span class="contador">${n}</span>`}</button>`
      );
    }
    $('#pilulas').innerHTML = html.join('');
  }

  $('#pilulas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (b) selecionarAba(b.dataset.aba);
  });
  $('#pilulas').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      $('#pilulas').scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  $('#novaAba').addEventListener('click', async () => {
    const nome = (prompt('Nome da nova aba (ex.: Campanha Técnico Enfermagem, Matrícula Realizada):') || '').trim();
    if (!nome) return;
    const lista = await VF.ler('abas', []);
    lista.push({ id: VF.novoId(), nome, cor: CORES[lista.length % CORES.length], tipo: 'manual', chats: [] });
    await VF.gravar('abas', lista);
    avisar(`Aba "${nome}" criada. Abra uma conversa e marque a aba no ícone 👤 Contato.`, 'ok');
  });

  // ---- Botão ⚡ ao lado do campo de mensagem ----
  function posicionarRaio() {
    const footer = document.querySelector('#main footer');
    const b = $('#raio');
    if (!footer) return b.classList.add('oculto');
    const r = footer.getBoundingClientRect();
    if (!r.width) return b.classList.add('oculto');
    b.classList.remove('oculto');
    b.style.left = r.left + 14 + 'px';
    b.style.top = r.top - 56 + 'px';
  }
  setInterval(posicionarRaio, 700);

  // ---- Atalho "/" no campo de mensagem ----
  let sugestoes = [];
  let sugIndice = 0;
  const campoDeMensagem = (alvo) =>
    alvo && alvo.isContentEditable && alvo.closest && alvo.closest('footer') ? alvo.closest('[contenteditable="true"]') || alvo : null;

  function fecharSugestoes() {
    sugestoes = [];
    $('#sugestoes').classList.add('oculto');
  }
  function desenharSugestoes(campo) {
    const caixa = $('#sugestoes');
    if (!sugestoes.length) return fecharSugestoes();
    caixa.innerHTML =
      sugestoes
        .map((r, i) => `<div class="sug ${i === sugIndice ? 'sel' : ''}" data-i="${i}"><code>/${esc(r.atalho || '')}</code> <b>${esc(r.nome)}</b><span>${esc(resumoResposta(r)).slice(0, 80)}</span></div>`)
        .join('') + '<div class="sug-dica">↑↓ escolher · Enter enviar · Tab colar · Esc fechar</div>';
    const r = campo.getBoundingClientRect();
    caixa.style.left = r.left + 'px';
    caixa.style.width = Math.max(320, Math.min(r.width, 560)) + 'px';
    caixa.style.bottom = window.innerHeight - r.top + 10 + 'px';
    caixa.classList.remove('oculto');
  }
  document.addEventListener(
    'input',
    (e) => {
      const campo = campoDeMensagem(e.target);
      if (!campo) return;
      const t = (campo.innerText || '').replace(/\n$/, '');
      const m = t.match(/^\/(\S*)$/);
      if (!m) return fecharSugestoes();
      const f = VF.semAcento(m[1].toLowerCase());
      sugestoes = respostas
        .filter((r) => VF.semAcento(((r.atalho || '') + ' ' + r.nome).toLowerCase()).includes(f))
        .sort((a, b) => (VF.semAcento((b.atalho || '').toLowerCase()).startsWith(f) ? 1 : 0) - (VF.semAcento((a.atalho || '').toLowerCase()).startsWith(f) ? 1 : 0))
        .slice(0, 8);
      sugIndice = 0;
      desenharSugestoes(campo);
    },
    true
  );
  async function escolherSugestao(i, modo) {
    const r = sugestoes[i];
    fecharSugestoes();
    if (!r) return;
    try {
      await rpc('colarTexto', '');
    } catch (e) { /* segue */ }
    usarResposta(r, modo === 'colar' && temSoTexto(r) ? 'colar' : 'enviar');
  }
  window.addEventListener(
    'keydown',
    (e) => {
      if (!sugestoes.length || !campoDeMensagem(e.target)) return;
      const parar = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        parar();
        sugIndice = (sugIndice + (e.key === 'ArrowDown' ? 1 : -1) + sugestoes.length) % sugestoes.length;
        desenharSugestoes(campoDeMensagem(e.target));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        parar();
        escolherSugestao(sugIndice, e.key === 'Tab' ? 'colar' : 'enviar');
      } else if (e.key === 'Escape') {
        parar();
        fecharSugestoes();
      }
    },
    true
  );
  $('#sugestoes').addEventListener('mousedown', (e) => {
    const s = e.target.closest('[data-i]');
    if (!s) return;
    e.preventDefault();
    escolherSugestao(Number(s.dataset.i), 'enviar');
  });

  // =====================================================================
  // Motor do envio em massa
  // =====================================================================
  let ocupado = false;
  let statusAtual = { texto: 'Envio em massa', tipo: 'parado' };

  function formatarEspera(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function textoStatus() {
    const s = statusAtual;
    if (s.tipo === 'enviando' && s.proximoEm) {
      const falta = s.proximoEm - Date.now();
      return falta > 0 ? `${s.texto} · próximo em ${formatarEspera(falta)}` : `${s.texto} · enviando…`;
    }
    return s.texto;
  }
  function atualizarStatus() {
    const b = $('#statusEnvio');
    b.className = 'status-envio ' + (statusAtual.tipo || 'parado');
    b.querySelector('span').textContent = statusAtual.tipo === 'parado' ? 'Envio em massa' : textoStatus();
  }
  setInterval(atualizarStatus, 1000);
  $('#statusEnvio').addEventListener('click', () => {
    abrirLateral('envio', statusAtual.campanhaId && statusAtual.tipo !== 'parado' ? 'campanha:' + statusAtual.campanhaId : null);
  });

  async function gravarStatus(s) {
    statusAtual = { ...s, atualizado: Date.now() };
    await VF.gravar('motorStatus', statusAtual);
    atualizarStatus();
  }

  async function pegarTrava() {
    const t = await VF.ler('motorTrava', null);
    if (t && t.token !== MEU_TOKEN && t.ate > Date.now()) return false;
    await VF.gravar('motorTrava', { token: MEU_TOKEN, ate: Date.now() + 90 * 1000 });
    return true;
  }

  async function salvarContato(campanhaId, indice, mudancas, extras = {}) {
    const chave = 'campanha:' + campanhaId;
    const c = await VF.ler(chave, null);
    if (!c) return null;
    Object.assign(c.contatos[indice], mudancas);
    Object.assign(c, extras);
    await VF.gravar(chave, c);
    return c;
  }

  async function passoDoMotor() {
    if (ocupado) return;
    ocupado = true;
    try {
      const campanhas = await lerCampanhas();
      const campanha = campanhas.find((c) => c.status === 'ativa');
      if (!campanha) {
        if (statusAtual.tipo !== 'parado') await gravarStatus({ texto: 'Envio em massa', tipo: 'parado' });
        return;
      }
      if (!(await pegarTrava())) return; // outra aba do WhatsApp está cuidando dos envios

      const cfg = await VF.config();
      const feitos = campanha.contatos.filter((x) => x.status !== 'pendente').length;
      const base = { campanhaId: campanha.id, campanhaNome: campanha.nome, feitos, total: campanha.contatos.length };

      if (!estadoWA.logado) {
        try {
          estadoWA = await rpc('estado');
        } catch (e) { /* segue */ }
        if (!estadoWA.logado) return gravarStatus({ ...base, texto: '⏳ Aguardando o WhatsApp carregar', tipo: 'aguardando' });
      }
      if (!VF.dentroDoHorario(cfg)) return gravarStatus({ ...base, texto: `🌙 Fora do horário (${cfg.horaInicio}–${cfg.horaFim})`, tipo: 'aguardando' });
      const hojeN = await VF.enviosHoje();
      if (hojeN >= cfg.limiteDia) return gravarStatus({ ...base, texto: `✋ Limite do dia (${hojeN}/${cfg.limiteDia}) — continua amanhã`, tipo: 'aguardando' });

      const motor = await VF.ler('motor', { proximoEm: 0, noLote: 0, falhasSeguidas: 0 });
      if (Date.now() < motor.proximoEm) {
        return gravarStatus({ ...base, texto: `${campanha.nome}: ${feitos}/${base.total}`, tipo: 'enviando', proximoEm: motor.proximoEm });
      }

      // Contato interrompido no meio (aba fechada durante o envio): não reenvia para não duplicar
      const interrompido = campanha.contatos.findIndex((x) => x.status === 'enviando');
      if (interrompido >= 0) await salvarContato(campanha.id, interrompido, { status: 'falhou', erro: 'Envio interrompido (confira a conversa)', em: Date.now() });

      const i = campanha.contatos.findIndex((x) => x.status === 'pendente');
      if (i < 0) {
        const c = await VF.ler('campanha:' + campanha.id);
        c.status = 'concluida';
        c.concluidaEm = Date.now();
        await VF.gravar('campanha:' + campanha.id, c);
        const n = contar(c);
        if (n.enviado) avisar(`✅ Campanha "${c.nome}" concluída: ${n.enviado} enviados${n.pulado + n.falhou ? `, ${n.pulado + n.falhou} pulados/falhas` : ''}.`, 'ok', 10000);
        else avisar(`⚠️ Campanha "${c.nome}" terminou sem enviar nenhuma mensagem. Abra a campanha para ver o motivo.`, 'erro', 12000);
        return gravarStatus({ texto: 'Envio em massa', tipo: 'parado' });
      }
      await processarContato(campanha, i, cfg, motor, base);
    } catch (e) {
      console.warn('[VendaFlow] motor:', e);
    } finally {
      ocupado = false;
    }
  }

  async function processarContato(campanha, i, cfg, motor, base) {
    const contato = campanha.contatos[i];
    let id = contato.id;
    const pular = async (motivo, esperaSeg) => {
      await salvarContato(campanha.id, i, { status: 'pulado', erro: motivo, em: Date.now() });
      motor.proximoEm = Date.now() + esperaSeg * 1000;
      await VF.gravar('motor', motor);
    };

    const naoPerturbe = await VF.ler('naoPerturbe', []);
    if (naoPerturbe.some((n) => n.ids.includes(id))) return pular('Está no Não perturbe', 1);

    await salvarContato(campanha.id, i, { status: 'enviando' });
    gravarStatus({ ...base, texto: `Enviando para ${contato.nome || VF.numeroDoId(id) || 'contato'} (${base.feitos + 1}/${base.total})`, tipo: 'enviando' });

    try {
      if (!contato.verificado && id.endsWith('@c.us')) {
        const certo = await rpc('verificarNumero', id);
        if (!certo) {
          await salvarContato(campanha.id, i, { status: 'falhou', erro: 'Número sem WhatsApp', em: Date.now() });
          motor.proximoEm = Date.now() + VF.aleatorio(5, 12) * 1000;
          return VF.gravar('motor', motor);
        }
        id = certo;
        await salvarContato(campanha.id, i, { id, verificado: true });
      }
      const ids = await equivalentes(id);
      if (naoPerturbe.some((n) => n.ids.some((x) => ids.includes(x)))) return pular('Está no Não perturbe', 1);

      const info = await rpc('infoChat', id).catch(() => null);
      const horas = campanha.pularRecenteHoras || 0;
      if (horas > 0 && !contato.ignorarRecente && info && info.t && Date.now() - info.t * 1000 < horas * 3600000) {
        return pular(`Conversou com você nas últimas ${horas}h (filtro da campanha)`, 2);
      }

      const nome = contato.nome || (info && info.nome) || (await rpc('nomeContato', id).catch(() => ''));
      const temMensagem = (campanha.etapas || []).length > 0;
      if (temMensagem) await enviarEtapas(id, campanha.etapas, { nome, vendedor: cfg.nomeVendedor }, { digitacao: cfg.simularDigitacao });

      const avisos = [];
      const a = campanha.acoes || {};
      const ops = [
        ...(a.addEtiquetas || []).map((labelId) => ({ labelId: String(labelId), type: 'add' })),
        ...(a.removerEtiquetas || []).map((labelId) => ({ labelId: String(labelId), type: 'remove' })),
      ];
      if (ops.length) {
        try {
          await rpc('etiquetar', [id], ops);
        } catch (e) {
          avisos.push('Etiqueta: ' + e.message);
        }
      }
      if (a.addAba) await alterarAba(a.addAba, ids, nome, true);
      if (a.removerAba) await alterarAba(a.removerAba, ids, nome, false);

      await salvarContato(campanha.id, i, { status: 'enviado', id, ids, nome, erro: avisos.join(' | '), em: Date.now() });
      motor.falhasSeguidas = 0;
      if (temMensagem) {
        await VF.somarEnvioHoje();
        motor.noLote = (motor.noLote || 0) + 1;
        if (motor.noLote >= cfg.loteTamanho) {
          motor.noLote = 0;
          motor.proximoEm = Date.now() + VF.aleatorio(cfg.pausaLoteMin, cfg.pausaLoteMax) * 60000;
        } else {
          motor.proximoEm = Date.now() + VF.aleatorio(cfg.intervaloMin, cfg.intervaloMax) * 1000;
        }
      } else {
        motor.proximoEm = Date.now() + VF.aleatorio(1, 3) * 1000;
      }
      await VF.gravar('motor', motor);
    } catch (e) {
      motor.falhasSeguidas = (motor.falhasSeguidas || 0) + 1;
      const extras = {};
      if (motor.falhasSeguidas >= cfg.maxFalhasSeguidas) {
        extras.status = 'pausada';
        extras.motivo = `Pausada sozinha: ${motor.falhasSeguidas} falhas seguidas (último erro: ${e.message}). Confira o WhatsApp e clique em Retomar.`;
        motor.falhasSeguidas = 0;
        avisar('⚠️ ' + extras.motivo, 'erro', 12000);
      }
      await salvarContato(campanha.id, i, { status: 'falhou', erro: e.message, em: Date.now() }, extras);
      motor.proximoEm = Date.now() + VF.aleatorio(cfg.intervaloMin, cfg.intervaloMax) * 1000;
      await VF.gravar('motor', motor);
    }
  }

  // Mensagem recebida: descadastro e "respondeu"
  async function tratarMensagemRecebida(d) {
    const ids = d.ids && d.ids.length ? d.ids : [d.chatId];
    const cfg = await VF.config();
    if (d.texto && VF.pediuParaSair(d.texto, cfg.palavrasSair)) {
      const lista = await VF.ler('naoPerturbe', []);
      if (!lista.some((n) => n.ids.some((x) => ids.includes(x)))) {
        lista.push({ ids, nome: d.nome || '', texto: d.texto.slice(0, 60), em: Date.now() });
        await VF.gravar('naoPerturbe', lista);
        avisar(`🚫 ${d.nome || 'Um contato'} pediu para sair ("${d.texto.slice(0, 30)}"). Não receberá mais envios em massa.`, 'info', 9000);
      }
    }
    const campanhas = await lerCampanhas();
    for (const c of campanhas) {
      if (c.status === 'cancelada') continue;
      const i = c.contatos.findIndex((x) => x.status === 'enviado' && !x.respondeu && [x.id, ...(x.ids || [])].some((y) => ids.includes(y)));
      if (i < 0) continue;
      const atual = await VF.ler('campanha:' + c.id);
      atual.contatos[i].respondeu = true;
      atual.contatos[i].respondeuEm = Date.now();
      await VF.gravar('campanha:' + c.id, atual);
      const r = c.aoResponder || {};
      if (r.addAba) await alterarAba(r.addAba, ids, atual.contatos[i].nome, true);
      if (r.addEtiqueta) rpc('etiquetar', [d.chatId], [{ labelId: String(r.addEtiqueta), type: 'add' }]).catch(() => {});
    }
  }

  // =====================================================================
  // Mensagens do background
  // =====================================================================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.tipo === 'tick') passoDoMotor();
    if (msg.tipo === 'abrirPainel') abrirLateral(msg.secao || 'respostas');
    return false;
  });

  // =====================================================================
  // Dados guardados -> tela
  // =====================================================================
  async function recarregarDados() {
    abas = await VF.ler('abas', []);
    respostas = await VF.ler('respostas', []);
    if (!etiquetas.length) etiquetas = await VF.ler('etiquetasCache', []);
    desenharPilulas();
  }

  let redesenho;
  chrome.storage.onChanged.addListener(async (mud, area) => {
    if (area !== 'local') return;
    const chaves = Object.keys(mud);
    if (mud.abas || mud.respostas) {
      await recarregarDados();
      if (mud.abas && abaSelecionada !== 'todas') {
        const aba = abas.find((a) => a.id === abaSelecionada);
        if (!aba) selecionarAba('todas');
        else if (aba.tipo === 'manual') rpc('filtrarLista', 'custom', idsDaAba(aba).length ? idsDaAba(aba) : ['0@c.us']).catch(() => {});
      }
    }
    if (mud.motorStatus && mud.motorStatus.newValue) {
      statusAtual = mud.motorStatus.newValue;
      atualizarStatus();
    }
    const mexeuCampanha = chaves.some((k) => k.startsWith('campanha'));
    if (mexeuCampanha || mud.config) setTimeout(passoDoMotor, 800);
    // Atualiza o painel aberto (menos telas com formulário)
    const relevante =
      (secaoAtual === 'respostas' && mud.respostas) ||
      (secaoAtual === 'envio' && (mexeuCampanha || mud.motorStatus)) ||
      (secaoAtual === 'naoperturbe' && mud.naoPerturbe) ||
      (secaoAtual === 'contato' && mud.abas);
    if (relevante && !telaComFormulario()) {
      clearTimeout(redesenho);
      redesenho = setTimeout(() => {
        const rolagem = $('#corpo').scrollTop;
        desenharLateral().then(() => ($('#corpo').scrollTop = rolagem));
      }, 300);
    }
  });

  recarregarDados();
  VF.ler('motorStatus', null).then((s) => s && ((statusAtual = s), atualizarStatus()));
  setInterval(passoDoMotor, 15000);
  setTimeout(passoDoMotor, 5000);
})();
