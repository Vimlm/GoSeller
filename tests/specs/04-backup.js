// Single "Restaurar backup" button: accepts a GoSeller backup and restores the chosen parts.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  async 'only one restore button, no competitor name on screen'(h) {
    await h.click('#trilho [data-abrir="config"]');
    h.assert(await h.exists('#restaurar'), 'restore input exists');
    h.assert(!(await h.exists('#importarWa')), 'old WaSeller button removed');
    h.assert(!/WaSeller/i.test(await h.text('#corpo')), 'WaSeller not mentioned');
  },

  async 'restores a GoSeller backup'(h) {
    const file = path.join(os.tmpdir(), 'goseller-test-backup.json');
    const reply = { id: 'r1', nome: 'Boas-vindas', atalho: 'oi', pasta: '', etapas: [{ tipo: 'texto', texto: 'Olá!', espera: 2 }] };
    fs.writeFileSync(file, JSON.stringify({ app: 'goseller', versao: 2, em: Date.now(), partes: ['respostas'], dados: { respostas: [reply] } }));
    await h.click('#trilho [data-abrir="config"]');
    const input = await h.handle('#restaurar');
    await input.uploadFile(file);
    await h.waitFor('#rsOk');
    await h.click('#rsOk');
    await h.page.waitForFunction(() => (JSON.parse(localStorage.getItem('goseller-test-storage') || '{}').respostas || []).length === 1);
    h.equal((await h.storage()).respostas[0].nome, 'Boas-vindas', 'reply restored');
  },
};
