// Roda no "mundo" da página do WhatsApp Web (acesso ao objeto WPP da biblioteca WA-JS).
// Recebe pedidos da extensão por window.postMessage e devolve respostas simples (sem objetos do WhatsApp).
(() => {
  const CANAL = 'vendaflow';
  const ORIGEM = location.origin;
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  const avisar = (dados) => window.postMessage({ canal: CANAL, de: 'pagina', ...dados }, ORIGEM);

  const serial = (wid) => (wid && (wid._serialized || (typeof wid === 'string' ? wid : ''))) || '';

  function nomeDoContato(contato) {
    if (!contato) return '';
    return contato.name || contato.verifiedName || contato.pushname || contato.notifyName || '';
  }

  function nomeDoChat(chat) {
    if (!chat) return '';
    const c = chat.contact;
    return (c && (c.name || c.verifiedName || c.pushname)) || chat.name || chat.formattedTitle || '';
  }

  function numeroDoChat(chat) {
    const c = chat && chat.contact;
    const tel = (c && c.phoneNumber && c.phoneNumber.user) || '';
    if (tel) return tel;
    const id = chat && chat.id;
    return id && id.server === 'c.us' ? id.user : '';
  }

  function etiquetasDoChat(chat) {
    const l = (chat && (chat.labels || (chat.contact && chat.contact.labels))) || [];
    return Array.isArray(l) ? l.map(String) : [];
  }

  function resumoChat(chat) {
    return {
      id: serial(chat.id),
      nome: nomeDoChat(chat),
      numero: numeroDoChat(chat),
      t: chat.t || 0,
      etiquetas: etiquetasDoChat(chat),
      grupo: !!chat.isGroup,
      arquivado: !!chat.archive,
    };
  }

  // Aguarda o fim de uma mensagem enviada (sem travar para sempre).
  async function aguardarEnvio(retorno) {
    if (!retorno) return { ok: true };
    const resultado = retorno.sendMsgResult;
    if (resultado && typeof resultado.then === 'function') {
      const r = await Promise.race([resultado.then(() => 'ok', (e) => e), dormir(45000).then(() => 'tempo')]);
      if (r instanceof Error) throw r;
    }
    return { ok: true, id: serial(retorno.id) || String(retorno.id || ''), ack: retorno.ack };
  }

  const funcoes = {
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
      return chat ? resumoChat(chat) : null;
    },

    async etiquetas() {
      try {
        const lista = await WPP.labels.getAllLabels();
        return lista.map((l) => ({ id: String(l.id), nome: l.name, cor: l.hexColor, total: l.count }));
      } catch (e) {
        return []; // conta sem etiquetas (WhatsApp comum)
      }
    },

    async listarChats(opcoes = {}) {
      const filtro = { onlyUsers: true };
      if (opcoes.etiqueta) filtro.withLabels = [String(opcoes.etiqueta)];
      const chats = await WPP.chat.list(filtro);
      return chats.map(resumoChat).filter((c) => !c.grupo && c.id && !c.id.endsWith('@broadcast'));
    },

    async infoChat(id) {
      const chat = WPP.chat.get(id);
      return chat ? resumoChat(chat) : null;
    },

    async nomeContato(id) {
      try {
        const chat = WPP.chat.get(id);
        if (chat) {
          const n = nomeDoChat(chat);
          if (n) return n;
        }
        const contato = await WPP.contact.get(id);
        return nomeDoContato(contato);
      } catch (e) {
        return '';
      }
    },

    // Confere se o número tem WhatsApp e devolve o id certo (resolve o 9º dígito).
    async verificarNumero(id) {
      const r = await WPP.contact.queryExists(id);
      return r && r.wid ? serial(r.wid) : null;
    },

    // Devolve as formas equivalentes de um id (telefone @c.us e @lid).
    async equivalentes(id) {
      const lista = [id];
      try {
        const e = await WPP.contact.getPnLidEntry(id);
        if (e && e.lid) lista.push(e.lid._serialized);
        if (e && e.phoneNumber) lista.push(e.phoneNumber._serialized);
      } catch (e) { /* id sem equivalente conhecido */ }
      return [...new Set(lista.filter(Boolean))];
    },

    async enviarTexto(id, texto, opcoes = {}) {
      const ms = opcoes.digitandoMs || 0;
      if (ms > 0) {
        WPP.chat.markIsComposing(id).catch(() => {});
        await dormir(ms);
      }
      const r = await WPP.chat.sendTextMessage(id, texto, { linkPreview: false });
      if (ms > 0) WPP.chat.markIsPaused(id).catch(() => {});
      return aguardarEnvio(r);
    },

    async enviarArquivo(id, dataUrl, opcoes = {}) {
      const ms = opcoes.digitandoMs || 0;
      const tipo = opcoes.tipo || 'auto-detect';
      if (ms > 0) {
        const marcar = tipo === 'audio' && opcoes.ptt ? WPP.chat.markIsRecording : WPP.chat.markIsComposing;
        marcar(id).catch(() => {});
        await dormir(ms);
      }
      const op = { type: tipo };
      if (opcoes.legenda && tipo !== 'audio') op.caption = opcoes.legenda;
      if (opcoes.nomeArquivo) op.filename = opcoes.nomeArquivo;
      if (opcoes.mime) op.mimetype = opcoes.mime;
      if (tipo === 'audio') {
        op.isPtt = !!opcoes.ptt;
        if (opcoes.ptt) op.waveform = true;
      }
      const r = await WPP.chat.sendFileMessage(id, dataUrl, op);
      if (ms > 0) WPP.chat.markIsPaused(id).catch(() => {});
      return aguardarEnvio(r);
    },

    async etiquetar(ids, operacoes) {
      if (!operacoes || !operacoes.length) return true;
      await WPP.labels.addOrRemoveLabels(ids, operacoes);
      return true;
    },

    // Salva o contato no WhatsApp (igual ao "Salvar contato" do próprio WhatsApp), com o nome escolhido
    async salvarContato(id, nome) {
      const partes = String(nome || '').trim().split(/\s+/);
      const primeiro = partes.shift();
      if (!primeiro) throw new Error('Nome vazio');
      await WPP.contact.save(id, primeiro, { lastName: partes.join(' '), syncAdressBook: true });
      return true;
    },

    async colarTexto(texto, id) {
      await WPP.chat.setInputText(texto, id || undefined);
      return true;
    },

    async filtrarLista(tipo, ids) {
      await WPP.chat.setChatList(tipo, ids);
      return true;
    },

    async abrirChat(id) {
      await WPP.chat.openChatBottom(id);
      return true;
    },
  };

  // Pedidos vindos da extensão
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.canal !== CANAL || d.de !== 'extensao') return;
    const fn = funcoes[d.fn];
    if (!fn) return avisar({ id: d.id, erro: 'Função desconhecida: ' + d.fn });
    try {
      if (d.fn !== 'estado' && !(window.WPP && WPP.isFullReady)) throw new Error('WhatsApp ainda carregando');
      const resultado = await fn(...(d.args || []));
      avisar({ id: d.id, resultado });
    } catch (e) {
      avisar({ id: d.id, erro: (e && (e.message || e.code)) || String(e) });
    }
  });

  // Eventos do WhatsApp repassados à extensão
  function ligarEventos() {
    WPP.on('chat.new_message', async (msg) => {
      try {
        if (!msg || !msg.id || msg.id.fromMe || !msg.isNewMsg) return;
        const chatId = serial(msg.id.remote) || serial(msg.from);
        if (!chatId || chatId.endsWith('@g.us') || chatId.includes('broadcast') || chatId.includes('newsletter')) return;
        const ids = await funcoes.equivalentes(chatId);
        avisar({
          tipo: 'evento',
          evento: 'mensagem',
          chatId,
          ids,
          texto: msg.type === 'chat' ? msg.body || '' : '',
          nome: nomeDoContato(msg.senderObj) || '',
        });
      } catch (e) { /* ignora */ }
    });
    WPP.on('chat.active_chat', (chat) => {
      avisar({ tipo: 'evento', evento: 'chatAtivo', chat: chat ? resumoChat(chat) : null });
    });
    WPP.on('conn.main_ready', () => avisar({ tipo: 'evento', evento: 'estado', estado: funcoes.estado() }));
    WPP.on('conn.logout', () => avisar({ tipo: 'evento', evento: 'estado', estado: funcoes.estado() }));
  }

  (function esperarBiblioteca() {
    if (!window.WPP || !WPP.loader) return setTimeout(esperarBiblioteca, 500);
    WPP.loader.onFullReady(() => {
      ligarEventos();
      avisar({ tipo: 'evento', evento: 'estado', estado: funcoes.estado() });
    });
  })();
})();
