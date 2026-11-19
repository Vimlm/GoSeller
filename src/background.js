// Bulk-send "alarm clock": every 30s nudges the WhatsApp Web tab,
// so sending keeps going even with the tab in the background.
const WA = 'https://web.whatsapp.com/*';

function ensureAlarm() {
  chrome.alarms.get('motor', (a) => {
    if (!a) chrome.alarms.create('motor', { periodInMinutes: 0.5 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

async function anyActiveCampaign() {
  const { campanhas: campaigns = [] } = await chrome.storage.local.get('campanhas');
  if (!campaigns.length) return false;
  const r = await chrome.storage.local.get(campaigns.map((id) => 'campanha:' + id));
  return Object.values(r).some((c) => c && c.status === 'ativa');
}

async function nudge() {
  const tabs = await chrome.tabs.query({ url: WA });
  const active = await anyActiveCampaign();
  if (!tabs.length) {
    if (active) {
      await chrome.storage.local.set({
        motorStatus: { texto: '⚠️ Abra o WhatsApp Web para continuar os envios', tipo: 'aguardando', atualizado: Date.now() },
      });
    }
    return;
  }
  for (const tab of tabs) {
    // Keeps Chrome from "freezing/discarding" the tab to save memory while sending
    if (active && tab.autoDiscardable !== false) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    if (!active && tab.autoDiscardable === false) chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
    chrome.tabs.sendMessage(tab.id, { tipo: 'tick' }).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'motor') nudge();
});

// Extension icon click: go to the WhatsApp Web tab (or open one) and show the panel
async function openPanel(section) {
  const [tab] = await chrome.tabs.query({ url: WA });
  if (!tab) {
    await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  chrome.tabs.sendMessage(tab.id, { tipo: 'abrirPainel', secao: section || 'respostas' }).catch(() => {});
}

chrome.action.onClicked.addListener(() => openPanel(''));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.tipo === 'cutucar') nudge();
});

// GoSeller server (Kanban and automatic sequences). Calls go out from here
// (not from the WhatsApp page) to avoid the CORS block.
const DEFAULT_SERVER = 'https://agents.coolmeia.tech/vendaflow';
async function callApi({ metodo: method, caminho: path, corpo: body }) {
  const { servidor: server = {} } = await chrome.storage.local.get('servidor');
  if (!server.chave) return { erro: 'Servidor não conectado' };
  try {
    const r = await fetch((server.url || DEFAULT_SERVER) + '/api' + path, {
      method: method,
      headers: { Authorization: 'Bearer ' + server.chave, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { erro: r.status === 401 ? 'Chave de acesso inválida' : j.erro || 'Erro ' + r.status };
    return { dados: j };
  } catch (e) {
    return { erro: 'Sem conexão com o servidor do GoSeller' };
  }
}
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg && msg.tipo === 'api') {
    callApi(msg).then(respond);
    return true;
  }
  return false;
});
