// GoSeller inside WhatsApp Web: tab bar, icon rail, side panel and bulk-send engine.
(() => {
  if (window.top !== window) return;
  const CHANNEL = 'goseller';
  const ORIGIN = location.origin;
  const MY_TOKEN = VF.newId(); // identifies this tab (prevents 2 tabs sending at the same time)
  const esc = VF.esc;

  // =====================================================================
  // Error log: last 50 errors, kept only on this computer (storage key 'logErros').
  // Sent along with "Relatar problema". Phone numbers are masked (LGPD).
  // =====================================================================
  const ERROR_LOG_MAX = 50;
  let errorLog = [];
  let errorLogTimer = null;
  VF.read('logErros', []).then((saved) => (errorLog = saved.concat(errorLog).slice(-ERROR_LOG_MAX)));
  const maskNumbers = (text) => String(text).replace(/\d{8,}/g, (d) => d.slice(0, 5) + '****' + d.slice(-4));
  function logError(source, message) {
    errorLog.push({ em: Date.now(), origem: source, msg: maskNumbers(message).slice(0, 500) });
    errorLog = errorLog.slice(-ERROR_LOG_MAX);
    clearTimeout(errorLogTimer);
    errorLogTimer = setTimeout(() => VF.write('logErros', errorLog), 1000);
  }
  const ownScript = (file) => String(file || '').startsWith(chrome.runtime.getURL(''));
  window.addEventListener('error', (e) => ownScript(e.filename) && logError('codigo', `${e.message} (${String(e.filename).split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r && r.stack && !ownScript((r.stack.match(/(chrome-extension:\/\/[^\s)]+)/) || [])[1])) return;
    logError('codigo', (r && r.message) || String(r));
  });

  // =====================================================================
  // Talking to the page (page.js)
  // =====================================================================
  const pending = new Map();
  let seq = 0;

  function rpc(fn, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const limit = setTimeout(() => {
        pending.delete(id);
        logError('whatsapp', `${fn}: sem resposta em 3 min`);
        reject(new Error('O WhatsApp não respondeu a tempo (' + fn + ')'));
      }, 180000);
      pending.set(id, { resolve, reject, limite: limit, fn });
      window.postMessage({ canal: CHANNEL, de: 'extensao', id, fn, args }, ORIGIN);
    });
  }

  let waState = { logado: false };
  let currentChat = null;

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.canal !== CHANNEL || d.de !== 'pagina') return;
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      clearTimeout(p.limite);
      if (d.erro) logError('whatsapp', `${p.fn}: ${d.erro}`);
      return d.erro ? p.reject(new Error(d.erro)) : p.resolve(d.resultado);
    }
    if (d.tipo !== 'evento') return;
    if (d.evento === 'estado') {
      waState = d.estado || waState;
      if (waState.logado) loadLabels();
    } else if (d.evento === 'chatAtivo') {
      currentChat = d.chat;
      if (currentSection === 'contato') renderSidePanel();
      updateHeader();
      fitHeader();
    } else if (d.evento === 'mensagem') {
      handleIncomingMessage(d).catch((e) => console.warn('[GoSeller]', e));
    }
  });

  // =====================================================================
  // Sending a sequence (text, audio, video...) to a contact
  // =====================================================================
  async function sendSteps(chatId, steps, data, options = {}) {
    const typing = !!options.digitacao;
    for (let i = 0; i < (steps || []).length; i++) {
      const e = steps[i];
      if (i > 0) await VF.sleep(Math.max(0, Number(e.espera ?? 2)) * 1000);
      if (e.tipo === 'texto') {
        const text = VF.buildText(e.texto, data);
        if (!text.trim()) continue;
        const ms = typing ? Math.min(9000, 1200 + text.length * 45) * VF.random(0.8, 1.2) : 0;
        await rpc('enviarTexto', chatId, text, { digitandoMs: Math.round(ms) });
      } else {
        let dataUrl = await VF.readMedia(e.midiaId);
        if (!dataUrl) throw new Error('Arquivo não encontrado: ' + (e.nomeArquivo || 'mídia'));
        const cleaned = VoiceNote.cleanHeader(dataUrl);
        if (cleaned !== dataUrl) await VF.write('midia:' + e.midiaId, (dataUrl = cleaned)); // fixes files saved by 0.8.4's converter
        const voiceNote = e.tipoMidia === 'audio' && !!e.ptt;
        if (voiceNote && !VoiceNote.isOggOpus(dataUrl)) {
          // MP3/M4A as a voice note can't be played by the receiver: convert once and keep the converted file
          try {
            dataUrl = (await VoiceNote.convert(dataUrl)).dataUrl;
          } catch (err) {
            throw new Error('Não consegui converter o áudio para nota de voz (' + (err.message || err) + ')');
          }
          await VF.write('midia:' + e.midiaId, dataUrl);
        }
        let ms = 0;
        if (typing) ms = e.tipoMidia === 'audio' && e.ptt ? Math.min(15000, (e.duracao || 5) * 1000) : 2500;
        await rpc('enviarArquivo', chatId, dataUrl, {
          tipo: e.tipoMidia,
          legenda: VF.buildText(e.legenda || '', data),
          nomeArquivo: e.nomeArquivo,
          mime: voiceNote ? VoiceNote.MIME : e.mime,
          ptt: !!e.ptt,
          digitandoMs: Math.round(ms),
        });
      }
    }
  }

  // =====================================================================
  // Data
  // =====================================================================
  let tabs = [];
  let replies = [];
  let scripts = []; // quick-reply chains: { id, nome, atalho, itens: [{ respostaId, espera }] }
  let labels = [];
  let categories = []; // categories created by the seller (may be empty)
  let names = {}; // name chosen by the seller for the contact: { 'id@c.us': 'Maria' } (used in the {nome} variables)
  let selectedTab = 'todas';
  const nameOf = (ids, fallback) => [].concat(ids || []).map((x) => names[x]).find(Boolean) || fallback || '';

  const tabIds = (tab) => [...new Set((tab.chats || []).flatMap((c) => c.ids))];
  const tabHas = (tab, ids) => (tab.chats || []).some((c) => c.ids.some((x) => ids.includes(x)));

  // Any tab can be linked to a WhatsApp label (tab.etiquetaId). Importing adds the label's
  // contacts to the tab's own list, so the tab keeps accepting contacts added by hand.
  // tab.importados remembers every id the label ever brought in: a contact removed by hand
  // or moved in the Kanban is never brought back, and losing the label doesn't remove anyone.
  const phoneKey = (id) => (String(id).endsWith('@c.us') ? numberKey(id) : id);
  async function importFromLabel(tab) {
    const chats = await rpc('listarChats', { etiqueta: String(tab.etiquetaId) });
    tab.chats = tab.chats || [];
    const imported = new Set(tab.importados || []);
    const present = new Set(tabIds(tab).map(phoneKey));
    let added = 0;
    for (const c of chats) {
      const key = phoneKey(c.id);
      if (!imported.has(key) && !present.has(key)) {
        tab.chats.push({ ids: [c.id], nome: c.nome || '', em: Date.now() });
        present.add(key);
        added++;
      }
      imported.add(key);
    }
    tab.importados = [...imported];
    return added;
  }

  let syncingLabels = false;
  async function syncLabelTabs() {
    if (syncingLabels || !waState.logado) return;
    syncingLabels = true;
    try {
      const list = await VF.read('abas', []);
      let changed = false;
      for (const tab of list.filter((a) => a.etiquetaId && a.sincronizar)) {
        const before = (tab.importados || []).length;
        const added = await importFromLabel(tab).catch(() => 0);
        if (added || tab.importados.length !== before) changed = true;
      }
      if (changed) await VF.write('abas', list);
    } finally {
      syncingLabels = false;
    }
  }

  async function changeTab(tabId, ids, name, include) {
    const list = await VF.read('abas', []);
    const tab = list.find((a) => a.id === tabId);
    if (!tab) return;
    tab.chats = (tab.chats || []).filter((c) => !c.ids.some((x) => ids.includes(x)));
    if (include) tab.chats.push({ ids, nome: name || '', em: Date.now() });
    await VF.write('abas', list);
  }

  async function equivalents(id) {
    try {
      return await rpc('equivalentes', id);
    } catch (e) {
      return [id];
    }
  }

  async function saveName(ids, name) {
    const mapping = await VF.read('nomes', {});
    ids.forEach((x) => (name ? (mapping[x] = name) : delete mapping[x]));
    names = mapping;
    await VF.write('nomes', mapping);
    // Updates the name stored in the tabs (shown in the lists)
    const list = await VF.read('abas', []);
    let touched = false;
    list.forEach((a) => (a.chats || []).forEach((c) => {
      if (c.ids.some((x) => ids.includes(x)) && name && c.nome !== name) ((c.nome = name), (touched = true));
    }));
    if (touched) await VF.write('abas', list);
  }

  // Changes the name: stores it in the extension and saves the contact in WhatsApp itself (shows in the header and list)
  async function changeName(ids, chatId, value) {
    await saveName(ids, value);
    if (!value) return notify('Voltou a usar o nome do WhatsApp nas mensagens.', 'ok', 3000);
    const id = ids.find((x) => x.endsWith('@c.us')) || chatId;
    try {
      await rpc('salvarContato', id, value);
      notify(`Contato salvo no WhatsApp como "${value}".`, 'ok', 3500);
    } catch (e) {
      notify(`O nome "${value}" vale nas mensagens da extensão, mas o WhatsApp não deixou salvar o contato (${e.message}). Use "Salvar contato" do próprio WhatsApp.`, 'erro', 9000);
    }
  }

  async function loadLabels() {
    try {
      labels = await rpc('etiquetas');
      await VF.write('etiquetasCache', labels);
      renderPills();
      syncLabelTabs();
    } catch (e) { /* still loading */ }
  }

  async function selectTab(id) {
    selectedTab = id;
    renderPills();
    try {
      if (id === 'todas') return await rpc('filtrarLista', 'all');
      const tab = tabs.find((a) => a.id === id);
      if (!tab) return selectTab('todas');
      if (tab.etiquetaId && tab.sincronizar) {
        await syncLabelTabs();
        if (selectedTab !== id) return;
      }
      const ids = tabIds(tabs.find((a) => a.id === id) || tab);
      await rpc('filtrarLista', 'custom', ids.length ? ids : ['0@c.us']);
      if (!ids.length) notify(`A aba "${tab.nome}" está vazia. Abra uma conversa e marque a aba no ícone 👤 Contato.`);
    } catch (e) {
      notify('Não consegui filtrar: ' + e.message, 'erro');
    }
  }

  // =====================================================================
  // Icons
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
  // UI structure
  // =====================================================================
  document.documentElement.classList.add('vf-ativo');
  const host = document.createElement('div');
  host.id = 'vf-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  // Second layer, above WhatsApp, only for floating things (menus, "/" suggestions, notices, hints).
  // The main layer (bar, rail, panel) sits BELOW #app so WhatsApp's menus
  // don't get hidden behind the panel.
  const floatHost = document.createElement('div');
  floatHost.id = 'vf-host-flut';
  floatHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(floatHost);
  const floatRoot = floatHost.attachShadow({ mode: 'open' });

  const SECTIONS = [
    ['contato', 'usuario', 'Contato aberto (nome e anotações)'],
    ['respostas', 'raio', 'Respostas rápidas'],
    ['envio', 'aviao', 'Envio em massa'],
    ['abas', 'funil', 'Abas'],
    ['kanban', 'kanban', 'Kanban automático (servidor)'],
    ['naoperturbe', 'proibido', 'Não perturbe'],
    ['config', 'engrenagem', 'Configurações'],
  ];

  root.innerHTML = `
    <header class="topo">
      <button class="logo" data-abrir="respostas" title="GoSeller">${IC.raio}</button>
      <div class="pilulas" id="pilulas"></div>
      <button class="icone-btn" id="novaAba" title="Criar nova aba">${IC.pastaMais}</button>
      <button class="icone-btn" data-abrir="abas" title="Organizar abas">${IC.lista}</button>
      <button class="icone-btn" id="abrirKanbanTopo" title="Quadro Kanban">${IC.kanban}</button>
      <button class="status-envio parado" id="statusEnvio">${IC.aviao}<span>Envio em massa</span></button>
    </header>
    <nav class="trilho" id="trilho">
      ${SECTIONS.map(([s, ic, hint], i) => `<button class="icone-btn" data-abrir="${s}" data-dica="${hint}">${IC[ic]}</button>${i === 0 || i === 3 ? '<div class="separador"></div>' : ''}`).join('')}
      <div class="base">v${chrome.runtime.getManifest().version}</div>
    </nav>
    <aside class="lateral oculto" id="lateral">
      <div class="lat-abas">
        ${SECTIONS.map(([s, ic, hint]) => `<button class="icone-btn" data-abrir="${s}" title="${hint}">${IC[ic]}</button>`).join('')}
        <button class="icone-btn fechar" id="fechar" title="Fechar">${IC.fechar}</button>
      </div>
      <div class="lat-corpo" id="corpo"></div>
      <div class="lat-rodape oculto" id="rodape"></div>
    </aside>`;
  floatRoot.innerHTML = `
    <div class="kanban oculto" id="kanban"></div>
    <div class="pop oculto" id="pop"></div>
    <div class="fundo-dialogo oculto" id="fundoDialogo"></div>
    <div class="dialogo oculto" id="dialogo" role="dialog" aria-modal="true"></div>
    <div class="sugestoes oculto" id="sugestoes"></div>
    <div class="avisos" id="avisos"></div>
    <div class="dica-flut oculto" id="dicaFlut"></div>`;

  const $ = (s) => root.querySelector(s) || floatRoot.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];

  // Tooltip when hovering rail icons (on the top layer, so it isn't behind WhatsApp)
  root.addEventListener('mouseover', (e) => {
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

  // Styles (constructable stylesheet: doesn't hit WhatsApp's security policy)
  fetch(chrome.runtime.getURL('src/ui.css'))
    .then((r) => r.text())
    .then((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      floatRoot.adoptedStyleSheets = [sheet];
    })
    .catch((e) => console.warn('[GoSeller] CSS', e));

  // Light/dark theme matching WhatsApp
  function checkTheme() {
    const dark = document.body && (document.body.classList.contains('dark') || document.documentElement.classList.contains('dark'));
    host.classList.toggle('escuro', !!dark);
    floatHost.classList.toggle('escuro', !!dark);
  }
  checkTheme();
  setInterval(checkTheme, 3000);

  // Quick notice in the footer. With "action" it becomes a notice with a button (e.g.: Undo).
  function notify(text, type = 'info', ms = 5000, action = null) {
    const el = document.createElement('div');
    el.className = 'aviso ' + type;
    el.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.className = 'aviso-acao';
      b.textContent = action.texto;
      b.onclick = () => {
        el.remove();
        action.fn();
      };
      el.appendChild(b);
    }
    $('#avisos').appendChild(el);
    setTimeout(() => el.remove(), ms);
    if (type === 'erro') logError('aviso', text);
  }
  VF.notice = notify; // used by the message editor (steps-editor.js)

  // ---- Confirmation box next to the clicked button (instead of the browser's confirm/prompt) ----
  let lastTouch = { em: 0, rect: null, x: 0, y: 0 };
  const storeTouch = (e) => {
    const target = e.composedPath()[0];
    const el = target && target.closest ? target.closest('button, a, label, .pilula, .kcard, [data-acao], [data-i]') || target : null;
    lastTouch = { em: Date.now(), rect: el && el.getBoundingClientRect ? el.getBoundingClientRect() : null, x: e.clientX, y: e.clientY };
  };
  document.addEventListener('pointerdown', storeTouch, true);
  root.addEventListener('pointerdown', storeTouch, true);
  floatRoot.addEventListener('pointerdown', storeTouch, true);

  let closeCurrentDialog = null;
  // options: [{ valor, texto, tipo: 'principal' | 'perigo' | 'sec', foco }]; field: { valor, placeholder } -> returns the text
  function dialog({ titulo: title, texto: text = '', opcoes: options, campo: field = null, largura: width = 300 }) {
    if (closeCurrentDialog) closeCurrentDialog(null);
    return new Promise((resolveFn) => {
      const box = $('#dialogo');
      box.style.width = width + 'px';
      box.innerHTML = `
        <div class="dlg-titulo">${esc(title)}</div>
        ${text ? text.split(/\n\n+/).map((p) => `<p class="dlg-texto">${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : ''}
        ${field ? `<input type="text" class="dlg-campo" maxlength="60" value="${esc(field.valor || '')}" placeholder="${esc(field.placeholder || '')}">` : ''}
        <div class="dlg-botoes">${options.map((o, i) => `<button type="button" class="btn peq ${o.tipo === 'perigo' ? 'perigo-cheio' : o.tipo === 'sec' ? 'sec' : ''}" data-op="${i}">${esc(o.texto)}</button>`).join('')}</div>`;
      $('#fundoDialogo').classList.remove('oculto');
      box.classList.remove('oculto', 'aparecer');
      // Position: right below (or above) the clicked button; with no recent click, in the middle of the screen
      const W = innerWidth, H = innerHeight, m = 10;
      const r = Date.now() - lastTouch.em < 1500 && lastTouch.rect && lastTouch.rect.width ? lastTouch.rect : null;
      const alt = box.offsetHeight, wdt = box.offsetWidth;
      let x, y;
      if (r) {
        x = Math.min(Math.max(m, r.left + r.width / 2 - wdt / 2), W - wdt - m);
        y = r.bottom + 8 + alt < H - m ? r.bottom + 8 : Math.max(m, r.top - 8 - alt);
        box.dataset.lado = y > r.top ? 'baixo' : 'cima';
        box.style.setProperty('--seta', Math.min(Math.max(14, r.left + r.width / 2 - x), wdt - 14) + 'px');
      } else {
        x = (W - wdt) / 2;
        y = Math.max(m, (H - alt) / 2.4);
        box.dataset.lado = 'meio';
      }
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      void box.offsetWidth;
      box.classList.add('aparecer');
      const input = box.querySelector('.dlg-campo');
      const getValue = (o) => (field ? (o.valor ? input.value.trim() : null) : o.valor);
      const close = (res) => {
        box.classList.add('oculto');
        $('#fundoDialogo').classList.add('oculto');
        document.removeEventListener('keydown', keysPressed, true);
        closeCurrentDialog = null;
        resolveFn(res);
      };
      closeCurrentDialog = close;
      const keysPressed = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(field ? null : options.find((o) => o.cancela)?.valor ?? false);
        }
        if (e.key === 'Enter' && input && e.composedPath().includes(input)) {
          e.preventDefault();
          e.stopPropagation();
          const o = options.find((x) => x.tipo === 'principal') || options[options.length - 1];
          close(getValue(o));
        }
      };
      document.addEventListener('keydown', keysPressed, true);
      box.onclick = (e) => {
        const b = e.target.closest('[data-op]');
        if (b) close(getValue(options[Number(b.dataset.op)]));
      };
      $('#fundoDialogo').onclick = () => close(field ? null : options.find((o) => o.cancela)?.valor ?? false);
      setTimeout(() => {
        if (input) {
          input.focus();
          input.select();
        } else box.querySelector(`[data-op="${Math.max(0, options.findIndex((o) => o.foco))}"]`).focus();
      }, 30);
    });
  }

  // Yes/no. The first paragraph becomes the title. danger = red button and focus on "Voltar".
  function confirm(message, { ok = 'Confirmar', cancelar: cancel = 'Voltar', perigo: danger = false } = {}) {
    const [title, ...rest] = String(message).split(/\n\n+/);
    return dialog({
      titulo: title,
      texto: rest.join('\n\n'),
      opcoes: [
        { valor: false, texto: cancel, tipo: 'sec', foco: danger, cancela: true },
        { valor: true, texto: ok, tipo: danger ? 'perigo' : 'principal', foco: !danger },
      ],
    });
  }

  // Asks for a text (tab name, category...). Returns null if cancelled.
  async function askText(title, value = '', { ok = 'Salvar', placeholder = '', texto: text = '' } = {}) {
    const r = await dialog({ titulo: title, texto: text, campo: { valor: value, placeholder }, opcoes: [{ valor: false, texto: 'Cancelar', tipo: 'sec' }, { valor: true, texto: ok, tipo: 'principal' }] });
    return r === null ? null : r.trim();
  }

  // ---- "..." menu (popover) ----
  function positionPop(button) {
    const pop = $('#pop');
    pop.classList.remove('oculto');
    const r = button.getBoundingClientRect();
    const wdt = pop.offsetWidth || 200;
    const alt = pop.offsetHeight || 100;
    pop.style.left = Math.max(8, Math.min(r.right - wdt, window.innerWidth - wdt - 8)) + 'px';
    pop.style.top = (r.bottom + 4 + alt > window.innerHeight - 8 ? Math.max(8, r.top - alt - 4) : r.bottom + 4) + 'px';
  }
  // Checkable list that stays open (pick several tabs/labels)
  function openMultiPop(button, options, sel, onChange, extra) {
    const pop = $('#pop');
    const render = () => {
      let group = null;
      pop.innerHTML =
        options
          .map((o, i) => {
            const hdr = o.grupo && o.grupo !== group ? `<div class="pop-grupo">${esc((group = o.grupo))}</div>` : '';
            return `${hdr}<button data-i="${i}" class="${sel.has(o.id) ? 'marcado' : ''}"><span class="caixa">${sel.has(o.id) ? '✓' : ''}</span><span style="color:${esc(o.cor || '#8696a0')}">●</span><span class="pop-nome">${esc(o.nome)}</span>${o.extra != null ? `<small>${esc(String(o.extra))}</small>` : ''}</button>`;
          })
          .join('') +
        (options.length ? '' : '<div class="dica" style="padding:8px">Nada para escolher.</div>') +
        (extra ? `<div class="pop-sep"></div><button data-extra>${extra.texto}</button>` : '');
    };
    render();
    positionPop(button);
    pop.onclick = (e) => {
      if (e.target.closest('[data-extra]')) {
        closePop();
        return extra.acao();
      }
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const o = options[Number(b.dataset.i)];
      sel.has(o.id) ? sel.delete(o.id) : sel.add(o.id);
      render();
      onChange(sel, o.id, sel.has(o.id));
    };
  }
  // Drag to reorder: click and hold anywhere on the item and move.
  // A simple click works as before — it only becomes a drag after the mouse moves a few pixels.
  // options: axis 'y'|'x', allowed(item) enables/disables, over(el, item) handles extra targets, onDrop(item)
  function dragSort(list, selector, options) {
    const { eixo: axis = 'y', pode: allowed = () => true, sobre: over = null, aoSoltar: onDrop } = options;
    const root = list.getRootNode();
    let item = null, x0 = 0, y0 = 0, activeIdx = false, scroll = null;
    const scrollable = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)[axis === 'y' ? 'overflowY' : 'overflowX'];
        if (/(auto|scroll)/.test(s)) return p;
      }
      return null;
    };
    const move = (e) => {
      if (!item) return;
      if (!activeIdx) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
        activeIdx = true;
        scroll = scrollable(item);
        item.classList.add('arrastando');
        list.classList.add('ordenando');
        getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      // Auto-scrolls near the edge
      if (scroll) {
        const r = scroll.getBoundingClientRect();
        const p = axis === 'y' ? e.clientY : e.clientX;
        const [start, end] = axis === 'y' ? [r.top, r.bottom] : [r.left, r.right];
        if (p < start + 40) scroll[axis === 'y' ? 'scrollTop' : 'scrollLeft'] -= 12;
        else if (p > end - 40) scroll[axis === 'y' ? 'scrollTop' : 'scrollLeft'] += 12;
      }
      const el = (root.elementFromPoint ? root : document).elementFromPoint(e.clientX, e.clientY);
      if (!el || !list.contains(el)) return;
      const target = el.closest(selector);
      if (target && target !== item && list.contains(target) && allowed(target)) {
        const r = target.getBoundingClientRect();
        const before = axis === 'y' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
        target.parentElement.insertBefore(item, before ? target : target.nextSibling);
      } else if (!target && over) over(el, item);
    };
    const noSelection = (e) => item && e.preventDefault();
    const drop = () => {
      window.removeEventListener('selectstart', noSelection, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', drop, true);
      window.removeEventListener('pointercancel', drop, true);
      const it = item;
      item = null;
      if (!activeIdx || !it) return;
      activeIdx = false;
      it.classList.remove('arrastando');
      list.classList.remove('ordenando');
      // The click that comes right after dropping must not open/select anything
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 80);
      Promise.resolve(onDrop(it)).catch((err) => notify('Não consegui salvar a ordem: ' + err.message, 'erro'));
    };
    list.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const it = e.target.closest(selector);
      if (!it || !list.contains(it) || !allowed(it)) return;
      const internal = e.target.closest('button, input, textarea, select, a, label, [contenteditable]');
      if (internal && internal !== it && it.contains(internal)) return; // the item's own buttons keep working normally
      item = it;
      x0 = e.clientX;
      y0 = e.clientY;
      activeIdx = false;
      window.addEventListener('selectstart', noSelection, true);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', drop, true);
      window.addEventListener('pointercancel', drop, true);
    });
  }

  // Compact selector: pills of what was chosen + "Adicionar" button
  function multiSelector(el, optionsFn, initial, onChange, empty = 'Nenhuma escolhida') {
    const sel = new Set(initial || []);
    const render = () => {
      const picked = optionsFn().filter((o) => sel.has(o.id));
      el.innerHTML = `<div class="tags">${picked.map((o) => `<span class="tag" style="--c:${esc(o.cor || '#8696a0')}"><i></i>${esc(o.nome)}<button type="button" data-tirar="${esc(o.id)}" title="Tirar">×</button></span>`).join('') || `<span class="dica">${empty}</span>`}<button type="button" class="mais-peq" data-add>${IC.mais2} Adicionar</button></div>`;
    };
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tirar]');
      if (t) {
        sel.delete(t.dataset.tirar);
        render();
        return onChange && onChange(sel);
      }
      const a = e.target.closest('[data-add]');
      if (a) openMultiPop(a, optionsFn(), sel, () => {
        render();
        onChange && onChange(sel);
      });
    });
    render();
    return { value: () => [...sel], set: (v) => (sel.clear(), (v || []).forEach((x) => sel.add(x)), render()) };
  }
  function openPop(button, items) {
    const pop = $('#pop');
    pop.innerHTML = items.map((it, i) => `<button data-i="${i}" class="${it.perigo ? 'perigo' : ''}">${it.texto}</button>`).join('');
    positionPop(button);
    pop.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      closePop();
      items[Number(b.dataset.i)].acao();
    };
  }
  const closePop = () => $('#pop').classList.add('oculto');
  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes($('#pop'))) closePop();
  }, true);
  root.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes($('#pop'))) closePop();
  });

  // =====================================================================
  // Side panel
  // =====================================================================
  let currentSection = null;
  let view = null; // sub-screen: 'editar:<id>', 'nova', 'campanha:<id>'...
  const uiState = { busca: '', filtroTipo: 'tudo', fechadas: new Set(), previa: new Set(), filtroContatos: 'todos' };

  const lastViews = {}; // section -> last sub-screen, so coming back lands where the user was

  function openSidePanel(section, newView = null) {
    if (currentSection === section && !newView && !$('#lateral').classList.contains('oculto')) return closeSidePanel();
    currentSection = section;
    view = newView || lastViews[section] || null;
    lastViews[section] = view;
    $('#lateral').classList.remove('oculto');
    document.documentElement.style.setProperty('--vf-direita', '380px');
    $$('[data-abrir]').forEach((b) => b.classList.toggle('ativo', b.dataset.abrir === section && !b.classList.contains('logo')));
    renderSidePanel();
  }
  function closeSidePanel() {
    currentSection = null;
    view = null;
    $('#lateral').classList.add('oculto');
    document.documentElement.style.setProperty('--vf-direita', '0px');
    $$('[data-abrir]').forEach((b) => b.classList.remove('ativo'));
  }
  function goTo(newView) {
    view = newView;
    if (currentSection) lastViews[currentSection] = newView;
    renderSidePanel();
    $('#corpo').scrollTop = 0;
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-abrir]');
    if (b) openSidePanel(b.dataset.abrir);
  });
  $('#fechar').addEventListener('click', closeSidePanel);
  $('#abrirKanbanTopo').addEventListener('click', () => (kanbanOpen ? closeKanban() : openKanban()));

  function footerText(html) {
    const r = $('#rodape');
    r.innerHTML = html || '';
    r.classList.toggle('oculto', !html);
  }

  const screens = {};
  async function renderSidePanel() {
    if (!currentSection) return;
    footerText('');
    const body = $('#corpo');
    body.onclick = body.onchange = body.oninput = body.onkeydown = null; // removes the previous screen's listeners
    try {
      await screens[currentSection](body);
    } catch (e) {
      $('#corpo').innerHTML = `<div class="alerta">Erro: ${esc(e.message)}</div>`;
    }
  }

  // Screens with a form are not redrawn automatically (so we don't wipe what the person is typing)
  const formScreen = () =>
    (currentSection === 'respostas' && view) || (currentSection === 'envio' && view && (view === 'nova' || view.startsWith('duplicar:'))) || currentSection === 'config' || currentSection === 'kanban' || (currentSection === 'abas' && view);

  // =====================================================================
  // SCREEN: Open contact
  // =====================================================================
  screens.contato = async (body) => {
    try {
      currentChat = (await rpc('chatAtivo')) || null;
    } catch (e) { /* uses the last */ }
    if (!currentChat || currentChat.grupo) {
      body.innerHTML = `<div class="lat-titulo"><h2>Contato</h2></div><div class="vazio">Abra uma conversa (que não seja grupo) para mudar o nome do lead e anotar coisas sobre ele.</div>`;
      return;
    }
    const ids = await equivalents(currentChat.id);
    const noteKey = 'nota:' + (ids.find((x) => x.endsWith('@c.us')) || ids[0]);
    const note = await VF.read(noteKey, '');
    const number = VF.numberFromId(ids.find((x) => x.endsWith('@c.us'))) || currentChat.numero || '';
    const waName = currentChat.nome || '';
    const myName = nameOf(ids, '');
    const shownName = myName || waName || number || 'Contato';
    body.innerHTML = `
      <div class="perfil"><div class="avatar">${esc((VF.firstName(shownName) || '?').charAt(0).toUpperCase())}</div>
        <div class="perfil-txt" id="perfilTxt">
          <div class="nome-linha"><b>${esc(shownName)}</b><button type="button" class="icone-btn mini" id="editarNome" title="Mudar o nome deste contato">${IC.lapis}</button></div>
          <div class="dica">${esc(number)}${myName && waName && waName !== myName ? ` · no WhatsApp: ${esc(waName)}` : ''}</div>
        </div></div>
      <div class="secao-t">Anotações</div>
      <textarea id="nota" placeholder="Ex.: interessado no técnico em enfermagem, retornar sexta">${esc(note)}</textarea>
      <div class="dica" id="notaSalva"></div>`;

    body.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'editarNome') {
        const box = body.querySelector('#perfilTxt');
        box.innerHTML = `<input type="text" id="novoNome" value="${esc(shownName === number ? '' : shownName)}" placeholder="Nome do contato">
          <div class="nome-acoes"><button type="button" class="btn peq" id="salvarNome">Salvar</button><button type="button" class="btn sec peq" id="cancelarNome">Cancelar</button>
          ${myName ? `<button type="button" class="link-btn" id="restaurarNome">Voltar ao nome do WhatsApp</button>` : ''}</div>
          <div class="dica">Salva o contato no WhatsApp com esse nome e vale em {nome} e {primeiro_nome}.</div>`;
        const inp = box.querySelector('#novoNome');
        inp.focus();
        inp.select();
        inp.onkeydown = (k) => {
          if (k.key === 'Enter') box.querySelector('#salvarNome').click();
          if (k.key === 'Escape') renderSidePanel();
          k.stopPropagation();
        };
        return;
      }
      if (b.id === 'cancelarNome') return renderSidePanel();
      if (b.id === 'salvarNome' || b.id === 'restaurarNome') {
        const value = b.id === 'salvarNome' ? body.querySelector('#novoNome').value.trim() : '';
        return changeName(ids, currentChat.id, value).then(() => renderSidePanel());
      }
    };
    let t;
    body.querySelector('#nota').oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await VF.write(noteKey, e.target.value);
        const s = body.querySelector('#notaSalva');
        if (s) s.textContent = 'Salvo ✓';
      }, 500);
    };
  };

  // =====================================================================
  // SCREEN: Quick replies
  // =====================================================================
  const replyType = (r) => {
    const types = [...new Set(r.etapas.map((e) => (e.tipo === 'texto' ? 'texto' : e.tipoMidia)))];
    if (types.length === 1) return types[0];
    return types.find((t) => t !== 'texto') || 'texto';
  };
  const textOnly = (r) => r.etapas.length === 1 && r.etapas[0].tipo === 'texto';
  const replySummary = (r) => r.etapas.map((e) => (e.tipo === 'texto' ? e.texto : '[' + (VF.MEDIA_TYPES[e.tipoMidia] || 'Arquivo') + ']')).join(' · ');

  async function useReply(r, mode) {
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return notify(e.message, 'erro');
    }
    if (!chat) return notify('Abra uma conversa primeiro.');
    const cfg = await VF.config();
    const data = { nome: nameOf(chat.id, chat.nome), vendedor: cfg.nomeVendedor };
    try {
      if (mode === 'colar' && textOnly(r)) {
        await rpc('colarTexto', VF.buildText(r.etapas[0].texto, data), chat.id);
      } else {
        await sendSteps(chat.id, r.etapas, data, { digitacao: cfg.digitacaoNasRespostas });
      }
      const list = await VF.read('respostas', []);
      const x = list.find((y) => y.id === r.id);
      if (x) {
        x.usos = (x.usos || 0) + 1;
        await VF.write('respostas', list);
      }
    } catch (e) {
      notify('Não consegui enviar: ' + e.message, 'erro');
    }
  }

  const repliesSegment = () => `<div class="segmento">
      <button data-seg="respostas" class="${uiState.seg !== 'scripts' ? 'ativo' : ''}">Respostas</button>
      <button data-seg="scripts" class="${uiState.seg === 'scripts' ? 'ativo' : ''}">Scripts <span class="qtd">${scripts.length}</span></button></div>`;

  screens.respostas = async (body) => {
    if (view && view.startsWith('editar:')) return editReplyScreen(body, view.slice(7));
    if (view && view.startsWith('script:')) return editScriptScreen(body, view.slice(7));
    if (uiState.seg === 'scripts') return scriptsScreen(body);
    const filters = [['tudo', 'Tudo'], ['texto', 'Texto'], ['audio', 'Áudio'], ['image', 'Imagem'], ['video', 'Vídeo'], ['document', 'Arquivo'], ['usadas', 'Mais usadas']];
    body.innerHTML = `
      ${repliesSegment()}
      <div class="busca"><label>${IC.lupa}<input id="busca" placeholder="Pesquisar resposta rápida" value="${esc(uiState.busca)}"></label>
        <button class="icone-btn" id="novaCat" title="Nova categoria">${IC.pastaMais}</button>
        <button class="icone-btn" id="nova" title="Nova resposta" style="background:var(--verde);color:#fff">${IC.mais2}</button></div>
      <div class="chips">${filters.map(([v, t]) => `<button class="chip ${uiState.filtroTipo === v ? 'ativo' : ''}" data-filtro="${v}">${t}</button>`).join('')}</div>
      <div id="listaResp"></div>
      <div class="dica" style="margin-top:12px">💡 Na conversa, digite <code>/</code> + atalho para usar sem tirar a mão do teclado.</div>`;
    const renderList = () => {
      const f = VF.stripAccents(uiState.busca.toLowerCase());
      let list = replies.filter((r) => !f || VF.stripAccents((r.nome + ' ' + (r.atalho || '') + ' ' + (r.pasta || '') + ' ' + replySummary(r)).toLowerCase()).includes(f));
      if (uiState.filtroTipo === 'usadas') list = list.filter((r) => r.usos).sort((a, b) => b.usos - a.usos).slice(0, 15);
      else if (uiState.filtroTipo !== 'tudo') list = list.filter((r) => r.etapas.some((e) => (e.tipo === 'texto' ? 'texto' : e.tipoMidia) === uiState.filtroTipo));
      const target = body.querySelector('#listaResp');
      const noFilter = !f && uiState.filtroTipo === 'tudo';
      if (!replies.length && !(noFilter && categories.length)) {
        target.innerHTML = `<div class="vazio">Você ainda não tem respostas rápidas.<br><br><button class="btn" data-nova>+ Criar a primeira</button></div>`;
        return;
      }
      if (!list.length && !noFilter) return (target.innerHTML = '<div class="vazio">Nada encontrado.</div>');
      const folders = {};
      if (noFilter) categories.forEach((c) => (folders[c] ||= []));
      list.forEach((r) => (folders[r.pasta || 'Sem categoria'] ||= []).push(r));
      // Many categories: start collapsed (only the first open), like the reference design
      if (!uiState.iniciouCategorias) {
        uiState.iniciouCategorias = true;
        const all = [...new Set(replies.map((r) => r.pasta || 'Sem categoria'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        if (all.length > 3) all.slice(1).forEach((p) => uiState.fechadas.add(p));
      }
      const names = uiState.filtroTipo === 'usadas' ? Object.keys(folders) : Object.keys(folders).sort((a, b) => a.localeCompare(b, 'pt-BR'));
      target.classList.toggle('pode-ordenar', noFilter);
      target.innerHTML = names
        .map((p) => {
          const isOpen = f || !uiState.fechadas.has(p);
          return `<div class="categoria ${isOpen ? 'aberta' : ''}">
            <div class="cat-topo" data-pasta="${esc(p)}" role="button"><span class="cat-icone">${IC.categoria}</span><span class="cat-nome">${esc(p)}</span><span class="qtd">${folders[p].length}</span>
              <button class="icone-btn cat-mais" data-catmenu="${esc(p)}" title="Editar categoria">${IC.mais}</button><span class="seta">${IC.seta}</span></div>
            ${isOpen ? (folders[p].length ? folders[p].map((r) => htmlReplyItem(r)).join('') : `<div class="cat-vazia">Categoria vazia. <button class="link-btn" data-novaem="${esc(p)}">+ Adicionar resposta</button></div>`) : ''}</div>`;
        })
        .join('');
    };
    renderList();
    // Holding and dragging a reply changes the order (and, if dropped in another category, changes the category)
    const replyList = body.querySelector('#listaResp');
    dragSort(replyList, '[data-resp]', {
      pode: () => replyList.classList.contains('pode-ordenar') && !uiState.editEnvio,
      sobre: (el, item) => {
        const top = el.closest('.cat-topo');
        if (top && top.parentElement.classList.contains('aberta')) return top.after(item);
        const emptyOne = el.closest('.cat-vazia');
        if (emptyOne) emptyOne.before(item);
      },
      aoSoltar: async (item) => {
        const folder = item.closest('.categoria')?.querySelector('.cat-topo')?.dataset.pasta;
        const order = [...replyList.querySelectorAll('[data-resp]')].map((x) => x.dataset.resp);
        const list = await VF.read('respostas', []);
        const r = list.find((x) => x.id === item.dataset.resp);
        if (r && folder !== undefined) r.pasta = folder === 'Sem categoria' ? '' : folder;
        // Only the ones on screen move; those in collapsed categories stay where they were
        const slots = list.map((x, i) => (order.includes(x.id) ? i : -1)).filter((i) => i >= 0);
        const newOnes = order.map((id) => list.find((x) => x.id === id)).filter(Boolean);
        const final = [...list];
        slots.forEach((i, k) => (final[i] = newOnes[k]));
        replies = final;
        renderList();
        await VF.write('respostas', final);
      },
    });
    body.oninput = (e) => {
      const i = e.target.dataset?.ee;
      const ed = uiState.editEnvio;
      if (i === undefined || !ed) return;
      const et = ed.etapas[Number(i)];
      et.tipo === 'texto' ? (et.texto = e.target.value) : (et.legenda = e.target.value);
    };
    body.onkeydown = (e) => {
      if (!e.target.dataset?.ee) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        uiState.editEnvio = null;
        renderList();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendEdited();
      }
    };
    body.querySelector('#busca').oninput = (e) => {
      uiState.busca = e.target.value;
      renderList();
    };
    body.querySelector('#busca').focus();
    body.onclick = (e) => {
      const catMenu = e.target.closest('[data-catmenu]');
      if (catMenu) return categoryMenu(catMenu, catMenu.dataset.catmenu);
      const newAt = e.target.closest('[data-novaem]');
      if (newAt) return newReplyIn(newAt.dataset.novaem);
      const top = e.target.closest('.cat-topo');
      if (top) {
        const p = top.dataset.pasta;
        uiState.fechadas.has(p) ? uiState.fechadas.delete(p) : uiState.fechadas.add(p);
        return renderList();
      }
      const target = e.target.closest('button');
      if (!target) return;
      if (target.id === 'novaCat') return newCategory();
      if (target.dataset.seg) {
        uiState.seg = target.dataset.seg;
        return renderSidePanel();
      }
      if (target.id === 'nova' || target.hasAttribute('data-nova')) return newReplyIn('');
      if (target.dataset.filtro) {
        uiState.filtroTipo = target.dataset.filtro;
        body.querySelectorAll('[data-filtro]').forEach((c) => c.classList.toggle('ativo', c === target));
        return renderList();
      }
      const r = replies.find((x) => x.id === target.closest('[data-resp]')?.dataset.resp);
      if (!r) return;
      if (target.dataset.acao === 'enviar') return useReply(r, 'enviar');
      if (target.dataset.acao === 'cancelarEnvio') {
        uiState.editEnvio = null;
        return renderList();
      }
      if (target.dataset.acao === 'enviarEditado') return sendEdited();
      if (target.dataset.acao === 'editarEnvio') {
        if (uiState.editEnvio?.id === r.id) {
          uiState.editEnvio = null;
          return renderList();
        }
        return openEditBeforeSend(r).then(() => {
          if (!uiState.editEnvio) return;
          uiState.fechadas.delete(r.pasta || 'Sem categoria');
          renderList();
          const t = body.querySelector('.editar-envio .ee-txt') || body.querySelector('.editar-envio textarea');
          if (t) {
            t.focus();
            t.setSelectionRange(t.value.length, t.value.length);
          }
        });
      }
      if (target.dataset.acao === 'mais') {
        openPop(target, [
          ...(textOnly(r) ? [{ texto: '📝 Colar no campo (para editar)', acao: () => useReply(r, 'colar') }] : []),
          { texto: '✏️ Editar', acao: () => goTo('editar:' + r.id) },
          { texto: '📄 Duplicar', acao: () => duplicateReply(r) },
          { texto: '🗑️ Excluir', perigo: true, acao: () => deleteReply(r) },
        ]);
      }
    };
  };

  // ---- Categories (create, rename, delete right in the list) ----
  const categoryNames = () => [...new Set([...categories, ...replies.map((r) => r.pasta).filter(Boolean)])];
  function newReplyIn(folder) {
    uiState.pastaNova = folder === 'Sem categoria' ? '' : folder;
    goTo('editar:nova');
  }
  async function newCategory() {
    const name = (await askText('Nova categoria', '', { ok: 'Criar', placeholder: 'Ex.: Técnico em Enfermagem, Objeções' })) || '';
    if (!name) return;
    if (categoryNames().some((c) => c.toLowerCase() === name.toLowerCase())) return notify(`A categoria "${name}" já existe.`, 'erro');
    uiState.fechadas.delete(name);
    await VF.write('categorias', [...(await VF.read('categorias', [])), name]);
    notify(`Categoria "${name}" criada. Use o ⋯ dela para adicionar respostas.`, 'ok');
  }
  async function renameCategory(old) {
    const name = (await askText('Renomear categoria', old)) || '';
    if (!name || name === old) return;
    if (categoryNames().some((c) => c !== old && c.toLowerCase() === name.toLowerCase()))
      if (!(await confirm(`Já existe "${name}"\n\nJuntar as duas categorias em uma só?`, { ok: 'Juntar' }))) return;
    const cats = await VF.read('categorias', []);
    await VF.write('categorias', [...new Set(cats.map((c) => (c === old ? name : c)))]);
    const list = await VF.read('respostas', []);
    list.forEach((r) => r.pasta === old && (r.pasta = name));
    if (uiState.fechadas.delete(old)) uiState.fechadas.add(name);
    await VF.write('respostas', list);
  }
  async function deleteCategory(name) {
    const qty = replies.filter((r) => r.pasta === name).length;
    if (!(await confirm(`Excluir a categoria "${name}"?${qty ? `\n\nAs ${qty} respostas dela NÃO são apagadas: vão para "Sem categoria".` : ''}`, { ok: 'Excluir', perigo: true }))) return;
    await VF.write('categorias', (await VF.read('categorias', [])).filter((c) => c !== name));
    if (qty) {
      const list = await VF.read('respostas', []);
      list.forEach((r) => r.pasta === name && (r.pasta = ''));
      await VF.write('respostas', list);
    }
  }
  function categoryMenu(button, name) {
    openPop(button, [
      { texto: '➕ Nova resposta nesta categoria', acao: () => newReplyIn(name) },
      ...(name === 'Sem categoria'
        ? []
        : [
            { texto: '✏️ Renomear categoria', acao: () => renameCategory(name) },
            { texto: '🗑️ Excluir categoria', perigo: true, acao: () => deleteCategory(name) },
          ]),
    ]);
  }

  function htmlEditBeforeSend(ed) {
    const ICM = { audio: '🎤', video: '🎬', image: '🖼️', document: '📄' };
    return `<div class="editar-envio">
      <div class="ee-topo">Editar antes de enviar${ed.contato ? ` para <b>${esc(ed.contato)}</b>` : ''}</div>
      ${ed.etapas
        .map((e, i) =>
          e.tipo === 'texto'
            ? `<textarea class="ee-txt" data-ee="${i}" rows="3" placeholder="(mensagem vazia não é enviada)">${esc(e.texto)}</textarea>`
            : `<div class="ee-arq">${ICM[e.tipoMidia] || '📄'} ${esc(e.nomeArquivo || VF.MEDIA_TYPES[e.tipoMidia])}</div>${
                e.tipoMidia === 'audio' ? '' : `<textarea data-ee="${i}" rows="1" placeholder="Legenda (opcional)">${esc(e.legenda || '')}</textarea>`
              }`
        )
        .join('')}
      <div class="dica">Vale só para este envio — a resposta salva continua igual. <b>Ctrl+Enter</b> envia, <b>Esc</b> cancela.</div>
      <div class="ee-botoes"><button class="btn sec peq" data-acao="cancelarEnvio">Cancelar</button><button class="btn peq" data-acao="enviarEditado">${IC.enviar} Enviar</button></div>
    </div>`;
  }

  function htmlReplyItem(r) {
    const ed = uiState.editEnvio && uiState.editEnvio.id === r.id ? uiState.editEnvio : null;
    return `<div data-resp="${esc(r.id)}" class="resp-arrastavel ${ed ? 'editando' : ''}"><div class="item">
      <span class="tipo">${IC[r.etapas.length > 1 ? 'sequencia' : replyType(r)] || IC.texto}</span>
      <span class="nome" title="${esc(replySummary(r)).slice(0, 300)}">${esc(r.nome)}${r.atalho ? `<code>/${esc(r.atalho)}</code>` : ''}</span>
      <button class="icone-btn" data-acao="mais" title="Mais opções">${IC.mais}</button>
      <button class="icone-btn ${ed ? 'ativo' : ''}" data-acao="editarEnvio" title="Editar antes de enviar">${IC.lapis}</button>
      <button class="icone-btn enviar" data-acao="enviar" title="Enviar na conversa aberta">${IC.enviar}</button>
    </div>${ed ? htmlEditBeforeSend(ed) : ''}</div>`;
  }

  // Opens the inline editor with the text already personalized for the open chat's contact
  async function openEditBeforeSend(r) {
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return notify(e.message, 'erro');
    }
    if (!chat) return notify('Abra uma conversa primeiro.');
    const cfg = await VF.config();
    const data = { nome: nameOf(chat.id, chat.nome), vendedor: cfg.nomeVendedor };
    uiState.editEnvio = {
      id: r.id,
      chatId: chat.id,
      contato: data.nome,
      etapas: JSON.parse(JSON.stringify(r.etapas)).map((e) =>
        e.tipo === 'texto' ? { ...e, texto: VF.buildText(e.texto, data) } : { ...e, legenda: VF.buildText(e.legenda || '', data) }
      ),
    };
  }

  async function sendEdited() {
    const ed = uiState.editEnvio;
    if (!ed) return;
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return notify(e.message, 'erro');
    }
    if (!chat) return notify('Abra uma conversa primeiro.');
    if (chat.id !== ed.chatId && !(await confirm(`Você trocou de conversa\n\nEste texto foi preparado para ${ed.contato || 'outro contato'}. Enviar para ${nameOf(chat.id, chat.nome) || 'a conversa aberta'} mesmo assim?`, { ok: 'Enviar mesmo assim' })))
      return;
    const steps = ed.etapas.filter((e) => e.tipo !== 'texto' || e.texto.trim());
    if (!steps.length) return notify('Não sobrou nenhuma mensagem para enviar.', 'erro');
    uiState.editEnvio = null;
    renderSidePanel();
    const cfg = await VF.config();
    try {
      // The text is ready: variables were replaced when the editor opened
      await sendSteps(chat.id, steps, { nome: nameOf(chat.id, chat.nome), vendedor: cfg.nomeVendedor }, { digitacao: cfg.digitacaoNasRespostas });
      const list = await VF.read('respostas', []);
      const x = list.find((y) => y.id === ed.id);
      if (x) {
        x.usos = (x.usos || 0) + 1;
        await VF.write('respostas', list);
      }
    } catch (e) {
      notify('Não consegui enviar: ' + e.message, 'erro');
    }
  }

  async function duplicateReply(r) {
    const list = await VF.read('respostas', []);
    list.push({ ...JSON.parse(JSON.stringify(r)), id: VF.newId(), nome: r.nome + ' (cópia)', atalho: '', usos: 0 });
    await VF.write('respostas', list);
  }
  async function deleteReply(r) {
    const usedIn = scripts.filter((s) => s.itens.some((it) => it.respostaId === r.id));
    const extra = usedIn.length ? `\n\nEla também sai ${usedIn.length > 1 ? 'dos scripts' : 'do script'}: ${usedIn.map((s) => s.nome).join(', ')}.` : '';
    if (!(await confirm(`Excluir a resposta "${r.nome}"?${extra}`, { ok: 'Excluir', perigo: true }))) return;
    await VF.write('respostas', (await VF.read('respostas', [])).filter((x) => x.id !== r.id));
    if (usedIn.length) {
      const list = await VF.read('scripts', []);
      list.forEach((s) => (s.itens = s.itens.filter((it) => it.respostaId !== r.id)));
      await VF.write('scripts', list);
    }
    VF.cleanOrphanMedia();
  }

  // =====================================================================
  // Scripts: a chain of quick replies sent with one click
  // =====================================================================
  const replyById = (id) => replies.find((x) => x.id === id);
  const validItems = (s) => (s.itens || []).filter((it) => replyById(it.respostaId));
  function scriptDuration(s) {
    const sec = validItems(s).reduce((t, it, j) => t + (j ? Number(it.espera) || 0 : 0) + replyById(it.respostaId).etapas.reduce((a, e, k) => a + (k ? Number(e.espera ?? 2) : 0), 0), 0);
    return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`;
  }
  const scriptSummary = (s) => validItems(s).map((it) => replyById(it.respostaId).nome).join(' → ');
  // Joins the messages of the script's replies into a single sequence (used in bulk send)
  const stepsOfScript = (s) =>
    validItems(s).flatMap((it, j) =>
      JSON.parse(JSON.stringify(replyById(it.respostaId).etapas)).map((e, k) => (k === 0 && j > 0 ? { ...e, espera: Number(it.espera) || 0 } : e))
    );

  let runningScript = null;
  async function useScript(s) {
    if (runningScript) return notify(`Espere o script "${runningScript}" terminar.`);
    const items = validItems(s);
    if (!items.length) return notify('Este script não tem respostas. Edite e adicione.', 'erro');
    let chat;
    try {
      chat = await rpc('chatAtivo');
    } catch (e) {
      return notify(e.message, 'erro');
    }
    if (!chat) return notify('Abra uma conversa primeiro.');
    const cfg = await VF.config();
    const data = { nome: nameOf(chat.id, chat.nome), vendedor: cfg.nomeVendedor };
    runningScript = s.nome;
    notify(`▶ Enviando o script "${s.nome}" (${items.length} respostas) para ${VF.firstName(data.nome) || 'o contato'}…`, 'info', 4000);
    try {
      for (let j = 0; j < items.length; j++) {
        if (j > 0) await VF.sleep(Math.max(0, Number(items[j].espera) || 0) * 1000);
        await sendSteps(chat.id, replyById(items[j].respostaId).etapas, data, { digitacao: cfg.digitacaoNasRespostas });
      }
      notify(`✓ Script "${s.nome}" enviado.`, 'ok');
      const list = await VF.read('scripts', []);
      const x = list.find((y) => y.id === s.id);
      if (x) {
        x.usos = (x.usos || 0) + 1;
        await VF.write('scripts', list);
      }
    } catch (e) {
      notify('O script parou: ' + e.message, 'erro');
    } finally {
      runningScript = null;
    }
  }

  function scriptsScreen(body) {
    body.innerHTML = `
      ${repliesSegment()}
      <div class="dica" style="margin:4px 0 12px">Um script envia várias respostas rápidas em sequência, com um clique. Ex.: Olá → Prazer/MEC → Áudio explicativo.</div>
      <button class="btn" id="novoScript" style="width:100%;margin-bottom:12px">${IC.mais2} Novo script</button>
      ${
        scripts.length
          ? `<div class="categoria aberta" style="border-color:var(--borda)">${scripts
              .map((s) => {
                const isOpen = uiState.previa.has(s.id);
                const items = validItems(s);
                return `<div data-script="${esc(s.id)}"><div class="item">
                  <span class="tipo">${IC.sequencia}</span>
                  <span class="nome"><b style="font-weight:600">${esc(s.nome)}</b>${s.atalho ? `<code>/${esc(s.atalho)}</code>` : ''}
                    <small class="dica" style="display:block">${items.length} resposta${items.length === 1 ? '' : 's'} · ~${scriptDuration(s)}</small></span>
                  <button class="icone-btn" data-acao="mais" title="Mais opções">${IC.mais}</button>
                  <button class="icone-btn" data-acao="ver" title="Ver a sequência">${IC.olho}</button>
                  <button class="icone-btn enviar" data-acao="enviar" title="Enviar na conversa aberta">${IC.enviar}</button>
                </div>${
                  isOpen
                    ? `<div class="previa-resp">${items
                        .map((it, j) => `<div class="arq">${j ? `<small>⏱ ${Number(it.espera) || 0}s</small><br>` : ''}<b>${j + 1}.</b> ${esc(replyById(it.respostaId).nome)}</div>`)
                        .join('')}</div>`
                    : ''
                }</div>`;
              })
              .join('')}</div>`
          : `<div class="vazio">Nenhum script ainda.</div>`
      }
      <div class="dica" style="margin-top:12px">💡 Scripts com atalho também aparecem quando você digita <code>/</code> na conversa.</div>`;
    body.onclick = (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      if (target.dataset.seg) {
        uiState.seg = target.dataset.seg;
        return renderSidePanel();
      }
      if (target.id === 'novoScript') return goTo('script:nova');
      const s = scripts.find((x) => x.id === target.closest('[data-script]')?.dataset.script);
      if (!s) return;
      if (target.dataset.acao === 'enviar') return useScript(s);
      if (target.dataset.acao === 'ver') {
        uiState.previa.has(s.id) ? uiState.previa.delete(s.id) : uiState.previa.add(s.id);
        return scriptsScreen(body);
      }
      if (target.dataset.acao === 'mais') {
        openPop(target, [
          { texto: '✏️ Editar', acao: () => goTo('script:' + s.id) },
          {
            texto: '📄 Duplicar',
            acao: async () => {
              const list = await VF.read('scripts', []);
              list.push({ ...JSON.parse(JSON.stringify(s)), id: VF.newId(), nome: s.nome + ' (cópia)', atalho: '', usos: 0 });
              await VF.write('scripts', list);
            },
          },
          {
            texto: '🗑️ Excluir',
            perigo: true,
            acao: async () => {
              if (!(await confirm(`Excluir o script "${s.nome}"?\n\nAs respostas rápidas usadas nele continuam salvas.`, { ok: 'Excluir', perigo: true }))) return;
              await VF.write('scripts', (await VF.read('scripts', [])).filter((x) => x.id !== s.id));
            },
          },
        ]);
      }
    };
  }

  function editScriptScreen(body, id) {
    const orig = scripts.find((x) => x.id === id);
    const s = orig ? JSON.parse(JSON.stringify(orig)) : { id: VF.newId(), nome: '', atalho: '', itens: [] };
    if (!s.itens.length) s.itens.push({ respostaId: '', espera: 0 });
    const folders = {};
    replies.forEach((r) => (folders[r.pasta || 'Sem categoria'] ||= []).push(r));
    const options = (sel) =>
      `<option value="">Escolha a resposta…</option>` +
      Object.keys(folders)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((p) => `<optgroup label="${esc(p)}">${folders[p].map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}</optgroup>`)
        .join('');
    const currentName = () => body.querySelector('#nomeScript')?.value ?? s.nome;
    const currentShortcut = () => body.querySelector('#atalhoScript')?.value ?? s.atalho;
    function render() {
      const name = currentName();
      const shortcut = currentShortcut();
      body.innerHTML = `
        <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${orig ? 'Editar script' : 'Novo script'}</h2></div>
        <div class="duas">
          <label class="campo">Nome<input type="text" id="nomeScript" value="${esc(name)}" placeholder="Ex.: Abertura técnico"></label>
          <label class="campo">Atalho<input type="text" id="atalhoScript" value="${esc(shortcut || '')}" placeholder="abertura"></label>
        </div>
        <div class="secao-t">Respostas, na ordem de envio</div>
        ${
          replies.length
            ? s.itens
                .map(
                  (it, j) => `${
                    j > 0
                      ? `<div class="espera-script">⏱ esperar <input type="number" min="0" max="600" data-espera="${j}" value="${Number(it.espera) || 0}"> segundos</div>`
                      : ''
                  }<div class="item-script" data-j="${j}">
                    <span class="passo">${j + 1}</span>
                    <select data-resp="${j}">${options(it.respostaId)}</select>
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
    render();
    footerText(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="salvar">Salvar</button>`);
    body.onchange = body.oninput = (e) => {
      const t = e.target;
      if (t.dataset.resp !== undefined) s.itens[Number(t.dataset.resp)].respostaId = t.value;
      if (t.dataset.espera !== undefined) s.itens[Number(t.dataset.espera)].espera = Math.max(0, Number(t.value) || 0);
    };
    body.onclick = (e) => {
      if (e.target.closest('#voltar')) return goTo(null);
      if (e.target.closest('#addItem')) {
        s.itens.push({ respostaId: '', espera: 3 });
        render();
        body.querySelector(`[data-resp="${s.itens.length - 1}"]`)?.focus();
        return;
      }
      const box = e.target.closest('[data-j]');
      if (!box) return;
      const j = Number(box.dataset.j);
      const move = e.target.closest('[data-mover]');
      if (move) {
        const k = j + Number(move.dataset.mover);
        [s.itens[j], s.itens[k]] = [s.itens[k], s.itens[j]];
        render();
      } else if (e.target.closest('[data-tirar]')) {
        s.itens.splice(j, 1);
        if (!s.itens.length) s.itens.push({ respostaId: '', espera: 0 });
        render();
      }
    };
    const ready = () => {
      const items = s.itens.filter((it) => it.respostaId);
      if (!items.length) return notify('Escolha pelo menos uma resposta.', 'erro'), null;
      return items;
    };
    $('#teste').onclick = async () => {
      const items = ready();
      if (!items) return;
      try {
        await sendToMe(stepsOfScript({ itens: items }));
        notify('Script enviado para o seu próprio número. Confira em "Mensagens para mim".', 'ok');
      } catch (er) {
        notify(er.message, 'erro');
      }
    };
    $('#salvar').onclick = async () => {
      const name = currentName().trim();
      const shortcut = currentShortcut().trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
      if (!name) return notify('Dê um nome para o script.', 'erro');
      const items = ready();
      if (!items) return;
      const list = await VF.read('scripts', []);
      if (shortcut && (list.some((x) => x.atalho === shortcut && x.id !== s.id) || replies.some((x) => x.atalho === shortcut)))
        return notify(`O atalho /${shortcut} já está em uso.`, 'erro');
      const updated = { ...s, nome: name, atalho: shortcut, itens: items };
      const i = list.findIndex((x) => x.id === s.id);
      if (i >= 0) list[i] = updated;
      else list.push(updated);
      await VF.write('scripts', list);
      scripts = list;
      notify('Script salvo.', 'ok');
      goTo(null);
    };
  }

  function editReplyScreen(body, id) {
    const r = replies.find((x) => x.id === id) || { id: VF.newId(), nome: '', atalho: '', pasta: uiState.pastaNova || '', etapas: [{ tipo: 'texto', texto: '', espera: 2 }] };
    uiState.pastaNova = '';
    const folders = categoryNames();
    body.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${id === 'nova' ? 'Nova resposta' : 'Editar resposta'}</h2></div>
      <label class="campo">Nome<input type="text" id="nome" value="${esc(r.nome)}" placeholder="Ex.: 1 - Olá / qual seu nome"></label>
      <div class="duas">
        <label class="campo">Categoria<input type="text" id="pasta" list="vfPastas" value="${esc(r.pasta || '')}" placeholder="Ex.: Técnico em Informática">
          <datalist id="vfPastas">${folders.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
        <label class="campo">Atalho<input type="text" id="atalho" value="${esc(r.atalho || '')}" placeholder="ola"></label>
      </div>
      <div class="secao-t">O que enviar</div>
      <div id="etapas"></div>`;
    footerText(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="salvar">Salvar</button>`);
    const editor = StepsEditor(body.querySelector('#etapas'), r.etapas, null, { semPrevia: true });
    body.querySelector('#voltar').onclick = () => goTo(null);
    $('#teste').onclick = async () => {
      const error = editor.validate();
      if (error) return notify(error, 'erro');
      try {
        await sendToMe(editor.value());
        notify('Enviado para o seu próprio número. Confira em "Mensagens para mim".', 'ok');
      } catch (e) {
        notify(e.message, 'erro');
      }
    };
    $('#salvar').onclick = async () => {
      const name = body.querySelector('#nome').value.trim();
      const shortcut = body.querySelector('#atalho').value.trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
      if (!name) return notify('Dê um nome para a resposta.', 'erro');
      const error = editor.validate();
      if (error) return notify(error, 'erro');
      if (!editor.value().length) return notify('Adicione pelo menos uma mensagem.', 'erro');
      const list = await VF.read('respostas', []);
      if (shortcut && (list.some((x) => x.atalho === shortcut && x.id !== r.id) || scripts.some((x) => x.atalho === shortcut)))
        return notify(`O atalho /${shortcut} já está em uso.`, 'erro');
      const newItem = { ...r, nome: name, atalho: shortcut, pasta: body.querySelector('#pasta').value.trim(), etapas: editor.value() };
      const i = list.findIndex((x) => x.id === r.id);
      if (i >= 0) list[i] = newItem;
      else list.push(newItem);
      await VF.write('respostas', list);
      replies = list;
      notify('Resposta salva.', 'ok');
      goTo(null);
    };
  }

  // Up to 3 "templates" (variations) of a message sequence: each lead gets a random one.
  // Used in campaigns and in the tabs' automatic messages.
  function TemplatesEditor(el, initials, options = {}) {
    const MAX = options.max || 3;
    el.innerHTML = '<div class="modelos"></div><div class="modelos-eds"></div>';
    const bar = el.querySelector('.modelos');
    const eds = el.querySelector('.modelos-eds');
    const editors = [];
    let activeIdx = 0;
    function addTemplate(steps) {
      const box = document.createElement('div');
      eds.appendChild(box);
      editors.push({ caixa: box, ed: StepsEditor(box, steps, null, { semPrevia: true }) });
    }
    function render() {
      editors.forEach((m, k) => m.caixa.classList.toggle('oculto', k !== activeIdx));
      bar.innerHTML =
        editors.map((_, k) => `<button type="button" class="modelo ${k === activeIdx ? 'ativo' : ''}" data-modelo="${k}">Modelo ${k + 1}${editors.length > 1 ? `<span class="x" data-tirar-modelo="${k}" title="Remover este modelo">✕</span>` : ''}</button>`).join('') +
        (editors.length < MAX ? `<button type="button" class="add-modelo" data-add-modelo>+ Outro modelo</button>` : '') +
        (editors.length > 1 ? '<span class="dica">sorteado para cada lead</span>' : '');
    }
    (initials && initials.length ? initials : [[{ tipo: 'texto', texto: '', espera: 2 }]]).slice(0, MAX).forEach(addTemplate);
    render();
    bar.addEventListener('click', async (e) => {
      const takeOut = e.target.closest('[data-tirar-modelo]');
      if (takeOut) {
        const k = Number(takeOut.dataset.tirarModelo);
        if (!(await confirm(`Remover o Modelo ${k + 1}?\n\nO texto e os arquivos dele saem desta mensagem.`, { ok: 'Remover', perigo: true }))) return;
        editors[k].caixa.remove();
        editors.splice(k, 1);
        activeIdx = Math.min(activeIdx >= k && activeIdx > 0 ? activeIdx - 1 : activeIdx, editors.length - 1);
        return render();
      }
      if (e.target.closest('[data-add-modelo]')) {
        addTemplate(editors[activeIdx].ed.value()); // starts as a copy of the open template
        activeIdx = editors.length - 1;
        notify(`Modelo ${activeIdx + 1} criado como cópia. Mude o texto para ficar diferente.`, 'info', 5000);
        return render();
      }
      const m = e.target.closest('[data-modelo]');
      if (m) {
        activeIdx = Number(m.dataset.modelo);
        render();
      }
    });
    return {
      validate(prefixo = '') {
        const p = (t) => (prefixo ? prefixo + ': ' : '') + t;
        for (let k = 0; k < editors.length; k++) {
          const error = editors[k].ed.validate();
          if (error) return p(editors.length > 1 ? `Modelo ${k + 1}: ${error}` : error);
          if (editors.length > 1 && !editors[k].ed.value().length) return p(`O Modelo ${k + 1} está vazio. Preencha ou remova (✕).`);
        }
        if (editors.length > 1) {
          const signatures = editors.map((m) => JSON.stringify(m.ed.value()));
          const k = signatures.findIndex((a, j) => signatures.indexOf(a) !== j);
          if (k >= 0) return p(`O Modelo ${k + 1} está igual a outro. Mude o texto ou remova (✕).`);
        }
        return '';
      },
      value: () => editors[activeIdx].ed.value(),
      all: () => editors.map((m) => m.ed.value()),
      set: (steps) => editors[activeIdx].ed.set(steps),
      activeIndex: () => activeIdx,
      count: () => editors.length,
    };
  }

  // "use a quick reply / script" options (campaigns and automations)
  const replyOptions = (first) =>
    `<option value="">${first}</option>${scripts.length ? `<optgroup label="Scripts">${scripts.map((s) => `<option value="s:${esc(s.id)}">🔗 ${esc(s.nome)}</option>`).join('')}</optgroup>` : ''}<optgroup label="Respostas rápidas">${replies.map((r) => `<option value="${esc(r.id)}">⚡ ${esc((r.pasta ? r.pasta + ' › ' : '') + r.nome)}</option>`).join('')}</optgroup>`;
  function stepsOfOption(v) {
    const s = v.startsWith('s:') && scripts.find((x) => x.id === v.slice(2));
    if (s) return stepsOfScript(s);
    const r = replies.find((x) => x.id === v);
    return r ? r.etapas : null;
  }

  async function sendToMe(steps) {
    const me = await rpc('meuId');
    if (!me) throw new Error('Não achei o seu número.');
    const cfg = await VF.config();
    await sendSteps(me, steps, { nome: 'Maria Teste', vendedor: cfg.nomeVendedor }, { digitacao: false });
  }

  // =====================================================================
  // SCREEN: Bulk send
  // =====================================================================
  const STATUS_NAME = { ativa: 'Enviando', pausada: 'Pausada', concluida: 'Concluída', cancelada: 'Cancelada' };
  const CONTACT_NAME = { pendente: 'Na fila', enviando: 'Enviando', enviado: 'Enviado', falhou: 'Falhou', pulado: 'Pulado' };

  async function readCampaigns() {
    const ids = await VF.read('campanhas', []);
    const r = await chrome.storage.local.get(ids.map((id) => 'campanha:' + id));
    return ids.map((id) => r['campanha:' + id]).filter(Boolean);
  }

  function count(c) {
    const n = { total: c.contatos.length, enviado: 0, falhou: 0, pulado: 0, pendente: 0, respondeu: 0 };
    c.contatos.forEach((x) => {
      n[x.status === 'enviando' ? 'pendente' : x.status]++;
      if (x.respondeu) n.respondeu++;
    });
    n.feitos = n.total - n.pendente;
    return n;
  }

  async function setStatus(id, status) {
    const c = await VF.read('campanha:' + id);
    c.status = status;
    c.motivo = '';
    await VF.write('campanha:' + id, c);
    if (status === 'ativa') setTimeout(engineStep, 300);
  }

  async function deleteCampaign(c) {
    const active = ['ativa', 'pausada'].includes(c.status);
    const msg = active
      ? `Excluir a campanha "${c.nome}"?\n\nEla ainda não terminou: o envio para quem está na fila PARA, e o histórico é apagado.`
      : `Excluir a campanha "${c.nome}" e o histórico dela?`;
    if (!(await confirm(msg, { ok: 'Excluir campanha', perigo: true }))) return false;
    await VF.write('campanhas', (await VF.read('campanhas', [])).filter((x) => x !== c.id));
    await VF.remove('campanha:' + c.id);
    VF.cleanOrphanMedia();
    notify('Campanha excluída.', 'ok');
    return true;
  }

  screens.envio = async (body) => {
    if (view === 'nova' || (view && view.startsWith('duplicar:'))) return newCampaignScreen(body, view.startsWith('duplicar:') ? view.slice(9) : null);
    if (view && view.startsWith('campanha:')) return campaignScreen(body, view.slice(9));
    const [campaigns, cfg, todayCount] = await Promise.all([readCampaigns(), VF.config(), VF.sentToday()]);
    const order = campaigns.reverse();
    body.innerHTML = `
      <div class="lat-titulo"><h2>Envio em massa</h2><span class="dica">Hoje: <b>${todayCount}</b>/${cfg.limiteDia}</span></div>
      <button class="btn" id="nova" style="width:100%;margin-bottom:12px">${IC.mais2} Nova campanha</button>
      ${currentStatus.tipo !== 'parado' ? `<div class="ok-box">${esc(statusText())}</div>` : ''}
      ${
        order.length
          ? order
              .map((c) => {
                const n = count(c);
                const pct = n.total ? Math.round((n.feitos / n.total) * 100) : 0;
                return `<div class="cartao" data-camp="${esc(c.id)}" style="cursor:pointer">
                  <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(c.nome)}</b><span class="etq ${c.status}">${STATUS_NAME[c.status]}</span><button class="icone-btn" data-excluir="${esc(c.id)}" title="Excluir campanha">${IC.lixo}</button></div>
                  <div class="progresso"><div style="width:${pct}%"></div></div>
                  <div class="dica">${n.feitos}/${n.total} · ✅ ${n.enviado} · 💬 ${n.respondeu} · ⏭ ${n.pulado} · ❌ ${n.falhou}</div>
                  ${c.motivo && c.status === 'pausada' ? `<div class="dica" style="color:var(--vermelho)">${esc(c.motivo)}</div>` : ''}
                </div>`;
              })
              .join('')
          : `<div class="vazio">Nenhuma campanha ainda.<br>Crie uma para mandar mensagem para vários leads, devagar e em segundo plano.</div>`
      }
      <div class="dica">Ritmo: ${cfg.intervaloMin}–${cfg.intervaloMax}s entre leads, pausa a cada ${cfg.loteTamanho}${cfg.usarHorario ? `, das ${cfg.horaInicio} às ${cfg.horaFim}` : ''}. <button class="link" data-abrir="config">mudar</button></div>`;
    body.onclick = async (e) => {
      if (e.target.closest('#nova')) return goTo('nova');
      const ex = e.target.closest('[data-excluir]');
      if (ex) {
        const target = campaigns.find((x) => x.id === ex.dataset.excluir);
        if (target && (await deleteCampaign(target))) renderSidePanel();
        return;
      }
      const c = e.target.closest('[data-camp]');
      if (c) goTo('campanha:' + c.dataset.camp);
    };
  };

  async function campaignScreen(body, id) {
    const c = await VF.read('campanha:' + id);
    if (!c) return goTo(null);
    const n = count(c);
    const pct = n.total ? Math.round((n.feitos / n.total) * 100) : 0;
    const f = uiState.filtroContatos;
    const visible = c.contatos.filter((x) => f === 'todos' || (f === 'respondeu' ? x.respondeu : x.status === f));
    const notSentYet = c.status === 'concluida' && n.enviado === 0;
    const nTemplates = (c.variacoes || []).length || 1;
    const perTemplate = nTemplates > 1
      ? Array.from({ length: nTemplates }, (_, k) => {
          const fromTemplate = c.contatos.filter((x) => x.modelo === k + 1);
          const env = fromTemplate.filter((x) => x.status === 'enviado').length;
          const reply = fromTemplate.filter((x) => x.respondeu).length;
          return `<div><b>Modelo ${k + 1}</b>: ${env} enviados · ${reply} responderam${env ? ` (${Math.round((reply / env) * 100)}%)` : ''}</div>`;
        }).join('')
      : '';
    body.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${esc(c.nome)}</h2><span class="etq ${c.status}">${STATUS_NAME[c.status]}</span></div>
      ${c.motivo && c.status === 'pausada' ? `<div class="alerta">${esc(c.motivo)}</div>` : ''}
      ${notSentYet ? `<div class="alerta">Nenhuma mensagem foi enviada. Veja abaixo o motivo de cada contato (coluna da direita).</div>` : ''}
      ${c.status === 'ativa' && c.id === currentStatus.campanhaId ? `<div class="ok-box">${esc(statusText())}</div>` : ''}
      <div class="progresso"><div style="width:${pct}%"></div></div>
      <div class="numeros">
        <div><b>${n.enviado}</b><span>enviados</span></div><div><b>${n.respondeu}</b><span>responderam</span></div>
        <div><b>${n.pendente}</b><span>na fila</span></div><div><b>${n.pulado + n.falhou}</b><span>pulados/falhas</span></div>
      </div>
      ${perTemplate ? `<div class="dica" style="margin-top:8px">🔀 ${nTemplates} modelos sorteados:${perTemplate}</div>` : ''}
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
        .map((x) => `<button class="chip ${f === x ? 'ativo' : ''}" data-fc="${x}">${x === 'todos' ? 'Todos' : x === 'respondeu' ? 'Responderam' : CONTACT_NAME[x]}</button>`)
        .join('')}</div>
      <div>${visible
        .slice(0, 500)
        .map(
          (x) => `<div class="contato-linha clicavel" data-abrir-chat="${esc(x.id)}" title="Abrir a conversa no WhatsApp"><div class="cresce"><div>${esc(x.nome || VF.numberFromId(x.id) || x.id.split('@')[0])}${x.respondeu ? ' 💬' : ''}${x.modelo && nTemplates > 1 ? ` <span class="dica">· modelo ${x.modelo}</span>` : ''}</div>
            ${x.erro ? `<small>${esc(x.erro)}</small>` : x.respondeuEm ? `<small>Respondeu ${new Date(x.respondeuEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>` : x.em ? `<small>${new Date(x.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>` : ''}</div>
            <span class="etq ${x.status}">${CONTACT_NAME[x.status] || x.status}</span><span class="abrir-chat">${IC.chat}</span></div>`
        )
        .join('') || '<div class="vazio">Ninguém aqui.</div>'}</div>
      ${visible.length ? '<div class="dica" style="margin-top:6px">Clique em um lead para abrir a conversa dele.</div>' : ''}`;
    body.onclick = async (e) => {
      if (e.target.closest('#voltar')) return goTo(null);
      const fc = e.target.closest('[data-fc]');
      if (fc) {
        uiState.filtroContatos = fc.dataset.fc;
        return renderSidePanel();
      }
      const lin = e.target.closest('[data-abrir-chat]');
      if (lin) {
        lin.classList.add('abrindo');
        try {
          await rpc('abrirChat', lin.dataset.abrirChat);
        } catch (err) {
          notify('Não consegui abrir essa conversa: ' + err.message, 'erro');
        }
        lin.classList.remove('abrindo');
        return;
      }
      const action = e.target.closest('[data-acao]')?.dataset.acao;
      if (!action) return;
      if (action === 'pausar') await setStatus(id, 'pausada');
      if (action === 'retomar') await setStatus(id, 'ativa');
      if (action === 'cancelar' && (await confirm('Cancelar a campanha?\n\nQuem ainda não recebeu não vai receber.', { ok: 'Cancelar envio', cancelar: 'Continuar enviando', perigo: true }))) await setStatus(id, 'cancelada');
      if (action === 'refazer') {
        const current = await VF.read('campanha:' + id);
        current.contatos.forEach((x) => ['falhou', 'pulado'].includes(x.status) && x.erro !== 'Número sem WhatsApp' && !/não receber/.test(x.erro || '') && Object.assign(x, { status: 'pendente', erro: '', ignorarRecente: true }));
        current.status = 'ativa';
        current.motivo = '';
        await VF.write('campanha:' + id, current);
        notify('Voltaram para a fila e o envio recomeçou.', 'ok');
      }
      if (action === 'duplicar') return goTo('duplicar:' + id);
      if (action === 'csv') return downloadCSV(c);
      if (action === 'excluir') {
        if (await deleteCampaign(c)) return goTo(null);
        return;
      }
      renderSidePanel();
    };
  }

  function downloadCSV(c) {
    const lines = [['nome', 'numero', 'situacao', 'respondeu', 'modelo', 'quando', 'observacao']];
    c.contatos.forEach((x) =>
      lines.push([x.nome || '', (x.id.match(/^(\d+)@c\.us$/) || [])[1] || x.id, CONTACT_NAME[x.status] || x.status, x.respondeu ? 'sim' : '', x.modelo || '', x.em ? new Date(x.em).toLocaleString('pt-BR') : '', x.erro || ''])
    );
    const csv = '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `campanha-${c.nome.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
  }

  // Reads a CSV sheet and returns [{ numero, nome }] (finds the separator and columns on its own)
  function readCSV(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return null;
    const sep = [';', ',', '\t'].map((c) => [c, lines[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    const split = (l) => {
      const out = [];
      let cur = '';
      let quoted = false;
      for (const ch of l) {
        if (ch === '"') quoted = !quoted;
        else if (ch === sep && !quoted) (out.push(cur), (cur = ''));
        else cur += ch;
      }
      out.push(cur);
      return out.map((x) => x.trim());
    };
    const rows = lines.map(split);
    const digits = (x) => String(x || '').replace(/\D/g, '').length;
    const hdr = rows[0].map((x) => VF.stripAccents(x.toLowerCase()));
    const hasHeader = !rows[0].some((x) => digits(x) >= 10);
    const data = hasHeader ? rows.slice(1) : rows;
    let iNumber = hasHeader ? hdr.findIndex((c) => /whats|celular|telefone|fone|^tel|numero|phone|mobile/.test(c)) : -1;
    if (iNumber < 0 || !data.some((r) => digits(r[iNumber]) >= 10)) {
      let best = -1;
      let qty = 0;
      const n = Math.max(...data.map((r) => r.length));
      for (let i = 0; i < n; i++) {
        const c = data.filter((r) => digits(r[i]) >= 10 && digits(r[i]) <= 15).length;
        if (c > qty) ((qty = c), (best = i));
      }
      iNumber = best;
    }
    if (iNumber < 0) return null;
    let iName = hasHeader ? hdr.findIndex((c, i) => i !== iNumber && /^(nome|name|primeiro nome|first name|cliente|lead|aluno|contato)/.test(c)) : -1;
    if (iName < 0 && data[0]) iName = data[0].findIndex((x, i) => i !== iNumber && /[a-zà-ú]{2}/i.test(x) && !x.includes('@'));
    return {
      colNumero: hasHeader ? rows[0][iNumber] : 'coluna ' + (iNumber + 1),
      colNome: iName >= 0 ? (hasHeader ? rows[0][iName] : 'coluna ' + (iName + 1)) : '',
      linhas: data.map((r) => ({ numero: r[iNumber] || '', nome: iName >= 0 ? r[iName] || '' : '' })).filter((x) => digits(x.numero) >= 8),
    };
  }

  let campaignDraft = null;
  VF.remove('rascunhoCampanha'); // drafts used to be stored; drop any leftover from older versions

  async function newCampaignScreen(body, baseId) {
    const base = baseId ? await VF.read('campanha:' + baseId) : null;
    // Unsent "new campaign" form is kept as an in-memory draft: survives switching
    // sections, but a page reload / browser restart starts clean on purpose.
    const draft = base ? null : campaignDraft;
    const cfg = await VF.config();
    const manualTabs = tabs;
    const tabOptions = (empty) => `<option value="">${empty}</option>` + manualTabs.map((a) => `<option value="${esc(a.id)}">${esc(a.nome)} (${(a.chats || []).length})</option>`).join('');
    const labelOptions = (empty) => `<option value="">${empty}</option>` + labels.map((e) => `<option value="${esc(e.id)}">${esc(e.nome)} (${e.total})</option>`).join('');
    const labelOps = () => labels.map((e) => ({ id: e.id, nome: e.nome, cor: e.cor, extra: e.total }));
    const groupOps = () => [
      ...labels.map((e) => ({ id: 'e:' + e.id, nome: e.nome, cor: e.cor, grupo: 'Etiquetas do WhatsApp', extra: e.total })),
      ...manualTabs.map((a) => ({ id: 'a:' + a.id, nome: a.nome, cor: a.cor, grupo: 'Abas', extra: (a.chats || []).length })),
    ];

    body.innerHTML = `
      <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>Nova campanha</h2></div>
      <label class="campo">Nome da campanha<input type="text" id="nome" placeholder="Ex.: Black November – leads de outubro" value="${esc(base ? base.nome + ' (2)' : draft ? draft.nome || '' : '')}"></label>

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
        <select id="usarResp" style="margin-bottom:10px"><option value="">✍️ Escrever aqui</option>${scripts.length ? `<optgroup label="Scripts">${scripts.map((s) => `<option value="s:${esc(s.id)}">🔗 ${esc(s.nome)}</option>`).join('')}</optgroup>` : ''}<optgroup label="Respostas rápidas">${replies.map((r) => `<option value="${esc(r.id)}">⚡ ${esc((r.pasta ? r.pasta + ' › ' : '') + r.nome)}</option>`).join('')}</optgroup></select>
        <div id="modelosCamp"></div>
        <div class="dica" style="margin-top:8px">🔀 Crie até 3 modelos diferentes: cada lead recebe um deles, sorteado. Mensagens variadas diminuem o risco de bloqueio.<br>Dica: <code>{Oi|Olá|E aí}</code> sorteia uma opção para cada lead e <code>{primeiro_nome}</code> coloca o nome.</div>
      </div>

      <details class="cartao"><summary>Mais opções (etiquetas, abas e filtros)</summary>
        <div class="secao-t">Depois de enviar</div>
        <div class="duas">
          <label class="campo">Pôr na aba<select id="addAba">${tabOptions('—')}</select></label>
          <label class="campo">Tirar da aba<select id="remAba">${tabOptions('—')}</select></label>
        </div>
        <div class="linha-sel"><span>Colocar etiquetas</span><div id="addEtiq"></div></div>
        <div class="linha-sel"><span>Tirar etiquetas</span><div id="remEtiq"></div></div>
        <div class="secao-t">Se responder</div>
        <div class="duas">
          <label class="campo">Pôr na aba<select id="respAba">${tabOptions('—')}</select></label>
          <label class="campo">Pôr etiqueta<select id="respEtiq">${labelOptions('—')}</select></label>
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
    footerText(`<button class="btn sec" id="teste">Testar em mim</button><button class="btn" id="criar">${IC.play} Começar envio</button>`);

    const q = (s) => body.querySelector(s);
    const initialTemplates = draft && draft.variacoes && draft.variacoes.length ? draft.variacoes : base && base.variacoes && base.variacoes.length ? base.variacoes : [base ? base.etapas : [{ tipo: 'texto', texto: '', espera: 2 }]];
    const editor = TemplatesEditor(q('#modelosCamp'), initialTemplates);
    const qq = (s) => [...body.querySelectorAll(s)];
    let audience = null;
    const selGroups = multiSelector(q('#origemGrupos'), groupOps, [], () => (updateAudience(), saveDraftSoon()), 'Nenhuma escolhida ainda');
    const selAdd = multiSelector(q('#addEtiq'), labelOps, [], () => saveDraftSoon(), '—');
    const selRem = multiSelector(q('#remEtiq'), labelOps, [], () => saveDraftSoon(), '—');
    const selExcluded = multiSelector(q('#exclEtiq'), labelOps, [], () => updateAudience(), '—');

    // Element refs are captured once: a detached form still holds its values, so a
    // pending save works even after the user already switched screens.
    const fields = Object.fromEntries(['nome', 'origem', 'origemLista', 'usarResp', 'addAba', 'remAba', 'respAba', 'respEtiq', 'minDias', 'maxDias', 'recente'].map((id) => [id, q('#' + id)]));
    let draftTimer = null;
    let draftDone = false;
    function draftSnapshot() {
      const v = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
      return { ...v, grupos: selGroups.value(), addEtiquetas: selAdd.value(), removerEtiquetas: selRem.value(), excluirEtiquetas: selExcluded.value(), variacoes: editor.all(), em: Date.now() };
    }
    function saveDraftNow() {
      clearTimeout(draftTimer);
      if (base || draftDone) return;
      campaignDraft = draftSnapshot();
    }
    function saveDraftSoon() {
      if (base || draftDone) return;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraftNow, 400);
    }
    body.onclick = saveDraftSoon; // property, not addEventListener: #corpo is reused by every screen

    if (base) {
      const a = base.acoes || {};
      q('#addAba').value = a.addAba || '';
      q('#remAba').value = a.removerAba || '';
      selAdd.set(a.addEtiquetas);
      selRem.set(a.removerEtiquetas);
      selExcluded.set(base.excluirEtiquetas);
      q('#respAba').value = (base.aoResponder || {}).addAba || '';
      q('#respEtiq').value = (base.aoResponder || {}).addEtiqueta || '';
      const o = base.origem || {};
      if (o.tipo === 'aba' || o.tipo === 'etiqueta') selGroups.set([(o.tipo === 'aba' ? 'a:' : 'e:') + o.valor]);
      if (o.tipo === 'grupos') selGroups.set(o.valores || []);
      if (o.tipo) q('#origem').value = o.tipo === 'aba' || o.tipo === 'etiqueta' ? 'grupos' : o.tipo;
    } else if (draft) {
      for (const [k, el] of Object.entries(fields)) if (k !== 'nome' && draft[k] != null) el.value = draft[k];
      selGroups.set(draft.grupos);
      selAdd.set(draft.addEtiquetas);
      selRem.set(draft.removerEtiquetas);
      selExcluded.set(draft.excluirEtiquetas);
    } else if (!labels.length && !manualTabs.length) {
      q('#origem').value = 'lista';
    }

    // Import sheet (CSV): finds the phone and name columns on its own
    q('#importarCSV').onclick = () => q('#arquivoCSV').click();
    q('#arquivoCSV').onchange = async (e) => {
      const fileEl = e.target.files[0];
      e.target.value = '';
      if (!fileEl) return;
      let text = await fileEl.text();
      if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(await fileEl.arrayBuffer()); // sheet saved in old Excel
      const r = readCSV(text);
      if (!r || !r.linhas.length) return notify('Não achei nenhuma coluna com telefone nessa planilha.', 'erro');
      const ta = q('#origemLista');
      const newOnes = r.linhas.map((x) => x.numero.replace(/[^\d+]/g, '') + (x.nome ? ';' + x.nome.replace(/[;\n]/g, ' ') : '')).join('\n');
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + newOnes;
      notify(`${r.linhas.length} contatos importados de "${fileEl.name}" (telefone: coluna "${r.colNumero}"${r.colNome ? `, nome: coluna "${r.colNome}"` : ''}).`, 'ok', 7000);
      updateAudience();
    };

    async function buildAudience() {
      const source = q('#origem').value;
      const minDays = Number(q('#minDias').value) || 0;
      const maxDays = Number(q('#maxDias').value) || 0;
      const excluded = selExcluded.value();
      const doNotDisturb = await VF.read('naoPerturbe', []);
      const blocked = new Set(doNotDisturb.flatMap((n) => n.ids));
      let candidates = [];
      let chats = null;
      const groups = selGroups.value();
      if (source === 'grupos' && !groups.length) return null;
      if (source === 'lista' && !q('#origemLista').value.trim()) return null;
      const selectedTabs = groups.filter((g) => g.startsWith('a:')).map((g) => g.slice(2));
      const selectedLabels = groups.filter((g) => g.startsWith('e:')).map((g) => g.slice(2));

      let invalid = 0;
      if (source === 'grupos') {
        for (const label of selectedLabels) candidates.push(...(await rpc('listarChats', { etiqueta: label })).map((c) => ({ ...c, ids: [c.id] })));
        if (selectedTabs.length) {
          chats = minDays || maxDays || excluded.length ? await rpc('listarChats', {}) : [];
          const mapping = new Map(chats.map((c) => [c.id, c]));
          for (const tabId of selectedTabs) {
            const tab = tabs.find((a) => a.id === tabId);
            if (!tab) continue;
            candidates.push(
              ...(tab.chats || []).map((c) => {
                const info = c.ids.map((x) => mapping.get(x)).find(Boolean);
                return { id: c.ids.find((x) => x.endsWith('@c.us')) || c.ids[0], ids: c.ids, nome: (info && info.nome) || c.nome, t: info ? info.t : 0, etiquetas: info ? info.etiquetas : [], semInfo: !info };
              })
            );
          }
        }
      } else if (source === 'todas') {
        candidates = (await rpc('listarChats', {})).map((c) => ({ ...c, ids: [c.id] }));
      } else {
        for (const l of q('#origemLista').value.split('\n').map((x) => x.trim()).filter(Boolean)) {
          const [num, ...rest] = l.split(/[;,\t]/);
          const id = VF.idFromNumber(num);
          if (!id) invalid++;
          else candidates.push({ id, ids: [id], nome: rest.join(' ').trim(), t: 0, etiquetas: [], lista: true });
        }
      }
      const now = Date.now();
      const seen = new Set();
      const contacts = [];
      const outside = { bloqueados: 0, filtro: 0, repetidos: 0, invalidos: invalid };
      for (const c of candidates) {
        if (c.ids.some((x) => seen.has(x))) { outside.repetidos++; continue; }
        c.ids.forEach((x) => seen.add(x));
        if (c.ids.some((x) => blocked.has(x))) { outside.bloqueados++; continue; }
        const days = c.t ? (now - c.t * 1000) / 86400000 : null;
        if (!c.lista && !c.semInfo) {
          if (minDays && days !== null && days < minDays) { outside.filtro++; continue; }
          if (maxDays && (days === null || days > maxDays)) { outside.filtro++; continue; }
          if (excluded.length && c.etiquetas.some((e) => excluded.includes(e))) { outside.filtro++; continue; }
        }
        contacts.push({ id: c.id, ids: c.ids, nome: c.nome || '', status: 'pendente', verificado: !c.lista });
      }
      return { contatos: contacts, fora: outside };
    }

    function estimate(qty) {
      const medioSeg = (cfg.intervaloMin + cfg.intervaloMax) / 2 + 10;
      const pauses = Math.floor(qty / cfg.loteTamanho) * ((cfg.pausaLoteMin + cfg.pausaLoteMax) / 2) * 60;
      const hours = (qty * medioSeg + pauses) / 3600;
      const days = Math.ceil(qty / cfg.limiteDia);
      return `⏱ Leva cerca de ${hours < 1 ? Math.max(1, Math.round(hours * 60)) + ' min' : hours.toFixed(1).replace('.', ',') + ' h'}${days > 1 ? ` (${days} dias, pelo limite de ${cfg.limiteDia}/dia)` : ''}. Pode continuar usando o WhatsApp normalmente.`;
    }

    let timer;
    async function updateAudience() {
      const source = q('#origem').value;
      qq('[data-o]').forEach((el) => el.classList.toggle('oculto', el.dataset.o !== source));
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const target = q('#publico');
        if (!target) return; // the user already left this screen
        const estimateEl = q('#estimativa');
        target.textContent = 'Contando…';
        try {
          audience = await buildAudience();
          if (!target.isConnected) return;
          if (!audience) {
            target.textContent = '';
            estimateEl.textContent = '';
            return;
          }
          const outside = audience.fora;
          const reasons = [outside.bloqueados && `${outside.bloqueados} no Não perturbe`, outside.filtro && `${outside.filtro} pelos filtros`, outside.repetidos && `${outside.repetidos} repetidos (estavam em mais de um grupo)`, outside.invalidos && `${outside.invalidos} números inválidos`].filter(Boolean);
          const names = audience.contatos.slice(0, 5).map((c) => c.nome || VF.numberFromId(c.id) || c.id.split('@')[0]);
          target.innerHTML = `<b style="color:var(--verde-txt);font-size:14px">👥 ${audience.contatos.length} lead(s) vão receber</b>
            ${names.length ? `<div>${esc(names.join(', '))}${audience.contatos.length > 5 ? '…' : ''}</div>` : ''}${reasons.length ? `<div>Fora: ${reasons.join(', ')}</div>` : ''}`;
          estimateEl.textContent = audience.contatos.length ? estimate(audience.contatos.length) : '';
        } catch (e) {
          audience = null;
          target.innerHTML = `<span style="color:var(--vermelho)">${esc(e.message)}</span>`;
        }
      }, 400);
    }
    body.oninput = body.onchange = (e) => {
      saveDraftSoon();
      if (e.target.closest('#modelosCamp') || e.target.id === 'nome' || e.target.id === 'usarResp') return;
      if (['addAba', 'remAba', 'respAba', 'respEtiq', 'recente', 'arquivoCSV'].includes(e.target.id)) return;
      updateAudience();
    };
    q('#usarResp').onchange = (e) => {
      const v = e.target.value;
      const s = v.startsWith('s:') && scripts.find((x) => x.id === v.slice(2));
      if (s) return editor.set(stepsOfScript(s));
      const r = replies.find((x) => x.id === v);
      if (r) editor.set(r.etapas);
      saveDraftSoon();
    };
    q('#voltar').onclick = () => (saveDraftNow(), goTo(null));
    updateAudience();

    $('#teste').onclick = async () => {
      const error = editor.validate();
      if (error) return notify(error, 'erro');
      try {
        await sendToMe(editor.value());
        notify(`Teste${editor.count() > 1 ? ` do Modelo ${editor.activeIndex() + 1}` : ''} enviado para você (com o nome "Maria Teste").`, 'ok');
      } catch (e) {
        notify(e.message, 'erro');
      }
    };
    $('#criar').onclick = async () => {
      const name = q('#nome').value.trim() || 'Campanha ' + new Date().toLocaleDateString('pt-BR');
      if (!audience) return notify('Escolha para quem enviar (passo 1).', 'erro');
      if (!audience.contatos.length) return notify('Ninguém para receber com essas opções.', 'erro');
      const error = editor.validate();
      if (error) return notify(error, 'erro');
      const variations = editor.all().filter((v) => v.length);
      const steps = variations[0] || [];
      const actions = {
        addAba: q('#addAba').value,
        removerAba: q('#remAba').value,
        addEtiquetas: selAdd.value(),
        removerEtiquetas: selRem.value(),
      };
      const hasAction = actions.addAba || actions.removerAba || actions.addEtiquetas.length || actions.removerEtiquetas.length;
      if (!steps.length && !hasAction) return notify('Coloque o que enviar (passo 2).', 'erro');
      if (!(await confirm(`Começar a enviar para ${audience.contatos.length} lead(s)?${variations.length > 1 ? `\n\n🔀 ${variations.length} modelos: cada lead recebe um sorteado.` : ''}\n\nO envio é lento de propósito (${cfg.intervaloMin}–${cfg.intervaloMax}s entre cada um) e segue em segundo plano.`, { ok: 'Começar envio' }))) return;
      const source = q('#origem').value;
      const c = {
        id: VF.newId(),
        nome: name,
        criadaEm: Date.now(),
        status: 'ativa',
        motivo: '',
        origem: { tipo: source, valores: source === 'grupos' ? selGroups.value() : [] },
        excluirEtiquetas: selExcluded.value(),
        etapas: steps,
        variacoes: variations.length > 1 ? variations : [],
        acoes: actions,
        aoResponder: { addAba: q('#respAba').value, addEtiqueta: q('#respEtiq').value },
        pularRecenteHoras: Number(q('#recente').value) || 0,
        contatos: audience.contatos,
      };
      draftDone = true;
      clearTimeout(draftTimer);
      campaignDraft = null;
      await VF.write('campanha:' + c.id, c);
      await VF.write('campanhas', [...(await VF.read('campanhas', [])), c.id]);
      // The first message goes out right away (doesn't wait for a previous campaign's interval)
      const engine = await VF.read('motor', { proximoEm: 0, noLote: 0, falhasSeguidas: 0 });
      const otherActive = (await readCampaigns()).some((x) => x.status === 'ativa' && x.id !== c.id);
      if (!otherActive) await VF.write('motor', { ...engine, proximoEm: 0 });
      notify('Campanha criada! A primeira mensagem sai em instantes.', 'ok');
      goTo('campanha:' + c.id);
      setTimeout(engineStep, 300);
    };
  }

  // =====================================================================
  // SCREEN: Tabs
  // =====================================================================
  const COLORS = ['#25d366', '#00bfa5', '#34b7f1', '#3f51b5', '#9c27b0', '#e91e63', '#ff5722', '#f5a623', '#8bc34a', '#607d8b'];

  function tabDescription(a) {
    const n = (a.chats || []).length;
    const et = a.etiquetaId && a.sincronizar ? labels.find((x) => x.id === String(a.etiquetaId)) : null;
    const linked = et ? ` · ligada à etiqueta "${et.nome}"` : '';
    return (n ? `${n} lead${n > 1 ? 's' : ''}` : 'Vazia: abra uma conversa e marque a aba no ícone 👤') + linked;
  }

  async function saveTab(newItem) {
    const list = await VF.read('abas', []);
    const i = list.findIndex((x) => x.id === newItem.id);
    if (i >= 0) list[i] = newItem;
    else list.push(newItem);
    await VF.write('abas', list);
    tabs = list;
    renderPills();
  }

  async function deleteTab(a) {
    if (!(await confirm(`Excluir a aba "${a.nome}"?\n\nOs leads e as conversas continuam no WhatsApp, só a aba some.${automations[a.id] ? '\n\nA sequência automática desta aba também para.' : ''}`, { ok: 'Excluir aba', perigo: true }))) return false;
    if (automations[a.id]) await deleteAutomation(a.id).catch((e) => notify('Sequência automática: ' + e.message, 'erro'));
    tabs = (await VF.read('abas', [])).filter((x) => x.id !== a.id);
    await VF.write('abas', tabs);
    if (selectedTab === a.id) selectTab('todas');
    renderPills();
    if (currentSection === 'abas' && !view) renderSidePanel();
    return true;
  }

  async function renameTab(a) {
    const name = (await askText('Renomear aba', a.nome)) || '';
    if (name && name !== a.nome) await saveTab({ ...a, nome: name });
  }

  screens.abas = async (body) => {
    if (view) return editTabScreen(body, view === 'nova' ? null : view.slice(7).replace(/:auto$/, ''), view.endsWith(':auto'));
    body.innerHTML = `
      <div class="lat-titulo"><h2>Abas</h2><button class="btn peq" id="nova">${IC.mais2} Nova aba</button></div>
      <div class="dica" style="margin-bottom:12px">As abas ficam na barra de cima e separam as conversas. Para mudar a ordem, <b>clique, segure e arraste</b> a aba (aqui ou lá em cima).
        Atalho: clique com o <b>botão direito</b> numa aba lá em cima para renomear, mudar a cor ou excluir.</div>
      ${
        tabs.length
          ? `<div class="abas-lista">${tabs
              .map(
                (a) => `<div class="aba-linha" data-id="${esc(a.id)}" title="Clique para editar · segure e arraste para mudar a ordem">
              <span class="bolinha" style="background:${esc(a.cor || '#25d366')}"></span>
              <div class="cresce"><div class="aba-nome">${esc(a.nome)}</div><div class="dica">${esc(tabDescription(a))}</div></div>
              <button class="icone-btn" data-acao="renomear" title="Renomear">${IC.lapis}</button>
              <button class="icone-btn" data-acao="excluir" title="Excluir aba">${IC.lixo}</button>
            </div>`
              )
              .join('')}</div>`
          : `<div class="vazio">Nenhuma aba ainda.<br>Crie abas para separar os leads, por exemplo "Leads Enfermagem" ou "Matrícula feita".</div>`
      }`;
    body.onclick = async (e) => {
      if (e.target.closest('#nova')) return goTo('nova');
      const line = e.target.closest('[data-id]');
      if (!line) return;
      const a = tabs.find((x) => x.id === line.dataset.id);
      if (!a) return;
      const action = e.target.closest('[data-acao]')?.dataset.acao;
      if (action === 'excluir') return deleteTab(a);
      if (action === 'renomear') return renameTab(a).then(() => renderSidePanel());
      goTo('editar:' + a.id);
    };
    // Holding and dragging the row changes the order
    const tabList = body.querySelector('.abas-lista');
    if (tabList)
      dragSort(tabList, '.aba-linha', {
        aoSoltar: () => saveTabOrder([...tabList.querySelectorAll('.aba-linha')].map((x) => x.dataset.id)),
      });
  };

  async function saveTabOrder(order) {
    const list = await VF.read('abas', []);
    tabs = order.map((id) => list.find((a) => a.id === id)).filter(Boolean).concat(list.filter((a) => !order.includes(a.id)));
    renderPills();
    await VF.write('abas', tabs);
  }

  function editTabScreen(body, id, focusAuto) {
    const orig = id ? tabs.find((x) => x.id === id) : null;
    if (id && !orig) return goTo(null);
    const a = orig ? JSON.parse(JSON.stringify(orig)) : { id: VF.newId(), nome: '', cor: COLORS[tabs.length % COLORS.length], tipo: 'manual', chats: [] };
    // Label link being edited: '' = none; mode 'sincronizar' keeps pulling new contacts, 'copiar' imports once
    let labelId = a.etiquetaId && a.sincronizar ? String(a.etiquetaId) : '';
    let labelMode = 'sincronizar';
    body.innerHTML = '<div id="formAba"></div><div id="autoAba"></div>';
    const tabForm = body.querySelector('#formAba');
    const tabAuto = body.querySelector('#autoAba');
    function render() {
      const name = body.querySelector('#nomeAba')?.value ?? a.nome;
      const free = !COLORS.includes(a.cor);
      tabForm.innerHTML = `
        <div class="lat-titulo"><button class="icone-btn" id="voltar">${IC.voltar}</button><h2>${orig ? 'Editar aba' : 'Nova aba'}</h2></div>
        <label class="campo">Nome da aba<input type="text" id="nomeAba" maxlength="40" value="${esc(name)}" placeholder="Ex.: Leads Enfermagem"></label>
        <div class="campo">Cor
          <div class="cores">${COLORS.map((c) => `<button type="button" class="cor-op ${c === a.cor ? 'sel' : ''}" data-cor="${c}" style="background:${c}"></button>`).join('')}
            <label class="cor-op livre ${free ? 'sel' : ''}" title="Outra cor" style="${free ? 'background:' + esc(a.cor) : ''}">${free ? '' : '+'}<input type="color" id="corLivre" value="${esc(a.cor)}"></label></div>
          <div class="previa-pilula"><span class="pilula ativa" style="border-color:${esc(a.cor)}"><span class="cor" style="background:${esc(a.cor)}"></span>${esc(name || 'Nome da aba')}</span></div>
        </div>
        <label class="campo">Etiqueta do WhatsApp (opcional)<select id="etqAba"><option value="">Nenhuma</option>${labels
          .map((t) => `<option value="${esc(t.id)}" ${labelId === t.id ? 'selected' : ''}>${esc(t.nome)} (${t.total})</option>`)
          .join('')}</select><small>Traz para esta aba quem tem a etiqueta. Você continua podendo adicionar e tirar contatos à mão.</small></label>
        ${
          labelId
            ? `<label class="opcao ${labelMode === 'sincronizar' ? 'sel' : ''}"><input type="radio" name="modoEtq" value="sincronizar" ${labelMode === 'sincronizar' ? 'checked' : ''}>
                <div><b>Manter sincronizada</b><small>Quem receber a etiqueta depois entra sozinho nesta aba.</small></div></label>
              <label class="opcao ${labelMode === 'copiar' ? 'sel' : ''}"><input type="radio" name="modoEtq" value="copiar" ${labelMode === 'copiar' ? 'checked' : ''}>
                <div><b>Copiar uma vez</b><small>Traz quem tem a etiqueta agora. Depois a aba não puxa mais ninguém sozinha.</small></div></label>`
            : ''
        }
        ${
          (a.chats || []).length
            ? `<div class="secao-t">Leads nesta aba (${a.chats.length})</div>${a.chats
                .map((c, j) => `<div class="contato-linha"><div class="cresce"><div>${esc(c.nome || VF.numberFromId(c.ids.find((x) => x.endsWith('@c.us'))) || c.ids[0])}</div></div><button class="link" data-tirar="${j}">tirar</button></div>`)
                .join('')}`
            : ''
        }`;
    }
    render();
    const edAuto = AutomationEditor(tabAuto, a);
    if (focusAuto) {
      edAuto.abrir();
      setTimeout(() => tabAuto.scrollIntoView({ block: 'start' }), 50);
    }
    footerText(`${orig ? `<button class="btn perigo" id="excluirAba">Excluir aba</button>` : ''}<button class="btn" id="salvarAba">Salvar</button>`);
    body.oninput = (e) => {
      if (e.target.closest('#autoAba')) return;
      if (e.target.id === 'nomeAba') {
        const p = body.querySelector('.previa-pilula .pilula');
        p.lastChild.textContent = e.target.value || 'Nome da aba';
      }
      if (e.target.id === 'corLivre') {
        a.cor = e.target.value;
        const p = body.querySelector('.previa-pilula .pilula');
        p.style.borderColor = a.cor;
        p.querySelector('.cor').style.background = a.cor;
      }
    };
    body.onchange = (e) => {
      if (e.target.closest('#autoAba')) return;
      if (e.target.id === 'etqAba') {
        labelId = e.target.value;
        render();
      }
      if (e.target.name === 'modoEtq') {
        labelMode = e.target.value;
        render();
      }
      if (e.target.id === 'corLivre') render();
    };
    body.onclick = (e) => {
      if (e.target.closest('#voltar')) return goTo(null);
      const c = e.target.closest('[data-cor]');
      if (c) {
        a.cor = c.dataset.cor;
        return render();
      }
      const t = e.target.closest('[data-tirar]');
      if (t) {
        a.chats.splice(Number(t.dataset.tirar), 1);
        render();
      }
    };
    if (orig) $('#excluirAba').onclick = async () => (await deleteTab(orig)) && goTo(null);
    $('#salvarAba').onclick = async () => {
      a.nome = body.querySelector('#nomeAba').value.trim();
      if (!a.nome) return notify('Dê um nome para a aba.', 'erro');
      const autoAction = edAuto.acao();
      if (autoAction === 'salvar') {
        const error = edAuto.validate();
        if (error) return notify(error, 'erro');
      }
      const button = $('#salvarAba');
      button.disabled = true;
      let imported = 0;
      a.tipo = 'manual';
      if (labelId) {
        const relinked = String(a.etiquetaId || '') !== labelId;
        a.etiquetaId = labelId;
        if (relinked) a.importados = [];
        try {
          imported = await importFromLabel(a);
        } catch (e) {
          button.disabled = false;
          return notify('Não consegui ler a etiqueta: ' + e.message, 'erro');
        }
      }
      if (labelId && labelMode === 'sincronizar') a.sincronizar = true;
      else {
        delete a.etiquetaId;
        delete a.sincronizar;
        delete a.importados;
      }
      await saveTab(a);
      try {
        if (autoAction === 'salvar') await saveAutomation(a, edAuto.value(), edAuto.nova);
        if (autoAction === 'apagar') await deleteAutomation(a.id);
      } catch (e) {
        button.disabled = false;
        return notify('A aba foi salva, mas a sequência automática não: ' + e.message, 'erro', 9000);
      }
      if (selectedTab === a.id) selectTab(a.id);
      const fromLabel = imported ? ` ${imported} contato${imported > 1 ? 's' : ''} da etiqueta entr${imported > 1 ? 'aram' : 'ou'}.` : '';
      notify((orig ? 'Aba salva.' : `Aba "${a.nome}" criada.`) + (fromLabel || (orig || labelId ? '' : ' Abra uma conversa e marque a aba no ícone 👤.')), 'ok');
      goTo(null);
    };
    if (!orig) body.querySelector('#nomeAba').focus();
  }

  // =====================================================================
  // KANBAN + AUTOMATIC SEQUENCE ON THE SERVER
  // "Picked by me" tabs become columns. Each tab can have a sequence
  // of messages the server sends on its own (even with the computer off).
  // =====================================================================
  let server = { chave: '' };
  let automations = {}; // { abaId: { ativa, passos: [{ espera: { n, unidade }, variacoes: [[etapas]] }], aoResponder, aoTerminar } }
  let kanban = { inscricoes: [], whatsapp: null, atualizado: 0, erro: '' };
  let kanbanOpen = false;
  let draggingCard = false;
  const serverOn = () => !!server.chave;
  // Key to compare numbers (ignores the 9th digit of Brazilian mobiles)
  const numberKey = (s) => {
    let d = String(s || '').split('@')[0].replace(/\D/g, '');
    if (d.startsWith('55') && d.length === 13 && d[4] === '9') d = d.slice(0, 4) + d.slice(5);
    return d;
  };
  const kanbanColumns = () => tabs;
  const UNITS = { min: 'minutos', h: 'horas', d: 'dias' };

  async function api(method, path, body) {
    const r = await chrome.runtime.sendMessage({ tipo: 'api', metodo: method, caminho: path, corpo: body });
    if (!r) throw new Error('A extensão não respondeu. Recarregue a página.');
    if (r.erro) throw new Error(r.erro);
    return r.dados;
  }

  async function leadNumber(ids) {
    let c = ids.find((x) => x.endsWith('@c.us'));
    for (const x of ids) {
      if (c) break;
      c = (await equivalents(x)).find((y) => y.endsWith('@c.us'));
    }
    return c ? c.split('@')[0] : '';
  }

  function subscriptionOf(tabId, ids) {
    const ks = new Set(ids.map(numberKey));
    return kanban.inscricoes.find((i) => i.abaId === tabId && (ks.has(numberKey(i.numero)) || (i.ids || []).some((x) => ks.has(numberKey(x)))));
  }

  async function buildEntries(tabId, chats) {
    const list = [];
    let noNumber = 0;
    for (const c of chats) {
      const number = await leadNumber(c.ids);
      if (!number) noNumber++;
      // em = when it entered the tab (no date = old: the server doesn't restart whoever already finished/replied)
      else list.push({ abaId: tabId, numero: number, ids: c.ids, nome: nameOf(c.ids, c.nome), em: c.em || 0 });
    }
    if (noNumber) notify(`${noNumber} lead(s) sem número de telefone visível ficaram fora da sequência automática.`, 'erro', 7000);
    return list;
  }

  // Lead entered/left a tab with automatic sequence -> tells the server
  async function reportTabChanges(before, after) {
    if (!serverOn()) return;
    const mapping = new Map((before || []).map((a) => [a.id, a]));
    const newItems = [];
    const leave = [];
    for (const a of after || []) {
      if (!automations[a.id]) continue;
      const oldOnes = (mapping.get(a.id) || {}).chats || [];
      const currentOnes = a.chats || [];
      currentOnes.forEach((c) => !oldOnes.some((v) => v.ids.some((x) => c.ids.includes(x))) && newItems.push([a.id, c]));
      for (const v of oldOnes) if (!currentOnes.some((c) => c.ids.some((x) => v.ids.includes(x)))) leave.push({ abaId: a.id, numero: await leadNumber(v.ids) });
    }
    if (!newItems.length && !leave.length) return;
    const enter = [];
    for (const [tabId, c] of newItems) enter.push(...(await buildEntries(tabId, [c])));
    const bundle = { entrar: enter, sair: leave.filter((x) => x.numero) };
    try {
      await api('POST', '/leads/mudancas', bundle);
      setTimeout(syncKanban, 1500);
    } catch (e) {
      // No internet/server down: keep it and retry on the next sync
      const queue = await VF.read('kanbanFila', { entrar: [], sair: [] });
      await VF.write('kanbanFila', { entrar: [...queue.entrar, ...bundle.entrar], sair: [...queue.sair, ...bundle.sair] });
    }
  }

  async function applyMoves(items) {
    const list = await VF.read('abas', []);
    const done = [];
    for (const i of items) {
      const from = list.find((a) => a.id === i.abaId);
      const to = list.find((a) => a.id === i.moverPara);
      const ks = new Set([i.numero, ...(i.ids || [])].map(numberKey));
      const matches = (c) => c.ids.some((x) => ks.has(numberKey(x)));
      const chat = (from && (from.chats || []).find(matches)) || { ids: i.ids && i.ids.length ? i.ids : [i.numero + '@c.us'], nome: i.nome };
      if (from) from.chats = (from.chats || []).filter((c) => !matches(c));
      if (to && !(to.chats || []).some(matches)) (to.chats = to.chats || []).push({ ids: chat.ids, nome: chat.nome || i.nome || '', em: Date.now() });
      done.push({ abaId: i.abaId, numero: i.numero });
      if (to) notify(`💬 ${chat.nome || i.nome || 'Um lead'} respondeu e foi para "${to.nome}".`, 'ok', 8000);
    }
    await VF.write('abas', list);
    await api('POST', '/mover-ok', { itens: done }).catch(() => {});
  }

  async function mergeDoNotDisturb(fromServer) {
    if (!fromServer || !fromServer.length) return;
    const list = await VF.read('naoPerturbe', []);
    let touched = false;
    for (const n of fromServer) {
      if (list.some((x) => x.ids.some((y) => numberKey(y) === numberKey(n.numero)))) continue;
      const d = n.numero;
      const ids = [d + '@c.us'];
      if (d.startsWith('55') && d.length === 12) ids.push(d.slice(0, 4) + '9' + d.slice(4) + '@c.us');
      list.push({ ids, nome: '', texto: n.texto || '', em: n.em || Date.now() });
      touched = true;
    }
    if (touched) await VF.write('naoPerturbe', list);
  }

  let syncing = false;
  async function syncKanban() {
    if (!serverOn() || syncing) return;
    syncing = true;
    try {
      const queue = await VF.read('kanbanFila', null);
      if (queue && (queue.entrar.length || queue.sair.length)) {
        await api('POST', '/leads/mudancas', queue);
        await VF.remove('kanbanFila');
      }
      const s = await api('GET', '/sync');
      kanban = { ...s, atualizado: Date.now(), erro: '' };
      const move = s.inscricoes.filter((i) => i.moverPara);
      if (move.length) await applyMoves(move);
      await mergeDoNotDisturb(s.naoPerturbe);
    } catch (e) {
      kanban.erro = e.message;
    }
    syncing = false;
    if (kanbanOpen && !draggingCard) renderKanban();
  }

  async function loadServer() {
    server = await VF.read('servidor', { chave: '' });
    automations = await VF.read('automacoes', {});
    if (serverOn() && !Object.keys(automations).length) {
      // Reinstalled extension / another computer: brings the sequences from the server
      try {
        const list = await api('GET', '/automacoes');
        list.forEach((a) => (automations[a.abaId] = { ativa: a.ativa, passos: a.passos, aoResponder: a.aoResponder, aoTerminar: a.aoTerminar }));
        if (list.length) await VF.write('automacoes', automations);
      } catch (e) { /* server down */ }
    }
    syncKanban();
  }

  async function saveAutomation(tab, v, newNow) {
    const ids = [...new Set([...JSON.stringify(v.passos).matchAll(/"midiaId":"([^"]+)"/g)].map((m) => m[1]))];
    if (ids.length) {
      const { faltando: missingOnes } = await api('POST', '/midias/faltando', { ids });
      if (missingOnes.length) notify(`Enviando ${missingOnes.length} arquivo(s) para o servidor…`, 'info', 4000);
      for (const id of missingOnes) {
        const dataUrl = await VF.readMedia(id);
        if (!dataUrl) throw new Error('Um arquivo da sequência sumiu. Escolha o arquivo de novo.');
        await api('POST', '/midias', { id, dataUrl });
      }
    }
    await api('PUT', '/automacoes/' + tab.id, { nome: tab.nome, ...v });
    automations = { ...(await VF.read('automacoes', {})), [tab.id]: v };
    await VF.write('automacoes', automations);
    const n = (tab.chats || []).length;
    const allItems =
      newNow && v.ativa && n &&
      (await dialog({
        titulo: `E quem já está em "${tab.nome}"?`,
        texto: `Já tem ${n} lead(s) nesta aba. A sequência pode valer para eles também ou só para quem entrar daqui pra frente.`,
        opcoes: [
          { valor: false, texto: 'Só os novos', tipo: 'sec', cancela: true },
          { valor: true, texto: `Incluir os ${n}`, tipo: 'principal', foco: true },
        ],
      }));
    if (allItems) {
      const enter = await buildEntries(tab.id, tab.chats);
      await api('POST', '/leads/mudancas', { entrar: enter.map((x) => ({ ...x, em: Date.now() })) });
      notify(`${enter.length} lead(s) entraram na sequência.`, 'ok');
    }
    syncKanban();
  }

  async function deleteAutomation(tabId) {
    if (serverOn()) await api('DELETE', '/automacoes/' + tabId);
    automations = await VF.read('automacoes', {});
    delete automations[tabId];
    await VF.write('automacoes', automations);
    syncKanban();
  }

  // ---- status texts ----
  function when(ts) {
    if (!ts || ts <= Date.now() + 60000) return 'agora';
    const d = new Date(ts);
    const hour = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const day = (x) => new Date(x).toDateString();
    if (day(ts) === day(Date.now())) return 'hoje ' + hour;
    if (day(ts) === day(Date.now() + 86400000)) return 'amanhã ' + hour;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hour;
  }
  function howLongAgo(ts) {
    if (!ts) return '';
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 60) return `há ${m} min`;
    if (m < 1440) return `há ${Math.round(m / 60)} h`;
    const d = Math.round(m / 1440);
    return `há ${d} dia${d > 1 ? 's' : ''}`;
  }
  function subscriptionBadge(i, tabId) {
    if (!i) return '';
    const total = ((automations[tabId] || {}).passos || []).length || '?';
    const t = {
      ativo: [`⏳ Mensagem ${i.passo + 1}/${total} · ${when(i.proximoEm)}`, 'ativo'],
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

  // ---- Kanban board (big screen, on top of WhatsApp) ----
  function openKanban() {
    kanbanOpen = true;
    closeSidePanel();
    $('#kanban').classList.remove('oculto');
    renderKanban();
    syncKanban();
  }
  function closeKanban() {
    kanbanOpen = false;
    $('#kanban').classList.add('oculto');
  }

  function renderKanban() {
    const el = $('#kanban');
    const search = VF.stripAccents((uiState.buscaKanban || '').toLowerCase());
    const wa = kanban.whatsapp;
    const statusServ = !serverOn()
      ? `<button class="kstatus off" data-k="servidor">⚪ Sequências automáticas desligadas · conectar servidor</button>`
      : kanban.erro
        ? `<button class="kstatus erro" data-k="servidor" title="${esc(kanban.erro)}">🔴 Servidor fora do ar</button>`
        : wa && wa.estado === 'open'
          ? `<button class="kstatus ok" data-k="servidor">🟢 Servidor enviando · ${esc(VF.numberFromId((wa.numero || '') + '@c.us') || wa.numero)} · hoje ${kanban.enviosHoje || 0}/${(kanban.config || {}).limiteDia || '?'}${kanban.dentroDoHorario === false ? ' · fora do horário' : ''}</button>`
          : `<button class="kstatus erro" data-k="servidor">🟠 WhatsApp do servidor desconectado · conectar</button>`;
    const cols = kanbanColumns();
    const scroll = el.querySelector('.kcolunas') ? el.querySelector('.kcolunas').scrollLeft : 0;
    el.innerHTML = `
      <div class="ktopo">
        <h2>Kanban</h2>
        <input type="text" id="kbusca" placeholder="Buscar lead…" value="${esc(uiState.buscaKanban || '')}">
        ${statusServ}
        <span class="cresce"></span>
        <button class="btn sec peq" data-k="novaColuna">${IC.mais2} Nova coluna</button>
        <button class="icone-btn" data-k="fechar" title="Fechar (Esc)">${IC.fechar}</button>
      </div>
      <div class="kcolunas">${
        cols.length
          ? cols
              .map((a) => {
                const auto = automations[a.id];
                let chats = [...(a.chats || [])].map((c, idx) => ({ c, idx })).sort((x, y) => (y.c.em || 0) - (x.c.em || 0));
                if (search) chats = chats.filter(({ c }) => VF.stripAccents((nameOf(c.ids, c.nome) + ' ' + c.ids.join(' ')).toLowerCase()).includes(search));
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
                    const name = nameOf(c.ids, c.nome) || VF.numberFromId(c.ids.find((x) => x.endsWith('@c.us'))) || c.ids[0].split('@')[0];
                    const num = VF.numberFromId(c.ids.find((x) => x.endsWith('@c.us')));
                    return `<div class="kcard" draggable="true" data-aba="${esc(a.id)}" data-i="${idx}" title="Clique para abrir a conversa · arraste para mudar de coluna">
                      <div class="kcard-nome">${esc(name)}</div>
                      <div class="kcard-sub">${esc([num !== name && num, howLongAgo(c.em)].filter(Boolean).join(' · '))}</div>
                      ${auto ? subscriptionBadge(subscriptionOf(a.id, c.ids), a.id) : ''}
                      <button class="kmenu icone-btn" data-k="menu" title="Opções">${IC.mais}</button>
                    </div>`;
                  })
                  .join('') + (chats.length > LIM ? `<div class="dica" style="padding:6px">…e mais ${chats.length - LIM}. Use a busca.</div>` : '') || `<div class="kvazio">${search ? 'Nada encontrado' : 'Arraste leads para cá'}</div>`
              }</div></div>`;
              })
              .join('')
          : `<div class="vazio" style="margin:40px auto">Nenhuma coluna ainda. Clique em <b>Nova coluna</b> (cada coluna é uma aba).</div>`
      }</div>`;
    el.querySelector('.kcolunas').scrollLeft = scroll;
  }

  async function moveBetweenTabs(fromId, toId, idx) {
    if (fromId === toId) return;
    const list = await VF.read('abas', []);
    const from = list.find((a) => a.id === fromId);
    const to = list.find((a) => a.id === toId);
    const chat = from && (from.chats || [])[idx];
    if (!chat || !to) return;
    from.chats = from.chats.filter((c) => !c.ids.some((x) => chat.ids.includes(x)));
    to.chats = (to.chats || []).filter((c) => !c.ids.some((x) => chat.ids.includes(x)));
    to.chats.push({ ...chat, em: Date.now() });
    tabs = list;
    if (kanbanOpen) renderKanban();
    await VF.write('abas', list);
    const auto = automations[toId];
    if (auto && auto.ativa && serverOn()) {
      const p0 = auto.passos[0] || {};
      const delay = Number((p0.espera || {}).n) || 0;
      notify(`${nameOf(chat.ids, chat.nome) || 'Lead'} entrou em "${to.nome}": a 1ª mensagem automática sai ${delay ? `em ${delay} ${UNITS[p0.espera.unidade]}` : 'em instantes'} (no horário de envio).`, 'ok', 7000);
    }
  }

  function cardMenu(button, tabId, idx) {
    const tab = tabs.find((a) => a.id === tabId);
    const chat = tab && (tab.chats || [])[idx];
    if (!chat) return;
    const subscription = subscriptionOf(tabId, chat.ids);
    const name = nameOf(chat.ids, chat.nome);
    const serverAction = (action, msg) => async () => {
      try {
        await api('POST', '/leads/acao', { abaId: tabId, numero: subscription ? subscription.numero : await leadNumber(chat.ids), acao: action, ids: chat.ids, nome: name });
        notify(msg, 'ok');
        syncKanban();
      } catch (e) {
        notify(e.message, 'erro');
      }
    };
    const items = [{ texto: '💬 Abrir conversa', acao: () => openChatFromKanban(chat) }];
    if (automations[tabId] && serverOn()) {
      if (subscription && subscription.estado === 'ativo') {
        items.push({ texto: '⏩ Enviar a próxima mensagem agora', acao: serverAction('agora', 'A próxima mensagem sai em instantes (respeitando o horário e o intervalo).') });
        items.push({ texto: '⏹ Parar a sequência deste lead', acao: serverAction('parar', 'Sequência parada para este lead.') });
      }
      items.push({ texto: '↺ Recomeçar a sequência do início', acao: serverAction('recomecar', 'A sequência recomeçou do início.') });
    }
    items.push({
      texto: 'Tirar desta coluna',
      perigo: true,
      acao: async () => {
        await changeTab(tabId, chat.ids, name, false);
        notify(`${name || 'Lead'} saiu de "${tab.nome}".`, 'info', 7000, { texto: 'Desfazer', fn: () => returnToTab(tabId, chat) });
      },
    });
    openPop(button, items);
  }

  // Undo "take out of column": puts it back with the original date (the sequence continues where it stopped)
  async function returnToTab(tabId, chat) {
    const list = await VF.read('abas', []);
    const tab = list.find((a) => a.id === tabId);
    if (!tab) return;
    tab.chats = (tab.chats || []).filter((x) => !x.ids.some((y) => chat.ids.includes(y)));
    tab.chats.push({ ...chat, em: chat.em || 0 });
    await VF.write('abas', list);
  }

  async function openChatFromKanban(chat) {
    const id = chat.ids.find((x) => x.endsWith('@c.us')) || chat.ids[0];
    try {
      await rpc('abrirChat', id);
      closeKanban();
    } catch (e) {
      notify('Não consegui abrir essa conversa: ' + e.message, 'erro');
    }
  }

  function bindKanbanEvents() {
    const el = $('#kanban');
    el.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-k]');
      const card = e.target.closest('.kcard');
      if (k && k.dataset.k === 'fechar') return closeKanban();
      if (k && k.dataset.k === 'servidor') return closeKanban(), openSidePanel('kanban');
      if (k && k.dataset.k === 'novaColuna') return closeKanban(), openSidePanel('abas', 'nova');
      if (k && k.dataset.k === 'auto') return closeKanban(), openSidePanel('abas', 'editar:' + k.dataset.aba + ':auto');
      if (k && k.dataset.k === 'menu' && card) return cardMenu(k, card.dataset.aba, Number(card.dataset.i));
      if (card) {
        const tab = tabs.find((a) => a.id === card.dataset.aba);
        const chat = tab && tab.chats[Number(card.dataset.i)];
        if (chat) openChatFromKanban(chat);
      }
    });
    el.addEventListener('input', (e) => {
      if (e.target.id !== 'kbusca') return;
      uiState.buscaKanban = e.target.value;
      const pos = e.target.selectionStart;
      renderKanban();
      const b = el.querySelector('#kbusca');
      b.focus();
      b.setSelectionRange(pos, pos);
    });
    // Drag cards between columns
    el.addEventListener('dragstart', (e) => {
      const card = e.target.closest && e.target.closest('.kcard');
      if (!card) return;
      draggingCard = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.aba + '|' + card.dataset.i);
      setTimeout(() => card.classList.add('arrastando'), 0);
    });
    el.addEventListener('dragend', (e) => {
      draggingCard = false;
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
      draggingCard = false;
      const [from, i] = (e.dataTransfer.getData('text/plain') || '').split('|');
      col.classList.remove('alvo');
      if (from) moveBetweenTabs(from, col.dataset.col, Number(i));
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && kanbanOpen && closeKanban());
  }

  // ---- Automatic sequence editor (inside the tab screen) ----
  function AutomationEditor(el, tab) {
    const orig = automations[tab.id] || null;
    let enabled = orig ? !!orig.ativa : true;
    const stages = [];
    const others = () => kanbanColumns().filter((x) => x.id !== tab.id);
    const tabOptions = (sel, empty) => `<option value="">${empty}</option>` + others().map((x) => `<option value="${esc(x.id)}" ${sel === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('');
    const n = (state) => kanban.inscricoes.filter((i) => i.abaId === tab.id && i.estado === state).length;
    el.innerHTML = `
      <div class="cartao auto-cartao" id="autoCartao">
        <h3>${IC.raio} Sequência automática <span class="dica">(o servidor envia)</span></h3>
        ${
          !serverOn()
            ? `<div class="dica">Quem entrar nesta aba pode receber mensagens sozinho (ex.: remarketing em 1, 3 e 7 dias), mesmo com o computador desligado.<br><br>Para usar, conecte o servidor primeiro: ícone <b>Kanban</b> no menu da esquerda › <b>Chave de acesso</b>.</div>
               <button type="button" class="btn sec peq" id="autoConectar" style="margin-top:8px">Conectar servidor</button>`
            : !orig
              ? `<div class="dica">Quem entrar nesta aba recebe as mensagens sozinho, no horário de envio, mesmo com o computador desligado. Se o lead responder, a sequência para.</div>
                 <button type="button" class="btn peq" id="autoCriar" style="margin-top:8px">${IC.mais2} Criar sequência automática</button>`
              : ''
        }
        <div id="autoForm" class="${serverOn() && orig ? '' : 'oculto'}">
          <label class="check"><input type="checkbox" id="autoLigada" ${enabled ? 'checked' : ''}> <b>Ligada</b>&nbsp;<span class="dica">(desligada = ninguém recebe; quem estava no meio fica pausado)</span></label>
          ${orig ? `<div class="dica" style="margin-bottom:8px">Agora: ⏳ ${n('ativo')} na sequência · 💬 ${n('respondeu')} responderam · ✅ ${n('concluido')} concluíram${n('falhou') ? ` · ⚠️ ${n('falhou')} com erro` : ''}</div>` : ''}
          <div id="autoPassos"></div>
          <button type="button" class="btn sec peq" id="autoAddPasso" style="width:100%;margin:4px 0 12px">${IC.mais2} Adicionar mensagem</button>
          <div class="duas">
            <label class="campo">Se responder: parar e mover para<select id="autoResp">${tabOptions((orig && orig.aoResponder || {}).moverPara, '— só parar')}</select></label>
            <label class="campo">Se terminar sem resposta: mover para<select id="autoFim">${tabOptions((orig && orig.aoTerminar || {}).moverPara, '— deixar aqui')}</select></label>
          </div>
          <div class="dica">Envio só no horário e no ritmo do servidor (ícone Kanban › Ritmo). Quem escrever "SAIR" não recebe mais.</div>
          ${orig ? '<button type="button" class="link" id="autoApagar" style="color:var(--vermelho);margin-top:8px">Apagar a sequência desta aba</button>' : ''}
        </div>
      </div>`;
    let exists = !!orig;
    let remove = false;
    const stepsBox = el.querySelector('#autoPassos');
    function renumber() {
      stages.forEach((p, i) => {
        p.caixa.querySelector('.passo-n').textContent = `Mensagem ${i + 1}`;
        p.caixa.querySelector('.passo-depois').textContent = i === 0 ? 'depois de entrar na aba' : 'depois da mensagem anterior';
      });
    }
    function addStep(p) {
      const box = document.createElement('div');
      box.className = 'passo-auto';
      const wait = p.espera || { n: stages.length ? 1 : 0, unidade: stages.length ? 'd' : 'min' };
      box.innerHTML = `
        <div class="passo-topo"><b class="passo-n"></b><span class="cresce"></span><button type="button" class="icone-btn" data-tirar-passo title="Remover esta mensagem">${IC.lixo}</button></div>
        <div class="passo-espera">Enviar <input type="number" min="0" max="999" class="esp-n" value="${Number(wait.n) || 0}">
          <select class="esp-u">${Object.entries(UNITS).map(([v, t]) => `<option value="${v}" ${wait.unidade === v ? 'selected' : ''}>${t}</option>`).join('')}</select> <span class="passo-depois"></span></div>
        <select class="usar-resp">${replyOptions('Usar uma resposta rápida ou script…')}</select>
        <div class="passo-modelos"></div>`;
      stepsBox.appendChild(box);
      const templates = TemplatesEditor(box.querySelector('.passo-modelos'), p.variacoes);
      const item = { caixa: box, modelos: templates };
      stages.push(item);
      box.querySelector('[data-tirar-passo]').onclick = async () => {
        if (stages.length === 1) return notify('A sequência precisa de pelo menos uma mensagem. Para não usar, desmarque "Ligada" ou apague a sequência.', 'erro');
        if (!(await confirm(`Remover a ${box.querySelector('.passo-n').textContent}?\n\nAs outras mensagens da sequência continuam.`, { ok: 'Remover', perigo: true }))) return;
        box.remove();
        stages.splice(stages.indexOf(item), 1);
        renumber();
      };
      box.querySelector('.usar-resp').onchange = (e) => {
        const et = stepsOfOption(e.target.value);
        if (et) templates.set(et);
        e.target.value = '';
      };
      renumber();
    }
    (orig ? orig.passos : []).forEach(addStep);
    const showForm = () => {
      exists = true;
      remove = false;
      el.querySelector('#autoForm').classList.remove('oculto');
      el.querySelector('#autoCriar')?.remove();
      if (!stages.length) addStep({ espera: { n: 0, unidade: 'min' } });
    };
    el.querySelector('#autoCriar')?.addEventListener('click', showForm);
    el.querySelector('#autoConectar')?.addEventListener('click', () => openSidePanel('kanban'));
    el.querySelector('#autoAddPasso').onclick = () => {
      if (stages.length >= 15) return notify('Máximo de 15 mensagens.', 'erro');
      addStep({});
      stages[stages.length - 1].caixa.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    el.querySelector('#autoLigada').onchange = (e) => (enabled = e.target.checked);
    el.querySelector('#autoApagar')?.addEventListener('click', async () => {
      if (!(await confirm('Apagar a sequência automática desta aba?\n\nQuem está no meio para de receber. Vale quando você clicar em Salvar.', { ok: 'Apagar sequência', perigo: true }))) return;
      remove = true;
      el.querySelector('#autoForm').classList.add('oculto');
      el.querySelector('#autoCartao').insertAdjacentHTML('beforeend', '<div class="alerta" style="margin-top:8px">A sequência será apagada ao salvar.</div>');
    });
    return {
      abrir: () => (serverOn() ? showForm() : null),
      acao() {
        if (!serverOn()) return null;
        if (remove) return orig ? 'apagar' : null;
        return exists ? 'salvar' : null;
      },
      validate() {
        if (!stages.length) return 'A sequência automática precisa de pelo menos uma mensagem.';
        for (let i = 0; i < stages.length; i++) {
          const error = stages[i].modelos.validate(`Mensagem ${i + 1}`);
          if (error) return error;
          if (!stages[i].modelos.all().some((v) => v.length)) return `Mensagem ${i + 1} está vazia.`;
        }
        return '';
      },
      value: () => ({
        ativa: enabled,
        passos: stages.map((p) => ({
          espera: { n: Math.max(0, Number(p.caixa.querySelector('.esp-n').value) || 0), unidade: p.caixa.querySelector('.esp-u').value },
          variacoes: p.modelos.all().filter((v) => v.length),
        })),
        aoResponder: { moverPara: el.querySelector('#autoResp').value },
        aoTerminar: { moverPara: el.querySelector('#autoFim').value },
      }),
      nova: !orig,
    };
  }

  // ---- Side screen: server (key, WhatsApp, pace) ----
  let timerQR = null;
  screens.kanban = async (body) => {
    clearInterval(timerQR);
    if (!serverOn()) {
      body.innerHTML = `
        <div class="lat-titulo"><h2>Kanban automático</h2></div>
        <button class="btn" id="abrirQuadro" style="width:100%;margin-bottom:14px">${IC.kanban} Abrir quadro Kanban</button>
        <div class="cartao"><h3>Sequências automáticas no servidor</h3>
          <div class="dica" style="margin-bottom:10px">O quadro funciona sem servidor (cada aba é uma coluna). Com o servidor, cada coluna pode ter uma <b>sequência automática</b>: quem entra na aba "Remarketing", por exemplo, recebe as mensagens sozinho, mesmo com o computador desligado.</div>
          <label class="campo">Chave de acesso<input type="text" id="chave" placeholder="vf_…" autocomplete="off"></label>
          <button class="btn" id="salvarChave">Conectar</button>
        </div>`;
      body.onclick = async (e) => {
        if (e.target.closest('#abrirQuadro')) return openKanban();
        if (!e.target.closest('#salvarChave')) return;
        const key = body.querySelector('#chave').value.trim();
        if (!key) return notify('Cole a chave de acesso.', 'erro');
        await VF.write('servidor', { chave: key });
        server = { chave: key };
        try {
          await api('GET', '/eu');
          notify('Servidor conectado! Agora conecte o WhatsApp no servidor.', 'ok');
          await loadServer();
          renderSidePanel();
        } catch (err) {
          await VF.write('servidor', { chave: '' });
          server = { chave: '' };
          notify(err.message, 'erro');
        }
      };
      return;
    }
    body.innerHTML = `<div class="lat-titulo"><h2>Kanban automático</h2></div><div class="dica">Carregando…</div>`;
    let me;
    try {
      me = await api('GET', '/eu');
    } catch (e) {
      body.innerHTML = `<div class="lat-titulo"><h2>Kanban automático</h2></div><div class="alerta">${esc(e.message)}</div>
        <button class="btn sec peq" id="tentar">Tentar de novo</button> <button class="link" id="trocarChave">Trocar a chave de acesso</button>`;
      body.onclick = async (ev) => {
        if (ev.target.closest('#tentar')) renderSidePanel();
        if (ev.target.closest('#trocarChave') && (await confirm('Desligar este computador do servidor?\n\nAs sequências continuam rodando no servidor.', { ok: 'Desligar', perigo: true }))) {
          await VF.write('servidor', { chave: '' });
          server = { chave: '' };
          renderSidePanel();
        }
      };
      return;
    }
    const z = me.whatsapp;
    const c = me.config;
    const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const withAuto = kanbanColumns().filter((a) => automations[a.id]);
    const account = (tabId, state) => kanban.inscricoes.filter((i) => i.abaId === tabId && i.estado === state).length;
    body.innerHTML = `
      <div class="lat-titulo"><h2>Kanban automático</h2></div>
      <button class="btn" id="abrirQuadro" style="width:100%;margin-bottom:14px">${IC.kanban} Abrir quadro Kanban</button>
      <div class="cartao"><h3>WhatsApp no servidor</h3>
        ${
          z.estado === 'open'
            ? `<div class="ok-box">✅ Conectado: <b>${esc(VF.numberFromId(z.numero + '@c.us') || z.numero)}</b><br>Hoje: ${me.enviosHoje}/${c.limiteDia} mensagens automáticas · ${me.dentroDoHorario ? 'dentro do horário' : 'fora do horário (espera abrir)'}</div>
               <button class="link" id="desconectarZap" style="color:var(--vermelho)">Desconectar o WhatsApp do servidor</button>`
            : `<div class="dica" style="margin-bottom:8px">Conecte o mesmo número deste WhatsApp. Ele vira mais um "aparelho conectado" (como o WhatsApp Web) e é por ele que o servidor envia as sequências.</div>
               <ol class="passos-lista"><li>Clique em <b>Mostrar QR code</b></li><li>No celular: WhatsApp › <b>⋮</b> (Android) ou <b>Configurações</b> (iPhone) › <b>Aparelhos conectados</b> › <b>Conectar um aparelho</b></li><li>Aponte a câmera para o QR code abaixo</li></ol>
               <button class="btn" id="mostrarQR">Mostrar QR code</button>
               <div id="qrArea" class="qr-area"></div>`
        }
      </div>
      <div class="cartao"><h3>Colunas com sequência automática</h3>
        ${
          withAuto.length
            ? withAuto
                .map((a) => {
                  const au = automations[a.id];
                  return `<div class="contato-linha clicavel" data-editar-auto="${esc(a.id)}"><span class="bolinha" style="background:${esc(a.cor)}"></span><div class="cresce"><div><b>${esc(a.nome)}</b> · ${au.passos.length} mensagem(ns)${au.ativa ? '' : ' · <span style="color:var(--amarelo)">desligada</span>'}</div>
                    <small>⏳ ${account(a.id, 'ativo')} na sequência · 💬 ${account(a.id, 'respondeu')} responderam · ✅ ${account(a.id, 'concluido')} concluíram</small></div></div>`;
                })
                .join('')
            : '<div class="dica">Nenhuma ainda. No quadro, clique no ⚡ de uma coluna (ou em Abas › editar aba) para criar.</div>'
        }
      </div>
      <div class="cartao"><h3>Ritmo do servidor</h3>
        <div class="duas"><label class="campo">Das<input type="time" id="sHoraInicio" value="${esc(c.horaInicio)}"></label><label class="campo">Até<input type="time" id="sHoraFim" value="${esc(c.horaFim)}"></label></div>
        <div class="chips">${days.map((d, i) => `<label class="check" style="padding:0 6px 0 0"><input type="checkbox" name="sDia" value="${i}" ${c.dias.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
        <div class="duas"><label class="campo">Intervalo mín. (seg)<input type="number" id="sIntMin" min="20" value="${c.intervaloMin}"></label><label class="campo">Intervalo máx. (seg)<input type="number" id="sIntMax" min="20" value="${c.intervaloMax}"></label></div>
        <label class="campo">Limite de mensagens automáticas por dia<input type="number" id="sLimite" min="1" max="500" value="${c.limiteDia}"></label>
        <label class="check"><input type="checkbox" id="sDigitando" ${c.simularDigitacao ? 'checked' : ''}> Mostrar "digitando…" / "gravando áudio…" antes</label>
        <button class="btn sec peq" id="salvarRitmo">Salvar ritmo</button>
        <div class="dica" style="margin-top:6px">Esse ritmo é só das sequências automáticas (o envio em massa tem o dele em Configurações).</div>
      </div>
      <button class="link" id="trocarChave">Desligar este computador do servidor</button>`;
    async function showQR(data) {
      const area = body.querySelector('#qrArea');
      if (!area) return;
      if (data.whatsapp.estado === 'open') {
        clearInterval(timerQR);
        notify('✅ WhatsApp conectado no servidor!', 'ok');
        syncKanban();
        return renderSidePanel();
      }
      area.innerHTML = data.codigo
        ? `<div class="codigo-par">${esc(data.codigo)}</div><div class="dica">No celular, em "Conectar um aparelho", toque em <b>Conectar com número de telefone</b> e digite esse código.</div>`
        : data.whatsapp.qr
          ? `<img src="${esc(data.whatsapp.qr)}" alt="QR code"><div class="dica">O código muda sozinho a cada ~40 segundos.</div>`
          : '<div class="dica">Gerando o QR code…</div>';
    }
    body.onclick = async (e) => {
      if (e.target.closest('#abrirQuadro')) return openKanban();
      const ed = e.target.closest('[data-editar-auto]');
      if (ed) return openSidePanel('abas', 'editar:' + ed.dataset.editarAuto + ':auto');
      if (e.target.closest('#mostrarQR')) {
        e.target.closest('#mostrarQR').disabled = true;
        try {
          showQR(await api('POST', '/whatsapp/conectar', {}));
          timerQR = setInterval(async () => {
            if (currentSection !== 'kanban') return clearInterval(timerQR);
            try {
              showQR(await api('GET', '/eu'));
            } catch (err) { /* retries on the next */ }
          }, 3000);
        } catch (err) {
          notify(err.message, 'erro');
          e.target.closest('#mostrarQR').disabled = false;
        }
      }
      if (e.target.closest('#desconectarZap') && (await confirm('Desconectar o WhatsApp do servidor?\n\nAs sequências automáticas param de sair até você conectar de novo.', { ok: 'Desconectar', perigo: true }))) {
        await api('POST', '/whatsapp/desconectar').catch((err) => notify(err.message, 'erro'));
        renderSidePanel();
      }
      if (e.target.closest('#salvarRitmo')) {
        const v = (id) => body.querySelector(id).value;
        const localCfg = await VF.config();
        try {
          await api('PUT', '/config', {
            horaInicio: v('#sHoraInicio'), horaFim: v('#sHoraFim'),
            dias: [...body.querySelectorAll('[name=sDia]:checked')].map((x) => Number(x.value)),
            intervaloMin: Number(v('#sIntMin')), intervaloMax: Number(v('#sIntMax')), limiteDia: Number(v('#sLimite')),
            simularDigitacao: body.querySelector('#sDigitando').checked,
            nomeVendedor: localCfg.nomeVendedor, palavrasSair: localCfg.palavrasSair,
          });
          notify('Ritmo do servidor salvo.', 'ok');
          renderSidePanel();
        } catch (err) {
          notify(err.message, 'erro');
        }
      }
      if (e.target.closest('#trocarChave') && (await confirm('Desligar este computador do servidor?\n\nAs sequências continuam rodando no servidor. Para voltar, cole a chave de novo.', { ok: 'Desligar', perigo: true }))) {
        await VF.write('servidor', { chave: '' });
        server = { chave: '' };
        renderSidePanel();
      }
    };
  };

  // =====================================================================
  // SCREEN: Do not disturb
  // =====================================================================
  screens.naoperturbe = async (body) => {
    const list = await VF.read('naoPerturbe', []);
    const cfg = await VF.config();
    body.innerHTML = `
      <div class="lat-titulo"><h2>Não perturbe</h2></div>
      <div class="dica" style="margin-bottom:10px">Quem está aqui nunca recebe envio em massa. Entra sozinho quando responde só com: ${cfg.palavrasSair.slice(0, 5).map((p) => `<code>${esc(p)}</code>`).join(' ')}…</div>
      <div class="busca" style="margin-bottom:12px"><label><input id="num" placeholder="Adicionar número, ex.: 11999998888"></label><button class="btn" id="add">Adicionar</button></div>
      ${
        list.length
          ? list
              .map(
                (n, i) => `<div class="contato-linha"><div class="cresce"><div>${esc(n.nome || VF.numberFromId(n.ids.find((x) => x.endsWith('@c.us'))) || n.ids[0])}</div>
            <small>${n.texto ? 'Respondeu "' + esc(n.texto) + '" · ' : ''}${new Date(n.em).toLocaleDateString('pt-BR')}</small></div><button class="link" data-i="${i}">remover</button></div>`
              )
              .join('')
          : '<div class="vazio">Ninguém na lista.</div>'
      }`;
    body.onclick = async (e) => {
      if (e.target.closest('#add')) {
        const id = VF.idFromNumber(body.querySelector('#num').value);
        if (!id) return notify('Número inválido.', 'erro');
        list.push({ ids: [id, id.replace(/^55(\d\d)9(\d{8})@/, '55$1$2@')], nome: '', texto: '', em: Date.now() });
      } else if (e.target.closest('[data-i]')) {
        if (!(await confirm('Tirar do Não perturbe?\n\nEste contato volta a poder receber envios em massa e sequências.', { ok: 'Tirar da lista', perigo: true }))) return;
        list.splice(Number(e.target.closest('[data-i]').dataset.i), 1);
      } else return;
      await VF.write('naoPerturbe', list);
      renderSidePanel();
    };
  };

  // =====================================================================
  // SCREEN: Settings (+ backup)
  // =====================================================================
  screens.config = async (body) => {
    const c = await VF.config();
    const days = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
    const num = (id, lbl, min = 1) => `<label class="campo">${lbl}<input type="number" id="${id}" min="${min}" value="${c[id]}"></label>`;
    body.innerHTML = `
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
      <div class="chips">${days.map((d, i) => `<label class="check" style="padding:0 6px 0 0"><input type="checkbox" name="dia" value="${i}" ${c.dias.includes(i) ? 'checked' : ''}>${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][i]}</label>`).join('')}</div>
      <div class="secao-t">Respostas rápidas</div>
      <label class="check"><input type="checkbox" id="digitacaoNasRespostas" ${c.digitacaoNasRespostas ? 'checked' : ''}> Mostrar "digitando…" antes (fica mais lento)</label>
      <div class="secao-t">Descadastro</div>
      <label class="campo">Palavras (separe por vírgula)<input type="text" id="palavrasSair" value="${esc(c.palavrasSair.join(', '))}"></label>
      <div class="secao-t">Backup</div>
      <div class="dica" style="margin-bottom:8px">Tudo fica só neste computador. Baixe um backup para não perder ou para levar a outro computador. Escolha o que vai no arquivo:</div>
      <div class="bk-lista">${BACKUP_PARTS.map(([v, t]) => `<label class="check"><input type="checkbox" name="bk" value="${v}" checked> ${t}</label>`).join('')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn sec peq" id="baixar">Baixar backup</button>
        <label class="btn sec peq" style="cursor:pointer">Restaurar backup<input type="file" id="restaurar" accept=".json" class="oculto"></label></div>
      <div class="dica" style="margin-top:6px">Veio de outra extensão? Exporte o backup lá e escolha o arquivo em "Restaurar backup" — o GoSeller reconhece o formato e importa respostas, abas, nomes e anotações.</div>
      <div id="bkRestaurar"></div>
      <div class="secao-t">Planilha de contatos (CSV)</div>
      <div class="dica" style="margin-bottom:8px">Escolha etiquetas e/ou abas e baixe nome + telefone dos contatos. Abre no Excel e no Google Planilhas.</div>
      <div id="csvGrupos"></div>
      <button class="btn sec peq" id="baixarCSV" style="margin-top:8px">📄 Baixar planilha</button>
      <div class="secao-t">Ajuda</div>
      <div class="dica" style="margin-bottom:8px">Algo deu errado? Conte o que aconteceu. Vão junto a versão do GoSeller, o sistema e os últimos erros (sem mensagens e com os números escondidos).</div>
      <button class="btn sec peq" id="relatar">Relatar problema</button>
      <div id="relatoCaixa"></div>`;
    footerText(`<button class="btn" id="salvar">Salvar configurações</button>`);
    const q = (s) => body.querySelector(s);
    $('#salvar').onclick = async () => {
      const n = (id) => Math.max(0, Number(q('#' + id).value) || 0);
      const newConfig = {
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
        dias: [...body.querySelectorAll('input[name=dia]:checked')].map((x) => Number(x.value)),
        digitacaoNasRespostas: q('#digitacaoNasRespostas').checked,
        palavrasSair: q('#palavrasSair').value.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (newConfig.intervaloMax < newConfig.intervaloMin) [newConfig.intervaloMin, newConfig.intervaloMax] = [newConfig.intervaloMax, newConfig.intervaloMin];
      if (newConfig.pausaLoteMax < newConfig.pausaLoteMin) [newConfig.pausaLoteMin, newConfig.pausaLoteMax] = [newConfig.pausaLoteMax, newConfig.pausaLoteMin];
      if (newConfig.usarHorario && !newConfig.dias.length) return notify('Marque pelo menos um dia.', 'erro');
      if (newConfig.usarHorario && VF.toMinutes(newConfig.horaFim) <= VF.toMinutes(newConfig.horaInicio)) return notify('O horário final precisa ser depois do inicial.', 'erro');
      await VF.write('config', newConfig);
      notify('Configurações salvas.', 'ok');
    };
    const downloadFile = (content, name, type) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: type }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    q('#baixar').onclick = async () => {
      const chosen = [...body.querySelectorAll('input[name=bk]:checked')].map((x) => x.value);
      if (!chosen.length) return notify('Marque pelo menos uma parte para o backup.', 'erro');
      const everything = await chrome.storage.local.get(null);
      const data = {};
      Object.keys(everything).forEach((k) => chosen.includes(keyPart(k)) && (data[k] = everything[k]));
      // Gathers only the files (audio, video, image) used by what was chosen
      for (const [, id] of JSON.stringify(data).matchAll(/"midiaId":"([^"]+)"/g)) if (everything['midia:' + id]) data['midia:' + id] = everything['midia:' + id];
      downloadFile(JSON.stringify({ app: 'goseller', versao: 2, em: Date.now(), partes: chosen, dados: data }), `goseller-backup-${VF.today()}.json`, 'application/json');
      notify('Backup baixado (pasta Downloads).', 'ok');
    };
    // Shows the "what to restore" confirmation for a backup already in GoSeller format.
    function showRestore(j, fileName, notice) {
      const box = q('#bkRestaurar');
      const present = BACKUP_PARTS.filter(([v]) => Object.keys(j.dados).some((k) => keyPart(k) === v));
      if (!present.length) throw new Error('O backup está vazio.');
      box.innerHTML = `<div class="cartao" style="margin-top:10px"><b>O que restaurar de "${esc(fileName)}"?</b>
        ${notice ? `<div class="dica" style="margin:4px 0 6px">${esc(notice)}</div>` : ''}
        <div class="dica" style="margin:4px 0 6px">O que você marcar SUBSTITUI o que está neste computador. O resto fica como está.</div>
        ${present.map(([v, t]) => `<label class="check"><input type="checkbox" name="rs" value="${v}" checked> ${t}</label>`).join('')}
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn peq" id="rsOk">Restaurar</button><button class="btn sec peq" id="rsCancelar">Cancelar</button></div></div>`;
      q('#rsCancelar').onclick = () => (box.innerHTML = '');
      q('#rsOk').onclick = async () => {
        const sel = [...box.querySelectorAll('input[name=rs]:checked')].map((x) => x.value);
        if (!sel.length) return notify('Marque pelo menos uma parte.', 'erro');
        const current = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(Object.keys(current).filter((k) => sel.includes(keyPart(k))));
        const restored = {};
        Object.keys(j.dados).forEach((k) => (sel.includes(keyPart(k)) || k.startsWith('midia:')) && (restored[k] = j.dados[k]));
        await chrome.storage.local.set(restored);
        await reloadData();
        VF.cleanOrphanMedia();
        notify('Backup restaurado.', 'ok');
        renderSidePanel();
      };
    }

    // ---- "Relatar problema": description + optional print/video + automatic diagnostics ----
    q('#relatar').onclick = () => {
      const box = q('#relatoCaixa');
      box.innerHTML = `<div class="cartao" style="margin-top:10px">
        <label class="campo">O que aconteceu?<textarea id="relDescricao" placeholder="Ex.: a campanha parou no 12º lead e não voltou mais"></textarea></label>
        <label class="campo">Print ou vídeo (opcional)<input type="file" id="relAnexo" accept="image/*,video/*"><small>Até 30 MB. O print pode mostrar conversas: envie só se não tiver problema.</small></label>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn peq" id="relEnviar">Enviar relato</button><button class="btn sec peq" id="relCancelar">Cancelar</button></div>
        <div id="relResultado"></div></div>`;
      q('#relCancelar').onclick = () => (box.innerHTML = '');
      q('#relEnviar').onclick = async () => {
        const description = q('#relDescricao').value.trim();
        if (!description) return notify('Conte em poucas palavras o que aconteceu.', 'erro');
        const file = q('#relAnexo').files[0];
        if (file && file.size > 30 * 1024 * 1024) return notify('O arquivo passa de 30 MB. Grave um vídeo mais curto ou mande um print.', 'erro');
        const button = q('#relEnviar');
        button.disabled = true;
        button.textContent = 'Enviando…';
        try {
          const [cfg, campaigns] = await Promise.all([VF.config(), readCampaigns()]);
          const fmt = (e) => `${new Date(e.em).toLocaleString('pt-BR')} [${e.origem}] ${e.msg}`;
          const report = {
            descricao: description,
            vendedor: cfg.nomeVendedor || '',
            erros: errorLog.map(fmt),
            info: {
              versao: chrome.runtime.getManifest().version,
              waJs: waState.versao || null,
              navegador: navigator.userAgent,
              sistema: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform,
              idioma: navigator.language,
              tela: `${screen.width}x${screen.height}`,
              janela: `${innerWidth}x${innerHeight}`,
              whatsappConectado: !!waState.logado,
              campanhasAtivas: campaigns.filter((c) => c.status === 'ativa').length,
              servidorConectado: serverOn(),
              abas: tabs.length,
              respostas: replies.length,
            },
          };
          const attachment = file ? { nome: file.name, mime: file.type, tamanho: file.size, dataUrl: await new Promise((ok, fail) => {
            const r = new FileReader();
            r.onload = () => ok(r.result);
            r.onerror = () => fail(new Error('Não consegui ler o arquivo.'));
            r.readAsDataURL(file);
          }) } : null;
          const r = await chrome.runtime.sendMessage({ tipo: 'relato', relato: report, anexo: attachment });
          if (!r) throw new Error('A extensão não respondeu. Recarregue a página.');
          if (r.erro) throw new Error(r.erro);
          q('#relatoCaixa').innerHTML = `<div class="ok-box" style="margin-top:10px">Relato enviado! Código <b>#${esc(r.id)}</b>.<br>Passe esse código para quem cuida do GoSeller.</div>`;
        } catch (e) {
          button.disabled = false;
          button.textContent = 'Enviar relato';
          notify('Não consegui enviar o relato: ' + e.message, 'erro', 8000);
        }
      };
      q('#relDescricao').focus();
    };

    // One restore button: detects GoSeller backups and other supported extensions' backups on its own
    q('#restaurar').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (['goseller', 'vendaflow'].includes(j.app) && j.dados) return showRestore(j, f.name);
        if (WaSeller.isBackup(j)) {
          notify('Lendo o backup…', 'info', 4000);
          const conv = await WaSeller.convert(j);
          const r = conv.resumo;
          return showRestore(conv, f.name, `Backup de outra extensão: ${r.respostas} respostas (${r.midias} com áudio/vídeo/imagem), ${r.abas} abas com ${r.leads} leads, ${r.nomes} nomes e ${r.notas} anotações.`);
        }
        throw new Error('Não reconheci este arquivo como backup. Use um backup baixado no GoSeller ou exportado pela outra extensão.');
      } catch (er) {
        notify(er instanceof SyntaxError ? 'O arquivo não é um backup válido (não é JSON).' : er.message, 'erro', 6000);
      }
    };
    const selCSV = multiSelector(
      q('#csvGrupos'),
      () => [
        ...labels.map((e) => ({ id: 'e:' + e.id, nome: e.nome, cor: e.cor, grupo: 'Etiquetas do WhatsApp', extra: e.total })),
        ...tabs.map((a) => ({ id: 'a:' + a.id, nome: a.nome, cor: a.cor, grupo: 'Abas', extra: (a.chats || []).length })),
      ],
      [],
      null,
      'Nenhuma escolhida'
    );
    q('#baixarCSV').onclick = async () => {
      const groups = selCSV.value();
      if (!groups.length) return notify('Escolha pelo menos uma etiqueta ou aba.', 'erro');
      const button = q('#baixarCSV');
      button.disabled = true;
      try {
        const contacts = new Map(); // number -> { nome, grupos }
        const merge = (ids, waName, group) => {
          const cus = ids.find((x) => x.endsWith('@c.us'));
          const number = VF.numberFromId(cus) || (cus || ids[0] || '').split('@')[0];
          if (!number) return;
          const c = contacts.get(number) || { nome: nameOf(ids, waName), grupos: [] };
          if (!c.nome) c.nome = nameOf(ids, waName);
          c.grupos.push(group);
          contacts.set(number, c);
        };
        for (const g of groups) {
          if (g.startsWith('e:')) {
            const et = labels.find((x) => x.id === g.slice(2));
            (await rpc('listarChats', { etiqueta: g.slice(2) })).forEach((c) => merge([c.id], c.nome, et ? et.nome : 'Etiqueta'));
          } else {
            const tab = tabs.find((x) => x.id === g.slice(2));
            (tab ? tab.chats || [] : []).forEach((c) => merge(c.ids, c.nome, tab.nome));
          }
        }
        if (!contacts.size) return notify('Nenhum contato nesses grupos.', 'erro');
        const cel = (x) => `"${String(x || '').replace(/"/g, '""')}"`;
        const lines = [['Nome', 'Telefone', 'Grupos'].map(cel).join(';')];
        contacts.forEach((c, number) => lines.push([c.nome, number, [...new Set(c.grupos)].join(', ')].map(cel).join(';')));
        downloadFile('﻿' + lines.join('\r\n'), `goseller-contatos-${VF.today()}.csv`, 'text/csv;charset=utf-8');
        notify(`Planilha com ${contacts.size} contatos baixada (pasta Downloads).`, 'ok');
      } catch (er) {
        notify('Não consegui montar a planilha: ' + er.message, 'erro');
      } finally {
        button.disabled = false;
      }
    };
  };

  // Backup parts (the seller picks which go into the file)
  const BACKUP_PARTS = [
    ['respostas', 'Respostas rápidas, scripts e categorias (com os áudios, vídeos e imagens)'],
    ['abas', 'Abas, com os leads de cada uma'],
    ['contatos', 'Contatos: nomes trocados, anotações e Não perturbe'],
    ['campanhas', 'Campanhas de envio em massa (histórico)'],
    ['config', 'Configurações'],
  ];
  function keyPart(k) {
    if (k === 'respostas' || k === 'scripts' || k === 'categorias') return 'respostas';
    if (k === 'abas' || k === 'automacoes') return 'abas';
    if (k === 'nomes' || k === 'naoPerturbe' || k.startsWith('nota:')) return 'contatos';
    if (k === 'campanhas' || k.startsWith('campanha:')) return 'campanhas';
    if (k === 'config') return 'config';
    return null; // media and internal data (engine, cache) don't count as a part
  }

  // =====================================================================
  // Top bar: tab pills
  // =====================================================================
  function tabCount(tab) {
    return (tab.chats || []).length;
  }

  function renderPills() {
    const html = [`<button class="pilula sem-conta ${selectedTab === 'todas' ? 'ativa' : ''}" data-aba="todas">Todas</button>`];
    for (const a of tabs) {
      const n = tabCount(a);
      html.push(
        `<button class="pilula ${n === null ? 'sem-conta' : ''} ${selectedTab === a.id ? 'ativa' : ''}" data-aba="${esc(a.id)}" title="${a.etiquetaId && a.sincronizar ? 'Aba ligada a uma etiqueta (quem recebe a etiqueta entra sozinho)' : 'Aba'}">` +
          `<span class="cor" style="background:${esc(a.cor || '#25d366')}"></span>${esc(a.nome)}${n === null ? '' : `<span class="contador">${n}</span>`}</button>`
      );
    }
    $('#pilulas').innerHTML = html.join('');
  }

  $('#pilulas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (b) selectTab(b.dataset.aba);
  });
  // Holding and dragging a top tab sideways changes the order ("Todas" always stays first)
  dragSort($('#pilulas'), '[data-aba]', {
    eixo: 'x',
    pode: (b) => b.dataset.aba !== 'todas',
    aoSoltar: async () => {
      await saveTabOrder([...$('#pilulas').querySelectorAll('[data-aba]')].map((x) => x.dataset.aba).filter((id) => id !== 'todas'));
      if (currentSection === 'abas') renderSidePanel();
    },
  });
  $('#pilulas').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      $('#pilulas').scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Right click on a top tab: rename, color, delete
  $('#pilulas').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('[data-aba]');
    if (!b || b.dataset.aba === 'todas') return;
    e.preventDefault();
    const a = tabs.find((x) => x.id === b.dataset.aba);
    if (!a) return;
    openPop(b, [
      { texto: '✏️ Renomear', acao: () => renameTab(a) },
      { texto: '🎨 Mudar cor e conteúdo', acao: () => openSidePanel('abas', 'editar:' + a.id) },
      { texto: '🗑️ Excluir aba', perigo: true, acao: () => deleteTab(a) },
    ]);
  });
  $('#pilulas').addEventListener('dblclick', (e) => {
    const b = e.target.closest('[data-aba]');
    const a = b && tabs.find((x) => x.id === b.dataset.aba);
    if (a) renameTab(a);
  });

  $('#novaAba').addEventListener('click', () => openSidePanel('abas', 'nova'));

  // ---- ⚡ button inside the typing bar, next to the microphone ----
  // It lives inside WhatsApp itself (doesn't float), so it doesn't jump around.
  // Only checks once in a while that it's still there (without measuring the screen, which is the heavy part).
  const waBolt = document.createElement('div');
  waBolt.id = 'vf-raio';
  waBolt.title = 'Respostas rápidas (GoSeller)';
  waBolt.setAttribute('role', 'button');
  waBolt.innerHTML = IC.raio;
  Object.assign(waBolt.style, {
    width: '34px', height: '34px', minWidth: '34px', borderRadius: '50%', background: '#00a884', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', margin: '0 4px', padding: '0', boxSizing: 'border-box', flex: 'none', alignSelf: 'center',
  });
  Object.assign(waBolt.firstElementChild.style, { width: '18px', height: '18px', fill: '#fff' });
  waBolt.addEventListener('mousedown', (e) => e.preventDefault()); // doesn't take the cursor out of the message field
  waBolt.addEventListener('click', (e) => {
    e.stopPropagation();
    openSidePanel('respostas');
  });
  const MIC_SELECTORS = [
    '[data-icon="mic-outlined"]', '[data-icon="ptt"]', '[data-icon="wds-ic-mic"]', '[data-icon="ic-mic"]', '[data-icon="audio-send"]',
    '[data-icon="send"]', '[data-icon="wds-ic-send-filled"]', '[data-icon="ic-send"]',
    'button[aria-label="Mensagem de voz"]', 'button[aria-label="Voice message"]', 'button[aria-label="Enviar"]', 'button[aria-label="Send"]',
  ].join(',');
  function fitBolt() {
    const footer = document.querySelector('#main footer');
    if (!footer) return;
    if (waBolt.isConnected && footer.contains(waBolt)) return;
    const icons = footer.querySelectorAll(MIC_SELECTORS);
    const icon = icons[icons.length - 1];
    if (!icon) return;
    // Climbs up to the button's block (the parent with more than one child is the bar's row)
    let block = icon.closest('button,[role="button"]') || icon;
    while (block.parentElement && block.parentElement !== footer && block.parentElement.childElementCount === 1) block = block.parentElement;
    if (block.parentElement) block.parentElement.insertBefore(waBolt, block);
  }
  setInterval(fitBolt, 1200);

  // ---- Chat header: pencil next to the name and tabs button next to the label ----
  const SVG_PENCIL = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
  const SVG_FOLDER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg>';
  const headerNameBtn = document.createElement('span');
  headerNameBtn.id = 'vf-nome-wa';
  headerNameBtn.title = 'Mudar o nome deste contato (GoSeller)';
  headerNameBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;gap:0;margin:0 4px;width:34px;height:34px;padding:0;border-radius:50%;box-sizing:border-box;align-self:center;cursor:pointer;color:#8696a0;font-size:13px;font-weight:500;vertical-align:middle;flex:none;white-space:nowrap;';
  headerNameBtn.innerHTML = SVG_PENCIL + '<span></span>';
  const tabsHeaderBtn = document.createElement('span');
  tabsHeaderBtn.id = 'vf-abas-wa';
  tabsHeaderBtn.title = 'Colocar este contato em abas (GoSeller)';
  // Icon only (no text) so the contact name isn't squeezed in the header
  tabsHeaderBtn.style.cssText = 'position:relative;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;margin-right:6px;border-radius:50%;cursor:pointer;color:inherit;flex:none;box-sizing:border-box;';
  tabsHeaderBtn.innerHTML = SVG_FOLDER.replace(/18/g, '22') + '<span style="position:absolute;right:2px;bottom:4px;display:flex;gap:1px"></span>';
  for (const b of [headerNameBtn, tabsHeaderBtn]) {
    b.addEventListener('mouseenter', () => (b.style.background = 'rgba(134,150,160,.15)'));
    b.addEventListener('mouseleave', () => (b.style.background = ''));
  }
  let hdr = { chatId: null, ids: [] };
  async function headerIds() {
    if (!currentChat || currentChat.grupo) return null;
    if (hdr.chatId !== currentChat.id) hdr = { chatId: currentChat.id, ids: await equivalents(currentChat.id) };
    return hdr.ids;
  }
  async function updateHeader() {
    const ids = await headerIds();
    const mine = ids ? nameOf(ids, '') : '';
    headerNameBtn.lastChild.textContent = '';
    headerNameBtn.style.color = mine ? '#21c063' : '#8696a0';
    headerNameBtn.title = mine ? `Nome no GoSeller: ${mine} (clique para mudar)` : 'Mudar o nome deste contato (GoSeller)';
    const myOnes = ids ? tabs.filter((a) => tabHas(a, ids)) : [];
    tabsHeaderBtn.lastChild.innerHTML = myOnes
      .slice(0, 3)
      .map((a) => `<span style="display:block;width:9px;height:9px;border-radius:50%;background:${esc(a.cor)};box-shadow:0 0 0 2px #111b21"></span>`)
      .join('');
    tabsHeaderBtn.title = myOnes.length ? `Abas: ${myOnes.map((a) => a.nome).join(', ')} (clique para mudar)` : 'Colocar este contato em abas (GoSeller)';
  }
  const openHeaderName = async () => {
    const ids = await headerIds();
    if (!ids) return notify('Abra uma conversa (que não seja grupo).');
    const waName = currentChat.nome || '';
    const current = nameOf(ids, '') || waName;
    const pop = $('#pop');
    pop.innerHTML = `<div class="pop-form"><b>Nome do contato</b>
      <input type="text" id="popNome" value="${esc(current)}" placeholder="Nome do contato">
      <div class="nome-acoes"><button type="button" class="btn peq" data-ok>Salvar</button>${nameOf(ids, '') ? '<button type="button" class="link-btn" data-volta>Voltar ao nome do WhatsApp</button>' : ''}</div>
      <div class="dica">Salva o contato no WhatsApp com esse nome e vale em {nome} e {primeiro_nome}.${waName ? `<br>No WhatsApp: ${esc(waName)}` : ''}</div></div>`;
    positionPop(headerNameBtn);
    const inp = pop.querySelector('#popNome');
    inp.focus();
    inp.select();
    const save = async (value) => {
      closePop();
      await changeName(ids, currentChat.id, value);
      updateHeader();
    };
    inp.onkeydown = (k) => {
      k.stopPropagation();
      if (k.key === 'Enter') save(inp.value.trim());
      if (k.key === 'Escape') closePop();
    };
    pop.onclick = (ev) => {
      if (ev.target.closest('[data-ok]')) save(inp.value.trim());
      if (ev.target.closest('[data-volta]')) save('');
    };
  };
  const openHeaderTabs = async () => {
    const ids = await headerIds();
    if (!ids) return notify('Abra uma conversa (que não seja grupo).');
    const manualTabs = tabs;
    const name = nameOf(ids, currentChat.nome);
    openMultiPop(
      tabsHeaderBtn,
      manualTabs.map((a) => ({ id: a.id, nome: a.nome, cor: a.cor })),
      new Set(manualTabs.filter((a) => tabHas(a, ids)).map((a) => a.id)),
      async (sel, id, include) => {
        await changeTab(id, ids, name, include);
        tabs = await VF.read('abas', []);
        updateHeader();
      },
      { texto: '➕ Criar nova aba…', acao: () => openSidePanel('abas', 'nova') }
    );
  };
  // The header name is clickable in WhatsApp (opens contact info). We catch the click
  // on the window, before WhatsApp sees it, so the pencil and tabs button only do their own thing.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend']) {
    window.addEventListener(
      type,
      (e) => {
        const path = e.composedPath();
        const b = path.includes(headerNameBtn) ? headerNameBtn : path.includes(tabsHeaderBtn) ? tabsHeaderBtn : null;
        if (!b) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (type === 'click') (b === headerNameBtn ? openHeaderName : openHeaderTabs)();
      },
      { capture: true, passive: false }
    );
  }
  const SEARCH_SELECTORS = '[data-icon="search-alt"],[data-icon="search"],[data-icon="search-refreshed"],[data-icon="wds-ic-search"],[aria-label="Pesquisar"],[aria-label="Search"],[aria-label="Pesquisar…"]';
  const LIST_CHIP_TEXTS = ['Adicionar à lista', 'Add to list', 'Agregar a la lista', 'Añadir a la lista'];
  function fitHeader() {
    const header = document.querySelector('#main header');
    if (!header) return;
    if (!currentChat || currentChat.grupo) {
      headerNameBtn.remove();
      tabsHeaderBtn.remove();
      return;
    }
    // Pencil right after the name block (outside the area WhatsApp uses to open contact info)
    const search0 = header.querySelector(SEARCH_SELECTORS);
    const title = header.querySelector('span[dir="auto"]');
    if (title) {
      let block = title; // name block = biggest ancestor of the name that doesn't contain the search/buttons
      while (block.parentElement && block.parentElement !== header && !(search0 && block.parentElement.contains(search0)) && !block.parentElement.contains(tabsHeaderBtn)) block = block.parentElement;
      if (headerNameBtn.previousElementSibling !== block) block.after(headerNameBtn);
    }
    // Tabs button left of the label chip. New WhatsApp versions show "Adicionar à lista" in that same
    // chip when the contact has no label/list; only without any chip it goes left of the search icon.
    const search = header.querySelector(SEARCH_SELECTORS);
    if (!search) return;
    let block = search.closest('button,[role="button"]') || search;
    while (block.parentElement && block.parentElement !== header && block.parentElement.childElementCount === 1) block = block.parentElement;
    let parent = block.parentElement;
    let before = block;
    const labelNames = new Set([...labels.map((t) => t.nome), ...LIST_CHIP_TEXTS]);
    for (let up = parent, child = block, n = 0; up && up !== header.parentElement && n < 6; child = up, up = up.parentElement, n++) {
      const chip = [...up.querySelectorAll('span,div')].find((el) => !el.closest('#vf-abas-wa') && el.childElementCount === 0 && labelNames.has(el.textContent.trim()) && !child.contains(el) && !el.closest('span[dir="auto"]'));
      if (chip) {
        let c = chip;
        while (c.parentElement && c.parentElement !== up) c = c.parentElement;
        parent = up;
        before = c;
        break;
      }
    }
    if (tabsHeaderBtn.parentElement !== parent || tabsHeaderBtn.nextElementSibling !== before) parent.insertBefore(tabsHeaderBtn, before);
  }
  setInterval(fitHeader, 1200);

  // ---- WhatsApp menus (message options...) that go under the panel: push them left ----
  function pushMenus() {
    const panelOpen = !$('#lateral').classList.contains('oculto');
    const limit = window.innerWidth - 380 - 8;
    const done = new Set();
    document.querySelectorAll('[role="menuitem"],[data-animate-dropdown-item],[role="menu"]').forEach((item) => {
      let el = item.parentElement;
      for (let n = 0; el && el !== document.body && n < 12; el = el.parentElement, n++) {
        if (el.id === 'app' || el.id === 'main') return;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'absolute') break;
      }
      if (!el || el === document.body || done.has(el)) return;
      done.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      // WA reuses the same box for several menus: always recompute from the natural position
      // (without our offset), otherwise the old offset accumulates and the menu ends up on the other side.
      const current = parseFloat(el.dataset.vfDx || '0');
      const left = r.left - current;
      const dir = r.right - current;
      let dx = 0;
      if (panelOpen && dir > limit) dx = Math.min(0, Math.max(limit - dir, 68 - left));
      if (dx === current) return;
      if (dx === 0) {
        el.style.translate = '';
        delete el.dataset.vfDx;
      } else {
        el.style.translate = dx + 'px 0px';
        el.dataset.vfDx = String(dx);
      }
    });
  }
  const scheduleMenus = () => [0, 40, 120, 250, 500, 900].forEach((ms) => setTimeout(pushMenus, ms));
  document.addEventListener('click', scheduleMenus, true);
  document.addEventListener('contextmenu', scheduleMenus, true);

  // ---- "/" shortcut in the message field ----
  let suggestions = [];
  let sugIndex = 0;
  const messageField = (target) =>
    target && target.isContentEditable && target.closest && target.closest('footer') ? target.closest('[contenteditable="true"]') || target : null;

  function closeSuggestions() {
    suggestions = [];
    $('#sugestoes').classList.add('oculto');
  }
  function renderSuggestions(field) {
    const box = $('#sugestoes');
    if (!suggestions.length) return closeSuggestions();
    box.innerHTML =
      suggestions
        .map(
          (r, i) =>
            `<div class="sug ${i === sugIndex ? 'sel' : ''}" data-i="${i}"><code>/${esc(r.atalho || '')}</code> <b>${r._script ? '🔗 ' : ''}${esc(r.nome)}</b><span>${esc(r._script ? scriptSummary(r) : replySummary(r)).slice(0, 80)}</span></div>`
        )
        .join('') + '<div class="sug-dica">↑↓ escolher · Enter enviar · Tab colar · Esc fechar</div>';
    const r = field.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.width = Math.max(320, Math.min(r.width, 560)) + 'px';
    box.style.bottom = window.innerHeight - r.top + 10 + 'px';
    box.classList.remove('oculto');
  }
  document.addEventListener(
    'input',
    (e) => {
      const field = messageField(e.target);
      if (!field) return;
      // textContent doesn't force the browser to re-layout (innerText does, on every key)
      const t = (field.textContent || '').trim();
      if (t[0] !== '/') return suggestions.length && closeSuggestions();
      const m = t.match(/^\/(\S*)$/);
      if (!m) return closeSuggestions();
      const f = VF.stripAccents(m[1].toLowerCase());
      suggestions = [...scripts.filter((s) => s.atalho).map((s) => ({ ...s, _script: true })), ...replies]
        .filter((r) => VF.stripAccents(((r.atalho || '') + ' ' + r.nome).toLowerCase()).includes(f))
        .sort((a, b) => (VF.stripAccents((b.atalho || '').toLowerCase()).startsWith(f) ? 1 : 0) - (VF.stripAccents((a.atalho || '').toLowerCase()).startsWith(f) ? 1 : 0))
        .slice(0, 8);
      sugIndex = 0;
      renderSuggestions(field);
    },
    true
  );
  async function pickSuggestion(i, mode) {
    const r = suggestions[i];
    closeSuggestions();
    if (!r) return;
    try {
      await rpc('colarTexto', '');
    } catch (e) { /* continues */ }
    if (r._script) return useScript(r);
    useReply(r, mode === 'colar' && textOnly(r) ? 'colar' : 'enviar');
  }
  window.addEventListener(
    'keydown',
    (e) => {
      if (!suggestions.length || !messageField(e.target)) return;
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        sugIndex = (sugIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        renderSuggestions(messageField(e.target));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        stop();
        pickSuggestion(sugIndex, e.key === 'Tab' ? 'colar' : 'enviar');
      } else if (e.key === 'Escape') {
        stop();
        closeSuggestions();
      }
    },
    true
  );
  $('#sugestoes').addEventListener('mousedown', (e) => {
    const s = e.target.closest('[data-i]');
    if (!s) return;
    e.preventDefault();
    pickSuggestion(Number(s.dataset.i), 'enviar');
  });

  // =====================================================================
  // Bulk-send engine
  // =====================================================================
  let busy = false;
  let currentStatus = { texto: 'Envio em massa', tipo: 'parado' };

  function formatDelay(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function statusText() {
    const s = currentStatus;
    if (s.tipo === 'enviando' && s.proximoEm) {
      const missing = s.proximoEm - Date.now();
      return missing > 0 ? `${s.texto} · próximo em ${formatDelay(missing)}` : `${s.texto} · enviando…`;
    }
    return s.texto;
  }
  // Only touches the screen when the text changes (before, it rewrote the button all the time)
  let lastStatus = '';
  function updateStatus() {
    const className = 'status-envio ' + (currentStatus.tipo || 'parado');
    const text = currentStatus.tipo === 'parado' ? 'Envio em massa' : statusText();
    if (className + text === lastStatus) return;
    lastStatus = className + text;
    const b = $('#statusEnvio');
    b.className = className;
    b.querySelector('span').textContent = text;
  }
  setInterval(() => currentStatus.tipo !== 'parado' && document.visibilityState === 'visible' && updateStatus(), 1000);
  $('#statusEnvio').addEventListener('click', () => {
    openSidePanel('envio', currentStatus.campanhaId && currentStatus.tipo !== 'parado' ? 'campanha:' + currentStatus.campanhaId : null);
  });

  async function saveStatus(s) {
    // Doesn't save the same status again (each save wakes up all tabs)
    if (s.texto === currentStatus.texto && s.tipo === currentStatus.tipo && (s.proximoEm || 0) === (currentStatus.proximoEm || 0)) return;
    currentStatus = { ...s, atualizado: Date.now() };
    await VF.write('motorStatus', currentStatus);
    updateStatus();
  }

  async function acquireLock() {
    const t = await VF.read('motorTrava', null);
    if (t && t.token !== MY_TOKEN && t.ate > Date.now()) return false;
    await VF.write('motorTrava', { token: MY_TOKEN, ate: Date.now() + 90 * 1000 });
    return true;
  }

  async function saveContact(campaignId, index, changes, extras = {}) {
    const key = 'campanha:' + campaignId;
    const c = await VF.read(key, null);
    if (!c) return null;
    Object.assign(c.contatos[index], changes);
    Object.assign(c, extras);
    await VF.write(key, c);
    return c;
  }

  // With no active campaign, the engine reads nothing (before, it read every campaign every 15s).
  // Looks again when some campaign changes.
  let hasActiveCampaign = null;
  let waitingIds = null; // contacts who received a campaign and haven't replied yet
  function campaignsChanged() {
    hasActiveCampaign = null;
    waitingIds = null;
  }

  async function engineStep() {
    if (busy || hasActiveCampaign === false) return;
    busy = true;
    try {
      const campaigns = await readCampaigns();
      const campaign = campaigns.find((c) => c.status === 'ativa');
      hasActiveCampaign = !!campaign;
      if (!campaign) {
        if (currentStatus.tipo !== 'parado') await saveStatus({ texto: 'Envio em massa', tipo: 'parado' });
        return;
      }
      if (!(await acquireLock())) return; // another WhatsApp tab is handling the sends

      const cfg = await VF.config();
      const done = campaign.contatos.filter((x) => x.status !== 'pendente').length;
      const base = { campanhaId: campaign.id, campanhaNome: campaign.nome, feitos: done, total: campaign.contatos.length };

      if (!waState.logado) {
        try {
          waState = await rpc('estado');
        } catch (e) { /* continues */ }
        if (!waState.logado) return saveStatus({ ...base, texto: '⏳ Aguardando o WhatsApp carregar', tipo: 'aguardando' });
      }
      if (!VF.withinHours(cfg)) return saveStatus({ ...base, texto: `🌙 Fora do horário (${cfg.horaInicio}–${cfg.horaFim})`, tipo: 'aguardando' });
      const todayCount = await VF.sentToday();
      if (todayCount >= cfg.limiteDia) return saveStatus({ ...base, texto: `✋ Limite do dia (${todayCount}/${cfg.limiteDia}) — continua amanhã`, tipo: 'aguardando' });

      // Contact interrupted midway (tab closed during sending): don't resend to avoid duplicates
      const interrupted = campaign.contatos.findIndex((x) => x.status === 'enviando');
      if (interrupted >= 0) await saveContact(campaign.id, interrupted, { status: 'falhou', erro: 'Envio interrompido (confira a conversa)', em: Date.now() });

      // Nobody left in the queue: finish right away (don't wait for the interval meant for a next lead)
      const i = campaign.contatos.findIndex((x) => x.status === 'pendente');
      if (i < 0) {
        const c = await VF.read('campanha:' + campaign.id);
        c.status = 'concluida';
        c.concluidaEm = Date.now();
        await VF.write('campanha:' + campaign.id, c);
        const n = count(c);
        if (n.enviado) notify(`✅ Campanha "${c.nome}" concluída: ${n.enviado} enviados${n.pulado + n.falhou ? `, ${n.pulado + n.falhou} pulados/falhas` : ''}.`, 'ok', 10000);
        else notify(`⚠️ Campanha "${c.nome}" terminou sem enviar nenhuma mensagem. Abra a campanha para ver o motivo.`, 'erro', 12000);
        return saveStatus({ texto: 'Envio em massa', tipo: 'parado' });
      }

      const engine = await VF.read('motor', { proximoEm: 0, noLote: 0, falhasSeguidas: 0 });
      if (Date.now() < engine.proximoEm) {
        return saveStatus({ ...base, texto: `${campaign.nome}: ${done}/${base.total}`, tipo: 'enviando', proximoEm: engine.proximoEm });
      }
      await processContact(campaign, i, cfg, engine, base);
    } catch (e) {
      console.warn('[GoSeller] motor:', e);
    } finally {
      busy = false;
    }
  }

  async function processContact(campaign, i, cfg, engine, base) {
    const contact = campaign.contatos[i];
    let id = contact.id;
    const skip = async (reason, delaySec) => {
      await saveContact(campaign.id, i, { status: 'pulado', erro: reason, em: Date.now() });
      engine.proximoEm = Date.now() + delaySec * 1000;
      await VF.write('motor', engine);
    };

    const doNotDisturb = await VF.read('naoPerturbe', []);
    if (doNotDisturb.some((n) => n.ids.includes(id))) return skip('Está no Não perturbe', 1);

    await saveContact(campaign.id, i, { status: 'enviando' });
    saveStatus({ ...base, texto: `Enviando para ${contact.nome || VF.numberFromId(id) || 'contato'} (${base.feitos + 1}/${base.total})`, tipo: 'enviando' });

    try {
      if (!contact.verificado && id.endsWith('@c.us')) {
        const exact = await rpc('verificarNumero', id);
        if (!exact) {
          await saveContact(campaign.id, i, { status: 'falhou', erro: 'Número sem WhatsApp', em: Date.now() });
          engine.proximoEm = Date.now() + VF.random(5, 12) * 1000;
          return VF.write('motor', engine);
        }
        id = exact;
        await saveContact(campaign.id, i, { id, verificado: true });
      }
      const ids = await equivalents(id);
      if (doNotDisturb.some((n) => n.ids.some((x) => ids.includes(x)))) return skip('Está no Não perturbe', 1);

      const info = await rpc('infoChat', id).catch(() => null);
      const hours = campaign.pularRecenteHoras || 0;
      if (hours > 0 && !contact.ignorarRecente && info && info.t && Date.now() - info.t * 1000 < hours * 3600000) {
        return skip(`Conversou com você nas últimas ${hours}h (filtro da campanha)`, 2);
      }

      const name = nameOf(ids, '') || contact.nome || (info && info.nome) || (await rpc('nomeContato', id).catch(() => ''));
      const variations = (campaign.variacoes || []).filter((v) => v && v.length);
      let template = 0;
      if (variations.length > 1) {
        // Random pick, leaning towards the least-used template so far (stays balanced)
        const uses = variations.map((_, k) => campaign.contatos.filter((x) => x.modelo === k + 1).length);
        const smallest = Math.min(...uses);
        const candidates = uses.map((u, k) => (u <= smallest + 1 ? k : -1)).filter((k) => k >= 0);
        template = candidates[Math.floor(Math.random() * candidates.length)] + 1;
      }
      const outgoingSteps = template ? variations[template - 1] : campaign.etapas || [];
      const hasMessage = outgoingSteps.length > 0;
      if (hasMessage) await sendSteps(id, outgoingSteps, { nome: name, vendedor: cfg.nomeVendedor }, { digitacao: cfg.simularDigitacao });

      const notices = [];
      const a = campaign.acoes || {};
      const ops = [
        ...(a.addEtiquetas || []).map((labelId) => ({ labelId: String(labelId), type: 'add' })),
        ...(a.removerEtiquetas || []).map((labelId) => ({ labelId: String(labelId), type: 'remove' })),
      ];
      if (ops.length) {
        try {
          await rpc('etiquetar', [id], ops);
        } catch (e) {
          notices.push('Etiqueta: ' + e.message);
        }
      }
      if (a.addAba) await changeTab(a.addAba, ids, name, true);
      if (a.removerAba) await changeTab(a.removerAba, ids, name, false);

      await saveContact(campaign.id, i, { status: 'enviado', id, ids, nome: name, erro: notices.join(' | '), em: Date.now(), ...(template ? { modelo: template } : {}) });
      engine.falhasSeguidas = 0;
      if (hasMessage) {
        await VF.addSentToday();
        engine.noLote = (engine.noLote || 0) + 1;
        if (engine.noLote >= cfg.loteTamanho) {
          engine.noLote = 0;
          engine.proximoEm = Date.now() + VF.random(cfg.pausaLoteMin, cfg.pausaLoteMax) * 60000;
        } else {
          engine.proximoEm = Date.now() + VF.random(cfg.intervaloMin, cfg.intervaloMax) * 1000;
        }
      } else {
        engine.proximoEm = Date.now() + VF.random(1, 3) * 1000;
      }
      await VF.write('motor', engine);
    } catch (e) {
      engine.falhasSeguidas = (engine.falhasSeguidas || 0) + 1;
      const extras = {};
      if (engine.falhasSeguidas >= cfg.maxFalhasSeguidas) {
        extras.status = 'pausada';
        extras.motivo = `Pausada sozinha: ${engine.falhasSeguidas} falhas seguidas (último erro: ${e.message}). Confira o WhatsApp e clique em Retomar.`;
        engine.falhasSeguidas = 0;
        notify('⚠️ ' + extras.motivo, 'erro', 12000);
      }
      logError('campanha', `${campaign.nome}: ${e.message}`);
      await saveContact(campaign.id, i, { status: 'falhou', erro: e.message, em: Date.now() }, extras);
      engine.proximoEm = Date.now() + VF.random(cfg.intervaloMin, cfg.intervaloMax) * 1000;
      await VF.write('motor', engine);
    }
  }

  // Incoming message: unsubscribe and "replied"
  async function handleIncomingMessage(d) {
    const ids = d.ids && d.ids.length ? d.ids : [d.chatId];
    const cfg = await VF.config();
    if (d.texto && VF.askedToLeave(d.texto, cfg.palavrasSair)) {
      const list = await VF.read('naoPerturbe', []);
      if (!list.some((n) => n.ids.some((x) => ids.includes(x)))) {
        list.push({ ids, nome: d.nome || '', texto: d.texto.slice(0, 60), em: Date.now() });
        await VF.write('naoPerturbe', list);
        notify(`🚫 ${d.nome || 'Um contato'} pediu para sair ("${d.texto.slice(0, 30)}"). Não receberá mais envios em massa.`, 'info', 9000);
      }
    }
    // Only opens campaigns if the sender received one (before, it read everything on every incoming message)
    if (!waitingIds) {
      const s = new Set();
      for (const c of await readCampaigns()) {
        if (c.status === 'cancelada') continue;
        c.contatos.forEach((x) => x.status === 'enviado' && !x.respondeu && [x.id, ...(x.ids || [])].forEach((y) => s.add(y)));
      }
      waitingIds = s;
    }
    if (!ids.some((x) => waitingIds.has(x))) return;
    const campaigns = await readCampaigns();
    for (const c of campaigns) {
      if (c.status === 'cancelada') continue;
      const i = c.contatos.findIndex((x) => x.status === 'enviado' && !x.respondeu && [x.id, ...(x.ids || [])].some((y) => ids.includes(y)));
      if (i < 0) continue;
      const current = await VF.read('campanha:' + c.id);
      current.contatos[i].respondeu = true;
      current.contatos[i].respondeuEm = Date.now();
      await VF.write('campanha:' + c.id, current);
      const r = c.aoResponder || {};
      if (r.addAba) await changeTab(r.addAba, ids, current.contatos[i].nome, true);
      if (r.addEtiqueta) rpc('etiquetar', [d.chatId], [{ labelId: String(r.addEtiqueta), type: 'add' }]).catch(() => {});
    }
  }

  // =====================================================================
  // Messages from the background
  // =====================================================================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.tipo === 'tick') engineStep();
    if (msg.tipo === 'abrirPainel') openSidePanel(msg.secao || 'respostas');
    return false;
  });

  // =====================================================================
  // Stored data -> screen
  // =====================================================================
  async function reloadData() {
    tabs = await VF.read('abas', []);
    // Old label-only tabs (tipo 'etiqueta') become regular tabs linked to the label, kept in sync
    if (tabs.some((a) => a.tipo === 'etiqueta')) {
      tabs = tabs.map((a) => (a.tipo === 'etiqueta' ? { ...a, tipo: 'manual', chats: a.chats || [], sincronizar: true } : a));
      await VF.write('abas', tabs);
      syncLabelTabs();
    }
    replies = await VF.read('respostas', []);
    scripts = await VF.read('scripts', []);
    names = await VF.read('nomes', {});
    categories = await VF.read('categorias', []);
    if (!labels.length) labels = await VF.read('etiquetasCache', []);
    renderPills();
  }

  let redraw;
  chrome.storage.onChanged.addListener(async (chg, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(chg);
    if (keys.some((k) => k === 'campanhas' || k.startsWith('campanha:'))) campaignsChanged();
    if (chg.nomes) names = chg.nomes.newValue || {};
    if (chg.nomes || chg.abas) setTimeout(updateHeader, 50);
    if (chg.servidor) server = chg.servidor.newValue || { chave: '' };
    if (chg.automacoes) automations = chg.automacoes.newValue || {};
    if (chg.abas) reportTabChanges(chg.abas.oldValue, chg.abas.newValue);
    if (chg.abas || chg.respostas || chg.scripts || chg.categorias) {
      await reloadData();
      if (chg.abas && selectedTab !== 'todas') {
        const tab = tabs.find((a) => a.id === selectedTab);
        if (!tab) selectTab('todas');
        else if (tab.tipo === 'manual') rpc('filtrarLista', 'custom', tabIds(tab).length ? tabIds(tab) : ['0@c.us']).catch(() => {});
      }
    }
    if (chg.motorStatus && chg.motorStatus.newValue) {
      currentStatus = chg.motorStatus.newValue;
      updateStatus();
    }
    const campaignTouched = keys.some((k) => k.startsWith('campanha'));
    if (campaignTouched || chg.config) setTimeout(engineStep, 800);
    // Refreshes the open panel (except form screens)
    const relevant =
      (currentSection === 'respostas' && (chg.respostas || chg.scripts || chg.categorias)) ||
      (currentSection === 'abas' && chg.abas) ||
      (currentSection === 'envio' && (campaignTouched || chg.motorStatus)) ||
      (currentSection === 'naoperturbe' && chg.naoPerturbe) ||
      (currentSection === 'contato' && (chg.abas || chg.nomes));
    if (kanbanOpen && !draggingCard && (chg.abas || chg.nomes || chg.automacoes)) setTimeout(() => kanbanOpen && !draggingCard && renderKanban(), 150);
    if (relevant && !formScreen()) {
      clearTimeout(redraw);
      redraw = setTimeout(() => {
        const scroll = $('#corpo').scrollTop;
        renderSidePanel().then(() => ($('#corpo').scrollTop = scroll));
      }, 300);
    }
  });

  reloadData();
  bindKanbanEvents();
  loadServer();
  setInterval(syncKanban, 60000);
  setInterval(syncLabelTabs, 60000);
  VF.read('motorStatus', null).then((s) => s && ((currentStatus = s), updateStatus()));
  setInterval(engineStep, 15000);
  setTimeout(engineStep, 5000);
})();
