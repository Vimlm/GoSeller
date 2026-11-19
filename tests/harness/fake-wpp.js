// Fake WA-JS (window.WPP) with a few chats and labels. Everything "sent" is
// recorded in window.__sent so tests can check it.
(() => {
  const wid = (s) => {
    const [user, server] = s.split('@');
    return { _serialized: s, user, server };
  };
  const now = Math.floor(Date.now() / 1000);
  const chats = [
    { id: wid('5511999990001@c.us'), contact: { name: 'Maria Silva' }, t: now - 3600, labels: ['1'] },
    { id: wid('5511999990002@c.us'), contact: { pushname: 'João' }, t: now - 86400 * 3, labels: ['1', '2'] },
    { id: wid('5511999990003@c.us'), contact: { name: 'Ana Souza' }, t: now - 86400 * 10, labels: [] },
    { id: wid('120363000000000000@g.us'), name: 'Grupo da turma', isGroup: true, t: now, labels: [] },
  ];
  const labels = [
    { id: '1', name: 'Lead', hexColor: '#25d366', count: 2 },
    { id: '2', name: 'Quente', hexColor: '#ff5722', count: 1 },
  ];
  const listeners = {};
  let active = chats[0];
  window.__sent = [];
  const ok = (extra) => ({ id: wid('msg' + Math.random().toString(36).slice(2) + '@c.us'), ack: 1, sendMsgResult: Promise.resolve(), ...extra });
  const findChat = (id) => chats.find((c) => c.id._serialized === id);

  const DATA_URL = /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z0-9-.!#$%*+.{}|~`]+=[a-z0-9-.!#$%*+.{}()_|~`]+)*)?(;base64)?,([a-z0-9!$&',()*+;=\-._~:@\/?%\s<>]*?)$/i;
  window.WPP = {
    version: 'fake',
    isFullReady: true,
    loader: { onFullReady: (fn) => setTimeout(fn, 0) },
    on: (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn),
    conn: { isMainReady: () => true, getMyUserId: () => wid('5511900000000@c.us') },
    chat: {
      list: async (filter = {}) => chats.filter((c) => (!filter.onlyUsers || !c.isGroup) && (!filter.withLabels || filter.withLabels.some((l) => c.labels.includes(l)))),
      get: (id) => findChat(id),
      find: async (id) => findChat(id) || Promise.reject(new Error('not found')),
      getActiveChat: () => active,
      openChatBottom: async (id) => {
        active = findChat(id) || active;
        (listeners['chat.active_chat'] || []).forEach((fn) => fn(active));
      },
      sendTextMessage: async (id, text) => (window.__sent.push({ id, type: 'text', text }), ok()),
      sendFileMessage: async (id, data, op) => {
        // Same data URL check as the real WA-JS (parse-data-url) — it throws 'invalid_data_url'
        if (typeof data === 'string' && !DATA_URL.test(data.trim())) throw 'invalid_data_url';
        window.__sent.push({ id, type: 'file', op, head: String(data).slice(0, 60) });
        return ok();
      },
      setInputText: async (text) => (window.__inputText = text),
      setChatList: async (type, ids) => (window.__chatList = { type, ids }),
      markIsComposing: async () => {},
      markIsPaused: async () => {},
      markIsRecording: async () => {},
    },
    contact: {
      get: async (id) => (findChat(id) || {}).contact || null,
      save: async (id, first, op) => (window.__savedContact = { id, first, last: op.lastName }),
      queryExists: async (id) => ({ wid: wid(id) }),
      getPnLidEntry: async () => null,
    },
    labels: {
      getAllLabels: async () => labels,
      addOrRemoveLabels: async (ids, ops) => (window.__labelOps = (window.__labelOps || []).concat([{ ids, ops }])),
    },
  };
  // Tests can change a contact's labels: __setLabels('5511999990003@c.us', ['1'])
  window.__setLabels = (id, ids) => (findChat(id).labels = ids);
  // Tests can simulate an incoming message: __incoming('5511999990001@c.us', 'oi')
  window.__incoming = (from, body) =>
    (listeners['chat.new_message'] || []).forEach((fn) => fn({ id: { fromMe: false, remote: wid(from) }, isNewMsg: true, type: 'chat', body }));
})();
