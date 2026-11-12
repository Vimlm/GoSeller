// Editor de sequência de mensagens (texto, imagem, vídeo, áudio, documento).
// Usado nas respostas rápidas e nas campanhas.
function EditorEtapas(container, etapasIniciais, aoMudar, opcoes = {}) {
  const LIMITE = 16 * 1024 * 1024;
  const ACEITA = { image: 'image/*', video: 'video/*', audio: 'audio/*,.ogg,.opus,.mp3,.m4a', document: '*/*' };
  const ICONE = { texto: '💬', image: '🖼️', video: '🎬', audio: '🎤', document: '📄' };
  const esc = VF.esc;
  let etapas = JSON.parse(JSON.stringify(etapasIniciais || []));
  const mudou = () => aoMudar && aoMudar(etapas);
  // Variáveis: o botão mostra o código de verdade ({primeiro_nome}...) e o que ele vira
  const VARIAVEIS = [
    ['{primeiro_nome}', 'Primeiro nome do contato (ex.: Maria)'],
    ['{nome}', 'Nome completo do contato (ex.: Maria Silva)'],
    ['{saudacao}', 'Bom dia / Boa tarde / Boa noite, conforme a hora'],
    ['{vendedor}', 'Seu nome (Configurações)'],
    ['{Oi|Olá|E aí}', 'Sorteia uma das opções para cada contato'],
  ];
  const htmlVars = (campo) =>
    `<div class="vars" data-alvo="${campo}"><span class="vars-rot">Inserir:</span>${VARIAVEIS.map(([v, d]) => `<button type="button" data-var="${esc(v)}" title="${esc(d)}">${esc(v)}</button>`).join('')}</div>`;

  function htmlEtapa(e, i) {
    const titulo = e.tipo === 'texto' ? 'Texto' : VF.TIPOS_MIDIA[e.tipoMidia];
    const espera =
      i > 0
        ? `<label class="espera">⏱ esperar <input type="number" min="0" max="600" data-campo="espera" value="${Number(e.espera ?? 2)}"> segundos antes</label>`
        : '';
    let corpo = '';
    if (e.tipo === 'texto') {
      corpo = `
        <textarea data-campo="texto" placeholder="Ex.: {saudacao}, {primeiro_nome}! Tudo bem? {Vi que|Notei que} você se interessou...">${esc(e.texto || '')}</textarea>
        ${htmlVars('texto')}
        <div class="previa" data-previa><b>Prévia:</b>${esc(VF.montarTexto(e.texto || '', { nome: 'Maria Silva', vendedor: 'Você' })) || 'Prévia aparece aqui'}</div>`;
    } else {
      const arquivo = e.midiaId
        ? `<span data-preview="${esc(e.midiaId)}"></span><span>${esc(e.nomeArquivo || '')} <small class="dica">${e.tamanho ? VF.tamanhoLegivel(e.tamanho) : ''}</small></span>`
        : '<span class="dica">Nenhum arquivo escolhido</span>';
      corpo = `
        <div class="arquivo">${arquivo}
          <span><button type="button" class="sec peq" data-escolher>${e.midiaId ? 'Trocar arquivo' : 'Escolher arquivo'}</button>
          <input type="file" class="oculto" accept="${ACEITA[e.tipoMidia]}" data-arquivo></span>
        </div>
        ${
          e.tipoMidia === 'audio'
            ? `<label class="linha"><input type="checkbox" data-campo="ptt" ${e.ptt !== false ? 'checked' : ''}> Enviar como áudio gravado na hora (nota de voz)</label>
               <div class="dica">Melhor resultado: áudio gravado no próprio WhatsApp ou em .ogg/.opus. MP3 e M4A também costumam funcionar, mas teste antes.</div>`
            : `<textarea data-campo="legenda" style="min-height:50px" placeholder="Legenda (opcional)">${esc(e.legenda || '')}</textarea>${htmlVars('legenda')}`
        }`;
    }
    return `<div class="etapa" data-i="${i}">
      <div class="etapa-topo"><b>${ICONE[e.tipo === 'texto' ? 'texto' : e.tipoMidia]} ${i + 1}. ${titulo}</b>
        <button type="button" class="sec peq" data-mover="-1" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
        <button type="button" class="sec peq" data-mover="1" ${i === etapas.length - 1 ? 'disabled' : ''} title="Descer">↓</button>
        <button type="button" class="perigo peq" data-remover title="Remover">✕</button>
      </div>${espera}${corpo}</div>`;
  }

  function desenhar() {
    container.innerHTML = `
      <div class="etapas">${etapas.map(htmlEtapa).join('') || '<div class="dica">Adicione abaixo o que vai ser enviado. Pode juntar texto, áudio, vídeo e arquivos em sequência.</div>'}</div>
      <div class="add-etapa" style="margin-top:10px">
        <button type="button" class="sec peq" data-add="texto">💬 Texto</button>
        <button type="button" class="sec peq" data-add="audio">🎤 Áudio</button>
        <button type="button" class="sec peq" data-add="image">🖼️ Imagem</button>
        <button type="button" class="sec peq" data-add="video">🎬 Vídeo</button>
        <button type="button" class="sec peq" data-add="document">📄 Arquivo</button>
      </div>`;
    if (opcoes.semPrevia) {
      container.querySelectorAll('[data-preview]').forEach((el) => {
        const e = etapas[Number(el.closest('[data-i]').dataset.i)];
        el.textContent = ICONE[e.tipoMidia] || '📄';
      });
      return;
    }
    container.querySelectorAll('[data-preview]').forEach(async (el) => {
      const i = Number(el.closest('[data-i]').dataset.i);
      const e = etapas[i];
      const url = await VF.lerMidia(e.midiaId);
      if (!url) return (el.textContent = '⚠️ arquivo sumiu — escolha de novo');
      if (e.tipoMidia === 'image') el.innerHTML = `<img src="${url}">`;
      else if (e.tipoMidia === 'video') el.innerHTML = `<video src="${url}" controls></video>`;
      else if (e.tipoMidia === 'audio') el.innerHTML = `<audio src="${url}" controls></audio>`;
      else el.textContent = '📄';
    });
  }

  container.addEventListener('click', (ev) => {
    const alvo = ev.target;
    const add = alvo.closest('[data-add]');
    if (add) {
      const t = add.dataset.add;
      etapas.push(t === 'texto' ? { tipo: 'texto', texto: '', espera: 2 } : { tipo: 'midia', tipoMidia: t, espera: 2, ptt: true });
      desenhar();
      mudou();
      if (t !== 'texto') container.querySelector(`[data-i="${etapas.length - 1}"] [data-arquivo]`).click();
      return;
    }
    const caixa = alvo.closest('[data-i]');
    if (!caixa) return;
    const i = Number(caixa.dataset.i);
    if (alvo.closest('[data-remover]')) {
      etapas.splice(i, 1);
      desenhar();
      mudou();
    } else if (alvo.closest('[data-mover]')) {
      const j = i + Number(alvo.closest('[data-mover]').dataset.mover);
      [etapas[i], etapas[j]] = [etapas[j], etapas[i]];
      desenhar();
      mudou();
    } else if (alvo.closest('[data-escolher]')) {
      caixa.querySelector('[data-arquivo]').click();
    } else if (alvo.closest('[data-var]')) {
      const ta = caixa.querySelector(`textarea[data-campo="${alvo.closest('[data-alvo]')?.dataset.alvo || 'texto'}"]`);
      const v = alvo.closest('[data-var]').dataset.var;
      const ini = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, ini) + v + ta.value.slice(ta.selectionEnd ?? ini);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ini + v.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  container.addEventListener('input', (ev) => {
    const campo = ev.target.dataset.campo;
    const caixa = ev.target.closest('[data-i]');
    if (!campo || !caixa) return;
    const e = etapas[Number(caixa.dataset.i)];
    if (campo === 'ptt') e.ptt = ev.target.checked;
    else if (campo === 'espera') e.espera = Math.max(0, Number(ev.target.value) || 0);
    else e[campo] = ev.target.value;
    if (campo === 'texto') {
      caixa.querySelector('[data-previa]').lastChild.textContent = ' ' + (VF.montarTexto(e.texto, { nome: 'Maria Silva', vendedor: 'Você' }) || 'Prévia aparece aqui');
    }
    mudou();
  });

  container.addEventListener('change', async (ev) => {
    if (ev.target.dataset.campo === 'ptt') {
      etapas[Number(ev.target.closest('[data-i]').dataset.i)].ptt = ev.target.checked;
      return mudou();
    }
    if (!ev.target.matches('[data-arquivo]')) return;
    const arq = ev.target.files[0];
    if (!arq) return;
    if (arq.size > LIMITE) return (VF.aviso || alert)(`Arquivo grande demais (${VF.tamanhoLegivel(arq.size)}). O limite é 16 MB.`, 'erro', 7000);
    const i = Number(ev.target.closest('[data-i]').dataset.i);
    const dataUrl = await new Promise((ok, erro) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = erro;
      r.readAsDataURL(arq);
    });
    const midiaId = VF.novoId();
    await VF.gravar('midia:' + midiaId, dataUrl);
    const e = etapas[i];
    Object.assign(e, { midiaId, nomeArquivo: arq.name, mime: arq.type || '', tamanho: arq.size });
    if (e.tipoMidia === 'audio' || e.tipoMidia === 'video') {
      e.duracao = await new Promise((ok) => {
        const m = document.createElement(e.tipoMidia);
        m.preload = 'metadata';
        m.onloadedmetadata = () => ok(Math.round(m.duration) || 5);
        m.onerror = () => ok(5);
        m.src = dataUrl;
      });
    }
    desenhar();
    mudou();
  });

  desenhar();

  return {
    valor: () => JSON.parse(JSON.stringify(etapas)),
    definir(novas) {
      etapas = JSON.parse(JSON.stringify(novas || []));
      desenhar();
      mudou();
    },
    validar() {
      if (etapas.some((e) => e.tipo === 'texto' && !String(e.texto || '').trim())) return 'Há uma mensagem de texto vazia.';
      if (etapas.some((e) => e.tipo === 'midia' && !e.midiaId)) return 'Há um áudio/vídeo/arquivo sem arquivo escolhido.';
      return '';
    },
  };
}
