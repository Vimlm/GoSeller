// "Despertador" do envio em massa: a cada 30s cutuca a aba do WhatsApp Web,
// para os envios seguirem mesmo com a aba em segundo plano.
const WA = 'https://web.whatsapp.com/*';

function garantirAlarme() {
  chrome.alarms.get('motor', (a) => {
    if (!a) chrome.alarms.create('motor', { periodInMinutes: 0.5 });
  });
}
chrome.runtime.onInstalled.addListener(garantirAlarme);
chrome.runtime.onStartup.addListener(garantirAlarme);
garantirAlarme();

async function temCampanhaAtiva() {
  const { campanhas = [] } = await chrome.storage.local.get('campanhas');
  if (!campanhas.length) return false;
  const r = await chrome.storage.local.get(campanhas.map((id) => 'campanha:' + id));
  return Object.values(r).some((c) => c && c.status === 'ativa');
}

async function cutucar() {
  const abas = await chrome.tabs.query({ url: WA });
  const ativa = await temCampanhaAtiva();
  if (!abas.length) {
    if (ativa) {
      await chrome.storage.local.set({
        motorStatus: { texto: '⚠️ Abra o WhatsApp Web para continuar os envios', tipo: 'aguardando', atualizado: Date.now() },
      });
    }
    return;
  }
  for (const aba of abas) {
    // Impede o Chrome de "congelar/descartar" a aba para economizar memória durante os envios
    if (ativa && aba.autoDiscardable !== false) chrome.tabs.update(aba.id, { autoDiscardable: false }).catch(() => {});
    if (!ativa && aba.autoDiscardable === false) chrome.tabs.update(aba.id, { autoDiscardable: true }).catch(() => {});
    chrome.tabs.sendMessage(aba.id, { tipo: 'tick' }).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'motor') cutucar();
});

function abrirPainel(secao) {
  const url = chrome.runtime.getURL('painel/painel.html') + (secao ? '#' + secao : '');
  chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(() => abrirPainel(''));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.tipo === 'abrirPainel') abrirPainel(msg.secao);
  if (msg && msg.tipo === 'cutucar') cutucar();
});
