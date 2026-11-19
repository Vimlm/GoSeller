// Message sequence editor (text, image, video, audio, document).
// Used in quick replies and campaigns.
function StepsEditor(container, initialSteps, onChange, options = {}) {
  const LIMIT = 16 * 1024 * 1024;
  const ACCEPTED = { image: 'image/*', video: 'video/*', audio: 'audio/*,.ogg,.opus,.mp3,.m4a', document: '*/*' };
  const ICON = { texto: '💬', image: '🖼️', video: '🎬', audio: '🎤', document: '📄' };
  const esc = VF.esc;
  let steps = JSON.parse(JSON.stringify(initialSteps || []));
  const changed = () => onChange && onChange(steps);
  // Variables: the button shows the real code ({primeiro_nome}...) and what it turns into
  const VARIABLES = [
    ['{primeiro_nome}', 'Primeiro nome do contato (ex.: Maria)'],
    ['{nome}', 'Nome completo do contato (ex.: Maria Silva)'],
    ['{saudacao}', 'Bom dia / Boa tarde / Boa noite, conforme a hora'],
    ['{vendedor}', 'Seu nome (Configurações)'],
    ['{Oi|Olá|E aí}', 'Sorteia uma das opções para cada contato'],
  ];
  const htmlVars = (field) =>
    `<div class="vars" data-alvo="${field}"><span class="vars-rot">Inserir:</span>${VARIABLES.map(([v, d]) => `<button type="button" data-var="${esc(v)}" title="${esc(d)}">${esc(v)}</button>`).join('')}</div>`;

  function htmlStep(e, i) {
    const title = e.tipo === 'texto' ? 'Texto' : VF.MEDIA_TYPES[e.tipoMidia];
    const delay =
      i > 0
        ? `<label class="espera">⏱ esperar <input type="number" min="0" max="600" data-campo="espera" value="${Number(e.espera ?? 2)}"> segundos antes</label>`
        : '';
    let body = '';
    if (e.tipo === 'texto') {
      body = `
        <textarea data-campo="texto" placeholder="Ex.: {saudacao}, {primeiro_nome}! Tudo bem? {Vi que|Notei que} você se interessou...">${esc(e.texto || '')}</textarea>
        ${htmlVars('texto')}
        <div class="previa" data-previa><b>Prévia:</b>${esc(VF.buildText(e.texto || '', { nome: 'Maria Silva', vendedor: 'Você' })) || 'Prévia aparece aqui'}</div>`;
    } else {
      const file = e.midiaId
        ? `<span data-preview="${esc(e.midiaId)}"></span><span>${esc(e.nomeArquivo || '')} <small class="dica">${e.tamanho ? VF.readableSize(e.tamanho) : ''}</small></span>`
        : '<span class="dica">Nenhum arquivo escolhido</span>';
      body = `
        <div class="arquivo">${file}
          <span><button type="button" class="sec peq" data-escolher>${e.midiaId ? 'Trocar arquivo' : 'Escolher arquivo'}</button>
          <input type="file" class="oculto" accept="${ACCEPTED[e.tipoMidia]}" data-arquivo></span>
        </div>
        ${
          e.tipoMidia === 'audio'
            ? `<label class="linha"><input type="checkbox" data-campo="ptt" ${e.ptt !== false ? 'checked' : ''}> Enviar como áudio gravado na hora (nota de voz)</label>
               <div class="dica">Melhor resultado: áudio gravado no próprio WhatsApp ou em .ogg/.opus. MP3 e M4A também costumam funcionar, mas teste antes.</div>`
            : `<textarea data-campo="legenda" style="min-height:50px" placeholder="Legenda (opcional)">${esc(e.legenda || '')}</textarea>${htmlVars('legenda')}`
        }`;
    }
    return `<div class="etapa" data-i="${i}">
      <div class="etapa-topo"><b>${ICON[e.tipo === 'texto' ? 'texto' : e.tipoMidia]} ${i + 1}. ${title}</b>
        <button type="button" class="sec peq" data-mover="-1" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
        <button type="button" class="sec peq" data-mover="1" ${i === steps.length - 1 ? 'disabled' : ''} title="Descer">↓</button>
        <button type="button" class="perigo peq" data-remover title="Remover">✕</button>
      </div>${delay}${body}</div>`;
  }

  function render() {
    container.innerHTML = `
      <div class="etapas">${steps.map(htmlStep).join('') || '<div class="dica">Adicione abaixo o que vai ser enviado. Pode juntar texto, áudio, vídeo e arquivos em sequência.</div>'}</div>
      <div class="add-etapa" style="margin-top:10px">
        <button type="button" class="sec peq" data-add="texto">💬 Texto</button>
        <button type="button" class="sec peq" data-add="audio">🎤 Áudio</button>
        <button type="button" class="sec peq" data-add="image">🖼️ Imagem</button>
        <button type="button" class="sec peq" data-add="video">🎬 Vídeo</button>
        <button type="button" class="sec peq" data-add="document">📄 Arquivo</button>
      </div>`;
    if (options.semPrevia) {
      container.querySelectorAll('[data-preview]').forEach((el) => {
        const e = steps[Number(el.closest('[data-i]').dataset.i)];
        el.textContent = ICON[e.tipoMidia] || '📄';
      });
      return;
    }
    container.querySelectorAll('[data-preview]').forEach(async (el) => {
      const i = Number(el.closest('[data-i]').dataset.i);
      const e = steps[i];
      const url = await VF.readMedia(e.midiaId);
      if (!url) return (el.textContent = '⚠️ arquivo sumiu — escolha de novo');
      if (e.tipoMidia === 'image') el.innerHTML = `<img src="${url}">`;
      else if (e.tipoMidia === 'video') el.innerHTML = `<video src="${url}" controls></video>`;
      else if (e.tipoMidia === 'audio') el.innerHTML = `<audio src="${url}" controls></audio>`;
      else el.textContent = '📄';
    });
  }

  container.addEventListener('click', (ev) => {
    const target = ev.target;
    const add = target.closest('[data-add]');
    if (add) {
      const t = add.dataset.add;
      steps.push(t === 'texto' ? { tipo: 'texto', texto: '', espera: 2 } : { tipo: 'midia', tipoMidia: t, espera: 2, ptt: true });
      render();
      changed();
      if (t !== 'texto') container.querySelector(`[data-i="${steps.length - 1}"] [data-arquivo]`).click();
      return;
    }
    const box = target.closest('[data-i]');
    if (!box) return;
    const i = Number(box.dataset.i);
    if (target.closest('[data-remover]')) {
      steps.splice(i, 1);
      render();
      changed();
    } else if (target.closest('[data-mover]')) {
      const j = i + Number(target.closest('[data-mover]').dataset.mover);
      [steps[i], steps[j]] = [steps[j], steps[i]];
      render();
      changed();
    } else if (target.closest('[data-escolher]')) {
      box.querySelector('[data-arquivo]').click();
    } else if (target.closest('[data-var]')) {
      const ta = box.querySelector(`textarea[data-campo="${target.closest('[data-alvo]')?.dataset.alvo || 'texto'}"]`);
      const v = target.closest('[data-var]').dataset.var;
      const start = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd ?? start);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + v.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  container.addEventListener('input', (ev) => {
    const field = ev.target.dataset.campo;
    const box = ev.target.closest('[data-i]');
    if (!field || !box) return;
    const e = steps[Number(box.dataset.i)];
    if (field === 'ptt') e.ptt = ev.target.checked;
    else if (field === 'espera') e.espera = Math.max(0, Number(ev.target.value) || 0);
    else e[field] = ev.target.value;
    if (field === 'texto') {
      box.querySelector('[data-previa]').lastChild.textContent = ' ' + (VF.buildText(e.texto, { nome: 'Maria Silva', vendedor: 'Você' }) || 'Prévia aparece aqui');
    }
    changed();
  });

  container.addEventListener('change', async (ev) => {
    if (ev.target.dataset.campo === 'ptt') {
      steps[Number(ev.target.closest('[data-i]').dataset.i)].ptt = ev.target.checked;
      return changed();
    }
    if (!ev.target.matches('[data-arquivo]')) return;
    const fileEl = ev.target.files[0];
    if (!fileEl) return;
    if (fileEl.size > LIMIT) return (VF.notice || alert)(`Arquivo grande demais (${VF.readableSize(fileEl.size)}). O limite é 16 MB.`, 'erro', 7000);
    const i = Number(ev.target.closest('[data-i]').dataset.i);
    const dataUrl = await new Promise((ok, error) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = error;
      r.readAsDataURL(fileEl);
    });
    const mediaId = VF.newId();
    await VF.write('midia:' + mediaId, dataUrl);
    const e = steps[i];
    Object.assign(e, { midiaId: mediaId, nomeArquivo: fileEl.name, mime: fileEl.type || '', tamanho: fileEl.size });
    if (e.tipoMidia === 'audio' || e.tipoMidia === 'video') {
      e.duracao = await new Promise((ok) => {
        const m = document.createElement(e.tipoMidia);
        m.preload = 'metadata';
        m.onloadedmetadata = () => ok(Math.round(m.duration) || 5);
        m.onerror = () => ok(5);
        m.src = dataUrl;
      });
    }
    render();
    changed();
  });

  render();

  return {
    value: () => JSON.parse(JSON.stringify(steps)),
    set(newOnes) {
      steps = JSON.parse(JSON.stringify(newOnes || []));
      render();
      changed();
    },
    validate() {
      if (steps.some((e) => e.tipo === 'texto' && !String(e.texto || '').trim())) return 'Há uma mensagem de texto vazia.';
      if (steps.some((e) => e.tipo === 'midia' && !e.midiaId)) return 'Há um áudio/vídeo/arquivo sem arquivo escolhido.';
      return '';
    },
  };
}
