// Minimal stand-in for the chrome.* extension APIs used by the content scripts.
// Storage is persisted in localStorage so a page reload behaves like the real
// extension (chrome.storage survives reloads).
(() => {
  const KEY = 'goseller-test-storage';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const save = (data) => localStorage.setItem(KEY, JSON.stringify(data));
  const changeListeners = [];
  const messageListeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function emit(changes) {
    if (!Object.keys(changes).length) return;
    setTimeout(() => changeListeners.forEach((fn) => fn(changes, 'local')), 0);
  }

  const local = {
    async get(keys) {
      const data = load();
      if (keys == null) return clone(data);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, def]) => [k, k in data ? clone(data[k]) : def]));
    },
    async set(items) {
      const data = load();
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: clone(v) };
        data[k] = clone(v);
      }
      save(data);
      emit(changes);
    },
    async remove(keys) {
      const data = load();
      const changes = {};
      for (const k of [].concat(keys)) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      save(data);
      emit(changes);
    },
    async clear() {
      save({});
    },
  };

  const manifestReq = new XMLHttpRequest();
  manifestReq.open('GET', '../../manifest.json', false);
  manifestReq.send();
  const manifest = JSON.parse(manifestReq.responseText);
  const root = new URL('../../', location.href).href;

  // Fake GoSeller server: tests can replace window.__fakeApi(msg) to answer API calls.
  window.__fakeApi = async () => ({ erro: 'Servidor não conectado' });

  window.chrome = {
    storage: { local, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
    runtime: {
      getManifest: () => manifest,
      getURL: (p) => root + p,
      sendMessage: async (msg) => (msg && msg.tipo === 'api' ? window.__fakeApi(msg) : undefined),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
  };
  window.__sendToContent = (msg) => messageListeners.forEach((fn) => fn(msg, {}, () => {}));
})();
