// Barra do VendaFlow dentro do WhatsApp Web + motor do envio em massa.
(() => {
  if (window.top !== window) return;
  const CANAL = 'vendaflow';
  const ORIGEM = location.origin;
  const MEU_TOKEN = VF.novoId(); // identifica esta aba (evita 2 abas enviando ao mesmo tempo)

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
    if (d.tipo === 'evento') {
      if (d.evento === 'estado') {
        estadoWA = d.estado || estadoWA;
        if (estadoWA.logado) carregarEtiquetas();
        atualizarStatus();
      } else if (d.evento === 'chatAtivo') {
        chatAtual = d.chat;
        atualizarBotaoAbaChat();
      } else if (d.evento === 'mensagem') {
        tratarMensagemRecebida(d).catch((e) => console.warn('[VendaFlow]', e));
      }
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
  // Abas
  // =====================================================================
  let abas = [];
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
      desenharAbas();
    } catch (e) { /* ainda carregando */ }
  }

  async function selecionarAba(id) {
    abaSelecionada = id;
    desenharAbas();
    try {
      if (id === 'todas') return await rpc('filtrarLista', 'all');
      const aba = abas.find((a) => a.id === id);
      if (!aba) return selecionarAba('todas');
      if (aba.tipo === 'etiqueta') return await rpc('filtrarLista', 'labels', String(aba.etiquetaId));
      const ids = idsDaAba(aba);
      await rpc('filtrarLista', 'custom', ids.length ? ids : ['0@c.us']);
      if (!ids.length) avisar(`A aba "${aba.nome}" ainda está vazia. Abra uma conversa e use "🗂 Aba da conversa".`);
    } catch (e) {
      avisar('Não consegui filtrar: ' + e.message, 'erro');
    }
  }

  // =====================================================================
  // Interface (barra no topo, menus, avisos)
  // =====================================================================
  document.documentElement.classList.add('vf-ativo');
  const host = document.createElement('div');
  host.id = 'vf-host';
  host.style.cssText = 'position:fixed;top:0;left:0;right:0;height:40px;z-index:2147483000;';
  document.documentElement.appendChild(host);
  const raiz = host.attachShadow({ mode: 'open' });
  raiz.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL('src/barra.css')}">
    <div class="barra">
      <button class="marca" id="vfMarca" title="Abrir o painel do VendaFlow">⚡ VendaFlow</button>
      <div class="abas" id="vfAbas"></div>
      <button class="icone" id="vfNovaAba" title="Criar nova aba">＋</button>
      <div class="espaco"></div>
      <button id="vfAbaChat" disabled title="Colocar ou tirar a conversa aberta de uma aba">🗂 Aba da conversa</button>
      <button id="vfRespostas" title="Respostas rápidas (ou digite / na conversa)">⚡ Respostas</button>
      <button id="vfStatus" class="status">📢 Envio em massa</button>
    </div>
    <div class="menu oculto" id="vfMenu"></div>
    <div class="sugestoes oculto" id="vfSugestoes"></div>
    <div class="avisos" id="vfAvisos"></div>`;
  const $ = (s) => raiz.querySelector(s);
  const esc = VF.esc;

  function avisar(texto, tipo = 'info', ms = 4500) {
    const el = document.createElement('div');
    el.className = 'aviso ' + tipo;
    el.textContent = texto;
    $('#vfAvisos').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  const abrirPainel = (secao) => chrome.runtime.sendMessage({ tipo: 'abrirPainel', secao }).catch(() => {});

  // ---- Menu flutuante genérico ----
  let menuDono = null;
  function abrirMenu(botao, html, aoMontar) {
    const velho = $('#vfMenu');
    if (menuDono === botao && !velho.classList.contains('oculto')) return fecharMenu();
    menuDono = botao;
    const menu = velho.cloneNode(false); // nó novo = sem ouvintes de cliques antigos
    velho.replaceWith(menu);
    menu.innerHTML = html;
    menu.classList.remove('oculto');
    const r = botao.getBoundingClientRect();
    const largura = Math.min(420, window.innerWidth - 16);
    menu.style.width = largura + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - largura - 8)) + 'px';
    menu.style.top = r.bottom + 6 + 'px';
    if (aoMontar) aoMontar(menu);
  }
  function fecharMenu() {
    $('#vfMenu').classList.add('oculto');
    menuDono = null;
  }
  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes(host)) fecharMenu();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && fecharMenu());

  // ---- Abas ----
  function contagemAba(aba) {
    if (aba.tipo === 'etiqueta') {
      const et = etiquetas.find((x) => x.id === String(aba.etiquetaId));
      return et ? et.total : '?';
    }
    return (aba.chats || []).length;
  }

  function desenharAbas() {
    const html = [`<button class="aba ${abaSelecionada === 'todas' ? 'ativa' : ''}" data-aba="todas">Todas</button>`];
    for (const a of abas) {
      html.push(
        `<button class="aba ${abaSelecionada === a.id ? 'ativa' : ''}" data-aba="${esc(a.id)}" title="${a.tipo === 'etiqueta' ? 'Aba ligada a uma etiqueta' : 'Aba manual'}">` +
          `<span class="bolinha" style="background:${esc(a.cor || '#25d366')}"></span>${esc(a.nome)}` +
          `<span class="conta">${contagemAba(a)}</span></button>`
      );
    }
    $('#vfAbas').innerHTML = html.join('');
  }

  $('#vfAbas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (b) selecionarAba(b.dataset.aba);
  });

  $('#vfNovaAba').addEventListener('click', async () => {
    const nome = (prompt('Nome da nova aba (ex.: Novos, Negociando, Matriculados):') || '').trim();
    if (!nome) return;
    const cores = ['#25d366', '#34b7f1', '#f5a623', '#e91e63', '#9c27b0', '#ff5722', '#607d8b', '#00bfa5'];
    const lista = await VF.ler('abas', []);
    lista.push({ id: VF.novoId(), nome, cor: cores[lista.length % cores.length], tipo: 'manual', chats: [] });
    await VF.gravar('abas', lista);
    avisar(`Aba "${nome}" criada. Abra uma conversa e use "🗂 Aba da conversa" para colocar leads nela.`, 'ok');
  });

  function atualizarBotaoAbaChat() {
    const b = $('#vfAbaChat');
    b.disabled = !chatAtual || chatAtual.grupo;
  }

  $('#vfAbaChat').addEventListener('click', async (ev) => {
    const botao = ev.currentTarget;
    try {
      chatAtual = (await rpc('chatAtivo')) || chatAtual;
    } catch (e) { /* usa o último conhecido */ }
    if (!chatAtual) return avisar('Abra uma conversa primeiro.');
    const ids = await equivalentes(chatAtual.id);
    const linhas = abas.length
      ? abas.map((a) => {
          const marcado = a.tipo === 'etiqueta' ? chatAtual.etiquetas.includes(String(a.etiquetaId)) : abaTem(a, ids);
          return `<label class="item-check"><input type="checkbox" data-aba="${esc(a.id)}" ${marcado ? 'checked' : ''}>
            <span class="bolinha" style="background:${esc(a.cor)}"></span>${esc(a.nome)}
            ${a.tipo === 'etiqueta' ? '<small>(etiqueta)</small>' : ''}</label>`;
        }).join('')
      : '<p class="vazio">Você ainda não tem abas. Clique em ＋ na barra para criar.</p>';
    abrirMenu(
      botao,
      `<div class="menu-titulo">Abas de <b>${esc(chatAtual.nome || VF.numeroDoId(chatAtual.id) || 'contato')}</b></div>${linhas}`,
      (menu) =>
        menu.addEventListener('change', async (e) => {
          const cx = e.target.closest('input[data-aba]');
          if (!cx) return;
          const aba = abas.find((a) => a.id === cx.dataset.aba);
          try {
            if (aba.tipo === 'etiqueta') {
              await rpc('etiquetar', [chatAtual.id], [{ labelId: String(aba.etiquetaId), type: cx.checked ? 'add' : 'remove' }]);
              chatAtual = (await rpc('chatAtivo')) || chatAtual;
              carregarEtiquetas();
            } else {
              await alterarAba(aba.id, ids, chatAtual.nome, cx.checked);
            }
          } catch (er) {
            cx.checked = !cx.checked;
            avisar('Não deu certo: ' + er.message, 'erro');
          }
        })
    );
  });

  // ---- Respostas rápidas ----
  let respostas = [];
  const temSoTexto = (r) => r.etapas.length === 1 && r.etapas[0].tipo === 'texto';
  const resumoResposta = (r) =>
    r.etapas.map((e) => (e.tipo === 'texto' ? e.texto : '[' + (VF.TIPOS_MIDIA[e.tipoMidia] || 'Arquivo') + ']')).join(' · ');

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
    } catch (e) {
      avisar('Não consegui enviar: ' + e.message, 'erro');
    }
  }

  function htmlListaRespostas(filtro) {
    const f = VF.semAcento(filtro.toLowerCase());
    const lista = respostas.filter(
      (r) => !f || VF.semAcento((r.nome + ' ' + (r.atalho || '') + ' ' + (r.pasta || '') + ' ' + resumoResposta(r)).toLowerCase()).includes(f)
    );
    if (!lista.length) return '<p class="vazio">Nenhuma resposta encontrada.</p>';
    const pastas = {};
    lista.forEach((r) => (pastas[r.pasta || 'Geral'] ||= []).push(r));
    return Object.keys(pastas)
      .sort()
      .map(
        (p) =>
          `<div class="pasta">${esc(p)}</div>` +
          pastas[p]
            .map(
              (r) => `<div class="resposta">
            <div class="resp-info"><b>${esc(r.nome)}</b> ${r.atalho ? `<code>/${esc(r.atalho)}</code>` : ''}
              <div class="resp-previa">${esc(resumoResposta(r)).slice(0, 140)}</div></div>
            <div class="resp-botoes">
              ${temSoTexto(r) ? `<button class="sec" data-colar="${esc(r.id)}" title="Coloca no campo de texto para você editar">Colar</button>` : ''}
              <button data-enviar="${esc(r.id)}">Enviar</button>
            </div></div>`
            )
            .join('')
      )
      .join('');
  }

  $('#vfRespostas').addEventListener('click', (ev) => {
    abrirMenu(
      ev.currentTarget,
      `<input class="busca" id="vfBusca" placeholder="Buscar resposta...">
       <div class="lista" id="vfListaResp">${htmlListaRespostas('')}</div>
       <div class="menu-rodape"><button class="link" id="vfGerenciar">Criar / editar respostas</button></div>`,
      (menu) => {
        const busca = menu.querySelector('#vfBusca');
        busca.focus();
        busca.addEventListener('input', () => (menu.querySelector('#vfListaResp').innerHTML = htmlListaRespostas(busca.value)));
        menu.querySelector('#vfGerenciar').addEventListener('click', () => abrirPainel('respostas'));
        menu.addEventListener('click', (e) => {
          const b = e.target.closest('[data-enviar],[data-colar]');
          if (!b) return;
          const r = respostas.find((x) => x.id === (b.dataset.enviar || b.dataset.colar));
          fecharMenu();
          if (r) usarResposta(r, b.dataset.colar ? 'colar' : 'enviar');
        });
      }
    );
  });

  $('#vfMarca').addEventListener('click', () => abrirPainel('inicio'));

  // ---- Atalho "/" no campo de mensagem ----
  let sugestoes = [];
  let sugIndice = 0;

  const campoDeMensagem = (alvo) =>
    alvo && alvo.isContentEditable && alvo.closest && alvo.closest('footer') ? alvo.closest('[contenteditable="true"]') || alvo : null;

  function fecharSugestoes() {
    sugestoes = [];
    $('#vfSugestoes').classList.add('oculto');
  }

  function desenharSugestoes(campo) {
    const caixa = $('#vfSugestoes');
    if (!sugestoes.length) return fecharSugestoes();
    caixa.innerHTML =
      sugestoes
        .map(
          (r, i) => `<div class="sug ${i === sugIndice ? 'sel' : ''}" data-i="${i}">
          <code>/${esc(r.atalho || '')}</code> <b>${esc(r.nome)}</b><span>${esc(resumoResposta(r)).slice(0, 80)}</span></div>`
        )
        .join('') + '<div class="sug-dica">↑↓ escolher · Enter enviar · Tab colar · Esc fechar</div>';
    const r = campo.getBoundingClientRect();
    caixa.style.left = r.left + 'px';
    caixa.style.width = Math.max(320, Math.min(r.width, 560)) + 'px';
    caixa.style.bottom = window.innerHeight - r.top + 8 + 'px';
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

  $('#vfSugestoes').addEventListener('mousedown', (e) => {
    const s = e.target.closest('[data-i]');
    if (!s) return;
    e.preventDefault();
    escolherSugestao(Number(s.dataset.i), 'enviar');
  });

  // =====================================================================
  // Motor do envio em massa
  // =====================================================================
  let ocupado = false;
  let statusAtual = { texto: '📢 Envio em massa', tipo: 'parado' };

  async function gravarStatus(s) {
    statusAtual = { ...s, atualizado: Date.now() };
    await VF.gravar('motorStatus', statusAtual);
    atualizarStatus();
  }

  async function pegarTrava() {
    const t = await VF.ler('motorTrava', null);
    if (t && t.token !== MEU_TOKEN && t.ate > Date.now()) return false;
    await VF.gravar('motorTrava', { token: MEU_TOKEN, ate: Date.now() + 3 * 60 * 1000 });
    return true;
  }

  async function lerCampanhas() {
    const ids = await VF.ler('campanhas', []);
    const r = await chrome.storage.local.get(ids.map((id) => 'campanha:' + id));
    return ids.map((id) => r['campanha:' + id]).filter(Boolean);
  }

  // Atualiza um contato da campanha relendo do armazenamento (não desfaz pausas feitas pelo painel)
  async function salvarContato(campanhaId, indice, mudancas, extras = {}) {
    const chave = 'campanha:' + campanhaId;
    const c = await VF.ler(chave, null);
    if (!c) return null;
    Object.assign(c.contatos[indice], mudancas);
    Object.assign(c, extras);
    await VF.gravar(chave, c);
    return c;
  }

  function formatarEspera(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  async function passoDoMotor() {
    if (ocupado) return;
    ocupado = true;
    try {
      const campanhas = await lerCampanhas();
      const campanha = campanhas.find((c) => c.status === 'ativa');
      if (!campanha) {
        if (statusAtual.tipo !== 'parado') await gravarStatus({ texto: '📢 Envio em massa', tipo: 'parado' });
        return;
      }
      if (!(await pegarTrava())) return; // outra aba do WhatsApp está cuidando dos envios

      const cfg = await VF.config();
      const base = { campanhaId: campanha.id, campanhaNome: campanha.nome };
      const feitos = campanha.contatos.filter((x) => x.status !== 'pendente').length;
      const total = campanha.contatos.length;
      base.feitos = feitos;
      base.total = total;

      if (!estadoWA.logado) {
        try {
          estadoWA = await rpc('estado');
        } catch (e) { /* segue */ }
        if (!estadoWA.logado) return gravarStatus({ ...base, texto: '⏳ Aguardando o WhatsApp conectar', tipo: 'aguardando' });
      }
      if (!VF.dentroDoHorario(cfg)) {
        return gravarStatus({ ...base, texto: `🌙 Fora do horário (${cfg.horaInicio}–${cfg.horaFim})`, tipo: 'aguardando' });
      }
      const hojeN = await VF.enviosHoje();
      if (hojeN >= cfg.limiteDia) {
        return gravarStatus({ ...base, texto: `✋ Limite do dia atingido (${hojeN}/${cfg.limiteDia})`, tipo: 'aguardando' });
      }
      const motor = await VF.ler('motor', { proximoEm: 0, noLote: 0, falhasSeguidas: 0 });
      if (Date.now() < motor.proximoEm) {
        return gravarStatus({ ...base, texto: `📢 ${campanha.nome}: ${feitos}/${total}`, tipo: 'enviando', proximoEm: motor.proximoEm });
      }

      // Contato interrompido no meio (aba fechada durante o envio): não reenvia para não duplicar
      const interrompido = campanha.contatos.findIndex((x) => x.status === 'enviando');
      if (interrompido >= 0) {
        await salvarContato(campanha.id, interrompido, { status: 'falhou', erro: 'Envio interrompido (confira a conversa)', em: Date.now() });
      }

      const i = campanha.contatos.findIndex((x) => x.status === 'pendente');
      if (i < 0) {
        const c = await VF.ler('campanha:' + campanha.id);
        c.status = 'concluida';
        c.concluidaEm = Date.now();
        await VF.gravar('campanha:' + campanha.id, c);
        avisar(`✅ Campanha "${campanha.nome}" concluída.`, 'ok', 8000);
        return gravarStatus({ texto: '📢 Envio em massa', tipo: 'parado' });
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
    const agora = Date.now();
    const pular = async (motivo, esperaSeg) => {
      await salvarContato(campanha.id, i, { status: 'pulado', erro: motivo, em: Date.now() });
      motor.proximoEm = Date.now() + esperaSeg * 1000;
      await VF.gravar('motor', motor);
    };

    // Lista de "não perturbe"
    const naoPerturbe = await VF.ler('naoPerturbe', []);
    if (naoPerturbe.some((n) => n.ids.includes(id))) return pular('Pediu para não receber mensagens', 1);

    await salvarContato(campanha.id, i, { status: 'enviando' });
    gravarStatus({ ...base, texto: `📤 Enviando para ${contato.nome || VF.numeroDoId(id) || 'contato'}… (${base.feitos + 1}/${base.total})`, tipo: 'enviando' });

    try {
      // Número digitado/colado: confere se tem WhatsApp (e acerta o 9º dígito)
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
      if (naoPerturbe.some((n) => n.ids.some((x) => ids.includes(x)))) {
        await salvarContato(campanha.id, i, { status: 'pendente' });
        return pular('Pediu para não receber mensagens', 1);
      }

      // Pular quem conversou recentemente
      const info = await rpc('infoChat', id).catch(() => null);
      if (campanha.pularRecenteHoras > 0 && info && info.t && agora - info.t * 1000 < campanha.pularRecenteHoras * 3600000) {
        await salvarContato(campanha.id, i, { status: 'pendente' });
        return pular(`Conversa nas últimas ${campanha.pularRecenteHoras}h`, 2);
      }

      const nome = contato.nome || (info && info.nome) || (await rpc('nomeContato', id).catch(() => ''));
      const temMensagem = (campanha.etapas || []).length > 0;
      if (temMensagem) {
        await enviarEtapas(id, campanha.etapas, { nome, vendedor: cfg.nomeVendedor }, { digitacao: cfg.simularDigitacao });
      }

      // Ações depois do envio (etiquetas e abas)
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
        extras.motivo = `Pausada sozinha: ${motor.falhasSeguidas} falhas seguidas. Confira se o WhatsApp está conectado e retome.`;
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

  // ---- Indicador do envio na barra ----
  function atualizarStatus() {
    const b = $('#vfStatus');
    const s = statusAtual;
    let texto = s.texto || '📢 Envio em massa';
    if (s.tipo === 'enviando' && s.proximoEm) {
      const falta = s.proximoEm - Date.now();
      texto = falta > 0 ? `${texto} · próximo em ${formatarEspera(falta)}` : `${texto} · enviando…`;
    }
    b.textContent = texto;
    b.className = 'status ' + (s.tipo || 'parado');
  }
  setInterval(atualizarStatus, 1000);

  $('#vfStatus').addEventListener('click', async (ev) => {
    const botao = ev.currentTarget;
    const campanhas = await lerCampanhas();
    const ativas = campanhas.filter((c) => c.status === 'ativa' || c.status === 'pausada');
    const hojeN = await VF.enviosHoje();
    const cfg = await VF.config();
    const linhas = ativas.length
      ? ativas
          .map((c) => {
            const feitos = c.contatos.filter((x) => x.status !== 'pendente').length;
            const pct = c.contatos.length ? Math.round((feitos / c.contatos.length) * 100) : 0;
            return `<div class="camp">
              <div><b>${esc(c.nome)}</b> <small>${c.status === 'ativa' ? 'enviando' : 'pausada'}</small></div>
              <div class="progresso"><div style="width:${pct}%"></div></div>
              <small>${feitos} de ${c.contatos.length} · ${c.contatos.filter((x) => x.respondeu).length} responderam</small>
              ${c.motivo && c.status === 'pausada' ? `<small class="alerta">${esc(c.motivo)}</small>` : ''}
              <div><button data-alternar="${esc(c.id)}">${c.status === 'ativa' ? '⏸ Pausar' : '▶ Retomar'}</button></div>
            </div>`;
          })
          .join('')
      : '<p class="vazio">Nenhuma campanha em andamento.</p>';
    abrirMenu(
      botao,
      `<div class="menu-titulo">Envio em massa · hoje ${hojeN}/${cfg.limiteDia}</div>${linhas}
       <div class="menu-rodape"><button class="link" id="vfCamps">Abrir campanhas / criar nova</button></div>`,
      (menu) => {
        menu.querySelector('#vfCamps').addEventListener('click', () => abrirPainel('campanhas'));
        menu.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-alternar]');
          if (!b) return;
          const c = await VF.ler('campanha:' + b.dataset.alternar);
          c.status = c.status === 'ativa' ? 'pausada' : 'ativa';
          c.motivo = '';
          await VF.gravar('campanha:' + c.id, c);
          fecharMenu();
          avisar(c.status === 'ativa' ? '▶ Campanha retomada.' : '⏸ Campanha pausada.', 'ok');
          if (c.status === 'ativa') setTimeout(passoDoMotor, 500);
        });
      }
    );
  });

  // =====================================================================
  // Pedidos do painel e do background
  // =====================================================================
  const PERMITIDAS_PAINEL = ['estado', 'etiquetas', 'listarChats', 'meuId'];

  chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
    if (msg.tipo === 'tick') {
      passoDoMotor();
      return false;
    }
    if (msg.tipo === 'rpc' && PERMITIDAS_PAINEL.includes(msg.fn)) {
      rpc(msg.fn, ...(msg.args || [])).then(
        (resultado) => responder({ resultado }),
        (e) => responder({ erro: e.message })
      );
      return true;
    }
    if (msg.tipo === 'testeParaMim') {
      (async () => {
        const eu = await rpc('meuId');
        if (!eu) throw new Error('Não achei o seu número');
        const cfg = await VF.config();
        await enviarEtapas(eu, msg.etapas, { nome: msg.nome || 'Maria Teste', vendedor: cfg.nomeVendedor }, { digitacao: false });
      })().then(
        () => responder({ resultado: true }),
        (e) => responder({ erro: e.message })
      );
      return true;
    }
    return false;
  });

  // =====================================================================
  // Dados guardados -> tela
  // =====================================================================
  async function recarregarDados() {
    abas = await VF.ler('abas', []);
    respostas = await VF.ler('respostas', []);
    etiquetas = etiquetas.length ? etiquetas : await VF.ler('etiquetasCache', []);
    desenharAbas();
  }

  chrome.storage.onChanged.addListener(async (mud, area) => {
    if (area !== 'local') return;
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
    if (mud.config || Object.keys(mud).some((k) => k.startsWith('campanha'))) {
      // campanha criada/retomada no painel: tenta andar logo
      setTimeout(passoDoMotor, 800);
    }
  });

  recarregarDados();
  VF.ler('motorStatus', null).then((s) => s && ((statusAtual = s), atualizarStatus()));
  // Relógio próprio (quando a aba está visível); o background também "cutuca" a cada 30s
  setInterval(passoDoMotor, 15000);
  setTimeout(passoDoMotor, 5000);
})();
