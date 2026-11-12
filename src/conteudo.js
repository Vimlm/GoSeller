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
      atualizarCabecalho();
      encaixarCabecalho();
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
  let scripts = []; // cadeias de respostas rápidas: { id, nome, atalho, itens: [{ respostaId, espera }] }
  let etiquetas = [];
  let categorias = []; // categorias criadas pelo vendedor (podem estar vazias)
  let nomes = {}; // nome escolhido pelo vendedor para o contato: { 'id@c.us': 'Maria' } (vale nas variáveis {nome})
  let abaSelecionada = 'todas';
  const nomeDe = (ids, padrao) => [].concat(ids || []).map((x) => nomes[x]).find(Boolean) || padrao || '';

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

  async function salvarNome(ids, nome) {
    const mapa = await VF.ler('nomes', {});
    ids.forEach((x) => (nome ? (mapa[x] = nome) : delete mapa[x]));
    nomes = mapa;
    await VF.gravar('nomes', mapa);
    // Atualiza o nome guardado nas abas (aparece nas listas)
    const lista = await VF.ler('abas', []);
    let mexeu = false;
    lista.forEach((a) => (a.chats || []).forEach((c) => {
      if (c.ids.some((x) => ids.includes(x)) && nome && c.nome !== nome) ((c.nome = nome), (mexeu = true));
    }));
    if (mexeu) await VF.gravar('abas', lista);
  }

  // Troca o nome: guarda na extensão e salva o contato no próprio WhatsApp (aparece no topo e na lista)
  async function trocarNome(ids, chatId, valor) {
    await salvarNome(ids, valor);
    if (!valor) return avisar('Voltou a usar o nome do WhatsApp nas mensagens.', 'ok', 3000);
    const id = ids.find((x) => x.endsWith('@c.us')) || chatId;
    try {
      await rpc('salvarContato', id, valor);
      avisar(`Contato salvo no WhatsApp como "${valor}".`, 'ok', 3500);
    } catch (e) {
      avisar(`O nome "${valor}" vale nas mensagens da extensão, mas o WhatsApp não deixou salvar o contato (${e.message}). Use "Salvar contato" do próprio WhatsApp.`, 'erro', 9000);
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
    lapis: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    lixo: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    kanban: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z"/></svg>',
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
  // Segunda camada, acima do WhatsApp, só para o que flutua (menus, sugestões do "/", avisos, dicas).
  // A camada principal (barra, trilho, painel) fica ABAIXO do #app para os menus do WhatsApp
  // não ficarem escondidos atrás do painel.
  const hostFlut = document.createElement('div');
  hostFlut.id = 'vf-host-flut';
  hostFlut.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(hostFlut);
  const raizFlut = hostFlut.attachShadow({ mode: 'open' });

  const SECOES = [
    ['contato', 'usuario', 'Contato aberto (nome e anotações)'],
    ['respostas', 'raio', 'Respostas rápidas'],
    ['envio', 'aviao', 'Envio em massa'],
    ['abas', 'funil', 'Abas'],
    ['kanban', 'kanban', 'Kanban automático (servidor)'],
    ['naoperturbe', 'proibido', 'Não perturbe'],
    ['config', 'engrenagem', 'Configurações'],
  ];

  raiz.innerHTML = `
    <header class="topo">
      <button class="logo" data-abrir="respostas" title="VendaFlow">${IC.raio}</button>
      <div class="pilulas" id="pilulas"></div>
      <button class="icone-btn" id="novaAba" title="Criar nova aba">${IC.pastaMais}</button>
      <button class="icone-btn" data-abrir="abas" title="Organizar abas">${IC.lista}</button>
      <button class="icone-btn" id="abrirKanbanTopo" title="Quadro Kanban">${IC.kanban}</button>
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
    </aside>`;
  raizFlut.innerHTML = `
    <div class="kanban oculto" id="kanban"></div>
    <div class="pop oculto" id="pop"></div>
    <div class="sugestoes oculto" id="sugestoes"></div>
    <div class="avisos" id="avisos"></div>
    <div class="dica-flut oculto" id="dicaFlut"></div>`;

  const $ = (s) => raiz.querySelector(s) || raizFlut.querySelector(s);
  const $$ = (s) => [...raiz.querySelectorAll(s)];

  // Dica ao passar o mouse nos ícones do trilho (na camada de cima, para não ficar atrás do WhatsApp)
  raiz.addEventListener('mouseover', (e) => {
    const b = e.target.closest && e.target.closest('[data-dica]');
    const d = $('#dicaFlut');
    if (!b) return d.classList.add('oculto');
    const r = b.getBoundingClientRect();
    d.textContent = b.dataset.dica;
    d.style.left = r.right + 8 + 'px';
    d.style.top = r.top + r.height / 2 + 'px';
    d.classList.remove('oculto');
  });
  $('#trilho').addEventListener('mouseleave', () => $('#dicaFlut').classList.add('oculto'));

  // Estilos (constructable stylesheet: não esbarra na política de segurança do WhatsApp)
  fetch(chrome.runtime.getURL('src/ui.css'))
    .then((r) => r.text())
    .then((css) => {
      const folha = new CSSStyleSheet();
      folha.replaceSync(css);
      raiz.adoptedStyleSheets = [folha];
      raizFlut.adoptedStyleSheets = [folha];
    })
    .catch((e) => console.warn('[VendaFlow] CSS', e));

  // Tema claro/escuro igual ao do WhatsApp
  function conferirTema() {
    const escuro = document.body && (document.body.classList.contains('dark') || document.documentElement.classList.contains('dark'));
    host.classList.toggle('escuro', !!escuro);
    hostFlut.classList.toggle('escuro', !!escuro);
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
  function posicionarPop(botao) {
    const pop = $('#pop');
    pop.classList.remove('oculto');
    const r = botao.getBoundingClientRect();
    const larg = pop.offsetWidth || 200;
    const alt = pop.offsetHeight || 100;
    pop.style.left = Math.max(8, Math.min(r.right - larg, window.innerWidth - larg - 8)) + 'px';
    pop.style.top = (r.bottom + 4 + alt > window.innerHeight - 8 ? Math.max(8, r.top - alt - 4) : r.bottom + 4) + 'px';
  }
  // Lista com marcar/desmarcar que continua aberta (escolher várias abas/etiquetas)
  function abrirPopMulti(botao, opcoes, sel, aoMudar, extra) {
    const pop = $('#pop');
    const desenhar = () => {
      let grupo = null;
      pop.innerHTML =
        opcoes
          .map((o, i) => {
            const cab = o.grupo && o.grupo !== grupo ? `<div class="pop-grupo">${esc((grupo = o.grupo))}</div>` : '';
            return `${cab}<button data-i="${i}" class="${sel.has(o.id) ? 'marcado' : ''}"><span class="caixa">${sel.has(o.id) ? '✓' : ''}</span><span style="color:${esc(o.cor || '#8696a0')}">●</span><span class="pop-nome">${esc(o.nome)}</span>${o.extra != null ? `<small>${esc(String(o.extra))}</small>` : ''}</button>`;
          })
          .join('') +
        (opcoes.length ? '' : '<div class="dica" style="padding:8px">Nada para escolher.</div>') +
        (extra ? `<div class="pop-sep"></div><button data-extra>${extra.texto}</button>` : '');
    };
    desenhar();
    posicionarPop(botao);
    pop.onclick = (e) => {
      if (e.target.closest('[data-extra]')) {
        fecharPop();
        return extra.acao();
      }
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const o = opcoes[Number(b.dataset.i)];
      sel.has(o.id) ? sel.delete(o.id) : sel.add(o.id);
      desenhar();
      aoMudar(sel, o.id, sel.has(o.id));
    };
  }
  // Arrastar para reordenar: clicar e segurar em qualquer parte do item e mover.
  // O clique simples continua igual — só vira arrasto depois que o mouse anda alguns pixels.
  // opcoes: eixo 'y'|'x', pode(item) liga/desliga, sobre(el, item) trata alvos extras, aoSoltar(item)
  function ordenarArrastando(lista, seletor, opcoes) {
    const { eixo = 'y', pode = () => true, sobre = null, aoSoltar } = opcoes;
    const raiz = lista.getRootNode();
    let item = null, x0 = 0, y0 = 0, ativo = false, rolagem = null;
    const rolavel = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)[eixo === 'y' ? 'overflowY' : 'overflowX'];
        if (/(auto|scroll)/.test(s)) return p;
      }
      return null;
    };
    const mover = (e) => {
      if (!item) return;
      if (!ativo) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
        ativo = true;
        rolagem = rolavel(item);
        item.classList.add('arrastando');
        lista.classList.add('ordenando');
        getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      // Rola sozinho perto da borda
      if (rolagem) {
        const r = rolagem.getBoundingClientRect();
        const p = eixo === 'y' ? e.clientY : e.clientX;
        const [ini, fim] = eixo === 'y' ? [r.top, r.bottom] : [r.left, r.right];
        if (p < ini + 40) rolagem[eixo === 'y' ? 'scrollTop' : 'scrollLeft'] -= 12;
        else if (p > fim - 40) rolagem[eixo === 'y' ? 'scrollTop' : 'scrollLeft'] += 12;
      }
      const el = (raiz.elementFromPoint ? raiz : document).elementFromPoint(e.clientX, e.clientY);
      if (!el || !lista.contains(el)) return;
      const alvo = el.closest(seletor);
      if (alvo && alvo !== item && lista.contains(alvo) && pode(alvo)) {
        const r = alvo.getBoundingClientRect();
        const antes = eixo === 'y' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
        alvo.parentElement.insertBefore(item, antes ? alvo : alvo.nextSibling);
      } else if (!alvo && sobre) sobre(el, item);
    };
    const semSelecao = (e) => item && e.preventDefault();
    const soltar = () => {
      window.removeEventListener('selectstart', semSelecao, true);
      window.removeEventListener('pointermove', mover, true);
      window.removeEventListener('pointerup', soltar, true);
      window.removeEventListener('pointercancel', soltar, true);
      const it = item;
      item = null;
      if (!ativo || !it) return;
      ativo = false;
      it.classList.remove('arrastando');
      lista.classList.remove('ordenando');
      // O clique que vem logo depois de soltar não deve abrir/selecionar nada
      const engolir = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', engolir, true);
      setTimeout(() => window.removeEventListener('click', engolir, true), 80);
      Promise.resolve(aoSoltar(it)).catch((err) => avisar('Não consegui salvar a ordem: ' + err.message, 'erro'));
    };
    lista.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const it = e.target.closest(seletor);
      if (!it || !lista.contains(it) || !pode(it)) return;
      const interno = e.target.closest('button, input, textarea, select, a, label, [contenteditable]');
      if (interno && interno !== it && it.contains(interno)) return; // botões do próprio item continuam normais
      item = it;
      x0 = e.clientX;
      y0 = e.clientY;
      ativo = false;
      window.addEventListener('selectstart', semSelecao, true);
      window.addEventListener('pointermove', mover, true);
      window.addEventListener('pointerup', soltar, true);
      window.addEventListener('pointercancel', soltar, true);
    });
  }

  // Seletor compacto: pílulas do que foi escolhido + botão "Adicionar"
  function seletorMulti(el, opcoesFn, inicial, aoMudar, vazio = 'Nenhuma escolhida') {
    const sel = new Set(inicial || []);
    const desenhar = () => {
      const escolhidos = opcoesFn().filter((o) => sel.has(o.id));
      el.innerHTML = `<div class="tags">${escolhidos.map((o) => `<span class="tag" style="--c:${esc(o.cor || '#8696a0')}"><i></i>${esc(o.nome)}<button type="button" data-tirar="${esc(o.id)}" title="Tirar">×</button></span>`).join('') || `<span class="dica">${vazio}</span>`}<button type="button" class="mais-peq" data-add>${IC.mais2} Adicionar</button></div>`;
    };
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tirar]');
      if (t) {
        sel.delete(t.dataset.tirar);
        desenhar();
        return aoMudar && aoMudar(sel);
      }
      const a = e.target.closest('[data-add]');
      if (a) abrirPopMulti(a, opcoesFn(), sel, () => {
        desenhar();
        aoMudar && aoMudar(sel);
      });
    });
    desenhar();
    return { valor: () => [...sel], definir: (v) => (sel.clear(), (v || []).forEach((x) => sel.add(x)), desenhar()) };
  }
  function abrirPop(botao, itens) {
    const pop = $('#pop');
    pop.innerHTML = itens.map((it, i) => `<button data-i="${i}" class="${it.perigo ? 'perigo' : ''}">${it.texto}</button>`).join('');
    posicionarPop(botao);
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
  $('#abrirKanbanTopo').addEventListener('click', () => (kanbanAberto ? fecharKanban() : abrirKanban()));

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
    corpo.onclick = corpo.onchange = corpo.oninput = corpo.onkeydown = null; // tira os ouvintes da tela anterior
    try {
      await telas[secaoAtual](corpo);
    } catch (e) {
      $('#corpo').innerHTML = `<div class="alerta">Erro: ${esc(e.message)}</div>`;
    }
  }

  // Telas com formulário não são redesenhadas sozinhas (para não apagar o que a pessoa está digitando)
  const telaComFormulario = () =>
    (secaoAtual === 'respostas' && visao) || (secaoAtual === 'envio' && visao && (visao === 'nova' || visao.startsWith('duplicar:'))) || secaoAtual === 'config' || secaoAtual === 'kanban' || (secaoAtual === 'abas' && visao);

  // =====================================================================
  // TELA: Contato aberto
  // =====================================================================
  telas.contato = async (corpo) => {
    try {
      chatAtual = (await rpc('chatAtivo')) || null;
    } catch (e) { /* usa o último */ }
    if (!chatAtual || chatAtual.grupo) {
      corpo.innerHTML = `<div class="lat-titulo"><h2>Contato</h2></div><div class="vazio">Abra uma conversa (que não seja grupo) para mudar o nome do lead e anotar coisas sobre ele.</div>`;
      return;
    }
    const ids = await equivalentes(chatAtual.id);
    const chaveNota = 'nota:' + (ids.find((x) => x.endsWith('@c.us')) || ids[0]);
    const nota = await VF.ler(chaveNota, '');
    const numero = VF.numeroDoId(ids.find((x) => x.endsWith('@c.us'))) || chatAtual.numero || '';
    const nomeWA = chatAtual.nome || '';
    const nomeMeu = nomeDe(ids, '');
    const nomeMostrado = nomeMeu || nomeWA || numero || 'Contato';
    corpo.innerHTML = `
      <div class="perfil"><div class="avatar">${esc((VF.primeiroNome(nomeMostrado) || '?').charAt(0).toUpperCase())}</div>
        <div class="perfil-txt" id="perfilTxt">
          <div class="nome-linha"><b>${esc(nomeMostrado)}</b><button type="button" class="icone-btn mini" id="editarNome" title="Mudar o nome deste contato">${IC.lapis}</button></div>
          <div class="dica">${esc(numero)}${nomeMeu && nomeWA && nomeWA !== nomeMeu ? ` · no WhatsApp: ${esc(nomeWA)}` : ''}</div>
        </div></div>
      <div class="secao-t">Anotações</div>
      <textarea id="nota" placeholder="Ex.: interessado no técnico em enfermagem, retornar sexta">${esc(nota)}</textarea>
      <div class="dica" id="notaSalva"></div>`;

    corpo.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'editarNome') {
        const caixa = corpo.querySelector('#perfilTxt');
        caixa.innerHTML = `<input type="text" id="novoNome" value="${esc(nomeMostrado === numero ? '' : nomeMostrado)}" placeholder="Nome do contato">
          <div class="nome-acoes"><button type="button" class="btn peq" id="salvarNome">Salvar</button><button type="button" class="btn sec peq" id="cancelarNome">Cancelar</button>
          ${nomeMeu ? `<button type="button" class="link-btn" id="restaurarNome">Voltar ao nome do WhatsApp</button>` : ''}</div>
          <div class="dica">Salva o contato no WhatsApp com esse nome e vale em {nome} e {primeiro_nome}.</div>`;
        const inp = caixa.querySelector('#novoNome');
        inp.focus();
        inp.select();
        inp.onkeydown = (k) => {
          if (k.key === 'Enter') caixa.querySelector('#salvarNome').click();
          if (k.key === 'Escape') desenharLateral();
          k.stopPropagation();
        };
        return;
      }
      if (b.id === 'cancelarNome') return desenharLateral();
      if (b.id === 'salvarNome' || b.id === 'restaurarNome') {
        const valor = b.id === 'salvarNome' ? corpo.querySelector('#novoNome').value.trim() : '';
        return trocarNome(ids, chatAtual.id, valor).then(() => desenharLateral());
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
    const dados = { nome: nomeDe(chat.id, chat.nome), vendedor: cfg.nomeVendedor };
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

  const segmentoRespostas = () => `<div class="segmento">
      <button data-seg="respostas" class="${estadoUI.seg !== 'scripts' ? 'ativo' : ''}">Respostas</button>
      <button data-seg="scripts" class="${estadoUI.seg === 'scripts' ? 'ativo' : ''}">Scripts <span class="qtd">${scripts.length}</span></button></div>`;

  telas.respostas = async (corpo) => {
    if (visao && visao.startsWith('editar:')) return telaEditarResposta(corpo, visao.slice(7));
    if (visao && visao.startsWith('script:')) return telaEditarScript(corpo, visao.slice(7));
    if (estadoUI.seg === 'scripts') return telaScripts(corpo);
    const filtros = [['tudo', 'Tudo'], ['texto', 'Texto'], ['audio', 'Áudio'], ['image', 'Imagem'], ['video', 'Vídeo'], ['document', 'Arquivo'], ['usadas', 'Mais usadas']];
    corpo.innerHTML = `
      ${segmentoRespostas()}
      <div class="busca"><label>${IC.lupa}<input id="busca" placeholder="Pesquisar resposta rápida" value="${esc(estadoUI.busca)}"></label>
        <button class="icone-btn" id="novaCat" title="Nova categoria">${IC.pastaMais}</button>
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
      const semFiltro = !f && estadoUI.filtroTipo === 'tudo';
      if (!respostas.length && !(semFiltro && categorias.length)) {
        alvo.innerHTML = `<div class="vazio">Você ainda não tem respostas rápidas.<br><br><button class="btn" data-nova>+ Criar a primeira</button></div>`;
        return;
      }
      if (!lista.length && !semFiltro) return (alvo.innerHTML = '<div class="vazio">Nada encontrado.</div>');
      const pastas = {};
      if (semFiltro) categorias.forEach((c) => (pastas[c] ||= []));
      lista.forEach((r) => (pastas[r.pasta || 'Sem categoria'] ||= []).push(r));
      // Muitas categorias: começam fechadas (só a primeira aberta), como no modelo
      if (!estadoUI.iniciouCategorias) {
        estadoUI.iniciouCategorias = true;
        const todas = [...new Set(respostas.map((r) => r.pasta || 'Sem categoria'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        if (todas.length > 3) todas.slice(1).forEach((p) => estadoUI.fechadas.add(p));
      }
      const nomes = estadoUI.filtroTipo === 'usadas' ? Object.keys(pastas) : Object.keys(pastas).sort((a, b) => a.localeCompare(b, 'pt-BR'));
      alvo.classList.toggle('pode-ordenar', semFiltro);
      alvo.innerHTML = nomes
        .map((p) => {
          const aberta = f || !estadoUI.fechadas.has(p);
          return `<div class="categoria ${aberta ? 'aberta' : ''}">
            <div class="cat-topo" data-pasta="${esc(p)}" role="button"><span class="cat-icone">${IC.categoria}</span><span class="cat-nome">${esc(p)}</span><span class="qtd">${pastas[p].length}</span>
              <button class="icone-btn cat-mais" data-catmenu="${esc(p)}" title="Editar categoria">${IC.mais}</button><span class="seta">${IC.seta}</span></div>
            ${aberta ? (pastas[p].length ? pastas[p].map((r) => htmlItemResposta(r)).join('') : `<div class="cat-vazia">Categoria vazia. <button class="link-btn" data-novaem="${esc(p)}">+ Adicionar resposta</button></div>`) : ''}</div>`;
        })
        .join('');
    };
    desenharLista();
    // Segurar e arrastar uma resposta muda a ordem (e, se soltar em outra categoria, muda a categoria)
    const listaResp = corpo.querySelector('#listaResp');
    ordenarArrastando(listaResp, '[data-resp]', {
      pode: () => listaResp.classList.contains('pode-ordenar') && !estadoUI.editEnvio,
      sobre: (el, item) => {
        const topo = el.closest('.cat-topo');
        if (topo && topo.parentElement.classList.contains('aberta')) return topo.after(item);
        const vazia = el.closest('.cat-vazia');
        if (vazia) vazia.before(item);
      },
      aoSoltar: async (item) => {
        const pasta = item.closest('.categoria')?.querySelector('.cat-topo')?.dataset.pasta;
        const ordem = [...listaResp.querySelectorAll('[data-resp]')].map((x) => x.dataset.resp);
        const lista = await VF.ler('respostas', []);
        const r = lista.find((x) => x.id === item.dataset.resp);
        if (r && pasta !== undefined) r.pasta = pasta === 'Sem categoria' ? '' : pasta;
        // Só as que estão na tela mudam de lugar; as de categorias fechadas ficam onde estavam
        const vagas = lista.map((x, i) => (ordem.includes(x.id) ? i : -1)).filter((i) => i >= 0);
        const novas = ordem.map((id) => lista.find((x) => x.id === id)).filter(Boolean);
        const final = [...lista];
        vagas.forEach((i, k) => (final[i] = novas[k]));
        respostas = final;
        desenharLista();
        await VF.gravar('respostas', final);
      },
    });
    corpo.oninput = (e) => {
      const i = e.target.dataset?.ee;
      const ed = estadoUI.editEnvio;
      if (i === undefined || !ed) return;
      const et = ed.etapas[Number(i)];
      et.tipo === 'texto' ? (et.texto = e.target.value) : (et.legenda = e.target.value);
    };
    corpo.onkeydown = (e) => {
      if (!e.target.dataset?.ee) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        estadoUI.editEnvio = null;
        desenharLista();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        enviarEditado();
      }
    };
    corpo.querySelector('#busca').oninput = (e) => {
      estadoUI.busca = e.target.value;
      desenharLista();
    };
    corpo.querySelector('#busca').focus();
    corpo.onclick = (e) => {
      const menuCat = e.target.closest('[data-catmenu]');
      if (menuCat) return menuCategoria(menuCat, menuCat.dataset.catmenu);
      const novaEm = e.target.closest('[data-novaem]');
      if (novaEm) return novaRespostaEm(novaEm.dataset.novaem);
      const topo = e.target.closest('.cat-topo');
      if (topo) {
        const p = topo.dataset.pasta;
        estadoUI.fechadas.has(p) ? estadoUI.fechadas.delete(p) : estadoUI.fechadas.add(p);
        return desenharLista();
      }
      const alvo = e.target.closest('button');
      if (!alvo) return;
      if (alvo.id === 'novaCat') return novaCategoria();
      if (alvo.dataset.seg) {
        estadoUI.seg = alvo.dataset.seg;
        return desenharLateral();
      }
      if (alvo.id === 'nova' || alvo.hasAttribute('data-nova')) return novaRespostaEm('');
      if (alvo.dataset.filtro) {
        estadoUI.filtroTipo = alvo.dataset.filtro;
        corpo.querySelectorAll('[data-filtro]').forEach((c) => c.classList.toggle('ativo', c === alvo));
        return desenharLista();
      }
      const r = respostas.find((x) => x.id === alvo.closest('[data-resp]')?.dataset.resp);
      if (!r) return;
      if (alvo.dataset.acao === 'enviar') return usarResposta(r, 'enviar');
      if (alvo.dataset.acao === 'cancelarEnvio') {
        estadoUI.editEnvio = null;
        return desenharLista();
      }
      if (alvo.dataset.acao === 'enviarEditado') return enviarEditado();
      if (alvo.dataset.acao === 'editarEnvio') {
        if (estadoUI.editEnvio?.id === r.id) {
          estadoUI.editEnvio = null;
          return desenharLista();
        }
        return abrirEditarEnvio(r).then(() => {
          if (!estadoUI.editEnvio) return;
          estadoUI.fechadas.delete(r.pasta || 'Sem categoria');
          desenharLista();
          const t = corpo.querySelector('.editar-envio .ee-txt') || corpo.querySelector('.editar-envio textarea');
          if (t) {
            t.focus();
            t.setSelectionRange(t.value.length, t.value.length);
          }
        });
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

  // ---- Categorias (criar, renomear, excluir direto na lista) ----
  const nomesCategorias = () => [...new Set([...categorias, ...respostas.map((r) => r.pasta).filter(Boolean)])];
  function novaRespostaEm(pasta) {
    estadoUI.pastaNova = pasta === 'Sem categoria' ? '' : pasta;
    irPara('editar:nova');
  }
  async function novaCategoria() {
    const nome = (prompt('Nome da nova categoria:\n(ex.: Técnico em Enfermagem, Pós-graduação, Objeções)') || '').trim();
    if (!nome) return;
    if (nomesCategorias().some((c) => c.toLowerCase() === nome.toLowerCase())) return avisar(`A categoria "${nome}" já existe.`, 'erro');
    estadoUI.fechadas.delete(nome);
    await VF.gravar('categorias', [...(await VF.ler('categorias', [])), nome]);
    avisar(`Categoria "${nome}" criada. Use o ⋯ dela para adicionar respostas.`, 'ok');
  }
  async function renomearCategoria(antigo) {
    const nome = (prompt('Novo nome da categoria:', antigo) || '').trim();
    if (!nome || nome === antigo) return;
    if (nomesCategorias().some((c) => c !== antigo && c.toLowerCase() === nome.toLowerCase()))
      if (!confirm(`Já existe "${nome}". Juntar as duas categorias?`)) return;
    const cats = await VF.ler('categorias', []);
    await VF.gravar('categorias', [...new Set(cats.map((c) => (c === antigo ? nome : c)))]);
    const lista = await VF.ler('respostas', []);
    lista.forEach((r) => r.pasta === antigo && (r.pasta = nome));
    if (estadoUI.fechadas.delete(antigo)) estadoUI.fechadas.add(nome);
    await VF.gravar('respostas', lista);
  }
  async function excluirCategoria(nome) {
    const qtd = respostas.filter((r) => r.pasta === nome).length;
    if (!confirm(`Excluir a categoria "${nome}"?${qtd ? `\n\nAs ${qtd} respostas dela NÃO são apagadas: vão para "Sem categoria".` : ''}`)) return;
    await VF.gravar('categorias', (await VF.ler('categorias', [])).filter((c) => c !== nome));
    if (qtd) {
      const lista = await VF.ler('respostas', []);
      lista.forEach((r) => r.pasta === nome && (r.pasta = ''));
      await VF.gravar('respostas', lista);
    }
  }
  function menuCategoria(botao, nome) {
    abrirPop(botao, [
      { texto: '➕ Nova resposta nesta categoria', acao: () => novaRespostaEm(nome) },
      ...(nome === 'Sem categoria'
        ? []
        : [
            { texto: '✏️ Renomear categoria', acao: () => renomearCategoria(nome) },
            { texto: '🗑️ Excluir categoria', perigo: true, acao: () => excluirCategoria(nome) },
          ]),
    ]);
  }

  function htmlEditarEnvio(ed) {
    const ICM = { audio: '🎤', video: '🎬', image: '🖼️', document: '📄' };
    return `<div class="editar-envio">
      <div class="ee-topo">Editar antes de enviar${ed.contato ? ` para <b>${esc(ed.contato)}</b>` : ''}</div>
      ${ed.etapas
        .map((e, i) =>
          e.tipo === 'texto'
            ? `<textarea class="ee-txt" data-ee="${i}" rows="3" placeholder="(mensagem vazia não é enviada)">${esc(e.texto)}</textarea>`
            : `<div class="ee-arq">${ICM[e.tipoMidia] || '📄'} ${esc(e.nomeArquivo || VF.TIPOS_MIDIA[e.tipoMidia])}</div>${
                e.tipoMidia === 'audio' ? '' : `<textarea data-ee="${i}" rows="1" placeholder="Legenda (opcional)">${esc(e.legenda || '')}</textarea>`
              }`
        )
        .join('')}
      <div class="dica">Vale só para este envio — a resposta salva continua igual. <b>Ctrl+Enter</b> envia, <b>Esc</b> cancela.</div>
      <div class="ee-botoes"><button class="btn sec peq" data-acao="cancelarEnvio">Cancelar</button><button class="btn peq" data-acao="enviarEditado">${IC.enviar} Enviar</button></div>
    </div>`;
  }

  function htmlItemResposta(r) {
    const ed = estadoUI.editEnvio && estadoUI.editEnvio.id === r.id ? estadoUI.editEnvio : null;
    return `<div data-resp="${esc(r.id)}" class="resp-arrastavel ${ed ? 'editando' : ''}"><div class="item">
      <span class="tipo">${IC[r.etapas.length > 1 ? 'sequencia' : tipoDaResposta(r)] || IC.texto}</span>
      <span class="nome" title="${esc(resumoResposta(r)).slice(0, 300)}">${esc(r.nome)}${r.atalho ? `<code>/${esc(r.atalho)}</code>` : ''}</span>
      <button class="icone-btn" data-acao="mais" title="Mais opções">${IC.mais}</button>
      <button class="icone-btn ${ed ? 'ativo' : ''}" data-acao="editarEnvio" title="Editar antes de enviar">${IC.lapis}</button>
      <button class="icone-btn enviar" data-acao="enviar" title="Enviar na conversa aberta">${IC.enviar}</button>
    </div>${ed ? htmlEditarEnvio(ed) : ''}</div>`;
  }

  // Abre o editor embutido com o texto já personalizado para o contato da conversa aberta
  async function abrirEditarEnvio(r) {
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return avisar(e.message, 'erro');
    }
    if (!chat) return avisar('Abra uma conversa primeiro.');
    const cfg = await VF.config();
    const dados = { nome: nomeDe(chat.id, chat.nome), vendedor: cfg.nomeVendedor };
    estadoUI.editEnvio = {
      id: r.id,
      chatId: chat.id,
      contato: dados.nome,
      etapas: JSON.parse(JSON.stringify(r.etapas)).map((e) =>
        e.tipo === 'texto' ? { ...e, texto: VF.montarTexto(e.texto, dados) } : { ...e, legenda: VF.montarTexto(e.legenda || '', dados) }
      ),
    };
  }

  async function enviarEditado() {
    const ed = estadoUI.editEnvio;
    if (!ed) return;
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return avisar(e.message, 'erro');
    }
    if (!chat) return avisar('Abra uma conversa primeiro.');
    if (chat.id !== ed.chatId && !confirm(`Você trocou de conversa.\n\nEste texto foi preparado para ${ed.contato || 'outro contato'}. Enviar para ${nomeDe(chat.id, chat.nome) || 'a conversa aberta'} mesmo assim?`))
      return;
    const etapas = ed.etapas.filter((e) => e.tipo !== 'texto' || e.texto.trim());
    if (!etapas.length) return avisar('Não sobrou nenhuma mensagem para enviar.', 'erro');
    estadoUI.editEnvio = null;
    desenharLateral();
    const cfg = await VF.config();
    try {
      // O texto já está pronto: as variáveis foram trocadas ao abrir o editor
      await enviarEtapas(chat.id, etapas, { nome: nomeDe(chat.id, chat.nome), vendedor: cfg.nomeVendedor }, { digitacao: cfg.digitacaoNasRespostas });
      const lista = await VF.ler('respostas', []);
      const x = lista.find((y) => y.id === ed.id);
      if (x) {
        x.usos = (x.usos || 0) + 1;
        await VF.gravar('respostas', lista);
      }
    } catch (e) {
      avisar('Não consegui enviar: ' + e.message, 'erro');
    }
  }

  async function duplicarResposta(r) {
    const lista = await VF.ler('respostas', []);
    lista.push({ ...JSON.parse(JSON.stringify(r)), id: VF.novoId(), nome: r.nome + ' (cópia)', atalho: '', usos: 0 });
    await VF.gravar('respostas', lista);
  }
  async function excluirResposta(r) {
    const usadaEm = scripts.filter((s) => s.itens.some((it) => it.respostaId === r.id));
    const extra = usadaEm.length ? `\n\nEla também sai ${usadaEm.length > 1 ? 'dos scripts' : 'do script'}: ${usadaEm.map((s) => s.nome).join(', ')}.` : '';
    if (!confirm(`Excluir a resposta "${r.nome}"?${extra}`)) return;
    await VF.gravar('respostas', (await VF.ler('respostas', [])).filter((x) => x.id !== r.id));
    if (usadaEm.length) {
      const lista = await VF.ler('scripts', []);
      lista.forEach((s) => (s.itens = s.itens.filter((it) => it.respostaId !== r.id)));
      await VF.gravar('scripts', lista);
    }
    VF.limparMidiasOrfas();
  }

  // =====================================================================
  // Scripts: uma cadeia de respostas rápidas enviada com um clique
  // =====================================================================
  const respostaPorId = (id) => respostas.find((x) => x.id === id);
  const itensValidos = (s) => (s.itens || []).filter((it) => respostaPorId(it.respostaId));
  function duracaoScript(s) {
    const seg = itensValidos(s).reduce((t, it, j) => t + (j ? Number(it.espera) || 0 : 0) + respostaPorId(it.respostaId).etapas.reduce((a, e, k) => a + (k ? Number(e.espera ?? 2) : 0), 0), 0);
    return seg < 60 ? `${seg}s` : `${Math.round(seg / 60)} min`;
  }
  const resumoScript = (s) => itensValidos(s).map((it) => respostaPorId(it.respostaId).nome).join(' → ');
  // Junta as mensagens das respostas do script numa sequência só (usada no envio em massa)
  const etapasDoScript = (s) =>
    itensValidos(s).flatMap((it, j) =>
      JSON.parse(JSON.stringify(respostaPorId(it.respostaId).etapas)).map((e, k) => (k === 0 && j > 0 ? { ...e, espera: Number(it.espera) || 0 } : e))
    );

  let scriptRodando = null;
  async function usarScript(s) {
    if (scriptRodando) return avisar(`Espere o script "${scriptRodando}" terminar.`);
    const itens = itensValidos(s);
    if (!itens.length) return avisar('Este script não tem respostas. Edite e adicione.', 'erro');
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return avisar(e.message, 'erro');
    }
    if (!chat) return avisar('Abra uma conversa primeiro.');
    const cfg = await VF.config();
    const dados = { nome: nomeDe(chat.id, chat.nome), vendedor: cfg.nomeVendedor };
    scriptRodando = s.nome;
    avisar(`▶ Enviando o script "${s.nome}" (${itens.length} respostas) para ${VF.primeiroNome(dados.nome) || 'o contato'}…`, 'info', 4000);
    try {
      for (let j = 0; j < itens.length; j++) {
        if (j > 0) await VF.dormir(Math.max(0, Number(itens[j].espera) || 0) * 1000);
        await enviarEtapas(chat.id, respostaPorId(itens[j].respostaId).etapas, dados, { digitacao: cfg.digitacaoNasRespostas });
      }
      avisar(`✓ Script "${s.nome}" enviado.`, 'ok');
      const lista = await VF.ler('scripts', []);
      const x = lista.find((y) => y.id === s.id);
      if (x) {
        x.usos = (x.usos || 0) + 1;
        await VF.gravar('scripts', lista);
      }
    } catch (e) {
      avisar('O script parou: ' + e.message, 'erro');
    } finally {
      scriptRodando = null;
    }
  }

  function telaScripts(corpo) {
    corpo.innerHTML = `
      ${segmentoRespostas()}
      <div class="dica" style="margin:4px 0 12px">Um script envia várias respostas rápidas em sequência, com um clique. Ex.: Olá → Prazer/MEC → Áudio explicativo.</div>
      <button class="btn" id="novoScript" style="width:100%;margin-bottom:12px">${IC.mais2} Novo script</button>
      ${
        scripts.length
          ? `<div class="categoria aberta" style="border-color:var(--borda)">${scripts
              .map((s) => {
                const aberta = estadoUI.previa.has(s.id);
                const itens = itensValidos(s);
                return `<div data-script="${esc(s.id)}"><div class="item">
                  <span class="tipo">${IC.sequencia}</span>
                  <span class="nome"><b style="font-weight:600">${esc(s.nome)}</b>${s.atalho ? `<code>/${esc(s.atalho)}</code>` : ''}
                    <small class="dica" style="display:block">${itens.length} resposta${itens.length === 1 ? '' : 's'} · ~${duracaoScript(s)}</small></span>
                  <button class="icone-btn" data-acao="mais" title="Mais opções">${IC.mais}</button>
                  <button class="icone-btn" data-acao="ver" title="Ver a sequência">${IC.olho}</button>
                  <button class="icone-btn enviar" data-acao="enviar" title="Enviar na conversa aberta">${IC.enviar}</button>
                </div>${
                  aberta
                    ? `<div class="previa-resp">${itens
                        .map((it, j) => `<div class="arq">${j ? `<small>⏱ ${Number(it.espera) || 0}s</small><br>` : ''}<b>${j + 1}.</b> ${esc(respostaPorId(it.respostaId).nome)}</div>`)
                        .join('')}</div>`
                    : ''
                }</div>`;
              })
              .join('')}</div>`
          : `<div class="vazio">Nenhum script ainda.</div>`
      }
      <div class="dica" style="margin-top:12px">💡 Scripts com atalho também aparecem quando você digita <code>/</code> na conversa.</div>`;
    corpo.onclick = (e) => {
      const alvo = e.target.closest('button');
      if (!alvo) return;
      if (alvo.dataset.seg) {
        estadoUI.seg = alvo.dataset.seg;
        return desenharLateral();
      }
      if (alvo.id === 'novoScript') return irPara('script:nova');
      const s = scripts.find((x) => x.id === alvo.closest('[data-script]')?.dataset.script);
      if (!s) return;
      if (alvo.dataset.acao === 'enviar') return usarScript(s);
      if (alvo.dataset.acao === 'ver') {
        estadoUI.previa.has(s.id) ? estadoUI.previa.delete(s.id) : estadoUI.previa.add(s.id);
        return telaScripts(corpo);
      }
      if (alvo.dataset.acao === 'mais') {
        abrirPop(alvo, [
          { texto: '✏️ Editar', acao: () => irPara('script:' + s.id) },
          {
            texto: '📄 Duplicar',
            acao: async () => {
              const lista = await VF.ler('scripts', []);
              lista.push({ ...JSON.parse(JSON.stringify(s)), id: VF.novoId(), nome: s.nome + ' (cópia)', atalho: '', usos: 0 });
              await VF.gravar('scripts', lista);
            },
          },
          {
            texto: '🗑️ Excluir',
            perigo: true,
            acao: async () => {
              if (!confirm(`Excluir o script "${s.nome}"? As respostas rápidas continuam salvas.`)) return;
              await VF.gravar('scripts', (await VF.ler('scripts', [])).filter((x) => x.id !== s.id));
            },
          },
        ]);
      }
    };
  }

  function telaEditarScript(corpo, id) {
    const orig = scripts.find((x) => x.id === id);
    const s = orig ? JSON.parse(JSON.stringify(orig)) : { id: VF.novoId(), nome: '', atalho: '', itens: [] };
    if (!s.itens.length) s.itens.push({ respostaId: '', espera: 0 });
    const pastas = {};
    respostas.forEach((r) => (pastas[r.pasta || 'Sem categoria'] ||= []).push(r));
    const opcoes = (sel) =>
      `<option value="">Escolha a resposta…</option>` +
      Object.keys(pastas)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((p) => `<optgroup label="${esc(p)}">${pastas[p].map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}</optgroup>`)
        .join('');
    const nomeAtual = () => corpo.querySelector('#nomeScript')?.value ?? s.nome;
    const atalhoAtual = () => corpo.querySelector('#atalhoScript')?.value ?? s.atalho;
    function desenhar() {
      const nome = nomeAtual();
      const atalho = atalhoAtual();
      corpo.innerHTML = `
        <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${orig ? 'Editar script' : 'Novo script'}</h2></div>
        <div class="duas">
          <label class="campo">Nome<input type="text" id="nomeScript" value="${esc(nome)}" placeholder="Ex.: Abertura técnico"></label>
          <label class="campo">Atalho<input type="text" id="atalhoScript" value="${esc(atalho || '')}" placeholder="abertura"></label>
        </div>
        <div class="secao-t">Respostas, na ordem de envio</div>
        ${
          respostas.length
            ? s.itens
                .map(
                  (it, j) => `${
                    j > 0
                      ? `<div class="espera-script">⏱ esperar <input type="number" min="0" max="600" data-espera="${j}" value="${Number(it.espera) || 0}"> segundos</div>`
                      : ''
                  }<div class="item-script" data-j="${j}">
                    <span class="passo">${j + 1}</span>
                    <select data-resp="${j}">${opcoes(it.respostaId)}</select>
                    <button type="button" class="icone-btn" data-mover="-1" ${j === 0 ? 'disabled' : ''} title="Subir" style="transform:rotate(180deg)">${IC.seta}</button>
                    <button type="button" class="icone-btn" data-mover="1" ${j === s.itens.length - 1 ? 'disabled' : ''} title="Descer">${IC.seta}</button>
                    <button type="button" class="icone-btn" data-tirar title="Tirar">${IC.fechar}</button>
                  </div>`
                )
                .join('') + `<button type="button" class="btn sec" id="addItem" style="width:100%;margin-top:10px">${IC.mais2} Adicionar resposta</button>`
            : '<div class="alerta">Crie primeiro as respostas rápidas (aba Respostas). Depois junte elas aqui.</div>'
        }
        <div class="dica" style="margin-top:10px">Cada resposta é enviada inteira (com os textos, áudios e arquivos dela). A espera conta a partir do fim da resposta anterior.</div>`;
    }
    desenhar();
    rodape(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="salvar">Salvar</button>`);
    corpo.onchange = corpo.oninput = (e) => {
      const t = e.target;
      if (t.dataset.resp !== undefined) s.itens[Number(t.dataset.resp)].respostaId = t.value;
      if (t.dataset.espera !== undefined) s.itens[Number(t.dataset.espera)].espera = Math.max(0, Number(t.value) || 0);
    };
    corpo.onclick = (e) => {
      if (e.target.closest('#voltar')) return irPara(null);
      if (e.target.closest('#addItem')) {
        s.itens.push({ respostaId: '', espera: 3 });
        desenhar();
        corpo.querySelector(`[data-resp="${s.itens.length - 1}"]`)?.focus();
        return;
      }
      const caixa = e.target.closest('[data-j]');
      if (!caixa) return;
      const j = Number(caixa.dataset.j);
      const mover = e.target.closest('[data-mover]');
      if (mover) {
        const k = j + Number(mover.dataset.mover);
        [s.itens[j], s.itens[k]] = [s.itens[k], s.itens[j]];
        desenhar();
      } else if (e.target.closest('[data-tirar]')) {
        s.itens.splice(j, 1);
        if (!s.itens.length) s.itens.push({ respostaId: '', espera: 0 });
        desenhar();
      }
    };
    const pronto = () => {
      const itens = s.itens.filter((it) => it.respostaId);
      if (!itens.length) return avisar('Escolha pelo menos uma resposta.', 'erro'), null;
      return itens;
    };
    $('#teste').onclick = async () => {
      const itens = pronto();
      if (!itens) return;
      try {
        await enviarParaMim(etapasDoScript({ itens }));
        avisar('Script enviado para o seu próprio número. Confira em "Mensagens para mim".', 'ok');
      } catch (er) {
        avisar(er.message, 'erro');
      }
    };
    $('#salvar').onclick = async () => {
      const nome = nomeAtual().trim();
      const atalho = atalhoAtual().trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
      if (!nome) return avisar('Dê um nome para o script.', 'erro');
      const itens = pronto();
      if (!itens) return;
      const lista = await VF.ler('scripts', []);
      if (atalho && (lista.some((x) => x.atalho === atalho && x.id !== s.id) || respostas.some((x) => x.atalho === atalho)))
        return avisar(`O atalho /${atalho} já está em uso.`, 'erro');
      const novo = { ...s, nome, atalho, itens };
      const i = lista.findIndex((x) => x.id === s.id);
      if (i >= 0) lista[i] = novo;
      else lista.push(novo);
      await VF.gravar('scripts', lista);
      scripts = lista;
      avisar('Script salvo.', 'ok');
      irPara(null);
    };
  }

  function telaEditarResposta(corpo, id) {
    const r = respostas.find((x) => x.id === id) || { id: VF.novoId(), nome: '', atalho: '', pasta: estadoUI.pastaNova || '', etapas: [{ tipo: 'texto', texto: '', espera: 2 }] };
    estadoUI.pastaNova = '';
    const pastas = nomesCategorias();
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
      if (atalho && (lista.some((x) => x.atalho === atalho && x.id !== r.id) || scripts.some((x) => x.atalho === atalho)))
        return avisar(`O atalho /${atalho} já está em uso.`, 'erro');
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

  // Até 3 "modelos" (variações) de uma sequência de mensagens: cada lead recebe um sorteado.
  // Usado nas campanhas e nas mensagens automáticas das abas.
  function EditorModelos(el, iniciais, opcoes = {}) {
    const MAX = opcoes.max || 3;
    el.innerHTML = '<div class="modelos"></div><div class="modelos-eds"></div>';
    const barra = el.querySelector('.modelos');
    const eds = el.querySelector('.modelos-eds');
    const editores = [];
    let ativo = 0;
    function novo(etapas) {
      const caixa = document.createElement('div');
      eds.appendChild(caixa);
      editores.push({ caixa, ed: EditorEtapas(caixa, etapas, null, { semPrevia: true }) });
    }
    function desenhar() {
      editores.forEach((m, k) => m.caixa.classList.toggle('oculto', k !== ativo));
      barra.innerHTML =
        editores.map((_, k) => `<button type="button" class="modelo ${k === ativo ? 'ativo' : ''}" data-modelo="${k}">Modelo ${k + 1}${editores.length > 1 ? `<span class="x" data-tirar-modelo="${k}" title="Remover este modelo">✕</span>` : ''}</button>`).join('') +
        (editores.length < MAX ? `<button type="button" class="add-modelo" data-add-modelo>+ Outro modelo</button>` : '') +
        (editores.length > 1 ? '<span class="dica">sorteado para cada lead</span>' : '');
    }
    (iniciais && iniciais.length ? iniciais : [[{ tipo: 'texto', texto: '', espera: 2 }]]).slice(0, MAX).forEach(novo);
    desenhar();
    barra.addEventListener('click', (e) => {
      const tirar = e.target.closest('[data-tirar-modelo]');
      if (tirar) {
        const k = Number(tirar.dataset.tirarModelo);
        if (!confirm(`Remover o Modelo ${k + 1}?`)) return;
        editores[k].caixa.remove();
        editores.splice(k, 1);
        ativo = Math.min(ativo >= k && ativo > 0 ? ativo - 1 : ativo, editores.length - 1);
        return desenhar();
      }
      if (e.target.closest('[data-add-modelo]')) {
        novo(editores[ativo].ed.valor()); // começa como cópia do modelo aberto
        ativo = editores.length - 1;
        avisar(`Modelo ${ativo + 1} criado como cópia. Mude o texto para ficar diferente.`, 'info', 5000);
        return desenhar();
      }
      const m = e.target.closest('[data-modelo]');
      if (m) {
        ativo = Number(m.dataset.modelo);
        desenhar();
      }
    });
    return {
      validar(prefixo = '') {
        const p = (t) => (prefixo ? prefixo + ': ' : '') + t;
        for (let k = 0; k < editores.length; k++) {
          const erro = editores[k].ed.validar();
          if (erro) return p(editores.length > 1 ? `Modelo ${k + 1}: ${erro}` : erro);
          if (editores.length > 1 && !editores[k].ed.valor().length) return p(`O Modelo ${k + 1} está vazio. Preencha ou remova (✕).`);
        }
        if (editores.length > 1) {
          const assin = editores.map((m) => JSON.stringify(m.ed.valor()));
          const k = assin.findIndex((a, j) => assin.indexOf(a) !== j);
          if (k >= 0) return p(`O Modelo ${k + 1} está igual a outro. Mude o texto ou remova (✕).`);
        }
        return '';
      },
      valor: () => editores[ativo].ed.valor(),
      todos: () => editores.map((m) => m.ed.valor()),
      definir: (etapas) => editores[ativo].ed.definir(etapas),
      ativo: () => ativo,
      quantos: () => editores.length,
    };
  }

  // Opções "usar uma resposta rápida / script" (campanhas e automações)
  const opcoesRespostas = (primeira) =>
    `<option value="">${primeira}</option>${scripts.length ? `<optgroup label="Scripts">${scripts.map((s) => `<option value="s:${esc(s.id)}">🔗 ${esc(s.nome)}</option>`).join('')}</optgroup>` : ''}<optgroup label="Respostas rápidas">${respostas.map((r) => `<option value="${esc(r.id)}">⚡ ${esc((r.pasta ? r.pasta + ' › ' : '') + r.nome)}</option>`).join('')}</optgroup>`;
  function etapasDaOpcao(v) {
    const s = v.startsWith('s:') && scripts.find((x) => x.id === v.slice(2));
    if (s) return etapasDoScript(s);
    const r = respostas.find((x) => x.id === v);
    return r ? r.etapas : null;
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

  async function excluirCampanha(c) {
    const ativa = ['ativa', 'pausada'].includes(c.status);
    const msg = ativa
      ? `Excluir a campanha "${c.nome}"?\n\nEla ainda não terminou: o envio para quem está na fila PARA, e o histórico é apagado.`
      : `Excluir a campanha "${c.nome}" e o histórico dela?`;
    if (!confirm(msg)) return false;
    await VF.gravar('campanhas', (await VF.ler('campanhas', [])).filter((x) => x !== c.id));
    await VF.apagar('campanha:' + c.id);
    VF.limparMidiasOrfas();
    avisar('Campanha excluída.', 'ok');
    return true;
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
                  <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(c.nome)}</b><span class="etq ${c.status}">${NOME_STATUS[c.status]}</span><button class="icone-btn" data-excluir="${esc(c.id)}" title="Excluir campanha">${IC.lixo}</button></div>
                  <div class="progresso"><div style="width:${pct}%"></div></div>
                  <div class="dica">${n.feitos}/${n.total} · ✅ ${n.enviado} · 💬 ${n.respondeu} · ⏭ ${n.pulado} · ❌ ${n.falhou}</div>
                  ${c.motivo && c.status === 'pausada' ? `<div class="dica" style="color:var(--vermelho)">${esc(c.motivo)}</div>` : ''}
                </div>`;
              })
              .join('')
          : `<div class="vazio">Nenhuma campanha ainda.<br>Crie uma para mandar mensagem para vários leads, devagar e em segundo plano.</div>`
      }
      <div class="dica">Ritmo: ${cfg.intervaloMin}–${cfg.intervaloMax}s entre leads, pausa a cada ${cfg.loteTamanho}${cfg.usarHorario ? `, das ${cfg.horaInicio} às ${cfg.horaFim}` : ''}. <button class="link" data-abrir="config">mudar</button></div>`;
    corpo.onclick = async (e) => {
      if (e.target.closest('#nova')) return irPara('nova');
      const ex = e.target.closest('[data-excluir]');
      if (ex) {
        const alvo = campanhas.find((x) => x.id === ex.dataset.excluir);
        if (alvo && (await excluirCampanha(alvo))) desenharLateral();
        return;
      }
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
    const nModelos = (c.variacoes || []).length || 1;
    const porModelo = nModelos > 1
      ? Array.from({ length: nModelos }, (_, k) => {
          const doModelo = c.contatos.filter((x) => x.modelo === k + 1);
          const env = doModelo.filter((x) => x.status === 'enviado').length;
          const resp = doModelo.filter((x) => x.respondeu).length;
          return `<div><b>Modelo ${k + 1}</b>: ${env} enviados · ${resp} responderam${env ? ` (${Math.round((resp / env) * 100)}%)` : ''}</div>`;
        }).join('')
      : '';
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
      ${porModelo ? `<div class="dica" style="margin-top:8px">🔀 ${nModelos} modelos sorteados:${porModelo}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">
        ${c.status === 'ativa' ? `<button class="btn sec peq" data-acao="pausar">${IC.pausa} Pausar</button>` : ''}
        ${c.status === 'pausada' ? `<button class="btn peq" data-acao="retomar">${IC.play} Retomar</button>` : ''}
        ${n.falhou + n.pulado && c.status !== 'cancelada' ? '<button class="btn sec peq" data-acao="refazer">Tentar de novo pulados/falhas</button>' : ''}
        <button class="btn sec peq" data-acao="duplicar">Duplicar</button>
        <button class="btn sec peq" data-acao="csv">Planilha</button>
        ${['ativa', 'pausada'].includes(c.status) ? '<button class="btn perigo peq" data-acao="cancelar">Cancelar</button>' : ''}
        <button class="btn perigo peq" data-acao="excluir">${IC.lixo} Excluir</button>
      </div>
      <div class="chips">${['todos', 'pendente', 'enviado', 'respondeu', 'pulado', 'falhou']
        .map((x) => `<button class="chip ${f === x ? 'ativo' : ''}" data-fc="${x}">${x === 'todos' ? 'Todos' : x === 'respondeu' ? 'Responderam' : NOME_CONTATO[x]}</button>`)
        .join('')}</div>
      <div>${visiveis
        .slice(0, 500)
        .map(
          (x) => `<div class="contato-linha clicavel" data-abrir-chat="${esc(x.id)}" title="Abrir a conversa no WhatsApp"><div class="cresce"><div>${esc(x.nome || VF.numeroDoId(x.id) || x.id.split('@')[0])}${x.respondeu ? ' 💬' : ''}${x.modelo && nModelos > 1 ? ` <span class="dica">· modelo ${x.modelo}</span>` : ''}</div>
            ${x.erro ? `<small>${esc(x.erro)}</small>` : x.respondeuEm ? `<small>Respondeu ${new Date(x.respondeuEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>` : x.em ? `<small>${new Date(x.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>` : ''}</div>
            <span class="etq ${x.status}">${NOME_CONTATO[x.status] || x.status}</span><span class="abrir-chat">${IC.chat}</span></div>`
        )
        .join('') || '<div class="vazio">Ninguém aqui.</div>'}</div>
      ${visiveis.length ? '<div class="dica" style="margin-top:6px">Clique em um lead para abrir a conversa dele.</div>' : ''}`;
    corpo.onclick = async (e) => {
      if (e.target.closest('#voltar')) return irPara(null);
      const fc = e.target.closest('[data-fc]');
      if (fc) {
        estadoUI.filtroContatos = fc.dataset.fc;
        return desenharLateral();
      }
      const lin = e.target.closest('[data-abrir-chat]');
      if (lin) {
        lin.classList.add('abrindo');
        try {
          await rpc('abrirChat', lin.dataset.abrirChat);
        } catch (err) {
          avisar('Não consegui abrir essa conversa: ' + err.message, 'erro');
        }
        lin.classList.remove('abrindo');
        return;
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
      if (acao === 'excluir') {
        if (await excluirCampanha(c)) return irPara(null);
        return;
      }
      desenharLateral();
    };
  }

  function baixarCSV(c) {
    const linhas = [['nome', 'numero', 'situacao', 'respondeu', 'modelo', 'quando', 'observacao']];
    c.contatos.forEach((x) =>
      linhas.push([x.nome || '', (x.id.match(/^(\d+)@c\.us$/) || [])[1] || x.id, NOME_CONTATO[x.status] || x.status, x.respondeu ? 'sim' : '', x.modelo || '', x.em ? new Date(x.em).toLocaleString('pt-BR') : '', x.erro || ''])
    );
    const csv = '﻿' + linhas.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `campanha-${c.nome.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
  }

  // Lê uma planilha CSV e devolve [{ numero, nome }] (descobre o separador e as colunas sozinho)
  function lerCSV(texto) {
    const linhas = texto.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!linhas.length) return null;
    const sep = [';', ',', '\t'].map((c) => [c, linhas[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    const partir = (l) => {
      const out = [];
      let cur = '';
      let aspas = false;
      for (const ch of l) {
        if (ch === '"') aspas = !aspas;
        else if (ch === sep && !aspas) (out.push(cur), (cur = ''));
        else cur += ch;
      }
      out.push(cur);
      return out.map((x) => x.trim());
    };
    const rows = linhas.map(partir);
    const digitos = (x) => String(x || '').replace(/\D/g, '').length;
    const cab = rows[0].map((x) => VF.semAcento(x.toLowerCase()));
    const temCab = !rows[0].some((x) => digitos(x) >= 10);
    const dados = temCab ? rows.slice(1) : rows;
    let iNum = temCab ? cab.findIndex((c) => /whats|celular|telefone|fone|^tel|numero|phone|mobile/.test(c)) : -1;
    if (iNum < 0 || !dados.some((r) => digitos(r[iNum]) >= 10)) {
      let melhor = -1;
      let qtd = 0;
      const n = Math.max(...dados.map((r) => r.length));
      for (let i = 0; i < n; i++) {
        const c = dados.filter((r) => digitos(r[i]) >= 10 && digitos(r[i]) <= 15).length;
        if (c > qtd) ((qtd = c), (melhor = i));
      }
      iNum = melhor;
    }
    if (iNum < 0) return null;
    let iNome = temCab ? cab.findIndex((c, i) => i !== iNum && /^(nome|name|primeiro nome|first name|cliente|lead|aluno|contato)/.test(c)) : -1;
    if (iNome < 0 && dados[0]) iNome = dados[0].findIndex((x, i) => i !== iNum && /[a-zà-ú]{2}/i.test(x) && !x.includes('@'));
    return {
      colNumero: temCab ? rows[0][iNum] : 'coluna ' + (iNum + 1),
      colNome: iNome >= 0 ? (temCab ? rows[0][iNome] : 'coluna ' + (iNome + 1)) : '',
      linhas: dados.map((r) => ({ numero: r[iNum] || '', nome: iNome >= 0 ? r[iNome] || '' : '' })).filter((x) => digitos(x.numero) >= 8),
    };
  }

  async function telaNovaCampanha(corpo, idBase) {
    const base = idBase ? await VF.ler('campanha:' + idBase) : null;
    const cfg = await VF.config();
    const manuais = abas.filter((a) => a.tipo !== 'etiqueta');
    const opAbas = (vazio) => `<option value="">${vazio}</option>` + manuais.map((a) => `<option value="${esc(a.id)}">${esc(a.nome)} (${(a.chats || []).length})</option>`).join('');
    const opEtiq = (vazio) => `<option value="">${vazio}</option>` + etiquetas.map((e) => `<option value="${esc(e.id)}">${esc(e.nome)} (${e.total})</option>`).join('');
    const opsEtq = () => etiquetas.map((e) => ({ id: e.id, nome: e.nome, cor: e.cor, extra: e.total }));
    const opsGrupos = () => [
      ...etiquetas.map((e) => ({ id: 'e:' + e.id, nome: e.nome, cor: e.cor, grupo: 'Etiquetas do WhatsApp', extra: e.total })),
      ...manuais.map((a) => ({ id: 'a:' + a.id, nome: a.nome, cor: a.cor, grupo: 'Abas', extra: (a.chats || []).length })),
    ];

    corpo.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>Nova campanha</h2></div>
      <label class="campo">Nome da campanha<input type="text" id="nome" placeholder="Ex.: Black November – leads de outubro" value="${esc(base ? base.nome + ' (2)' : '')}"></label>

      <div class="cartao"><h3><span class="passo">1</span>Para quem?</h3>
        <select id="origem">
          <option value="grupos">Etiquetas e/ou abas (pode escolher várias)</option>
          <option value="todas">Todas as conversas</option>
          <option value="lista">Planilha (CSV) ou lista de números</option>
        </select>
        <div style="margin-top:8px">
          <div id="origemGrupos" data-o="grupos"></div>
          <div data-o="lista" class="oculto">
            <button type="button" class="btn sec peq" id="importarCSV">📄 Importar planilha (CSV)</button>
            <input type="file" id="arquivoCSV" accept=".csv,.txt,text/csv" class="oculto">
            <textarea id="origemLista" style="margin-top:8px" placeholder="Ou cole um número por linha (pode ter o nome depois de ; )&#10;11999998888;Maria&#10;21988887777;João"></textarea>
            <div class="dica">A planilha precisa ter uma coluna com o telefone (com DDD). Se tiver uma coluna de nome, ele vai para o {nome}. No Excel/Google Planilhas: Arquivo › Baixar/Salvar como › CSV.</div>
          </div>
        </div>
        <div id="publico" class="dica" style="margin-top:8px"></div>
      </div>

      <div class="cartao"><h3><span class="passo">2</span>O que enviar?</h3>
        <select id="usarResp" style="margin-bottom:10px"><option value="">✍️ Escrever aqui</option>${scripts.length ? `<optgroup label="Scripts">${scripts.map((s) => `<option value="s:${esc(s.id)}">🔗 ${esc(s.nome)}</option>`).join('')}</optgroup>` : ''}<optgroup label="Respostas rápidas">${respostas.map((r) => `<option value="${esc(r.id)}">⚡ ${esc((r.pasta ? r.pasta + ' › ' : '') + r.nome)}</option>`).join('')}</optgroup></select>
        <div id="modelosCamp"></div>
        <div class="dica" style="margin-top:8px">🔀 Crie até 3 modelos diferentes: cada lead recebe um deles, sorteado. Mensagens variadas diminuem o risco de bloqueio.<br>Dica: <code>{Oi|Olá|E aí}</code> sorteia uma opção para cada lead e <code>{primeiro_nome}</code> coloca o nome.</div>
      </div>

      <details class="cartao"><summary>Mais opções (etiquetas, abas e filtros)</summary>
        <div class="secao-t">Depois de enviar</div>
        <div class="duas">
          <label class="campo">Pôr na aba<select id="addAba">${opAbas('—')}</select></label>
          <label class="campo">Tirar da aba<select id="remAba">${opAbas('—')}</select></label>
        </div>
        <div class="linha-sel"><span>Colocar etiquetas</span><div id="addEtiq"></div></div>
        <div class="linha-sel"><span>Tirar etiquetas</span><div id="remEtiq"></div></div>
        <div class="secao-t">Se responder</div>
        <div class="duas">
          <label class="campo">Pôr na aba<select id="respAba">${opAbas('—')}</select></label>
          <label class="campo">Pôr etiqueta<select id="respEtiq">${opEtiq('—')}</select></label>
        </div>
        <div class="secao-t">Filtros</div>
        <div class="duas">
          <label class="campo">Última conversa há pelo menos<input type="number" id="minDias" min="0" placeholder="dias"></label>
          <label class="campo">Última conversa há no máximo<input type="number" id="maxDias" min="0" placeholder="dias"></label>
        </div>
        <label class="campo">Pular quem conversou com você nas últimas (horas)<input type="number" id="recente" min="0" value="${base ? base.pularRecenteHoras || 0 : 0}"><small>0 = não pular ninguém. Use para não mandar campanha para quem está em atendimento agora.</small></label>
        <div class="linha-sel"><span>Não enviar para quem tem</span><div id="exclEtiq"></div></div>
      </details>
      <div id="estimativa" class="dica"></div>`;
    rodape(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="criar">${IC.play} Começar envio</button>`);

    const q = (s) => corpo.querySelector(s);
    const editor = EditorModelos(q('#modelosCamp'), base && base.variacoes && base.variacoes.length ? base.variacoes : [base ? base.etapas : [{ tipo: 'texto', texto: '', espera: 2 }]]);
    const qq = (s) => [...corpo.querySelectorAll(s)];
    let publico = null;
    const selGrupos = seletorMulti(q('#origemGrupos'), opsGrupos, [], () => atualizarPublico(), 'Nenhuma escolhida ainda');
    const selAdd = seletorMulti(q('#addEtiq'), opsEtq, [], null, '—');
    const selRem = seletorMulti(q('#remEtiq'), opsEtq, [], null, '—');
    const selExcl = seletorMulti(q('#exclEtiq'), opsEtq, [], () => atualizarPublico(), '—');

    if (base) {
      const a = base.acoes || {};
      q('#addAba').value = a.addAba || '';
      q('#remAba').value = a.removerAba || '';
      selAdd.definir(a.addEtiquetas);
      selRem.definir(a.removerEtiquetas);
      selExcl.definir(base.excluirEtiquetas);
      q('#respAba').value = (base.aoResponder || {}).addAba || '';
      q('#respEtiq').value = (base.aoResponder || {}).addEtiqueta || '';
      const o = base.origem || {};
      if (o.tipo === 'aba' || o.tipo === 'etiqueta') selGrupos.definir([(o.tipo === 'aba' ? 'a:' : 'e:') + o.valor]);
      if (o.tipo === 'grupos') selGrupos.definir(o.valores || []);
      if (o.tipo) q('#origem').value = o.tipo === 'aba' || o.tipo === 'etiqueta' ? 'grupos' : o.tipo;
    } else if (!etiquetas.length && !manuais.length) {
      q('#origem').value = 'lista';
    }

    // Importar planilha (CSV): acha a coluna do telefone e a do nome sozinho
    q('#importarCSV').onclick = () => q('#arquivoCSV').click();
    q('#arquivoCSV').onchange = async (e) => {
      const arq = e.target.files[0];
      e.target.value = '';
      if (!arq) return;
      let texto = await arq.text();
      if (texto.includes('\uFFFD')) texto = new TextDecoder('windows-1252').decode(await arq.arrayBuffer()); // planilha salva no Excel antigo
      const r = lerCSV(texto);
      if (!r || !r.linhas.length) return avisar('Não achei nenhuma coluna com telefone nessa planilha.', 'erro');
      const ta = q('#origemLista');
      const novas = r.linhas.map((x) => x.numero.replace(/[^\d+]/g, '') + (x.nome ? ';' + x.nome.replace(/[;\n]/g, ' ') : '')).join('\n');
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + novas;
      avisar(`${r.linhas.length} contatos importados de "${arq.name}" (telefone: coluna "${r.colNumero}"${r.colNome ? `, nome: coluna "${r.colNome}"` : ''}).`, 'ok', 7000);
      atualizarPublico();
    };

    async function montarPublico() {
      const origem = q('#origem').value;
      const minDias = Number(q('#minDias').value) || 0;
      const maxDias = Number(q('#maxDias').value) || 0;
      const excl = selExcl.valor();
      const naoPerturbe = await VF.ler('naoPerturbe', []);
      const bloqueados = new Set(naoPerturbe.flatMap((n) => n.ids));
      let candidatos = [];
      let chats = null;
      const grupos = selGrupos.valor();
      if (origem === 'grupos' && !grupos.length) return null;
      if (origem === 'lista' && !q('#origemLista').value.trim()) return null;
      const abasSel = grupos.filter((g) => g.startsWith('a:')).map((g) => g.slice(2));
      const etqSel = grupos.filter((g) => g.startsWith('e:')).map((g) => g.slice(2));

      let invalidos = 0;
      if (origem === 'grupos') {
        for (const etq of etqSel) candidatos.push(...(await rpc('listarChats', { etiqueta: etq })).map((c) => ({ ...c, ids: [c.id] })));
        if (abasSel.length) {
          chats = minDias || maxDias || excl.length ? await rpc('listarChats', {}) : [];
          const mapa = new Map(chats.map((c) => [c.id, c]));
          for (const abaId of abasSel) {
            const aba = abas.find((a) => a.id === abaId);
            if (!aba) continue;
            candidatos.push(
              ...(aba.chats || []).map((c) => {
                const info = c.ids.map((x) => mapa.get(x)).find(Boolean);
                return { id: c.ids.find((x) => x.endsWith('@c.us')) || c.ids[0], ids: c.ids, nome: (info && info.nome) || c.nome, t: info ? info.t : 0, etiquetas: info ? info.etiquetas : [], semInfo: !info };
              })
            );
          }
        }
      } else if (origem === 'todas') {
        candidatos = (await rpc('listarChats', {})).map((c) => ({ ...c, ids: [c.id] }));
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
          const motivos = [fora.bloqueados && `${fora.bloqueados} no Não perturbe`, fora.filtro && `${fora.filtro} pelos filtros`, fora.repetidos && `${fora.repetidos} repetidos (estavam em mais de um grupo)`, fora.invalidos && `${fora.invalidos} números inválidos`].filter(Boolean);
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
      if (e.target.closest('#modelosCamp') || e.target.id === 'nome' || e.target.id === 'usarResp') return;
      if (['addAba', 'remAba', 'respAba', 'respEtiq', 'recente', 'arquivoCSV'].includes(e.target.id)) return;
      atualizarPublico();
    };
    q('#usarResp').onchange = (e) => {
      const v = e.target.value;
      const s = v.startsWith('s:') && scripts.find((x) => x.id === v.slice(2));
      if (s) return editor.definir(etapasDoScript(s));
      const r = respostas.find((x) => x.id === v);
      if (r) editor.definir(r.etapas);
    };
    q('#voltar').onclick = () => irPara(null);
    atualizarPublico();

    $('#teste').onclick = async () => {
      const erro = editor.validar();
      if (erro) return avisar(erro, 'erro');
      try {
        await enviarParaMim(editor.valor());
        avisar(`Teste${editor.quantos() > 1 ? ` do Modelo ${editor.ativo() + 1}` : ''} enviado para você (com o nome "Maria Teste").`, 'ok');
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
      const variacoes = editor.todos().filter((v) => v.length);
      const etapas = variacoes[0] || [];
      const acoes = {
        addAba: q('#addAba').value,
        removerAba: q('#remAba').value,
        addEtiquetas: selAdd.valor(),
        removerEtiquetas: selRem.valor(),
      };
      const temAcao = acoes.addAba || acoes.removerAba || acoes.addEtiquetas.length || acoes.removerEtiquetas.length;
      if (!etapas.length && !temAcao) return avisar('Coloque o que enviar (passo 2).', 'erro');
      if (!confirm(`Começar a enviar para ${publico.contatos.length} lead(s)?${variacoes.length > 1 ? `\n\n🔀 ${variacoes.length} modelos: cada lead recebe um sorteado.` : ''}\n\nO envio é lento de propósito (${cfg.intervaloMin}–${cfg.intervaloMax}s entre cada um) e segue em segundo plano.`)) return;
      const origem = q('#origem').value;
      const c = {
        id: VF.novoId(),
        nome,
        criadaEm: Date.now(),
        status: 'ativa',
        motivo: '',
        origem: { tipo: origem, valores: origem === 'grupos' ? selGrupos.valor() : [] },
        excluirEtiquetas: selExcl.valor(),
        etapas,
        variacoes: variacoes.length > 1 ? variacoes : [],
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
  const CORES = ['#25d366', '#00bfa5', '#34b7f1', '#3f51b5', '#9c27b0', '#e91e63', '#ff5722', '#f5a623', '#8bc34a', '#607d8b'];

  function descricaoAba(a) {
    if (a.tipo === 'etiqueta') {
      const et = etiquetas.find((x) => x.id === String(a.etiquetaId));
      return et ? `Quem tem a etiqueta "${et.nome}" · ${et.total}` : 'Etiqueta não escolhida';
    }
    const n = (a.chats || []).length;
    return n ? `${n} lead${n > 1 ? 's' : ''} escolhido${n > 1 ? 's' : ''} por você` : 'Vazia: abra uma conversa e marque a aba no ícone 👤';
  }

  async function salvarAba(nova) {
    const lista = await VF.ler('abas', []);
    const i = lista.findIndex((x) => x.id === nova.id);
    if (i >= 0) lista[i] = nova;
    else lista.push(nova);
    await VF.gravar('abas', lista);
    abas = lista;
    desenharPilulas();
  }

  async function excluirAba(a) {
    if (!confirm(`Excluir a aba "${a.nome}"?\n\nOs leads e as conversas continuam no WhatsApp, só a aba some.${automacoes[a.id] ? '\n\nA sequência automática desta aba também para.' : ''}`)) return false;
    if (automacoes[a.id]) await apagarAutomacao(a.id).catch((e) => avisar('Sequência automática: ' + e.message, 'erro'));
    abas = (await VF.ler('abas', [])).filter((x) => x.id !== a.id);
    await VF.gravar('abas', abas);
    if (abaSelecionada === a.id) selecionarAba('todas');
    desenharPilulas();
    if (secaoAtual === 'abas' && !visao) desenharLateral();
    return true;
  }

  async function renomearAba(a) {
    const nome = (prompt('Novo nome da aba:', a.nome) || '').trim();
    if (nome && nome !== a.nome) await salvarAba({ ...a, nome });
  }

  telas.abas = async (corpo) => {
    if (visao) return telaEditarAba(corpo, visao === 'nova' ? null : visao.slice(7).replace(/:auto$/, ''), visao.endsWith(':auto'));
    corpo.innerHTML = `
      <div class="lat-titulo"><h2>Abas</h2><button class="btn peq" id="nova">${IC.mais2} Nova aba</button></div>
      <div class="dica" style="margin-bottom:12px">As abas ficam na barra de cima e separam as conversas. Para mudar a ordem, <b>clique, segure e arraste</b> a aba (aqui ou lá em cima).
        Atalho: clique com o <b>botão direito</b> numa aba lá em cima para renomear, mudar a cor ou excluir.</div>
      ${
        abas.length
          ? `<div class="abas-lista">${abas
              .map(
                (a) => `<div class="aba-linha" data-id="${esc(a.id)}" title="Clique para editar · segure e arraste para mudar a ordem">
              <span class="bolinha" style="background:${esc(a.cor || '#25d366')}"></span>
              <div class="cresce"><div class="aba-nome">${esc(a.nome)}</div><div class="dica">${esc(descricaoAba(a))}</div></div>
              <button class="icone-btn" data-acao="renomear" title="Renomear">${IC.lapis}</button>
              <button class="icone-btn" data-acao="excluir" title="Excluir aba">${IC.lixo}</button>
            </div>`
              )
              .join('')}</div>`
          : `<div class="vazio">Nenhuma aba ainda.<br>Crie abas para separar os leads, por exemplo "Leads Enfermagem" ou "Matrícula feita".</div>`
      }`;
    corpo.onclick = async (e) => {
      if (e.target.closest('#nova')) return irPara('nova');
      const linha = e.target.closest('[data-id]');
      if (!linha) return;
      const a = abas.find((x) => x.id === linha.dataset.id);
      if (!a) return;
      const acao = e.target.closest('[data-acao]')?.dataset.acao;
      if (acao === 'excluir') return excluirAba(a);
      if (acao === 'renomear') return renomearAba(a).then(() => desenharLateral());
      irPara('editar:' + a.id);
    };
    // Segurar e arrastar a linha muda a ordem
    const listaAbas = corpo.querySelector('.abas-lista');
    if (listaAbas)
      ordenarArrastando(listaAbas, '.aba-linha', {
        aoSoltar: () => salvarOrdemAbas([...listaAbas.querySelectorAll('.aba-linha')].map((x) => x.dataset.id)),
      });
  };

  async function salvarOrdemAbas(ordem) {
    const lista = await VF.ler('abas', []);
    abas = ordem.map((id) => lista.find((a) => a.id === id)).filter(Boolean).concat(lista.filter((a) => !ordem.includes(a.id)));
    desenharPilulas();
    await VF.gravar('abas', abas);
  }

  function telaEditarAba(corpo, id, focarAuto) {
    const orig = id ? abas.find((x) => x.id === id) : null;
    if (id && !orig) return irPara(null);
    const a = orig ? JSON.parse(JSON.stringify(orig)) : { id: VF.novoId(), nome: '', cor: CORES[abas.length % CORES.length], tipo: 'manual', chats: [] };
    corpo.innerHTML = '<div id="formAba"></div><div id="autoAba"></div>';
    const formAba = corpo.querySelector('#formAba');
    const autoAba = corpo.querySelector('#autoAba');
    function desenhar() {
      const nome = corpo.querySelector('#nomeAba')?.value ?? a.nome;
      const livre = !CORES.includes(a.cor);
      autoAba.classList.toggle('oculto', a.tipo === 'etiqueta');
      formAba.innerHTML = `
        <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${orig ? 'Editar aba' : 'Nova aba'}</h2></div>
        <label class="campo">Nome da aba<input type="text" id="nomeAba" maxlength="40" value="${esc(nome)}" placeholder="Ex.: Leads Enfermagem"></label>
        <div class="campo">Cor
          <div class="cores">${CORES.map((c) => `<button type="button" class="cor-op ${c === a.cor ? 'sel' : ''}" data-cor="${c}" style="background:${c}"></button>`).join('')}
            <label class="cor-op livre ${livre ? 'sel' : ''}" title="Outra cor" style="${livre ? 'background:' + esc(a.cor) : ''}">${livre ? '' : '+'}<input type="color" id="corLivre" value="${esc(a.cor)}"></label></div>
          <div class="previa-pilula"><span class="pilula ativa" style="border-color:${esc(a.cor)}"><span class="cor" style="background:${esc(a.cor)}"></span>${esc(nome || 'Nome da aba')}</span></div>
        </div>
        <div class="campo">Quais conversas aparecem nesta aba?
          <label class="opcao ${a.tipo !== 'etiqueta' ? 'sel' : ''}"><input type="radio" name="tipo" value="manual" ${a.tipo !== 'etiqueta' ? 'checked' : ''}>
            <div><b>As que eu escolher</b><small>Com a conversa aberta, clique no ícone 👤 e marque esta aba.</small></div></label>
          <label class="opcao ${a.tipo === 'etiqueta' ? 'sel' : ''}"><input type="radio" name="tipo" value="etiqueta" ${a.tipo === 'etiqueta' ? 'checked' : ''}>
            <div><b>As que têm uma etiqueta do WhatsApp</b><small>A aba se atualiza sozinha quando você etiqueta alguém.</small></div></label>
        </div>
        ${
          a.tipo === 'etiqueta'
            ? `<label class="campo">Etiqueta<select id="etqAba"><option value="">Escolha a etiqueta…</option>${etiquetas
                .map((t) => `<option value="${esc(t.id)}" ${String(a.etiquetaId) === t.id ? 'selected' : ''}>${esc(t.nome)} (${t.total})</option>`)
                .join('')}</select></label>`
            : (a.chats || []).length
              ? `<div class="secao-t">Leads nesta aba (${a.chats.length})</div>${a.chats
                  .map((c, j) => `<div class="contato-linha"><div class="cresce"><div>${esc(c.nome || VF.numeroDoId(c.ids.find((x) => x.endsWith('@c.us'))) || c.ids[0])}</div></div><button class="link" data-tirar="${j}">tirar</button></div>`)
                  .join('')}`
              : ''
        }`;
    }
    desenhar();
    const edAuto = EditorAutomacao(autoAba, a);
    if (focarAuto) {
      edAuto.abrir();
      setTimeout(() => autoAba.scrollIntoView({ block: 'start' }), 50);
    }
    rodape(`${orig ? `<button class="btn perigo" id="excluirAba">Excluir aba</button>` : ''}<button class="btn" id="salvarAba">Salvar</button>`);
    corpo.oninput = (e) => {
      if (e.target.closest('#autoAba')) return;
      if (e.target.id === 'nomeAba') {
        const p = corpo.querySelector('.previa-pilula .pilula');
        p.lastChild.textContent = e.target.value || 'Nome da aba';
      }
      if (e.target.id === 'corLivre') {
        a.cor = e.target.value;
        const p = corpo.querySelector('.previa-pilula .pilula');
        p.style.borderColor = a.cor;
        p.querySelector('.cor').style.background = a.cor;
      }
    };
    corpo.onchange = (e) => {
      if (e.target.closest('#autoAba')) return;
      if (e.target.name === 'tipo') {
        a.tipo = e.target.value;
        desenhar();
      }
      if (e.target.id === 'etqAba') a.etiquetaId = e.target.value;
      if (e.target.id === 'corLivre') desenhar();
    };
    corpo.onclick = (e) => {
      if (e.target.closest('#voltar')) return irPara(null);
      const c = e.target.closest('[data-cor]');
      if (c) {
        a.cor = c.dataset.cor;
        return desenhar();
      }
      const t = e.target.closest('[data-tirar]');
      if (t) {
        a.chats.splice(Number(t.dataset.tirar), 1);
        desenhar();
      }
    };
    if (orig) $('#excluirAba').onclick = async () => (await excluirAba(orig)) && irPara(null);
    $('#salvarAba').onclick = async () => {
      a.nome = corpo.querySelector('#nomeAba').value.trim();
      if (!a.nome) return avisar('Dê um nome para a aba.', 'erro');
      if (a.tipo === 'etiqueta' && !a.etiquetaId) return avisar('Escolha a etiqueta.', 'erro');
      const acaoAuto = a.tipo === 'etiqueta' ? (automacoes[a.id] ? 'apagar' : null) : edAuto.acao();
      if (acaoAuto === 'salvar') {
        const erro = edAuto.validar();
        if (erro) return avisar(erro, 'erro');
      }
      const botao = $('#salvarAba');
      botao.disabled = true;
      await salvarAba(a);
      try {
        if (acaoAuto === 'salvar') await salvarAutomacao(a, edAuto.valor(), edAuto.nova);
        if (acaoAuto === 'apagar') await apagarAutomacao(a.id);
      } catch (e) {
        botao.disabled = false;
        return avisar('A aba foi salva, mas a sequência automática não: ' + e.message, 'erro', 9000);
      }
      if (abaSelecionada === a.id) selecionarAba(a.id);
      avisar(orig ? 'Aba salva.' : `Aba "${a.nome}" criada.${a.tipo === 'etiqueta' ? '' : ' Abra uma conversa e marque a aba no ícone 👤.'}`, 'ok');
      irPara(null);
    };
    if (!orig) corpo.querySelector('#nomeAba').focus();
  }

  // =====================================================================
  // KANBAN + SEQUÊNCIA AUTOMÁTICA NO SERVIDOR
  // As abas "escolhidas por mim" viram colunas. Cada aba pode ter uma sequência
  // de mensagens que o servidor envia sozinho (mesmo com o computador desligado).
  // =====================================================================
  let servidor = { chave: '' };
  let automacoes = {}; // { abaId: { ativa, passos: [{ espera: { n, unidade }, variacoes: [[etapas]] }], aoResponder, aoTerminar } }
  let kanban = { inscricoes: [], whatsapp: null, atualizado: 0, erro: '' };
  let kanbanAberto = false;
  let arrastandoCard = false;
  const servidorLigado = () => !!servidor.chave;
  // Chave para comparar números (ignora o 9º dígito dos celulares do Brasil)
  const chaveNum = (s) => {
    let d = String(s || '').split('@')[0].replace(/\D/g, '');
    if (d.startsWith('55') && d.length === 13 && d[4] === '9') d = d.slice(0, 4) + d.slice(5);
    return d;
  };
  const colunasKanban = () => abas.filter((a) => a.tipo !== 'etiqueta');
  const UNIDADES = { min: 'minutos', h: 'horas', d: 'dias' };

  async function api(metodo, caminho, corpo) {
    const r = await chrome.runtime.sendMessage({ tipo: 'api', metodo, caminho, corpo });
    if (!r) throw new Error('A extensão não respondeu. Recarregue a página.');
    if (r.erro) throw new Error(r.erro);
    return r.dados;
  }

  async function numeroDoLead(ids) {
    let c = ids.find((x) => x.endsWith('@c.us'));
    for (const x of ids) {
      if (c) break;
      c = (await equivalentes(x)).find((y) => y.endsWith('@c.us'));
    }
    return c ? c.split('@')[0] : '';
  }

  function inscricaoDe(abaId, ids) {
    const ks = new Set(ids.map(chaveNum));
    return kanban.inscricoes.find((i) => i.abaId === abaId && (ks.has(chaveNum(i.numero)) || (i.ids || []).some((x) => ks.has(chaveNum(x)))));
  }

  async function montarEntradas(abaId, chats) {
    const lista = [];
    let semNumero = 0;
    for (const c of chats) {
      const numero = await numeroDoLead(c.ids);
      if (!numero) semNumero++;
      // em = quando entrou na aba (sem data = antigo: o servidor não recomeça quem já terminou/respondeu)
      else lista.push({ abaId, numero, ids: c.ids, nome: nomeDe(c.ids, c.nome), em: c.em || 0 });
    }
    if (semNumero) avisar(`${semNumero} lead(s) sem número de telefone visível ficaram fora da sequência automática.`, 'erro', 7000);
    return lista;
  }

  // Lead entrou/saiu de uma aba com sequência automática -> avisa o servidor
  async function avisarMudancasAbas(antes, depois) {
    if (!servidorLigado()) return;
    const mapa = new Map((antes || []).map((a) => [a.id, a]));
    const novos = [];
    const sair = [];
    for (const a of depois || []) {
      if (!automacoes[a.id] || a.tipo === 'etiqueta') continue;
      const velhos = (mapa.get(a.id) || {}).chats || [];
      const atuais = a.chats || [];
      atuais.forEach((c) => !velhos.some((v) => v.ids.some((x) => c.ids.includes(x))) && novos.push([a.id, c]));
      for (const v of velhos) if (!atuais.some((c) => c.ids.some((x) => v.ids.includes(x)))) sair.push({ abaId: a.id, numero: await numeroDoLead(v.ids) });
    }
    if (!novos.length && !sair.length) return;
    const entrar = [];
    for (const [abaId, c] of novos) entrar.push(...(await montarEntradas(abaId, [c])));
    const pacote = { entrar, sair: sair.filter((x) => x.numero) };
    try {
      await api('POST', '/leads/mudancas', pacote);
      setTimeout(sincronizarKanban, 1500);
    } catch (e) {
      // Sem internet/servidor fora: guarda e tenta de novo na próxima sincronização
      const fila = await VF.ler('kanbanFila', { entrar: [], sair: [] });
      await VF.gravar('kanbanFila', { entrar: [...fila.entrar, ...pacote.entrar], sair: [...fila.sair, ...pacote.sair] });
    }
  }

  async function aplicarMovimentos(itens) {
    const lista = await VF.ler('abas', []);
    const feitos = [];
    for (const i of itens) {
      const de = lista.find((a) => a.id === i.abaId);
      const para = lista.find((a) => a.id === i.moverPara);
      const ks = new Set([i.numero, ...(i.ids || [])].map(chaveNum));
      const casa = (c) => c.ids.some((x) => ks.has(chaveNum(x)));
      const chat = (de && (de.chats || []).find(casa)) || { ids: i.ids && i.ids.length ? i.ids : [i.numero + '@c.us'], nome: i.nome };
      if (de) de.chats = (de.chats || []).filter((c) => !casa(c));
      if (para && !(para.chats || []).some(casa)) (para.chats = para.chats || []).push({ ids: chat.ids, nome: chat.nome || i.nome || '', em: Date.now() });
      feitos.push({ abaId: i.abaId, numero: i.numero });
      if (para) avisar(`💬 ${chat.nome || i.nome || 'Um lead'} respondeu e foi para "${para.nome}".`, 'ok', 8000);
    }
    await VF.gravar('abas', lista);
    await api('POST', '/mover-ok', { itens: feitos }).catch(() => {});
  }

  async function juntarNaoPerturbe(doServidor) {
    if (!doServidor || !doServidor.length) return;
    const lista = await VF.ler('naoPerturbe', []);
    let mexeu = false;
    for (const n of doServidor) {
      if (lista.some((x) => x.ids.some((y) => chaveNum(y) === chaveNum(n.numero)))) continue;
      const d = n.numero;
      const ids = [d + '@c.us'];
      if (d.startsWith('55') && d.length === 12) ids.push(d.slice(0, 4) + '9' + d.slice(4) + '@c.us');
      lista.push({ ids, nome: '', texto: n.texto || '', em: n.em || Date.now() });
      mexeu = true;
    }
    if (mexeu) await VF.gravar('naoPerturbe', lista);
  }

  let sincronizando = false;
  async function sincronizarKanban() {
    if (!servidorLigado() || sincronizando) return;
    sincronizando = true;
    try {
      const fila = await VF.ler('kanbanFila', null);
      if (fila && (fila.entrar.length || fila.sair.length)) {
        await api('POST', '/leads/mudancas', fila);
        await VF.apagar('kanbanFila');
      }
      const s = await api('GET', '/sync');
      kanban = { ...s, atualizado: Date.now(), erro: '' };
      const mover = s.inscricoes.filter((i) => i.moverPara);
      if (mover.length) await aplicarMovimentos(mover);
      await juntarNaoPerturbe(s.naoPerturbe);
    } catch (e) {
      kanban.erro = e.message;
    }
    sincronizando = false;
    if (kanbanAberto && !arrastandoCard) desenharKanban();
  }

  async function carregarServidor() {
    servidor = await VF.ler('servidor', { chave: '' });
    automacoes = await VF.ler('automacoes', {});
    if (servidorLigado() && !Object.keys(automacoes).length) {
      // Extensão reinstalada / outro computador: traz as sequências do servidor
      try {
        const lista = await api('GET', '/automacoes');
        lista.forEach((a) => (automacoes[a.abaId] = { ativa: a.ativa, passos: a.passos, aoResponder: a.aoResponder, aoTerminar: a.aoTerminar }));
        if (lista.length) await VF.gravar('automacoes', automacoes);
      } catch (e) { /* servidor fora */ }
    }
    sincronizarKanban();
  }

  async function salvarAutomacao(aba, v, novaAgora) {
    const ids = [...new Set([...JSON.stringify(v.passos).matchAll(/"midiaId":"([^"]+)"/g)].map((m) => m[1]))];
    if (ids.length) {
      const { faltando } = await api('POST', '/midias/faltando', { ids });
      if (faltando.length) avisar(`Enviando ${faltando.length} arquivo(s) para o servidor…`, 'info', 4000);
      for (const id of faltando) {
        const dataUrl = await VF.lerMidia(id);
        if (!dataUrl) throw new Error('Um arquivo da sequência sumiu. Escolha o arquivo de novo.');
        await api('POST', '/midias', { id, dataUrl });
      }
    }
    await api('PUT', '/automacoes/' + aba.id, { nome: aba.nome, ...v });
    automacoes = { ...(await VF.ler('automacoes', {})), [aba.id]: v };
    await VF.gravar('automacoes', automacoes);
    const n = (aba.chats || []).length;
    if (novaAgora && v.ativa && n && confirm(`Começar a sequência também para os ${n} lead(s) que JÁ estão em "${aba.nome}"?\n\nOK = sim, todos recebem.\nCancelar = só quem entrar daqui pra frente.`)) {
      const entrar = await montarEntradas(aba.id, aba.chats);
      await api('POST', '/leads/mudancas', { entrar: entrar.map((x) => ({ ...x, em: Date.now() })) });
      avisar(`${entrar.length} lead(s) entraram na sequência.`, 'ok');
    }
    sincronizarKanban();
  }

  async function apagarAutomacao(abaId) {
    if (servidorLigado()) await api('DELETE', '/automacoes/' + abaId);
    automacoes = await VF.ler('automacoes', {});
    delete automacoes[abaId];
    await VF.gravar('automacoes', automacoes);
    sincronizarKanban();
  }

  // ---- textos de situação ----
  function quando(ts) {
    if (!ts || ts <= Date.now() + 60000) return 'agora';
    const d = new Date(ts);
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dia = (x) => new Date(x).toDateString();
    if (dia(ts) === dia(Date.now())) return 'hoje ' + hora;
    if (dia(ts) === dia(Date.now() + 86400000)) return 'amanhã ' + hora;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hora;
  }
  function haQuanto(ts) {
    if (!ts) return '';
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 60) return `há ${m} min`;
    if (m < 1440) return `há ${Math.round(m / 60)} h`;
    const d = Math.round(m / 1440);
    return `há ${d} dia${d > 1 ? 's' : ''}`;
  }
  function seloInscricao(i, abaId) {
    if (!i) return '';
    const total = ((automacoes[abaId] || {}).passos || []).length || '?';
    const t = {
      ativo: [`⏳ Mensagem ${i.passo + 1}/${total} · ${quando(i.proximoEm)}`, 'ativo'],
      pausado: ['⏸ Sequência pausada', 'pausado'],
      respondeu: ['💬 Respondeu', 'respondeu'],
      concluido: [`✅ Recebeu as ${i.enviados} mensagens`, 'concluido'],
      falhou: ['⚠️ ' + (i.erro || 'Erro no envio'), 'falhou'],
      descadastrou: ['🚫 Pediu para não receber', 'falhou'],
      saiu: ['', ''],
    }[i.estado] || ['', ''];
    if (!t[0]) return '';
    return `<div class="kselo ${t[1]}" title="${esc(i.erro || '')}">${esc(t[0])}${i.estado === 'ativo' && i.erro ? ' · tentando de novo' : ''}</div>`;
  }

  // ---- Quadro Kanban (tela grande, por cima do WhatsApp) ----
  function abrirKanban() {
    kanbanAberto = true;
    fecharLateral();
    $('#kanban').classList.remove('oculto');
    desenharKanban();
    sincronizarKanban();
  }
  function fecharKanban() {
    kanbanAberto = false;
    $('#kanban').classList.add('oculto');
  }

  function desenharKanban() {
    const el = $('#kanban');
    const busca = VF.semAcento((estadoUI.buscaKanban || '').toLowerCase());
    const zap = kanban.whatsapp;
    const statusServ = !servidorLigado()
      ? `<button class="kstatus off" data-k="servidor">⚪ Sequências automáticas desligadas · conectar servidor</button>`
      : kanban.erro
        ? `<button class="kstatus erro" data-k="servidor" title="${esc(kanban.erro)}">🔴 Servidor fora do ar</button>`
        : zap && zap.estado === 'open'
          ? `<button class="kstatus ok" data-k="servidor">🟢 Servidor enviando · ${esc(VF.numeroDoId((zap.numero || '') + '@c.us') || zap.numero)} · hoje ${kanban.enviosHoje || 0}/${(kanban.config || {}).limiteDia || '?'}${kanban.dentroDoHorario === false ? ' · fora do horário' : ''}</button>`
          : `<button class="kstatus erro" data-k="servidor">🟠 WhatsApp do servidor desconectado · conectar</button>`;
    const cols = colunasKanban();
    const rolagem = el.querySelector('.kcolunas') ? el.querySelector('.kcolunas').scrollLeft : 0;
    el.innerHTML = `
      <div class="ktopo">
        <h2>Kanban</h2>
        <input type="text" id="kbusca" placeholder="Buscar lead…" value="${esc(estadoUI.buscaKanban || '')}">
        ${statusServ}
        <span class="cresce"></span>
        <button class="btn sec peq" data-k="novaColuna">${IC.mais2} Nova coluna</button>
        <button class="icone-btn" data-k="fechar" title="Fechar (Esc)">${IC.fechar}</button>
      </div>
      <div class="kcolunas">${
        cols.length
          ? cols
              .map((a) => {
                const auto = automacoes[a.id];
                let chats = [...(a.chats || [])].map((c, idx) => ({ c, idx })).sort((x, y) => (y.c.em || 0) - (x.c.em || 0));
                if (busca) chats = chats.filter(({ c }) => VF.semAcento((nomeDe(c.ids, c.nome) + ' ' + c.ids.join(' ')).toLowerCase()).includes(busca));
                const LIM = 150;
                return `<div class="kcol" data-col="${esc(a.id)}">
              <div class="kcol-topo" style="border-top-color:${esc(a.cor || '#25d366')}">
                <span class="bolinha" style="background:${esc(a.cor || '#25d366')}"></span><b>${esc(a.nome)}</b><span class="kconta">${(a.chats || []).length}</span>
                <span class="cresce"></span>
                <button class="kauto ${auto ? (auto.ativa ? 'ligada' : 'pausada') : ''}" data-k="auto" data-aba="${esc(a.id)}" title="${auto ? 'Editar a sequência automática' : 'Criar sequência automática para quem entrar nesta coluna'}">${IC.raio}${auto ? `${auto.passos.length} msg${auto.ativa ? '' : ' · pausada'}` : ''}</button>
              </div>
              <div class="kcards">${
                chats
                  .slice(0, LIM)
                  .map(({ c, idx }) => {
                    const nome = nomeDe(c.ids, c.nome) || VF.numeroDoId(c.ids.find((x) => x.endsWith('@c.us'))) || c.ids[0].split('@')[0];
                    const num = VF.numeroDoId(c.ids.find((x) => x.endsWith('@c.us')));
                    return `<div class="kcard" draggable="true" data-aba="${esc(a.id)}" data-i="${idx}" title="Clique para abrir a conversa · arraste para mudar de coluna">
                      <div class="kcard-nome">${esc(nome)}</div>
                      <div class="kcard-sub">${esc([num !== nome && num, haQuanto(c.em)].filter(Boolean).join(' · '))}</div>
                      ${auto ? seloInscricao(inscricaoDe(a.id, c.ids), a.id) : ''}
                      <button class="kmenu icone-btn" data-k="menu" title="Opções">${IC.mais}</button>
                    </div>`;
                  })
                  .join('') + (chats.length > LIM ? `<div class="dica" style="padding:6px">…e mais ${chats.length - LIM}. Use a busca.</div>` : '') || `<div class="kvazio">${busca ? 'Nada encontrado' : 'Arraste leads para cá'}</div>`
              }</div></div>`;
              })
              .join('')
          : `<div class="vazio" style="margin:40px auto">Nenhuma coluna ainda. Clique em <b>Nova coluna</b> (cada coluna é uma aba).</div>`
      }</div>`;
    el.querySelector('.kcolunas').scrollLeft = rolagem;
  }

  async function moverEntreAbas(deId, paraId, idx) {
    if (deId === paraId) return;
    const lista = await VF.ler('abas', []);
    const de = lista.find((a) => a.id === deId);
    const para = lista.find((a) => a.id === paraId);
    const chat = de && (de.chats || [])[idx];
    if (!chat || !para) return;
    de.chats = de.chats.filter((c) => !c.ids.some((x) => chat.ids.includes(x)));
    para.chats = (para.chats || []).filter((c) => !c.ids.some((x) => chat.ids.includes(x)));
    para.chats.push({ ...chat, em: Date.now() });
    abas = lista;
    if (kanbanAberto) desenharKanban();
    await VF.gravar('abas', lista);
    const auto = automacoes[paraId];
    if (auto && auto.ativa && servidorLigado()) {
      const p0 = auto.passos[0] || {};
      const espera = Number((p0.espera || {}).n) || 0;
      avisar(`${nomeDe(chat.ids, chat.nome) || 'Lead'} entrou em "${para.nome}": a 1ª mensagem automática sai ${espera ? `em ${espera} ${UNIDADES[p0.espera.unidade]}` : 'em instantes'} (no horário de envio).`, 'ok', 7000);
    }
  }

  function menuCard(botao, abaId, idx) {
    const aba = abas.find((a) => a.id === abaId);
    const chat = aba && (aba.chats || [])[idx];
    if (!chat) return;
    const insc = inscricaoDe(abaId, chat.ids);
    const nome = nomeDe(chat.ids, chat.nome);
    const acaoServ = (acao, msg) => async () => {
      try {
        await api('POST', '/leads/acao', { abaId, numero: insc ? insc.numero : await numeroDoLead(chat.ids), acao, ids: chat.ids, nome });
        avisar(msg, 'ok');
        sincronizarKanban();
      } catch (e) {
        avisar(e.message, 'erro');
      }
    };
    const itens = [{ texto: '💬 Abrir conversa', acao: () => abrirChatDoKanban(chat) }];
    if (automacoes[abaId] && servidorLigado()) {
      if (insc && insc.estado === 'ativo') {
        itens.push({ texto: '⏩ Enviar a próxima mensagem agora', acao: acaoServ('agora', 'A próxima mensagem sai em instantes (respeitando o horário e o intervalo).') });
        itens.push({ texto: '⏹ Parar a sequência deste lead', acao: acaoServ('parar', 'Sequência parada para este lead.') });
      }
      itens.push({ texto: '↺ Recomeçar a sequência do início', acao: acaoServ('recomecar', 'A sequência recomeçou do início.') });
    }
    itens.push({ texto: 'Tirar desta coluna', perigo: true, acao: () => alterarAba(abaId, chat.ids, nome, false) });
    abrirPop(botao, itens);
  }

  async function abrirChatDoKanban(chat) {
    const id = chat.ids.find((x) => x.endsWith('@c.us')) || chat.ids[0];
    try {
      await rpc('abrirChat', id);
      fecharKanban();
    } catch (e) {
      avisar('Não consegui abrir essa conversa: ' + e.message, 'erro');
    }
  }

  function ligarEventosKanban() {
    const el = $('#kanban');
    el.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-k]');
      const card = e.target.closest('.kcard');
      if (k && k.dataset.k === 'fechar') return fecharKanban();
      if (k && k.dataset.k === 'servidor') return fecharKanban(), abrirLateral('kanban');
      if (k && k.dataset.k === 'novaColuna') return fecharKanban(), abrirLateral('abas', 'nova');
      if (k && k.dataset.k === 'auto') return fecharKanban(), abrirLateral('abas', 'editar:' + k.dataset.aba + ':auto');
      if (k && k.dataset.k === 'menu' && card) return menuCard(k, card.dataset.aba, Number(card.dataset.i));
      if (card) {
        const aba = abas.find((a) => a.id === card.dataset.aba);
        const chat = aba && aba.chats[Number(card.dataset.i)];
        if (chat) abrirChatDoKanban(chat);
      }
    });
    el.addEventListener('input', (e) => {
      if (e.target.id !== 'kbusca') return;
      estadoUI.buscaKanban = e.target.value;
      const pos = e.target.selectionStart;
      desenharKanban();
      const b = el.querySelector('#kbusca');
      b.focus();
      b.setSelectionRange(pos, pos);
    });
    // Arrastar cartões entre colunas
    el.addEventListener('dragstart', (e) => {
      const card = e.target.closest && e.target.closest('.kcard');
      if (!card) return;
      arrastandoCard = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.aba + '|' + card.dataset.i);
      setTimeout(() => card.classList.add('arrastando'), 0);
    });
    el.addEventListener('dragend', (e) => {
      arrastandoCard = false;
      el.querySelectorAll('.arrastando, .kcol.alvo').forEach((x) => x.classList.remove('arrastando', 'alvo'));
    });
    el.addEventListener('dragover', (e) => {
      const col = e.target.closest && e.target.closest('.kcol');
      if (!col) return;
      e.preventDefault();
      el.querySelectorAll('.kcol.alvo').forEach((x) => x !== col && x.classList.remove('alvo'));
      col.classList.add('alvo');
    });
    el.addEventListener('drop', (e) => {
      const col = e.target.closest && e.target.closest('.kcol');
      if (!col) return;
      e.preventDefault();
      arrastandoCard = false;
      const [de, i] = (e.dataTransfer.getData('text/plain') || '').split('|');
      col.classList.remove('alvo');
      if (de) moverEntreAbas(de, col.dataset.col, Number(i));
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && kanbanAberto && fecharKanban());
  }

  // ---- Editor da sequência automática (dentro da tela da aba) ----
  function EditorAutomacao(el, aba) {
    const orig = automacoes[aba.id] || null;
    let ligada = orig ? !!orig.ativa : true;
    const passos = [];
    const outras = () => colunasKanban().filter((x) => x.id !== aba.id);
    const opAbas = (sel, vazio) => `<option value="">${vazio}</option>` + outras().map((x) => `<option value="${esc(x.id)}" ${sel === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('');
    const n = (est) => kanban.inscricoes.filter((i) => i.abaId === aba.id && i.estado === est).length;
    el.innerHTML = `
      <div class="cartao auto-cartao" id="autoCartao">
        <h3>${IC.raio} Sequência automática <span class="dica">(o servidor envia)</span></h3>
        ${
          !servidorLigado()
            ? `<div class="dica">Quem entrar nesta aba pode receber mensagens sozinho (ex.: remarketing em 1, 3 e 7 dias), mesmo com o computador desligado.<br><br>Para usar, conecte o servidor primeiro: ícone <b>Kanban</b> no menu da esquerda › <b>Chave de acesso</b>.</div>
               <button type="button" class="btn sec peq" id="autoConectar" style="margin-top:8px">Conectar servidor</button>`
            : !orig
              ? `<div class="dica">Quem entrar nesta aba recebe as mensagens sozinho, no horário de envio, mesmo com o computador desligado. Se o lead responder, a sequência para.</div>
                 <button type="button" class="btn peq" id="autoCriar" style="margin-top:8px">${IC.mais2} Criar sequência automática</button>`
              : ''
        }
        <div id="autoForm" class="${servidorLigado() && orig ? '' : 'oculto'}">
          <label class="check"><input type="checkbox" id="autoLigada" ${ligada ? 'checked' : ''}> <b>Ligada</b>&nbsp;<span class="dica">(desligada = ninguém recebe; quem estava no meio fica pausado)</span></label>
          ${orig ? `<div class="dica" style="margin-bottom:8px">Agora: ⏳ ${n('ativo')} na sequência · 💬 ${n('respondeu')} responderam · ✅ ${n('concluido')} concluíram${n('falhou') ? ` · ⚠️ ${n('falhou')} com erro` : ''}</div>` : ''}
          <div id="autoPassos"></div>
          <button type="button" class="btn sec peq" id="autoAddPasso" style="width:100%;margin:4px 0 12px">${IC.mais2} Adicionar mensagem</button>
          <div class="duas">
            <label class="campo">Se responder: parar e mover para<select id="autoResp">${opAbas((orig && orig.aoResponder || {}).moverPara, '— só parar')}</select></label>
            <label class="campo">Se terminar sem resposta: mover para<select id="autoFim">${opAbas((orig && orig.aoTerminar || {}).moverPara, '— deixar aqui')}</select></label>
          </div>
          <div class="dica">Envio só no horário e no ritmo do servidor (ícone Kanban › Ritmo). Quem escrever "SAIR" não recebe mais.</div>
          ${orig ? '<button type="button" class="link" id="autoApagar" style="color:var(--vermelho);margin-top:8px">Apagar a sequência desta aba</button>' : ''}
        </div>
      </div>`;
    let existe = !!orig;
    let apagar = false;
    const caixaPassos = el.querySelector('#autoPassos');
    function renumerar() {
      passos.forEach((p, i) => {
        p.caixa.querySelector('.passo-n').textContent = `Mensagem ${i + 1}`;
        p.caixa.querySelector('.passo-depois').textContent = i === 0 ? 'depois de entrar na aba' : 'depois da mensagem anterior';
      });
    }
    function addPasso(p) {
      const caixa = document.createElement('div');
      caixa.className = 'passo-auto';
      const esp = p.espera || { n: passos.length ? 1 : 0, unidade: passos.length ? 'd' : 'min' };
      caixa.innerHTML = `
        <div class="passo-topo"><b class="passo-n"></b><span class="cresce"></span><button type="button" class="icone-btn" data-tirar-passo title="Remover esta mensagem">${IC.lixo}</button></div>
        <div class="passo-espera">Enviar <input type="number" min="0" max="999" class="esp-n" value="${Number(esp.n) || 0}">
          <select class="esp-u">${Object.entries(UNIDADES).map(([v, t]) => `<option value="${v}" ${esp.unidade === v ? 'selected' : ''}>${t}</option>`).join('')}</select> <span class="passo-depois"></span></div>
        <select class="usar-resp">${opcoesRespostas('Usar uma resposta rápida ou script…')}</select>
        <div class="passo-modelos"></div>`;
      caixaPassos.appendChild(caixa);
      const modelos = EditorModelos(caixa.querySelector('.passo-modelos'), p.variacoes);
      const item = { caixa, modelos };
      passos.push(item);
      caixa.querySelector('[data-tirar-passo]').onclick = () => {
        if (passos.length === 1) return avisar('A sequência precisa de pelo menos uma mensagem. Para não usar, desmarque "Ligada" ou apague a sequência.', 'erro');
        if (!confirm('Remover esta mensagem da sequência?')) return;
        caixa.remove();
        passos.splice(passos.indexOf(item), 1);
        renumerar();
      };
      caixa.querySelector('.usar-resp').onchange = (e) => {
        const et = etapasDaOpcao(e.target.value);
        if (et) modelos.definir(et);
        e.target.value = '';
      };
      renumerar();
    }
    (orig ? orig.passos : []).forEach(addPasso);
    const mostrarForm = () => {
      existe = true;
      apagar = false;
      el.querySelector('#autoForm').classList.remove('oculto');
      el.querySelector('#autoCriar')?.remove();
      if (!passos.length) addPasso({ espera: { n: 0, unidade: 'min' } });
    };
    el.querySelector('#autoCriar')?.addEventListener('click', mostrarForm);
    el.querySelector('#autoConectar')?.addEventListener('click', () => abrirLateral('kanban'));
    el.querySelector('#autoAddPasso').onclick = () => {
      if (passos.length >= 15) return avisar('Máximo de 15 mensagens.', 'erro');
      addPasso({});
      passos[passos.length - 1].caixa.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    el.querySelector('#autoLigada').onchange = (e) => (ligada = e.target.checked);
    el.querySelector('#autoApagar')?.addEventListener('click', () => {
      if (!confirm('Apagar a sequência automática desta aba?\nQuem está no meio para de receber. (Vale quando clicar em Salvar.)')) return;
      apagar = true;
      el.querySelector('#autoForm').classList.add('oculto');
      el.querySelector('#autoCartao').insertAdjacentHTML('beforeend', '<div class="alerta" style="margin-top:8px">A sequência será apagada ao salvar.</div>');
    });
    return {
      abrir: () => (servidorLigado() ? mostrarForm() : null),
      acao() {
        if (!servidorLigado()) return null;
        if (apagar) return orig ? 'apagar' : null;
        return existe ? 'salvar' : null;
      },
      validar() {
        if (!passos.length) return 'A sequência automática precisa de pelo menos uma mensagem.';
        for (let i = 0; i < passos.length; i++) {
          const erro = passos[i].modelos.validar(`Mensagem ${i + 1}`);
          if (erro) return erro;
          if (!passos[i].modelos.todos().some((v) => v.length)) return `Mensagem ${i + 1} está vazia.`;
        }
        return '';
      },
      valor: () => ({
        ativa: ligada,
        passos: passos.map((p) => ({
          espera: { n: Math.max(0, Number(p.caixa.querySelector('.esp-n').value) || 0), unidade: p.caixa.querySelector('.esp-u').value },
          variacoes: p.modelos.todos().filter((v) => v.length),
        })),
        aoResponder: { moverPara: el.querySelector('#autoResp').value },
        aoTerminar: { moverPara: el.querySelector('#autoFim').value },
      }),
      nova: !orig,
    };
  }

  // ---- Tela lateral: servidor (chave, WhatsApp, ritmo) ----
  let timerQR = null;
  telas.kanban = async (corpo) => {
    clearInterval(timerQR);
    if (!servidorLigado()) {
      corpo.innerHTML = `
        <div class="lat-titulo"><h2>Kanban automático</h2></div>
        <button class="btn" id="abrirQuadro" style="width:100%;margin-bottom:14px">${IC.kanban} Abrir quadro Kanban</button>
        <div class="cartao"><h3>Sequências automáticas no servidor</h3>
          <div class="dica" style="margin-bottom:10px">O quadro funciona sem servidor (cada aba é uma coluna). Com o servidor, cada coluna pode ter uma <b>sequência automática</b>: quem entra na aba "Remarketing", por exemplo, recebe as mensagens sozinho, mesmo com o computador desligado.</div>
          <label class="campo">Chave de acesso<input type="text" id="chave" placeholder="vf_…" autocomplete="off"></label>
          <button class="btn" id="salvarChave">Conectar</button>
        </div>`;
      corpo.onclick = async (e) => {
        if (e.target.closest('#abrirQuadro')) return abrirKanban();
        if (!e.target.closest('#salvarChave')) return;
        const chave = corpo.querySelector('#chave').value.trim();
        if (!chave) return avisar('Cole a chave de acesso.', 'erro');
        await VF.gravar('servidor', { chave });
        servidor = { chave };
        try {
          await api('GET', '/eu');
          avisar('Servidor conectado! Agora conecte o WhatsApp no servidor.', 'ok');
          await carregarServidor();
          desenharLateral();
        } catch (err) {
          await VF.gravar('servidor', { chave: '' });
          servidor = { chave: '' };
          avisar(err.message, 'erro');
        }
      };
      return;
    }
    corpo.innerHTML = `<div class="lat-titulo"><h2>Kanban automático</h2></div><div class="dica">Carregando…</div>`;
    let eu;
    try {
      eu = await api('GET', '/eu');
    } catch (e) {
      corpo.innerHTML = `<div class="lat-titulo"><h2>Kanban automático</h2></div><div class="alerta">${esc(e.message)}</div>
        <button class="btn sec peq" id="tentar">Tentar de novo</button> <button class="link" id="trocarChave">Trocar a chave de acesso</button>`;
      corpo.onclick = async (ev) => {
        if (ev.target.closest('#tentar')) desenharLateral();
        if (ev.target.closest('#trocarChave') && confirm('Desligar este computador do servidor? (As sequências continuam rodando no servidor.)')) {
          await VF.gravar('servidor', { chave: '' });
          servidor = { chave: '' };
          desenharLateral();
        }
      };
      return;
    }
    const z = eu.whatsapp;
    const c = eu.config;
    const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const comAuto = colunasKanban().filter((a) => automacoes[a.id]);
    const conta = (abaId, est) => kanban.inscricoes.filter((i) => i.abaId === abaId && i.estado === est).length;
    corpo.innerHTML = `
      <div class="lat-titulo"><h2>Kanban automático</h2></div>
      <button class="btn" id="abrirQuadro" style="width:100%;margin-bottom:14px">${IC.kanban} Abrir quadro Kanban</button>
      <div class="cartao"><h3>WhatsApp no servidor</h3>
        ${
          z.estado === 'open'
            ? `<div class="ok-box">✅ Conectado: <b>${esc(VF.numeroDoId(z.numero + '@c.us') || z.numero)}</b><br>Hoje: ${eu.enviosHoje}/${c.limiteDia} mensagens automáticas · ${eu.dentroDoHorario ? 'dentro do horário' : 'fora do horário (espera abrir)'}</div>
               <button class="link" id="desconectarZap" style="color:var(--vermelho)">Desconectar o WhatsApp do servidor</button>`
            : `<div class="dica" style="margin-bottom:8px">Conecte o mesmo número deste WhatsApp. Ele vira mais um "aparelho conectado" (como o WhatsApp Web) e é por ele que o servidor envia as sequências.</div>
               <ol class="passos-lista"><li>Clique em <b>Mostrar QR code</b></li><li>No celular: WhatsApp › <b>⋮</b> (Android) ou <b>Configurações</b> (iPhone) › <b>Aparelhos conectados</b> › <b>Conectar um aparelho</b></li><li>Aponte a câmera para o QR code abaixo</li></ol>
               <button class="btn" id="mostrarQR">Mostrar QR code</button>
               <div id="qrArea" class="qr-area"></div>`
        }
      </div>
      <div class="cartao"><h3>Colunas com sequência automática</h3>
        ${
          comAuto.length
            ? comAuto
                .map((a) => {
                  const au = automacoes[a.id];
                  return `<div class="contato-linha clicavel" data-editar-auto="${esc(a.id)}"><span class="bolinha" style="background:${esc(a.cor)}"></span><div class="cresce"><div><b>${esc(a.nome)}</b> · ${au.passos.length} mensagem(ns)${au.ativa ? '' : ' · <span style="color:var(--amarelo)">desligada</span>'}</div>
                    <small>⏳ ${conta(a.id, 'ativo')} na sequência · 💬 ${conta(a.id, 'respondeu')} responderam · ✅ ${conta(a.id, 'concluido')} concluíram</small></div></div>`;
                })
                .join('')
            : '<div class="dica">Nenhuma ainda. No quadro, clique no ⚡ de uma coluna (ou em Abas › editar aba) para criar.</div>'
        }
      </div>
      <div class="cartao"><h3>Ritmo do servidor</h3>
        <div class="duas"><label class="campo">Das<input type="time" id="sHoraInicio" value="${esc(c.horaInicio)}"></label><label class="campo">Até<input type="time" id="sHoraFim" value="${esc(c.horaFim)}"></label></div>
        <div class="chips">${dias.map((d, i) => `<label class="check" style="padding:0 6px 0 0"><input type="checkbox" name="sDia" value="${i}" ${c.dias.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
        <div class="duas"><label class="campo">Intervalo mín. (seg)<input type="number" id="sIntMin" min="20" value="${c.intervaloMin}"></label><label class="campo">Intervalo máx. (seg)<input type="number" id="sIntMax" min="20" value="${c.intervaloMax}"></label></div>
        <label class="campo">Limite de mensagens automáticas por dia<input type="number" id="sLimite" min="1" max="500" value="${c.limiteDia}"></label>
        <label class="check"><input type="checkbox" id="sDigitando" ${c.simularDigitacao ? 'checked' : ''}> Mostrar "digitando…" / "gravando áudio…" antes</label>
        <button class="btn sec peq" id="salvarRitmo">Salvar ritmo</button>
        <div class="dica" style="margin-top:6px">Esse ritmo é só das sequências automáticas (o envio em massa tem o dele em Configurações).</div>
      </div>
      <button class="link" id="trocarChave">Desligar este computador do servidor</button>`;
    async function mostrarQR(dados) {
      const area = corpo.querySelector('#qrArea');
      if (!area) return;
      if (dados.whatsapp.estado === 'open') {
        clearInterval(timerQR);
        avisar('✅ WhatsApp conectado no servidor!', 'ok');
        sincronizarKanban();
        return desenharLateral();
      }
      area.innerHTML = dados.codigo
        ? `<div class="codigo-par">${esc(dados.codigo)}</div><div class="dica">No celular, em "Conectar um aparelho", toque em <b>Conectar com número de telefone</b> e digite esse código.</div>`
        : dados.whatsapp.qr
          ? `<img src="${esc(dados.whatsapp.qr)}" alt="QR code"><div class="dica">O código muda sozinho a cada ~40 segundos.</div>`
          : '<div class="dica">Gerando o QR code…</div>';
    }
    corpo.onclick = async (e) => {
      if (e.target.closest('#abrirQuadro')) return abrirKanban();
      const ed = e.target.closest('[data-editar-auto]');
      if (ed) return abrirLateral('abas', 'editar:' + ed.dataset.editarAuto + ':auto');
      if (e.target.closest('#mostrarQR')) {
        e.target.closest('#mostrarQR').disabled = true;
        try {
          mostrarQR(await api('POST', '/whatsapp/conectar', {}));
          timerQR = setInterval(async () => {
            if (secaoAtual !== 'kanban') return clearInterval(timerQR);
            try {
              mostrarQR(await api('GET', '/eu'));
            } catch (err) { /* tenta no próximo */ }
          }, 3000);
        } catch (err) {
          avisar(err.message, 'erro');
          e.target.closest('#mostrarQR').disabled = false;
        }
      }
      if (e.target.closest('#desconectarZap') && confirm('Desconectar o WhatsApp do servidor?\n\nAs sequências automáticas param de sair até você conectar de novo.')) {
        await api('POST', '/whatsapp/desconectar').catch((err) => avisar(err.message, 'erro'));
        desenharLateral();
      }
      if (e.target.closest('#salvarRitmo')) {
        const v = (id) => corpo.querySelector(id).value;
        const cfgLocal = await VF.config();
        try {
          await api('PUT', '/config', {
            horaInicio: v('#sHoraInicio'), horaFim: v('#sHoraFim'),
            dias: [...corpo.querySelectorAll('[name=sDia]:checked')].map((x) => Number(x.value)),
            intervaloMin: Number(v('#sIntMin')), intervaloMax: Number(v('#sIntMax')), limiteDia: Number(v('#sLimite')),
            simularDigitacao: corpo.querySelector('#sDigitando').checked,
            nomeVendedor: cfgLocal.nomeVendedor, palavrasSair: cfgLocal.palavrasSair,
          });
          avisar('Ritmo do servidor salvo.', 'ok');
          desenharLateral();
        } catch (err) {
          avisar(err.message, 'erro');
        }
      }
      if (e.target.closest('#trocarChave') && confirm('Desligar este computador do servidor?\n\nAs sequências continuam rodando no servidor. Para voltar, cole a chave de novo.')) {
        await VF.gravar('servidor', { chave: '' });
        servidor = { chave: '' };
        desenharLateral();
      }
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
      <div class="dica" style="margin-bottom:8px">Tudo fica só neste computador. Baixe um backup para não perder ou para levar a outro computador. Escolha o que vai no arquivo:</div>
      <div class="bk-lista">${PARTES_BACKUP.map(([v, t]) => `<label class="check"><input type="checkbox" name="bk" value="${v}" checked> ${t}</label>`).join('')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn sec peq" id="baixar">Baixar backup</button>
        <label class="btn sec peq" style="cursor:pointer">Restaurar backup<input type="file" id="restaurar" accept=".json" class="oculto"></label></div>
      <div id="bkRestaurar"></div>
      <div class="secao-t">Planilha de contatos (CSV)</div>
      <div class="dica" style="margin-bottom:8px">Escolha etiquetas e/ou abas e baixe nome + telefone dos contatos. Abre no Excel e no Google Planilhas.</div>
      <div id="csvGrupos"></div>
      <button class="btn sec peq" id="baixarCSV" style="margin-top:8px">📄 Baixar planilha</button>`;
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
    const baixarArquivo = (conteudo, nome, tipo) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
      a.download = nome;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    q('#baixar').onclick = async () => {
      const escolhidas = [...corpo.querySelectorAll('input[name=bk]:checked')].map((x) => x.value);
      if (!escolhidas.length) return avisar('Marque pelo menos uma parte para o backup.', 'erro');
      const tudo = await chrome.storage.local.get(null);
      const dados = {};
      Object.keys(tudo).forEach((k) => escolhidas.includes(parteDaChave(k)) && (dados[k] = tudo[k]));
      // Junta só os arquivos (áudio, vídeo, imagem) usados pelo que foi escolhido
      for (const [, id] of JSON.stringify(dados).matchAll(/"midiaId":"([^"]+)"/g)) if (tudo['midia:' + id]) dados['midia:' + id] = tudo['midia:' + id];
      baixarArquivo(JSON.stringify({ app: 'vendaflow', versao: 2, em: Date.now(), partes: escolhidas, dados }), `vendaflow-backup-${VF.hoje()}.json`, 'application/json');
      avisar('Backup baixado (pasta Downloads).', 'ok');
    };
    q('#restaurar').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const caixa = q('#bkRestaurar');
      try {
        const j = JSON.parse(await f.text());
        if (j.app !== 'vendaflow' || !j.dados) throw new Error('Este arquivo não é um backup do VendaFlow.');
        const presentes = PARTES_BACKUP.filter(([v]) => Object.keys(j.dados).some((k) => parteDaChave(k) === v));
        if (!presentes.length) throw new Error('O backup está vazio.');
        caixa.innerHTML = `<div class="cartao" style="margin-top:10px"><b>O que restaurar de "${esc(f.name)}"?</b>
          <div class="dica" style="margin:4px 0 6px">O que você marcar SUBSTITUI o que está neste computador. O resto fica como está.</div>
          ${presentes.map(([v, t]) => `<label class="check"><input type="checkbox" name="rs" value="${v}" checked> ${t}</label>`).join('')}
          <div style="display:flex;gap:8px;margin-top:8px"><button class="btn peq" id="rsOk">Restaurar</button><button class="btn sec peq" id="rsCancelar">Cancelar</button></div></div>`;
        q('#rsCancelar').onclick = () => (caixa.innerHTML = '');
        q('#rsOk').onclick = async () => {
          const sel = [...caixa.querySelectorAll('input[name=rs]:checked')].map((x) => x.value);
          if (!sel.length) return avisar('Marque pelo menos uma parte.', 'erro');
          const atual = await chrome.storage.local.get(null);
          await chrome.storage.local.remove(Object.keys(atual).filter((k) => sel.includes(parteDaChave(k))));
          const novo = {};
          Object.keys(j.dados).forEach((k) => (sel.includes(parteDaChave(k)) || k.startsWith('midia:')) && (novo[k] = j.dados[k]));
          await chrome.storage.local.set(novo);
          await recarregarDados();
          VF.limparMidiasOrfas();
          avisar('Backup restaurado.', 'ok');
          desenharLateral();
        };
      } catch (er) {
        avisar(er.message, 'erro');
      }
    };
    const selCSV = seletorMulti(
      q('#csvGrupos'),
      () => [
        ...etiquetas.map((e) => ({ id: 'e:' + e.id, nome: e.nome, cor: e.cor, grupo: 'Etiquetas do WhatsApp', extra: e.total })),
        ...abas.filter((a) => a.tipo !== 'etiqueta').map((a) => ({ id: 'a:' + a.id, nome: a.nome, cor: a.cor, grupo: 'Abas', extra: (a.chats || []).length })),
      ],
      [],
      null,
      'Nenhuma escolhida'
    );
    q('#baixarCSV').onclick = async () => {
      const grupos = selCSV.valor();
      if (!grupos.length) return avisar('Escolha pelo menos uma etiqueta ou aba.', 'erro');
      const botao = q('#baixarCSV');
      botao.disabled = true;
      try {
        const contatos = new Map(); // número -> { nome, grupos }
        const juntar = (ids, nomeWA, grupo) => {
          const cus = ids.find((x) => x.endsWith('@c.us'));
          const numero = VF.numeroDoId(cus) || (cus || ids[0] || '').split('@')[0];
          if (!numero) return;
          const c = contatos.get(numero) || { nome: nomeDe(ids, nomeWA), grupos: [] };
          if (!c.nome) c.nome = nomeDe(ids, nomeWA);
          c.grupos.push(grupo);
          contatos.set(numero, c);
        };
        for (const g of grupos) {
          if (g.startsWith('e:')) {
            const et = etiquetas.find((x) => x.id === g.slice(2));
            (await rpc('listarChats', { etiqueta: g.slice(2) })).forEach((c) => juntar([c.id], c.nome, et ? et.nome : 'Etiqueta'));
          } else {
            const aba = abas.find((x) => x.id === g.slice(2));
            (aba ? aba.chats || [] : []).forEach((c) => juntar(c.ids, c.nome, aba.nome));
          }
        }
        if (!contatos.size) return avisar('Nenhum contato nesses grupos.', 'erro');
        const cel = (x) => `"${String(x || '').replace(/"/g, '""')}"`;
        const linhas = [['Nome', 'Telefone', 'Grupos'].map(cel).join(';')];
        contatos.forEach((c, numero) => linhas.push([c.nome, numero, [...new Set(c.grupos)].join(', ')].map(cel).join(';')));
        baixarArquivo('﻿' + linhas.join('\r\n'), `vendaflow-contatos-${VF.hoje()}.csv`, 'text/csv;charset=utf-8');
        avisar(`Planilha com ${contatos.size} contatos baixada (pasta Downloads).`, 'ok');
      } catch (er) {
        avisar('Não consegui montar a planilha: ' + er.message, 'erro');
      } finally {
        botao.disabled = false;
      }
    };
  };

  // Partes do backup (o vendedor escolhe quais vão no arquivo)
  const PARTES_BACKUP = [
    ['respostas', 'Respostas rápidas, scripts e categorias (com os áudios, vídeos e imagens)'],
    ['abas', 'Abas, com os leads de cada uma'],
    ['contatos', 'Contatos: nomes trocados, anotações e Não perturbe'],
    ['campanhas', 'Campanhas de envio em massa (histórico)'],
    ['config', 'Configurações'],
  ];
  function parteDaChave(k) {
    if (k === 'respostas' || k === 'scripts' || k === 'categorias') return 'respostas';
    if (k === 'abas' || k === 'automacoes') return 'abas';
    if (k === 'nomes' || k === 'naoPerturbe' || k.startsWith('nota:')) return 'contatos';
    if (k === 'campanhas' || k.startsWith('campanha:')) return 'campanhas';
    if (k === 'config') return 'config';
    return null; // mídia e dados internos (motor, cache) não contam como parte
  }

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
  // Segurar e arrastar uma aba do topo para os lados muda a ordem ("Todas" fica sempre primeiro)
  ordenarArrastando($('#pilulas'), '[data-aba]', {
    eixo: 'x',
    pode: (b) => b.dataset.aba !== 'todas',
    aoSoltar: async () => {
      await salvarOrdemAbas([...$('#pilulas').querySelectorAll('[data-aba]')].map((x) => x.dataset.aba).filter((id) => id !== 'todas'));
      if (secaoAtual === 'abas') desenharLateral();
    },
  });
  $('#pilulas').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      $('#pilulas').scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Botão direito numa aba do topo: renomear, cor, excluir
  $('#pilulas').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-aba]');
    if (!b || b.dataset.aba === 'todas') return;
    e.preventDefault();
    const a = abas.find((x) => x.id === b.dataset.aba);
    if (!a) return;
    abrirPop(b, [
      { texto: '✏️ Renomear', acao: () => renomearAba(a) },
      { texto: '🎨 Mudar cor e conteúdo', acao: () => abrirLateral('abas', 'editar:' + a.id) },
      { texto: '🗑️ Excluir aba', perigo: true, acao: () => excluirAba(a) },
    ]);
  });
  $('#pilulas').addEventListener('dblclick', (e) => {
    const b = e.target.closest('[data-aba]');
    const a = b && abas.find((x) => x.id === b.dataset.aba);
    if (a) renomearAba(a);
  });

  $('#novaAba').addEventListener('click', () => abrirLateral('abas', 'nova'));

  // ---- Botão ⚡ dentro da barra de digitar, ao lado do microfone ----
  // Fica dentro do próprio WhatsApp (não flutua), então não pula de lugar.
  // Só confere de vez em quando se ainda está lá (sem medir a tela, que é o que pesa).
  const raioWA = document.createElement('div');
  raioWA.id = 'vf-raio';
  raioWA.title = 'Respostas rápidas (VendaFlow)';
  raioWA.setAttribute('role', 'button');
  raioWA.innerHTML = IC.raio;
  Object.assign(raioWA.style, {
    width: '34px', height: '34px', minWidth: '34px', borderRadius: '50%', background: '#00a884', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', margin: '0 4px', padding: '0', boxSizing: 'border-box', flex: 'none', alignSelf: 'center',
  });
  Object.assign(raioWA.firstElementChild.style, { width: '18px', height: '18px', fill: '#fff' });
  raioWA.addEventListener('mousedown', (e) => e.preventDefault()); // não tira o cursor do campo de mensagem
  raioWA.addEventListener('click', (e) => {
    e.stopPropagation();
    abrirLateral('respostas');
  });
  const SELETORES_MIC = [
    '[data-icon="mic-outlined"]', '[data-icon="ptt"]', '[data-icon="wds-ic-mic"]', '[data-icon="ic-mic"]', '[data-icon="audio-send"]',
    '[data-icon="send"]', '[data-icon="wds-ic-send-filled"]', '[data-icon="ic-send"]',
    'button[aria-label="Mensagem de voz"]', 'button[aria-label="Voice message"]', 'button[aria-label="Enviar"]', 'button[aria-label="Send"]',
  ].join(',');
  function encaixarRaio() {
    const footer = document.querySelector('#main footer');
    if (!footer) return;
    if (raioWA.isConnected && footer.contains(raioWA)) return;
    const icones = footer.querySelectorAll(SELETORES_MIC);
    const icone = icones[icones.length - 1];
    if (!icone) return;
    // Sobe até o bloco do botão (o pai que tem mais de um filho é a fileira da barra)
    let bloco = icone.closest('button,[role="button"]') || icone;
    while (bloco.parentElement && bloco.parentElement !== footer && bloco.parentElement.childElementCount === 1) bloco = bloco.parentElement;
    if (bloco.parentElement) bloco.parentElement.insertBefore(raioWA, bloco);
  }
  setInterval(encaixarRaio, 1200);

  // ---- Cabeçalho da conversa: lápis ao lado do nome e botão de abas ao lado da etiqueta ----
  const SVG_LAPIS = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
  const SVG_PASTA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>';
  const nomeWABtn = document.createElement('span');
  nomeWABtn.id = 'vf-nome-wa';
  nomeWABtn.title = 'Mudar o nome deste contato (VendaFlow)';
  nomeWABtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;gap:0;margin:0 4px;width:34px;height:34px;padding:0;border-radius:50%;box-sizing:border-box;align-self:center;cursor:pointer;color:#8696a0;font-size:13px;font-weight:500;vertical-align:middle;flex:none;white-space:nowrap;';
  nomeWABtn.innerHTML = SVG_LAPIS + '<span></span>';
  const abasWABtn = document.createElement('span');
  abasWABtn.id = 'vf-abas-wa';
  abasWABtn.title = 'Colocar este contato em abas (VendaFlow)';
  // Só ícone (sem texto) para não espremer o nome do contato no cabeçalho
  abasWABtn.style.cssText = 'position:relative;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;margin-right:6px;border-radius:50%;cursor:pointer;color:inherit;flex:none;box-sizing:border-box;';
  abasWABtn.innerHTML = SVG_PASTA.replace(/18/g, '22') + '<span style="position:absolute;right:2px;bottom:4px;display:flex;gap:1px"></span>';
  for (const b of [nomeWABtn, abasWABtn]) {
    b.addEventListener('mouseenter', () => (b.style.background = 'rgba(134,150,160,.15)'));
    b.addEventListener('mouseleave', () => (b.style.background = ''));
  }
  let cab = { chatId: null, ids: [] };
  async function idsDoCabecalho() {
    if (!chatAtual || chatAtual.grupo) return null;
    if (cab.chatId !== chatAtual.id) cab = { chatId: chatAtual.id, ids: await equivalentes(chatAtual.id) };
    return cab.ids;
  }
  async function atualizarCabecalho() {
    const ids = await idsDoCabecalho();
    const meu = ids ? nomeDe(ids, '') : '';
    nomeWABtn.lastChild.textContent = '';
    nomeWABtn.style.color = meu ? '#21c063' : '#8696a0';
    nomeWABtn.title = meu ? `Nome no VendaFlow: ${meu} (clique para mudar)` : 'Mudar o nome deste contato (VendaFlow)';
    const minhas = ids ? abas.filter((a) => a.tipo !== 'etiqueta' && abaTem(a, ids)) : [];
    abasWABtn.lastChild.innerHTML = minhas
      .slice(0, 3)
      .map((a) => `<span style="display:block;width:9px;height:9px;border-radius:50%;background:${esc(a.cor)};box-shadow:0 0 0 2px #111b21"></span>`)
      .join('');
    abasWABtn.title = minhas.length ? `Abas: ${minhas.map((a) => a.nome).join(', ')} (clique para mudar)` : 'Colocar este contato em abas (VendaFlow)';
  }
  const abrirNomeCab = async () => {
    const ids = await idsDoCabecalho();
    if (!ids) return avisar('Abra uma conversa (que não seja grupo).');
    const nomeWA = chatAtual.nome || '';
    const atual = nomeDe(ids, '') || nomeWA;
    const pop = $('#pop');
    pop.innerHTML = `<div class="pop-form"><b>Nome do contato</b>
      <input type="text" id="popNome" value="${esc(atual)}" placeholder="Nome do contato">
      <div class="nome-acoes"><button type="button" class="btn peq" data-ok>Salvar</button>${nomeDe(ids, '') ? '<button type="button" class="link-btn" data-volta>Voltar ao nome do WhatsApp</button>' : ''}</div>
      <div class="dica">Salva o contato no WhatsApp com esse nome e vale em {nome} e {primeiro_nome}.${nomeWA ? `<br>No WhatsApp: ${esc(nomeWA)}` : ''}</div></div>`;
    posicionarPop(nomeWABtn);
    const inp = pop.querySelector('#popNome');
    inp.focus();
    inp.select();
    const salvar = async (valor) => {
      fecharPop();
      await trocarNome(ids, chatAtual.id, valor);
      atualizarCabecalho();
    };
    inp.onkeydown = (k) => {
      k.stopPropagation();
      if (k.key === 'Enter') salvar(inp.value.trim());
      if (k.key === 'Escape') fecharPop();
    };
    pop.onclick = (ev) => {
      if (ev.target.closest('[data-ok]')) salvar(inp.value.trim());
      if (ev.target.closest('[data-volta]')) salvar('');
    };
  };
  const abrirAbasCab = async () => {
    const ids = await idsDoCabecalho();
    if (!ids) return avisar('Abra uma conversa (que não seja grupo).');
    const manuais = abas.filter((a) => a.tipo !== 'etiqueta');
    const nome = nomeDe(ids, chatAtual.nome);
    abrirPopMulti(
      abasWABtn,
      manuais.map((a) => ({ id: a.id, nome: a.nome, cor: a.cor })),
      new Set(manuais.filter((a) => abaTem(a, ids)).map((a) => a.id)),
      async (sel, id, incluir) => {
        await alterarAba(id, ids, nome, incluir);
        abas = await VF.ler('abas', []);
        atualizarCabecalho();
      },
      { texto: '➕ Criar nova aba…', acao: () => abrirLateral('abas', 'nova') }
    );
  };
  // O nome no cabeçalho é clicável no WhatsApp (abre os dados do contato). Seguramos o clique
  // na janela, antes de o WhatsApp ver, para o lápis e o botão de abas só fazerem o que é deles.
  for (const tipo of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
    window.addEventListener(
      tipo,
      (e) => {
        const caminho = e.composedPath();
        const b = caminho.includes(nomeWABtn) ? nomeWABtn : caminho.includes(abasWABtn) ? abasWABtn : null;
        if (!b) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (tipo === 'click') (b === nomeWABtn ? abrirNomeCab : abrirAbasCab)();
      },
      { capture: true, passive: false }
    );
  }
  const SELETORES_BUSCA = '[data-icon="search-alt"],[data-icon="search"],[data-icon="search-refreshed"],[data-icon="wds-ic-search"],[aria-label="Pesquisar"],[aria-label="Search"],[aria-label="Pesquisar…"]';
  function encaixarCabecalho() {
    const header = document.querySelector('#main header');
    if (!header) return;
    if (!chatAtual || chatAtual.grupo) {
      nomeWABtn.remove();
      abasWABtn.remove();
      return;
    }
    // Lápis logo depois do bloco do nome (fora da área que o WhatsApp usa para abrir os dados do contato)
    const busca0 = header.querySelector(SELETORES_BUSCA);
    const titulo = header.querySelector('span[dir="auto"]');
    if (titulo) {
      let bloco = titulo; // bloco do nome = maior ancestral do nome que não contém a lupa/botões
      while (bloco.parentElement && bloco.parentElement !== header && !(busca0 && bloco.parentElement.contains(busca0)) && !bloco.parentElement.contains(abasWABtn)) bloco = bloco.parentElement;
      if (nomeWABtn.previousElementSibling !== bloco) bloco.after(nomeWABtn);
    }
    // Botão de abas à esquerda da etiqueta (ou da lupa, se o contato não tiver etiqueta)
    const busca = header.querySelector(SELETORES_BUSCA);
    if (!busca) return;
    let bloco = busca.closest('button,[role="button"]') || busca;
    while (bloco.parentElement && bloco.parentElement !== header && bloco.parentElement.childElementCount === 1) bloco = bloco.parentElement;
    let pai = bloco.parentElement;
    let antes = bloco;
    const nomesEtq = new Set(etiquetas.map((t) => t.nome));
    for (let sobe = pai, filho = bloco, n = 0; sobe && sobe !== header.parentElement && n < 6; filho = sobe, sobe = sobe.parentElement, n++) {
      const chip = [...sobe.querySelectorAll('span,div')].find((el) => !el.closest('#vf-abas-wa') && el.childElementCount === 0 && nomesEtq.has(el.textContent.trim()) && !filho.contains(el) && !el.closest('span[dir="auto"]'));
      if (chip) {
        let c = chip;
        while (c.parentElement && c.parentElement !== sobe) c = c.parentElement;
        pai = sobe;
        antes = c;
        break;
      }
    }
    if (abasWABtn.parentElement !== pai || abasWABtn.nextElementSibling !== antes) pai.insertBefore(abasWABtn, antes);
  }
  setInterval(encaixarCabecalho, 1200);

  // ---- Menus do WhatsApp (opções da mensagem...) que passam por baixo do painel: empurra para a esquerda ----
  function empurrarMenus() {
    const painelAberto = !$('#lateral').classList.contains('oculto');
    const limite = window.innerWidth - 380 - 8;
    const feitos = new Set();
    document.querySelectorAll('[role="menuitem"],[data-animate-dropdown-item],[role="menu"]').forEach((item) => {
      let el = item.parentElement;
      for (let n = 0; el && el !== document.body && n < 12; el = el.parentElement, n++) {
        if (el.id === 'app' || el.id === 'main') return;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'absolute') break;
      }
      if (!el || el === document.body || feitos.has(el)) return;
      feitos.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      // O WA reaproveita a mesma caixa para vários menus: sempre recalcula a partir da posição natural
      // (sem o nosso deslocamento), senão o deslocamento antigo se acumula e o menu vai parar do outro lado.
      const atual = parseFloat(el.dataset.vfDx || '0');
      const esq = r.left - atual;
      const dir = r.right - atual;
      let dx = 0;
      if (painelAberto && dir > limite) dx = Math.min(0, Math.max(limite - dir, 68 - esq));
      if (dx === atual) return;
      if (dx === 0) {
        el.style.translate = '';
        delete el.dataset.vfDx;
      } else {
        el.style.translate = dx + 'px 0px';
        el.dataset.vfDx = String(dx);
      }
    });
  }
  const agendarMenus = () => [0, 40, 120, 250, 500, 900].forEach((ms) => setTimeout(empurrarMenus, ms));
  document.addEventListener('click', agendarMenus, true);
  document.addEventListener('contextmenu', agendarMenus, true);

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
        .map(
          (r, i) =>
            `<div class="sug ${i === sugIndice ? 'sel' : ''}" data-i="${i}"><code>/${esc(r.atalho || '')}</code> <b>${r._script ? '🔗 ' : ''}${esc(r.nome)}</b><span>${esc(r._script ? resumoScript(r) : resumoResposta(r)).slice(0, 80)}</span></div>`
        )
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
      // textContent não obriga o navegador a recalcular a tela (innerText obriga, a cada tecla)
      const t = (campo.textContent || '').trim();
      if (t[0] !== '/') return sugestoes.length && fecharSugestoes();
      const m = t.match(/^\/(\S*)$/);
      if (!m) return fecharSugestoes();
      const f = VF.semAcento(m[1].toLowerCase());
      sugestoes = [...scripts.filter((s) => s.atalho).map((s) => ({ ...s, _script: true })), ...respostas]
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
    if (r._script) return usarScript(r);
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
  // Só mexe na tela quando o texto muda (antes reescrevia o botão toda hora)
  let ultimoStatus = '';
  function atualizarStatus() {
    const classe = 'status-envio ' + (statusAtual.tipo || 'parado');
    const texto = statusAtual.tipo === 'parado' ? 'Envio em massa' : textoStatus();
    if (classe + texto === ultimoStatus) return;
    ultimoStatus = classe + texto;
    const b = $('#statusEnvio');
    b.className = classe;
    b.querySelector('span').textContent = texto;
  }
  setInterval(() => statusAtual.tipo !== 'parado' && document.visibilityState === 'visible' && atualizarStatus(), 1000);
  $('#statusEnvio').addEventListener('click', () => {
    abrirLateral('envio', statusAtual.campanhaId && statusAtual.tipo !== 'parado' ? 'campanha:' + statusAtual.campanhaId : null);
  });

  async function gravarStatus(s) {
    // Não grava de novo o mesmo status (cada gravação acorda todas as abas)
    if (s.texto === statusAtual.texto && s.tipo === statusAtual.tipo && (s.proximoEm || 0) === (statusAtual.proximoEm || 0)) return;
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

  // Sem campanha ativa, o motor não lê nada (antes lia todas as campanhas a cada 15s).
  // Volta a olhar quando alguma campanha muda.
  let haCampanhaAtiva = null;
  let idsAguardando = null; // contatos que receberam campanha e ainda não responderam
  function campanhasMudaram() {
    haCampanhaAtiva = null;
    idsAguardando = null;
  }

  async function passoDoMotor() {
    if (ocupado || haCampanhaAtiva === false) return;
    ocupado = true;
    try {
      const campanhas = await lerCampanhas();
      const campanha = campanhas.find((c) => c.status === 'ativa');
      haCampanhaAtiva = !!campanha;
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

      const nome = nomeDe(ids, '') || contato.nome || (info && info.nome) || (await rpc('nomeContato', id).catch(() => ''));
      const variacoes = (campanha.variacoes || []).filter((v) => v && v.length);
      let modelo = 0;
      if (variacoes.length > 1) {
        // Sorteio, puxando para o modelo menos usado até agora (fica equilibrado)
        const usos = variacoes.map((_, k) => campanha.contatos.filter((x) => x.modelo === k + 1).length);
        const menor = Math.min(...usos);
        const candidatos = usos.map((u, k) => (u <= menor + 1 ? k : -1)).filter((k) => k >= 0);
        modelo = candidatos[Math.floor(Math.random() * candidatos.length)] + 1;
      }
      const etapasEnvio = modelo ? variacoes[modelo - 1] : campanha.etapas || [];
      const temMensagem = etapasEnvio.length > 0;
      if (temMensagem) await enviarEtapas(id, etapasEnvio, { nome, vendedor: cfg.nomeVendedor }, { digitacao: cfg.simularDigitacao });

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

      await salvarContato(campanha.id, i, { status: 'enviado', id, ids, nome, erro: avisos.join(' | '), em: Date.now(), ...(modelo ? { modelo } : {}) });
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
    // Só abre as campanhas se quem escreveu recebeu alguma (antes lia tudo a cada mensagem recebida)
    if (!idsAguardando) {
      const s = new Set();
      for (const c of await lerCampanhas()) {
        if (c.status === 'cancelada') continue;
        c.contatos.forEach((x) => x.status === 'enviado' && !x.respondeu && [x.id, ...(x.ids || [])].forEach((y) => s.add(y)));
      }
      idsAguardando = s;
    }
    if (!ids.some((x) => idsAguardando.has(x))) return;
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
    scripts = await VF.ler('scripts', []);
    nomes = await VF.ler('nomes', {});
    categorias = await VF.ler('categorias', []);
    if (!etiquetas.length) etiquetas = await VF.ler('etiquetasCache', []);
    desenharPilulas();
  }

  let redesenho;
  chrome.storage.onChanged.addListener(async (mud, area) => {
    if (area !== 'local') return;
    const chaves = Object.keys(mud);
    if (chaves.some((k) => k === 'campanhas' || k.startsWith('campanha:'))) campanhasMudaram();
    if (mud.nomes) nomes = mud.nomes.newValue || {};
    if (mud.nomes || mud.abas) setTimeout(atualizarCabecalho, 50);
    if (mud.servidor) servidor = mud.servidor.newValue || { chave: '' };
    if (mud.automacoes) automacoes = mud.automacoes.newValue || {};
    if (mud.abas) avisarMudancasAbas(mud.abas.oldValue, mud.abas.newValue);
    if (mud.abas || mud.respostas || mud.scripts || mud.categorias) {
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
      (secaoAtual === 'respostas' && (mud.respostas || mud.scripts || mud.categorias)) ||
      (secaoAtual === 'abas' && mud.abas) ||
      (secaoAtual === 'envio' && (mexeuCampanha || mud.motorStatus)) ||
      (secaoAtual === 'naoperturbe' && mud.naoPerturbe) ||
      (secaoAtual === 'contato' && (mud.abas || mud.nomes));
    if (kanbanAberto && !arrastandoCard && (mud.abas || mud.nomes || mud.automacoes)) setTimeout(() => kanbanAberto && !arrastandoCard && desenharKanban(), 150);
    if (relevante && !telaComFormulario()) {
      clearTimeout(redesenho);
      redesenho = setTimeout(() => {
        const rolagem = $('#corpo').scrollTop;
        desenharLateral().then(() => ($('#corpo').scrollTop = rolagem));
      }, 300);
    }
  });

  recarregarDados();
  ligarEventosKanban();
  carregarServidor();
  setInterval(sincronizarKanban, 60000);
  VF.ler('motorStatus', null).then((s) => s && ((statusAtual = s), atualizarStatus()));
  setInterval(passoDoMotor, 15000);
  setTimeout(passoDoMotor, 5000);
})();
