// Runs in the WhatsApp Web page's "world" (access to the WA-JS library's WPP object).
// Receives requests from the extension via window.postMessage and returns plain answers (no WhatsApp objects).
(() => {
  const CHANNEL = 'goseller';
  const ORIGIN = location.origin;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const notify = (data) => window.postMessage({ canal: CHANNEL, de: 'pagina', ...data }, ORIGIN);

  const serial = (wid) => (wid && (wid._serialized || (typeof wid === 'string' ? wid : ''))) || '';

  function contactName(contact) {
    if (!contact) return '';
    return contact.name || contact.verifiedName || contact.pushname || contact.notifyName || '';
  }

  function chatName(chat) {
    if (!chat) return '';
    const c = chat.contact;
    return (c && (c.name || c.verifiedName || c.pushname)) || chat.name || chat.formattedTitle || '';
  }

  function chatNumber(chat) {
    const c = chat && chat.contact;
    const phone = (c && c.phoneNumber && c.phoneNumber.user) || '';
    if (phone) return phone;
    const id = chat && chat.id;
    return id && id.server === 'c.us' ? id.user : '';
  }

  function chatLabels(chat) {
    const l = (chat && (chat.labels || (chat.contact && chat.contact.labels))) || [];
    return Array.isArray(l) ? l.map(String) : [];
  }

  function chatSummary(chat) {
    return {
      id: serial(chat.id),
      nome: chatName(chat),
      numero: chatNumber(chat),
      t: chat.t || 0,
      etiquetas: chatLabels(chat),
      grupo: !!chat.isGroup,
      arquivado: !!chat.archive,
    };
  }

  // Waits for a sent message to finish (without hanging forever).
  async function waitForSend(ret) {
    if (!ret) return { ok: true };
    const result = ret.sendMsgResult;
    if (result && typeof result.then === 'function') {
      const r = await Promise.race([result.then(() => 'ok', (e) => e), sleep(45000).then(() => 'tempo')]);
      if (r instanceof Error) throw r;
    }
    return { ok: true, id: serial(ret.id) || String(ret.id || ''), ack: ret.ack };
  }

  const handlers = {
    estado() {
      const W = window.WPP;
      return {
        biblioteca: !!W,
        pronto: !!(W && W.isFullReady),
        logado: !!(W && W.isFullReady && W.conn.isMainReady()),
        versao: W ? W.version : null,
      };
    },

    meuId() {
      return serial(WPP.conn.getMyUserId());
    },

    chatAtivo() {
      const chat = WPP.chat.getActiveChat();
      return chat ? chatSummary(chat) : null;
    },

    async etiquetas() {
      try {
        const list = await WPP.labels.getAllLabels();
        return list.map((l) => ({ id: String(l.id), nome: l.name, cor: l.hexColor, total: l.count }));
      } catch (e) {
        return []; // account without labels (regular WhatsApp)
      }
    },

    async listarChats(options = {}) {
      const filter = { onlyUsers: true };
      if (options.etiqueta) filter.withLabels = [String(options.etiqueta)];
      const chats = await WPP.chat.list(filter);
      return chats.map(chatSummary).filter((c) => !c.grupo && c.id && !c.id.endsWith('@broadcast'));
    },

    async infoChat(id) {
      const chat = WPP.chat.get(id);
      return chat ? chatSummary(chat) : null;
    },

    async nomeContato(id) {
      try {
        const chat = WPP.chat.get(id);
        if (chat) {
          const n = chatName(chat);
          if (n) return n;
        }
        const contact = await WPP.contact.get(id);
        return contactName(contact);
      } catch (e) {
        return '';
      }
    },

    // Checks whether the number has WhatsApp and returns the right id (handles the 9th digit).
    async verificarNumero(id) {
      const r = await WPP.contact.queryExists(id);
      return r && r.wid ? serial(r.wid) : null;
    },

    // Returns the equivalent forms of an id (phone @c.us and @lid).
    async equivalentes(id) {
      const list = [id];
      try {
        const e = await WPP.contact.getPnLidEntry(id);
        if (e && e.lid) list.push(e.lid._serialized);
        if (e && e.phoneNumber) list.push(e.phoneNumber._serialized);
      } catch (e) { /* id with no known equivalent */ }
      return [...new Set(list.filter(Boolean))];
    },

    async enviarTexto(id, text, options = {}) {
      const ms = options.digitandoMs || 0;
      if (ms > 0) {
        WPP.chat.markIsComposing(id).catch(() => {});
        await sleep(ms);
      }
      const r = await WPP.chat.sendTextMessage(id, text, { linkPreview: false });
      if (ms > 0) WPP.chat.markIsPaused(id).catch(() => {});
      return waitForSend(r);
    },

    async enviarArquivo(id, dataUrl, options = {}) {
      const ms = options.digitandoMs || 0;
      const type = options.tipo || 'auto-detect';
      if (ms > 0) {
        const mark = type === 'audio' && options.ptt ? WPP.chat.markIsRecording : WPP.chat.markIsComposing;
        mark(id).catch(() => {});
        await sleep(ms);
      }
      const op = { type: type };
      if (options.legenda && type !== 'audio') op.caption = options.legenda;
      if (options.nomeArquivo) op.filename = options.nomeArquivo;
      if (options.mime) op.mimetype = options.mime;
      if (type === 'audio') {
        op.isPtt = !!options.ptt;
        if (options.ptt) op.waveform = true;
      }
      const r = await WPP.chat.sendFileMessage(id, dataUrl, op);
      if (ms > 0) WPP.chat.markIsPaused(id).catch(() => {});
      return waitForSend(r);
    },

    async etiquetar(ids, operations) {
      if (!operations || !operations.length) return true;
      await WPP.labels.addOrRemoveLabels(ids, operations);
      return true;
    },

    // Saves the contact in WhatsApp (same as WhatsApp's own "Save contact"), with the chosen name
    async salvarContato(id, name) {
      const parts = String(name || '').trim().split(/\s+/);
      const firstOne = parts.shift();
      if (!firstOne) throw new Error('Nome vazio');
      await WPP.contact.save(id, firstOne, { lastName: parts.join(' '), syncAdressBook: true });
      return true;
    },

    async colarTexto(text, id) {
      await WPP.chat.setInputText(text, id || undefined);
      return true;
    },

    async filtrarLista(type, ids) {
      await WPP.chat.setChatList(type, ids);
      return true;
    },

    async abrirChat(id) {
      // If the chat isn't in the list yet (e.g.: number from a sheet), create it before opening
      try {
        await WPP.chat.find(id);
      } catch (e) {}
      await WPP.chat.openChatBottom(id);
      return true;
    },
  };

  // Requests coming from the extension
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.canal !== CHANNEL || d.de !== 'extensao') return;
    const fn = handlers[d.fn];
    if (!fn) return notify({ id: d.id, erro: 'Função desconhecida: ' + d.fn });
    try {
      if (d.fn !== 'estado' && !(window.WPP && WPP.isFullReady)) throw new Error('WhatsApp ainda carregando');
      const result = await fn(...(d.args || []));
      notify({ id: d.id, resultado: result });
    } catch (e) {
      notify({ id: d.id, erro: (e && (e.message || e.code)) || String(e) });
    }
  });

  // WhatsApp events forwarded to the extension
  function bindEvents() {
    WPP.on('chat.new_message', async (msg) => {
      try {
        if (!msg || !msg.id || msg.id.fromMe || !msg.isNewMsg) return;
        const chatId = serial(msg.id.remote) || serial(msg.from);
        if (!chatId || chatId.endsWith('@g.us') || chatId.includes('broadcast') || chatId.includes('newsletter')) return;
        const ids = await handlers.equivalentes(chatId);
        notify({
          tipo: 'evento',
          evento: 'mensagem',
          chatId,
          ids,
          texto: msg.type === 'chat' ? msg.body || '' : '',
          nome: contactName(msg.senderObj) || '',
        });
      } catch (e) { /* ignore */ }
    });
    WPP.on('chat.active_chat', (chat) => {
      notify({ tipo: 'evento', evento: 'chatAtivo', chat: chat ? chatSummary(chat) : null });
    });
    WPP.on('conn.main_ready', () => notify({ tipo: 'evento', evento: 'estado', estado: handlers.estado() }));
    WPP.on('conn.logout', () => notify({ tipo: 'evento', evento: 'estado', estado: handlers.estado() }));
  }

  (function waitForLibrary() {
    if (!window.WPP || !WPP.loader) return setTimeout(waitForLibrary, 500);
    WPP.loader.onFullReady(() => {
      bindEvents();
      notify({ tipo: 'evento', evento: 'estado', estado: handlers.estado() });
    });
  })();
})();
