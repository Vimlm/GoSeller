// "Relatar problema": collects recent errors (numbers masked) and sends them with the description.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  async 'sends description, diagnostics, masked errors and the attachment'(h) {
    // an error from our own code containing a phone number
    await h.page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'falhou para 5511999990001', filename: chrome.runtime.getURL('src/content.js'), lineno: 42 })));
    // an error notice shown to the seller (campaign without audience)
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.click('#criar');

    const file = path.join(os.tmpdir(), 'goseller-print.png');
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    await h.click('#trilho [data-abrir="config"]');
    await h.click('#relatar');
    await h.type('#relDescricao', 'A campanha parou');
    await (await h.handle('#relAnexo')).uploadFile(file);
    await h.click('#relEnviar');
    await h.waitUntil(() => window.__reports.length === 1, 'report sent');
    const msg = (await h.page.evaluate(() => window.__reports))[0];
    h.equal(msg.relato.descricao, 'A campanha parou', 'description');
    h.equal(msg.relato.info.versao, require('../../manifest.json').version, 'version');
    h.assert(msg.relato.info.whatsappConectado === true, 'WhatsApp state');
    const errors = msg.relato.erros.join('\n');
    h.assert(errors.includes('55119****0001'), 'phone number masked: ' + errors);
    h.assert(!errors.includes('5511999990001'), 'full number never sent');
    h.assert(errors.includes('Escolha para quem enviar'), 'error notice logged');
    h.equal(msg.anexo.mime, 'image/png', 'attachment type');
    h.assert(msg.anexo.dataUrl.startsWith('data:image/png;base64,'), 'attachment data');
    h.assert((await h.text('#relatoCaixa')).includes('#A1B2C3'), 'shows the report code');
  },

  async 'asks for a description'(h) {
    await h.click('#trilho [data-abrir="config"]');
    await h.click('#relatar');
    await h.click('#relEnviar');
    await h.sleep(200);
    h.equal((await h.page.evaluate(() => window.__reports)).length, 0, 'nothing sent without description');
  },

  async 'error log survives a reload and keeps only the last 50'(h) {
    await h.page.evaluate(() => {
      for (let i = 0; i < 60; i++) window.dispatchEvent(new ErrorEvent('error', { message: 'erro ' + i, filename: chrome.runtime.getURL('src/content.js') }));
    });
    await h.sleep(1500); // log is saved with a 1s debounce
    await h.reload();
    const log = (await h.storage()).logErros;
    h.equal(log.length, 50, 'capped at 50');
    h.equal(log[49].msg.startsWith('erro 59'), true, 'keeps the most recent');
  },
};
