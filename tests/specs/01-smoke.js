// The extension loads on the WhatsApp page and every side-panel section opens without errors.
module.exports = {
  async 'loads the bar, rail and version'(h) {
    const manifest = require('../../manifest.json');
    h.assert(await h.exists('#pilulas'), 'tab pills bar exists');
    h.assert((await h.text('#trilho')).includes('v' + manifest.version), 'rail shows the manifest version');
  },

  async 'every side-panel section opens'(h) {
    for (const section of ['contato', 'respostas', 'envio', 'abas', 'kanban', 'naoperturbe', 'config']) {
      await h.click(`#trilho [data-abrir="${section}"]`);
      h.assert(!(await h.exists('#lateral.oculto')), `panel open for ${section}`);
      h.assert(!(await h.text('#corpo')).includes('Erro:'), `no error rendered in ${section}`);
    }
  },
};
