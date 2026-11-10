// Painel do VendaFlow: respostas rápidas, abas, campanhas, configurações e backup.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = VF.esc;
const main = $('#conteudo');

function avisar(texto, tipo = 'ok', ms = 4000) {
  const a = $('#aviso');
  a.textContent = texto;
  a.className = 'aviso-flutuante ' + tipo;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => a.classList.add('oculto'), ms);
}

const dataHora = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

// ---------- Conversa com a aba do WhatsApp Web ----------
async function abaWhatsApp() {
  const abas = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  return abas[0] || null;
}

async function wa(fn, ...args) {
  const aba = await abaWhatsApp();
  if (!aba) throw new Error('Abra o WhatsApp Web (web.whatsapp.com) em outra aba.');
  let r;
  try {
    r = await chrome.tabs.sendMessage(aba.id, { tipo: 'rpc', fn, args });
  } catch (e) {
    throw new Error('Recarregue a aba do WhatsApp Web (F5) e tente de novo.');
  }
  if (!r) throw new Error('O WhatsApp Web não respondeu.');
  if (r.erro) throw new Error(r.erro);
  return r.resultado;
}

async function testeParaMim(etapas) {
  const aba = await abaWhatsApp();
  if (!aba) throw new Error('Abra o WhatsApp Web em outra aba.');
  const r = await chrome.tabs.sendMessage(aba.id, { tipo: 'testeParaMim', etapas });
  if (r && r.erro) throw new Error(r.erro);
}

async function verificarWA() {
  const el = $('#estadoWA');
  try {
    const e = await wa('estado');
    if (e.logado) {
      el.className = 'estado-wa ok';
      el.textContent = '🟢 WhatsApp Web conectado';
    } else {
      el.className = 'estado-wa';
      el.textContent = '🟡 WhatsApp Web aberto, mas ainda carregando ou desconectado';
    }
    return e.logado;
  } catch (e) {
    el.className = 'estado-wa';
    el.textContent = '🔴 ' + e.message;
    return false;
  }
}

async function etiquetasAtuais() {
  try {
    const l = await wa('etiquetas');
    await VF.gravar('etiquetasCache', l);
    return l;
  } catch (e) {
    return VF.ler('etiquetasCache', []);
  }
}

// ---------- Navegação ----------
const secoes = {};
async function navegar() {
  const secao = (location.hash || '#inicio').slice(1).split('/')[0];
  $$('nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.secao === secao));
  main.innerHTML = '';
  await (secoes[secao] || secoes.inicio)();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', navegar);

// =====================================================================
// INÍCIO
// =====================================================================
secoes.inicio = async () => {
  const [respostas, abas, ids, hojeN, cfg, status] = await Promise.all([
    VF.ler('respostas', []), VF.ler('abas', []), VF.ler('campanhas', []), VF.enviosHoje(), VF.config(), VF.ler('motorStatus', null),
  ]);
  main.innerHTML = `
    <h1>Olá${cfg.nomeVendedor ? ', ' + esc(cfg.nomeVendedor) : ''}! 👋</h1>
    <p class="sub">Tudo fica salvo só neste computador. Para usar, deixe o <b>WhatsApp Web</b> aberto em uma aba — a barra do VendaFlow aparece no topo dele.</p>
    <div class="numeros">
      <div class="numero"><b>${respostas.length}</b><span>respostas rápidas</span></div>
      <div class="numero"><b>${abas.length}</b><span>abas</span></div>
      <div class="numero"><b>${ids.length}</b><span>campanhas</span></div>
      <div class="numero"><b>${hojeN}/${cfg.limiteDia}</b><span>envios em massa hoje</span></div>
    </div>
    ${status && status.tipo !== 'parado' ? `<div class="cartao"><b>Agora:</b> ${esc(status.texto)}</div>` : ''}
    <div class="cartao">
      <h3>Como começar</h3>
      <ol style="line-height:1.8;margin:0;padding-left:20px">
        <li>Vá em <a href="#config">⚙️ Configurações</a> e coloque o seu nome (usado em <code>{vendedor}</code>).</li>
        <li>Crie suas <a href="#respostas">⚡ Respostas rápidas</a>. Na conversa, digite <code>/</code> + atalho, ou clique em "⚡ Respostas" na barra.</li>
        <li>Crie <a href="#abas">🗂 Abas</a> (ex.: Novos, Negociando, Matriculados). Na conversa aberta, use "🗂 Aba da conversa" para mover o lead.</li>
        <li>No <a href="#campanhas">📢 Envio em massa</a>, escolha o público, a mensagem e o que fazer depois (etiquetas/abas). Os envios seguem sozinhos, devagar, com o WhatsApp Web aberto.</li>
      </ol>
    </div>
    <div class="alerta">⚠️ Envio em massa sempre tem risco de bloqueio do número. O que mais pesa é o lead <b>denunciar</b> a mensagem. Prefira mandar para quem já conversou com você, use variações de texto e mantenha o ritmo lento.</div>`;
};

// =====================================================================
// RESPOSTAS RÁPIDAS
// =====================================================================
secoes.respostas = async () => {
  const respostas = await VF.ler('respostas', []);
  const editando = location.hash.split('/')[1];
  if (editando) return editarResposta(respostas, editando);

  const resumo = (r) => r.etapas.map((e) => (e.tipo === 'texto' ? e.texto : '[' + VF.TIPOS_MIDIA[e.tipoMidia] + ']')).join(' · ');
  main.innerHTML = `
    <div class="linha"><div class="cresce"><h1>⚡ Respostas rápidas</h1>
      <p class="sub">Mensagens prontas para enviar com um clique. Podem ter vários passos: texto + áudio + vídeo + PDF.</p></div>
      <button id="nova">+ Nova resposta</button></div>
    <div id="lista">${
      respostas.length
        ? respostas
            .map(
              (r) => `<div class="item-lista">
          <div class="cresce"><b>${esc(r.nome)}</b> ${r.atalho ? `<code>/${esc(r.atalho)}</code>` : ''} <span class="etiqueta-chip">${esc(r.pasta || 'Geral')}</span>
            <small>${esc(resumo(r)).slice(0, 160)}</small></div>
          <a href="#respostas/${esc(r.id)}"><button class="sec peq">Editar</button></a>
          <button class="sec peq" data-dup="${esc(r.id)}">Duplicar</button>
          <button class="perigo peq" data-del="${esc(r.id)}">Excluir</button></div>`
            )
            .join('')
        : '<div class="vazio">Nenhuma resposta ainda. Clique em <b>+ Nova resposta</b>.</div>'
    }</div>`;
  $('#nova').onclick = () => (location.hash = 'respostas/nova');
  $('#lista').onclick = async (e) => {
    const dup = e.target.closest('[data-dup]');
    const del = e.target.closest('[data-del]');
    if (dup) {
      const r = respostas.find((x) => x.id === dup.dataset.dup);
      respostas.push({ ...JSON.parse(JSON.stringify(r)), id: VF.novoId(), nome: r.nome + ' (cópia)', atalho: '' });
      await VF.gravar('respostas', respostas);
      navegar();
    }
    if (del && confirm('Excluir esta resposta?')) {
      await VF.gravar('respostas', respostas.filter((x) => x.id !== del.dataset.del));
      navegar();
    }
  };
};

function editarResposta(respostas, id) {
  const r = respostas.find((x) => x.id === id) || { id: VF.novoId(), nome: '', atalho: '', pasta: '', etapas: [{ tipo: 'texto', texto: '', espera: 2 }] };
  const pastas = [...new Set(respostas.map((x) => x.pasta).filter(Boolean))];
  main.innerHTML = `
    <h1>${id === 'nova' ? 'Nova resposta rápida' : 'Editar resposta'}</h1>
    <p class="sub"><a href="#respostas">← voltar</a></p>
    <div class="cartao grade">
      <label class="campo">Nome<input type="text" id="nome" value="${esc(r.nome)}" placeholder="Ex.: Preço do técnico"></label>
      <label class="campo">Atalho <small>Digite /atalho na conversa</small><input type="text" id="atalho" value="${esc(r.atalho || '')}" placeholder="preco"></label>
      <label class="campo">Pasta<input type="text" id="pasta" list="pastas" value="${esc(r.pasta || '')}" placeholder="Ex.: Preços, Objeções">
        <datalist id="pastas">${pastas.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
    </div>
    <div class="cartao"><h3>Mensagens</h3><div id="etapas"></div></div>
    <div class="botoes"><button id="salvar">Salvar</button><button class="sec" id="teste">Enviar teste para mim</button><a href="#respostas"><button class="sec">Cancelar</button></a></div>`;
  const editor = EditorEtapas($('#etapas'), r.etapas);
  $('#teste').onclick = async () => {
    const erro = editor.validar();
    if (erro) return avisar(erro, 'erro');
    try {
      await testeParaMim(editor.valor());
      avisar('Enviado para o seu próprio número. Confira no WhatsApp.');
    } catch (e) {
      avisar(e.message, 'erro');
    }
  };
  $('#salvar').onclick = async () => {
    const nome = $('#nome').value.trim();
    const atalho = $('#atalho').value.trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
    if (!nome) return avisar('Dê um nome para a resposta.', 'erro');
    const erro = editor.validar();
    if (erro) return avisar(erro, 'erro');
    if (!editor.valor().length) return avisar('Adicione pelo menos uma mensagem.', 'erro');
    const lista = await VF.ler('respostas', []);
    if (atalho && lista.some((x) => x.atalho === atalho && x.id !== r.id)) return avisar(`Já existe uma resposta com o atalho /${atalho}.`, 'erro');
    const nova = { ...r, nome, atalho, pasta: $('#pasta').value.trim(), etapas: editor.valor() };
    const i = lista.findIndex((x) => x.id === r.id);
    if (i >= 0) lista[i] = nova;
    else lista.push(nova);
    await VF.gravar('respostas', lista);
    avisar('Resposta salva.');
    location.hash = 'respostas';
  };
}

// =====================================================================
// ABAS
// =====================================================================
secoes.abas = async () => {
  const abas = await VF.ler('abas', []);
  const etiquetas = await etiquetasAtuais();
  const opcoesEtiq = (sel) => etiquetas.map((e) => `<option value="${esc(e.id)}" ${String(sel) === e.id ? 'selected' : ''}>${esc(e.nome)}</option>`).join('');
  main.innerHTML = `
    <div class="linha"><div class="cresce"><h1>🗂 Abas</h1>
      <p class="sub">As abas aparecem na barra do WhatsApp Web e filtram a lista de conversas.<br>
      <b>Manual:</b> você coloca cada lead (botão "🗂 Aba da conversa"). <b>Etiqueta:</b> a aba mostra quem tem uma etiqueta do WhatsApp Business.</p></div>
      <button id="nova">+ Nova aba</button></div>
    <div id="lista">${
      abas.length
        ? abas
            .map(
              (a, i) => `<div class="cartao" data-id="${esc(a.id)}">
          <div class="linha">
            <input type="color" data-campo="cor" value="${esc(a.cor || '#25d366')}">
            <input type="text" data-campo="nome" value="${esc(a.nome)}" style="max-width:240px">
            <select data-campo="tipo" style="max-width:150px">
              <option value="manual" ${a.tipo !== 'etiqueta' ? 'selected' : ''}>Manual</option>
              <option value="etiqueta" ${a.tipo === 'etiqueta' ? 'selected' : ''}>Etiqueta</option></select>
            ${
              a.tipo === 'etiqueta'
                ? `<select data-campo="etiquetaId" style="max-width:220px">${etiquetas.length ? '<option value="">Escolha a etiqueta…</option>' + opcoesEtiq(a.etiquetaId) : '<option value="">Abra o WhatsApp Web para listar</option>'}</select>`
                : `<span class="dica">${(a.chats || []).length} lead(s)</span>`
            }
            <div class="cresce"></div>
            <button class="sec peq" data-mover="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="sec peq" data-mover="1" ${i === abas.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="perigo peq" data-del>Excluir</button>
          </div>
          ${
            a.tipo !== 'etiqueta' && (a.chats || []).length
              ? `<details style="margin-top:10px"><summary>Ver leads</summary><div class="lista-leads">${a.chats
                  .map(
                    (c, j) => `<div><span>${esc(c.nome || '')} <small class="dica">${esc(VF.numeroDoId(c.ids.find((x) => x.endsWith('@c.us'))) || '')}</small></span>
                    <button class="perigo peq" data-tirar="${j}">tirar</button></div>`
                  )
                  .join('')}</div></details>`
              : ''
          }</div>`
            )
            .join('')
        : '<div class="vazio">Nenhuma aba ainda.</div>'
    }</div>`;

  const salvar = async (lista) => {
    await VF.gravar('abas', lista);
  };
  $('#nova').onclick = async () => {
    const cores = ['#25d366', '#34b7f1', '#f5a623', '#e91e63', '#9c27b0', '#ff5722', '#607d8b', '#00bfa5'];
    abas.push({ id: VF.novoId(), nome: 'Nova aba', cor: cores[abas.length % cores.length], tipo: 'manual', chats: [] });
    await salvar(abas);
    navegar();
  };
  $('#lista').addEventListener('change', async (e) => {
    const caixa = e.target.closest('[data-id]');
    const campo = e.target.dataset.campo;
    if (!caixa || !campo) return;
    const a = abas.find((x) => x.id === caixa.dataset.id);
    a[campo] = e.target.value;
    await salvar(abas);
    if (campo === 'tipo') navegar();
    else avisar('Salvo.');
  });
  $('#lista').addEventListener('click', async (e) => {
    const caixa = e.target.closest('[data-id]');
    if (!caixa) return;
    const i = abas.findIndex((x) => x.id === caixa.dataset.id);
    if (e.target.closest('[data-del]')) {
      if (!confirm(`Excluir a aba "${abas[i].nome}"? Os leads não são apagados do WhatsApp.`)) return;
      abas.splice(i, 1);
    } else if (e.target.closest('[data-mover]')) {
      const j = i + Number(e.target.closest('[data-mover]').dataset.mover);
      [abas[i], abas[j]] = [abas[j], abas[i]];
    } else if (e.target.closest('[data-tirar]')) {
      abas[i].chats.splice(Number(e.target.closest('[data-tirar]').dataset.tirar), 1);
    } else return;
    await salvar(abas);
    navegar();
  });
};

// =====================================================================
// CAMPANHAS (ENVIO EM MASSA)
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

secoes.campanhas = async () => {
  const sub = location.hash.split('/')[1];
  if (sub === 'nova') return novaCampanha();
  if (sub) return detalheCampanha(sub);
  const campanhas = (await lerCampanhas()).reverse();
  const [cfg, hojeN, status] = await Promise.all([VF.config(), VF.enviosHoje(), VF.ler('motorStatus', null)]);
  main.innerHTML = `
    <div class="linha"><div class="cresce"><h1>📢 Envio em massa</h1>
      <p class="sub">Os envios saem um por vez, no ritmo das <a href="#config">Configurações</a> (${cfg.intervaloMin}–${cfg.intervaloMax}s entre leads, pausa a cada ${cfg.loteTamanho}, até ${cfg.limiteDia}/dia).
      Hoje: <b>${hojeN}</b> enviados. Deixe o WhatsApp Web aberto (pode ficar em segundo plano).</p></div>
      <button id="nova">+ Nova campanha</button></div>
    ${status && status.tipo !== 'parado' ? `<div class="cartao"><b>Agora:</b> ${esc(status.texto)}</div>` : ''}
    <div id="lista">${
      campanhas.length
        ? campanhas
            .map((c) => {
              const n = contar(c);
              const pct = n.total ? Math.round((n.feitos / n.total) * 100) : 0;
              return `<div class="item-lista" data-id="${esc(c.id)}">
            <div class="cresce"><b>${esc(c.nome)}</b> <span class="status ${c.status}">${NOME_STATUS[c.status]}</span>
              <div class="progresso"><div style="width:${pct}%"></div></div>
              <small>${n.feitos}/${n.total} · ✅ ${n.enviado} enviados · 💬 ${n.respondeu} responderam · ❌ ${n.falhou} falhas · ⏭ ${n.pulado} pulados — criada ${dataHora(c.criadaEm)}</small>
              ${c.motivo && c.status === 'pausada' ? `<small style="color:var(--vermelho)">${esc(c.motivo)}</small>` : ''}</div>
            ${c.status === 'ativa' ? '<button class="sec peq" data-acao="pausar">⏸ Pausar</button>' : ''}
            ${c.status === 'pausada' ? '<button class="peq" data-acao="retomar">▶ Retomar</button>' : ''}
            <a href="#campanhas/${esc(c.id)}"><button class="sec peq">Detalhes</button></a></div>`;
            })
            .join('')
        : '<div class="vazio">Nenhuma campanha ainda. Clique em <b>+ Nova campanha</b>.</div>'
    }</div>`;
  $('#nova').onclick = () => (location.hash = 'campanhas/nova');
  $('#lista').onclick = async (e) => {
    const b = e.target.closest('[data-acao]');
    if (!b) return;
    await mudarStatus(b.closest('[data-id]').dataset.id, b.dataset.acao === 'pausar' ? 'pausada' : 'ativa');
    navegar();
  };
};

async function mudarStatus(id, status) {
  const c = await VF.ler('campanha:' + id);
  c.status = status;
  c.motivo = '';
  await VF.gravar('campanha:' + id, c);
  if (status === 'ativa') chrome.runtime.sendMessage({ tipo: 'cutucar' }).catch(() => {});
  avisar(status === 'ativa' ? 'Campanha em andamento.' : status === 'pausada' ? 'Campanha pausada.' : 'Campanha cancelada.');
}

async function detalheCampanha(id) {
  const c = await VF.ler('campanha:' + id);
  if (!c) return (location.hash = 'campanhas');
  const n = contar(c);
  const filtro = sessionStorage.getItem('filtroContatos') || 'todos';
  const visiveis = c.contatos.filter((x) => filtro === 'todos' || (filtro === 'respondeu' ? x.respondeu : x.status === filtro));
  main.innerHTML = `
    <p class="sub"><a href="#campanhas">← campanhas</a></p>
    <div class="linha"><div class="cresce"><h1>${esc(c.nome)} <span class="status ${c.status}">${NOME_STATUS[c.status]}</span></h1>
      <p class="sub">Criada ${dataHora(c.criadaEm)}${c.concluidaEm ? ' · concluída ' + dataHora(c.concluidaEm) : ''}</p></div></div>
    ${c.motivo && c.status === 'pausada' ? `<div class="alerta" style="margin-bottom:12px">${esc(c.motivo)}</div>` : ''}
    <div class="numeros">
      <div class="numero"><b>${n.total}</b><span>no público</span></div>
      <div class="numero"><b>${n.enviado}</b><span>enviados</span></div>
      <div class="numero"><b>${n.respondeu}</b><span>responderam ${n.enviado ? '(' + Math.round((n.respondeu / n.enviado) * 100) + '%)' : ''}</span></div>
      <div class="numero"><b>${n.falhou}</b><span>falhas</span></div>
      <div class="numero"><b>${n.pulado}</b><span>pulados</span></div>
      <div class="numero"><b>${n.pendente}</b><span>na fila</span></div>
    </div>
    <div class="botoes" style="margin-bottom:16px">
      ${c.status === 'ativa' ? '<button class="sec" data-acao="pausar">⏸ Pausar</button>' : ''}
      ${c.status === 'pausada' ? '<button data-acao="retomar">▶ Retomar</button>' : ''}
      ${['ativa', 'pausada'].includes(c.status) ? '<button class="perigo" data-acao="cancelar">Cancelar campanha</button>' : ''}
      ${n.falhou && c.status !== 'cancelada' ? '<button class="sec" data-acao="refazer">Tentar de novo as falhas</button>' : ''}
      <button class="sec" data-acao="duplicar">Duplicar (nova campanha igual)</button>
      <button class="sec" data-acao="csv">Baixar planilha (CSV)</button>
      ${['concluida', 'cancelada'].includes(c.status) ? '<button class="perigo" data-acao="excluir">Excluir</button>' : ''}
    </div>
    <div class="radios" id="filtro" style="margin-bottom:10px">
      ${['todos', 'pendente', 'enviado', 'respondeu', 'falhou', 'pulado']
        .map((f) => `<label><input type="radio" name="f" value="${f}" ${filtro === f ? 'checked' : ''}> ${f === 'todos' ? 'Todos' : f === 'respondeu' ? 'Responderam' : NOME_CONTATO[f]}</label>`)
        .join('')}
    </div>
    <table><thead><tr><th>Nome</th><th>Número</th><th>Situação</th><th>Respondeu</th><th>Quando</th><th>Observação</th></tr></thead>
    <tbody>${visiveis
      .slice(0, 1000)
      .map(
        (x) => `<tr><td>${esc(x.nome || '')}</td><td>${esc(VF.numeroDoId(x.id) || x.id.split('@')[0])}</td>
        <td class="st-${x.status}">${NOME_CONTATO[x.status] || x.status}</td><td>${x.respondeu ? '💬 ' + dataHora(x.respondeuEm) : ''}</td>
        <td>${dataHora(x.em)}</td><td class="dica">${esc(x.erro || '')}</td></tr>`
      )
      .join('')}</tbody></table>
    ${visiveis.length > 1000 ? '<p class="dica">Mostrando 1000. Baixe a planilha para ver todos.</p>' : ''}`;

  $('#filtro').onchange = (e) => {
    sessionStorage.setItem('filtroContatos', e.target.value);
    navegar();
  };
  main.querySelector('.botoes').onclick = async (e) => {
    const acao = e.target.closest('[data-acao]')?.dataset.acao;
    if (!acao) return;
    if (acao === 'pausar') await mudarStatus(id, 'pausada');
    if (acao === 'retomar') await mudarStatus(id, 'ativa');
    if (acao === 'cancelar' && confirm('Cancelar a campanha? Quem ainda não recebeu não vai receber.')) await mudarStatus(id, 'cancelada');
    if (acao === 'refazer') {
      const atual = await VF.ler('campanha:' + id);
      atual.contatos.forEach((x) => x.status === 'falhou' && x.erro !== 'Número sem WhatsApp' && Object.assign(x, { status: 'pendente', erro: '' }));
      if (atual.status === 'concluida') atual.status = 'pausada';
      await VF.gravar('campanha:' + id, atual);
      avisar('As falhas voltaram para a fila. Clique em Retomar para enviar.');
    }
    if (acao === 'duplicar') {
      sessionStorage.setItem('duplicar', id);
      location.hash = 'campanhas/nova';
      return;
    }
    if (acao === 'csv') return baixarCSV(c);
    if (acao === 'excluir' && confirm('Excluir a campanha e o histórico dela?')) {
      await VF.apagar('campanha:' + id);
      await VF.gravar('campanhas', (await VF.ler('campanhas', [])).filter((x) => x !== id));
      location.hash = 'campanhas';
      return;
    }
    navegar();
  };
}

function baixarCSV(c) {
  const linhas = [['nome', 'numero', 'situacao', 'respondeu', 'quando', 'observacao']];
  c.contatos.forEach((x) =>
    linhas.push([x.nome || '', (x.id.match(/^(\d+)@c\.us$/) || [])[1] || x.id, NOME_CONTATO[x.status] || x.status, x.respondeu ? 'sim' : '', dataHora(x.em), x.erro || ''])
  );
  const csv = '﻿' + linhas.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `campanha-${c.nome.replace(/[^\w-]+/g, '_')}.csv`;
  a.click();
}

async function novaCampanha() {
  const [abas, respostas, cfg] = await Promise.all([VF.ler('abas', []), VF.ler('respostas', []), VF.config()]);
  const etiquetas = await etiquetasAtuais();
  const idDup = sessionStorage.getItem('duplicar');
  sessionStorage.removeItem('duplicar');
  const base = idDup ? await VF.ler('campanha:' + idDup) : null;

  const opAbas = (vazio) => `<option value="">${vazio}</option>` + abas.filter((a) => a.tipo !== 'etiqueta').map((a) => `<option value="${esc(a.id)}">${esc(a.nome)}</option>`).join('');
  const opEtiq = (vazio) => `<option value="">${vazio}</option>` + etiquetas.map((e) => `<option value="${esc(e.id)}">${esc(e.nome)} (${e.total})</option>`).join('');
  const checksEtiq = (nome) =>
    etiquetas.length
      ? `<div class="checks">${etiquetas.map((e) => `<label><input type="checkbox" name="${nome}" value="${esc(e.id)}"><span class="bolinha" style="background:${esc(e.cor)}"></span>${esc(e.nome)}</label>`).join('')}</div>`
      : '<span class="dica">Abra o WhatsApp Web para listar as etiquetas.</span>';

  main.innerHTML = `
    <p class="sub"><a href="#campanhas">← campanhas</a></p>
    <h1>Nova campanha</h1>
    <p class="sub">Monte em 5 passos. Nada é enviado até você clicar em <b>Criar e começar</b>.</p>
    <div class="passos">
      <div class="cartao"><h3>Nome</h3><input type="text" id="nome" placeholder="Ex.: Retrabalho leads outubro" value="${esc(base ? base.nome + ' (2)' : '')}"></div>

      <div class="cartao"><h3>Para quem enviar</h3>
        <div class="radios" id="origem">
          <label><input type="radio" name="origem" value="aba" checked> Uma aba</label>
          <label><input type="radio" name="origem" value="etiqueta"> Uma etiqueta</label>
          <label><input type="radio" name="origem" value="todas"> Todas as conversas</label>
          <label><input type="radio" name="origem" value="lista"> Colar lista de números</label>
        </div>
        <div style="margin-top:12px">
          <div data-origem="aba"><select id="origemAba">${opAbas('Escolha a aba…')}</select></div>
          <div data-origem="etiqueta" class="oculto"><select id="origemEtiqueta">${opEtiq(etiquetas.length ? 'Escolha a etiqueta…' : 'Abra o WhatsApp Web para listar')}</select></div>
          <div data-origem="todas" class="oculto"><span class="dica">Todas as conversas individuais (sem grupos).</span></div>
          <div data-origem="lista" class="oculto"><textarea id="origemLista" placeholder="Um por linha. Pode ter o nome depois de ; ou ,&#10;11999998888;Maria Silva&#10;5511988887777, João"></textarea>
            <span class="dica">Sem o 55 na frente, considero número do Brasil. Números sem WhatsApp são pulados na hora do envio.</span></div>
        </div>
        <details style="margin-top:12px"><summary><b>Filtros</b> (opcional)</summary>
          <div class="grade" style="margin-top:10px">
            <label class="campo">Última conversa há pelo menos (dias)<input type="number" id="minDias" min="0" placeholder="ex.: 7"><small>Bom para retrabalhar leads frios.</small></label>
            <label class="campo">Última conversa há no máximo (dias)<input type="number" id="maxDias" min="0" placeholder="ex.: 90"></label>
            <label class="campo">Na hora do envio, pular quem conversou nas últimas (horas)<input type="number" id="recente" min="0" value="${base ? base.pularRecenteHoras || 0 : 24}"><small>Evita mandar campanha para quem está em atendimento.</small></label>
          </div>
          <div style="margin-top:10px"><b>Não enviar para quem tem a etiqueta:</b> ${checksEtiq('exclEtiq')}</div>
        </details>
        <div class="botoes" style="margin-top:12px"><button class="sec" id="carregar">Ver quem vai receber</button></div>
        <div id="publico" style="margin-top:10px"></div>
      </div>

      <div class="cartao"><h3>Mensagem</h3>
        <div class="linha" style="margin-bottom:10px"><span class="dica">Copiar de uma resposta rápida:</span>
          <select id="copiarResp" style="max-width:300px"><option value="">—</option>${respostas.map((r) => `<option value="${esc(r.id)}">${esc(r.nome)}</option>`).join('')}</select></div>
        <div id="etapas"></div>
        <p class="dica">Dica: use variações como <code>{Oi|Olá|E aí}</code> e o <code>{primeiro_nome}</code> para cada mensagem sair diferente — isso reduz o risco de bloqueio.
        Se deixar sem mensagem, a campanha só aplica as etiquetas/abas abaixo.</p>
      </div>

      <div class="cartao"><h3>Depois de enviar para cada lead</h3>
        <div class="grade">
          <label class="campo">Colocar na aba<select id="addAba">${opAbas('— não mexer —')}</select></label>
          <label class="campo">Tirar da aba<select id="remAba">${opAbas('— não mexer —')}</select></label>
        </div>
        <div style="margin-top:10px"><b>Adicionar etiqueta:</b> ${checksEtiq('addEtiq')}</div>
        <div style="margin-top:10px"><b>Remover etiqueta:</b> ${checksEtiq('remEtiq')}</div>
      </div>

      <div class="cartao"><h3>Quando o lead responder</h3>
        <div class="grade">
          <label class="campo">Colocar na aba<select id="respAba">${opAbas('— não mexer —')}</select></label>
          <label class="campo">Adicionar etiqueta<select id="respEtiq">${opEtiq('— não mexer —')}</select></label>
        </div>
        <p class="dica">Quem responder fica marcado como "Respondeu" no relatório. Quem mandar "SAIR"/"PARAR" vai para a lista 🚫 Não perturbe.</p>
      </div>
    </div>
    <div class="cartao" id="estimativa"><span class="dica">Clique em "Ver quem vai receber" para calcular o tempo estimado.</span></div>
    <div class="botoes"><button id="criar">Criar e começar</button><button class="sec" id="criarPausada">Criar pausada</button>
      <button class="sec" id="teste">Enviar teste para mim</button></div>`;

  const editor = EditorEtapas($('#etapas'), base ? base.etapas : [{ tipo: 'texto', texto: '', espera: 2 }]);
  let publico = null;

  if (base) {
    const a = base.acoes || {};
    $('#addAba').value = a.addAba || '';
    $('#remAba').value = a.removerAba || '';
    (a.addEtiquetas || []).forEach((v) => $(`input[name=addEtiq][value="${CSS.escape(v)}"]`)?.click());
    (a.removerEtiquetas || []).forEach((v) => $(`input[name=remEtiq][value="${CSS.escape(v)}"]`)?.click());
    $('#respAba').value = (base.aoResponder || {}).addAba || '';
    $('#respEtiq').value = (base.aoResponder || {}).addEtiqueta || '';
    if (base.origem) {
      $(`input[name=origem][value="${base.origem.tipo}"]`).click();
      if (base.origem.tipo === 'aba') $('#origemAba').value = base.origem.valor || '';
      if (base.origem.tipo === 'etiqueta') $('#origemEtiqueta').value = base.origem.valor || '';
    }
  }

  $('#origem').onchange = () => {
    const v = $('input[name=origem]:checked').value;
    $$('[data-origem]').forEach((d) => d.classList.toggle('oculto', d.dataset.origem !== v));
    publico = null;
    $('#publico').innerHTML = '';
  };
  $('#copiarResp').onchange = (e) => {
    const r = respostas.find((x) => x.id === e.target.value);
    if (r) editor.definir(r.etapas);
    e.target.value = '';
  };
  $('.passos').addEventListener('change', (e) => {
    if (e.target.closest('#origem, details, [data-origem]')) {
      publico = null;
      $('#publico').innerHTML = '<span class="dica">Filtros mudaram — clique em "Ver quem vai receber" de novo.</span>';
    }
  });

  async function montarPublico() {
    const origem = $('input[name=origem]:checked').value;
    const minDias = Number($('#minDias').value) || 0;
    const maxDias = Number($('#maxDias').value) || 0;
    const excl = $$('input[name=exclEtiq]:checked').map((x) => x.value);
    const naoPerturbe = await VF.ler('naoPerturbe', []);
    const bloqueados = new Set(naoPerturbe.flatMap((n) => n.ids));
    let candidatos = []; // {id, ids, nome, t, etiquetas}
    let chats = null;
    const precisaWA = origem === 'etiqueta' || origem === 'todas' || minDias || maxDias || excl.length;
    if (precisaWA) chats = await wa('listarChats', origem === 'etiqueta' ? { etiqueta: $('#origemEtiqueta').value } : {});

    if (origem === 'aba') {
      const aba = abas.find((a) => a.id === $('#origemAba').value);
      if (!aba) throw new Error('Escolha a aba.');
      const mapa = new Map((chats || []).map((c) => [c.id, c]));
      candidatos = (aba.chats || []).map((c) => {
        const info = c.ids.map((x) => mapa.get(x)).find(Boolean);
        return { id: c.ids.find((x) => x.endsWith('@c.us')) || c.ids[0], ids: c.ids, nome: (info && info.nome) || c.nome, t: info ? info.t : 0, etiquetas: info ? info.etiquetas : [], semInfo: !info };
      });
    } else if (origem === 'etiqueta') {
      if (!$('#origemEtiqueta').value) throw new Error('Escolha a etiqueta.');
      candidatos = chats.map((c) => ({ ...c, ids: [c.id] }));
    } else if (origem === 'todas') {
      candidatos = chats.map((c) => ({ ...c, ids: [c.id] }));
    } else {
      const linhas = $('#origemLista').value.split('\n').map((l) => l.trim()).filter(Boolean);
      const invalidos = [];
      candidatos = [];
      for (const l of linhas) {
        const [num, ...resto] = l.split(/[;,\t]/);
        const id = VF.idDoNumero(num);
        if (!id) invalidos.push(l);
        else candidatos.push({ id, ids: [id], nome: resto.join(' ').trim(), t: 0, etiquetas: [], lista: true });
      }
      if (invalidos.length) avisar(`${invalidos.length} linha(s) com número inválido foram ignoradas.`, 'erro', 6000);
    }

    const agora = Date.now();
    const vistos = new Set();
    const ficam = [];
    let fora = { bloqueados: 0, filtro: 0, repetidos: 0 };
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
      ficam.push({ id: c.id, ids: c.ids, nome: c.nome || '', status: 'pendente', verificado: !c.lista });
    }
    return { contatos: ficam, fora };
  }

  function estimar(qtd) {
    const medioSeg = (cfg.intervaloMin + cfg.intervaloMax) / 2 + 15;
    const pausas = Math.floor(qtd / cfg.loteTamanho) * ((cfg.pausaLoteMin + cfg.pausaLoteMax) / 2) * 60;
    const horas = (qtd * medioSeg + pausas) / 3600;
    const dias = Math.ceil(qtd / cfg.limiteDia);
    return `⏱ Estimativa: cerca de <b>${horas < 1 ? Math.round(horas * 60) + ' min' : horas.toFixed(1).replace('.', ',') + ' h'}</b> de envio
      ${dias > 1 ? ` — por causa do limite de ${cfg.limiteDia}/dia, deve levar <b>${dias} dias</b>` : ''}${cfg.usarHorario ? ` (só das ${cfg.horaInicio} às ${cfg.horaFim})` : ''}.`;
  }

  $('#carregar').onclick = async () => {
    $('#publico').innerHTML = '<span class="dica">Carregando…</span>';
    try {
      publico = await montarPublico();
      const p = publico;
      const extras = [p.fora.bloqueados && `${p.fora.bloqueados} na lista Não perturbe`, p.fora.filtro && `${p.fora.filtro} pelos filtros`, p.fora.repetidos && `${p.fora.repetidos} repetidos`].filter(Boolean);
      $('#publico').innerHTML = `<p><b>${p.contatos.length} lead(s)</b> vão receber.${extras.length ? ' <span class="dica">Ficaram de fora: ' + extras.join(', ') + '.</span>' : ''}</p>
        <div class="lista-leads">${p.contatos.slice(0, 300).map((c) => `<div><span>${esc(c.nome || '(sem nome)')}</span><span class="dica">${esc(VF.numeroDoId(c.id) || c.id.split('@')[0])}</span></div>`).join('')}
        ${p.contatos.length > 300 ? `<div class="dica">… e mais ${p.contatos.length - 300}</div>` : ''}</div>`;
      $('#estimativa').innerHTML = estimar(p.contatos.length);
    } catch (e) {
      publico = null;
      $('#publico').innerHTML = `<span style="color:var(--vermelho)">${esc(e.message)}</span>`;
    }
  };

  $('#teste').onclick = async () => {
    const erro = editor.validar();
    if (erro) return avisar(erro, 'erro');
    try {
      await testeParaMim(editor.valor());
      avisar('Teste enviado para o seu próprio número (com o nome "Maria Teste").');
    } catch (e) {
      avisar(e.message, 'erro');
    }
  };

  async function criar(status) {
    const nome = $('#nome').value.trim();
    if (!nome) return avisar('Dê um nome para a campanha.', 'erro');
    if (!publico) return avisar('Clique em "Ver quem vai receber" antes de criar.', 'erro');
    if (!publico.contatos.length) return avisar('Ninguém para receber com esses filtros.', 'erro');
    const erro = editor.validar();
    if (erro) return avisar(erro, 'erro');
    const etapas = editor.valor();
    const acoes = {
      addAba: $('#addAba').value,
      removerAba: $('#remAba').value,
      addEtiquetas: $$('input[name=addEtiq]:checked').map((x) => x.value),
      removerEtiquetas: $$('input[name=remEtiq]:checked').map((x) => x.value),
    };
    const temAcao = acoes.addAba || acoes.removerAba || acoes.addEtiquetas.length || acoes.removerEtiquetas.length;
    if (!etapas.length && !temAcao) return avisar('Coloque uma mensagem ou alguma ação de etiqueta/aba.', 'erro');
    if (status === 'ativa' && etapas.length && !confirm(`Começar a enviar para ${publico.contatos.length} lead(s)?`)) return;
    const origemTipo = $('input[name=origem]:checked').value;
    const c = {
      id: VF.novoId(),
      nome,
      criadaEm: Date.now(),
      status,
      motivo: '',
      origem: { tipo: origemTipo, valor: origemTipo === 'aba' ? $('#origemAba').value : origemTipo === 'etiqueta' ? $('#origemEtiqueta').value : '' },
      etapas,
      acoes,
      aoResponder: { addAba: $('#respAba').value, addEtiqueta: $('#respEtiq').value },
      pularRecenteHoras: Number($('#recente').value) || 0,
      contatos: publico.contatos,
    };
    await VF.gravar('campanha:' + c.id, c);
    await VF.gravar('campanhas', [...(await VF.ler('campanhas', [])), c.id]);
    if (status === 'ativa') chrome.runtime.sendMessage({ tipo: 'cutucar' }).catch(() => {});
    avisar(status === 'ativa' ? 'Campanha criada! Os envios vão começar em instantes.' : 'Campanha criada (pausada).');
    location.hash = 'campanhas/' + c.id;
  }
  $('#criar').onclick = () => criar('ativa');
  $('#criarPausada').onclick = () => criar('pausada');
}

// =====================================================================
// NÃO PERTURBE
// =====================================================================
secoes.naoperturbe = async () => {
  const lista = await VF.ler('naoPerturbe', []);
  const cfg = await VF.config();
  main.innerHTML = `
    <h1>🚫 Não perturbe</h1>
    <p class="sub">Quem está aqui nunca recebe envio em massa. Entra sozinho quando responde uma mensagem curta com: ${cfg.palavrasSair.map((p) => `<code>${esc(p)}</code>`).join(' ')}
      (dá para mudar em <a href="#config">Configurações</a>). Você também pode adicionar números à mão.</p>
    <div class="cartao"><div class="linha"><input type="text" id="num" placeholder="Número com DDD, ex.: 11999998888" style="max-width:280px"><button id="add">Adicionar</button></div></div>
    <div id="lista">${
      lista.length
        ? lista
            .map(
              (n, i) => `<div class="item-lista"><div class="cresce"><b>${esc(n.nome || VF.numeroDoId(n.ids.find((x) => x.endsWith('@c.us'))) || n.ids[0])}</b>
            <small>${n.texto ? 'Respondeu "' + esc(n.texto) + '" · ' : ''}${dataHora(n.em)}</small></div><button class="perigo peq" data-i="${i}">Remover</button></div>`
            )
            .join('')
        : '<div class="vazio">Ninguém na lista.</div>'
    }</div>`;
  $('#add').onclick = async () => {
    const id = VF.idDoNumero($('#num').value);
    if (!id) return avisar('Número inválido.', 'erro');
    lista.push({ ids: [id, id.replace(/^55(\d\d)9(\d{8})@/, '55$1$2@')], nome: '', texto: '', em: Date.now() });
    await VF.gravar('naoPerturbe', lista);
    navegar();
  };
  $('#lista').onclick = async (e) => {
    const b = e.target.closest('[data-i]');
    if (!b || !confirm('Remover da lista? Ele volta a poder receber envios em massa.')) return;
    lista.splice(Number(b.dataset.i), 1);
    await VF.gravar('naoPerturbe', lista);
    navegar();
  };
};

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
secoes.config = async () => {
  const c = await VF.config();
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const num = (id, rot, dica, min = 0) =>
    `<label class="campo">${rot}<input type="number" id="${id}" min="${min}" value="${c[id]}">${dica ? `<small>${dica}</small>` : ''}</label>`;
  main.innerHTML = `
    <h1>⚙️ Configurações</h1>
    <p class="sub">Os valores padrão já são conservadores. Número novo ou que nunca fez envio em massa: comece com limite baixo (30–50/dia) e aumente aos poucos.</p>
    <div class="cartao"><h3>Você</h3><div class="grade">
      <label class="campo">Seu nome<input type="text" id="nomeVendedor" value="${esc(c.nomeVendedor)}" placeholder="Ex.: Victor"><small>Usado em {vendedor}.</small></label>
    </div></div>
    <div class="cartao"><h3>Ritmo do envio em massa</h3><div class="grade">
      ${num('intervaloMin', 'Intervalo mínimo entre leads (segundos)', '', 10)}
      ${num('intervaloMax', 'Intervalo máximo entre leads (segundos)', 'O tempo é sorteado entre o mínimo e o máximo.', 10)}
      ${num('loteTamanho', 'Pausa longa a cada (envios)', '', 1)}
      ${num('pausaLoteMin', 'Pausa longa mínima (minutos)', '', 1)}
      ${num('pausaLoteMax', 'Pausa longa máxima (minutos)', '', 1)}
      ${num('limiteDia', 'Limite por dia (envios)', 'Somando todas as campanhas.', 1)}
      ${num('maxFalhasSeguidas', 'Pausar campanha após X falhas seguidas', '', 1)}
    </div>
    <label class="linha" style="margin-top:12px"><input type="checkbox" id="simularDigitacao" ${c.simularDigitacao ? 'checked' : ''}> Mostrar "digitando…" / "gravando áudio…" antes de cada mensagem</label>
    </div>
    <div class="cartao"><h3>Horário de envio</h3>
      <label class="linha"><input type="checkbox" id="usarHorario" ${c.usarHorario ? 'checked' : ''}> Só enviar dentro do horário abaixo</label>
      <div class="linha" style="margin-top:10px">das <input type="time" id="horaInicio" value="${c.horaInicio}" style="width:120px"> às <input type="time" id="horaFim" value="${c.horaFim}" style="width:120px"></div>
      <div class="checks" style="margin-top:10px">${dias.map((d, i) => `<label><input type="checkbox" name="dia" value="${i}" ${c.dias.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
    </div>
    <div class="cartao"><h3>Respostas rápidas</h3>
      <label class="linha"><input type="checkbox" id="digitacaoNasRespostas" ${c.digitacaoNasRespostas ? 'checked' : ''}> Mostrar "digitando…" antes de enviar respostas rápidas (fica mais lento)</label>
    </div>
    <div class="cartao"><h3>Palavras de descadastro</h3>
      <label class="campo">Separadas por vírgula<input type="text" id="palavrasSair" value="${esc(c.palavrasSair.join(', '))}">
      <small>Se o lead responder uma mensagem curta (até 3 palavras) com uma delas, entra no 🚫 Não perturbe.</small></label>
    </div>
    <div class="botoes"><button id="salvar">Salvar</button><button class="sec" id="padrao">Voltar ao padrão</button></div>`;

  $('#salvar').onclick = async () => {
    const n = (id) => Math.max(0, Number($('#' + id).value) || 0);
    const novo = {
      nomeVendedor: $('#nomeVendedor').value.trim(),
      intervaloMin: Math.max(10, n('intervaloMin')),
      intervaloMax: Math.max(10, n('intervaloMax')),
      loteTamanho: Math.max(1, n('loteTamanho')),
      pausaLoteMin: Math.max(1, n('pausaLoteMin')),
      pausaLoteMax: Math.max(1, n('pausaLoteMax')),
      limiteDia: Math.max(1, n('limiteDia')),
      maxFalhasSeguidas: Math.max(1, n('maxFalhasSeguidas')),
      simularDigitacao: $('#simularDigitacao').checked,
      usarHorario: $('#usarHorario').checked,
      horaInicio: $('#horaInicio').value || '08:00',
      horaFim: $('#horaFim').value || '19:00',
      dias: $$('input[name=dia]:checked').map((x) => Number(x.value)),
      digitacaoNasRespostas: $('#digitacaoNasRespostas').checked,
      palavrasSair: $('#palavrasSair').value.split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (novo.intervaloMax < novo.intervaloMin) [novo.intervaloMin, novo.intervaloMax] = [novo.intervaloMax, novo.intervaloMin];
    if (novo.pausaLoteMax < novo.pausaLoteMin) [novo.pausaLoteMin, novo.pausaLoteMax] = [novo.pausaLoteMax, novo.pausaLoteMin];
    if (novo.usarHorario && !novo.dias.length) return avisar('Marque pelo menos um dia da semana.', 'erro');
    if (novo.usarHorario && VF.paraMin(novo.horaFim) <= VF.paraMin(novo.horaInicio)) return avisar('O horário final precisa ser depois do inicial.', 'erro');
    await VF.gravar('config', novo);
    avisar('Configurações salvas.');
  };
  $('#padrao').onclick = async () => {
    if (!confirm('Voltar todas as configurações ao padrão?')) return;
    await VF.gravar('config', { nomeVendedor: c.nomeVendedor });
    navegar();
  };
};

// =====================================================================
// BACKUP
// =====================================================================
secoes.backup = async () => {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  main.innerHTML = `
    <h1>💾 Backup</h1>
    <p class="sub">Tudo fica guardado só neste computador. Faça backup para trocar de computador ou não perder suas respostas.</p>
    <div class="cartao"><h3>Baixar backup</h3><p class="dica">Inclui respostas (com áudios/vídeos), abas, campanhas, configurações e a lista Não perturbe. Espaço usado: ${VF.tamanhoLegivel(bytes)}.</p>
      <button id="baixar">Baixar arquivo de backup</button></div>
    <div class="cartao"><h3>Restaurar backup</h3><p class="dica">Substitui TUDO o que está neste computador pelo conteúdo do arquivo.</p>
      <input type="file" id="arquivo" accept=".json,application/json"></div>`;
  $('#baixar').onclick = async () => {
    const tudo = await chrome.storage.local.get(null);
    delete tudo.motorTrava;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'vendaflow', versao: 1, em: Date.now(), dados: tudo })], { type: 'application/json' }));
    a.download = `vendaflow-backup-${VF.hoje()}.json`;
    a.click();
  };
  $('#arquivo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.app !== 'vendaflow' || !j.dados) throw new Error('Este arquivo não é um backup do VendaFlow.');
      if (!confirm('Substituir tudo deste computador pelo backup?')) return;
      await chrome.storage.local.clear();
      await chrome.storage.local.set(j.dados);
      avisar('Backup restaurado.');
      navegar();
    } catch (er) {
      avisar(er.message, 'erro');
    }
  };
};

// ---------- Início ----------
(async () => {
  await VF.limparMidiasOrfas().catch(() => {});
  navegar();
  verificarWA();
  setInterval(verificarWA, 15000);
})();
