// Voice notes must be OGG/Opus or the receiver can't play them. MP3s (e.g. imported from WaSeller)
// are converted before sending. Fixture: fixtures/tone-2s.mp3 (synthetic 2 s tone).
const fs = require('fs');
const path = require('path');
const MP3 = 'data:audio/mpeg;base64,' + fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tone-2s.mp3')).toString('base64');

module.exports = {
  async 'converts MP3 into a valid OGG/Opus file of the same length'(h) {
    const r = await h.page.evaluate(async (mp3) => {
      const out = await VoiceNote.convert(mp3);
      const bytes = Uint8Array.from(atob(out.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
      window.__lastOgg = out.dataUrl;
      return { head: out.dataUrl.slice(0, 40), isOgg: VoiceNote.isOggOpus(out.dataUrl), duration: decoded.duration, size: bytes.length };
    }, MP3);
    h.assert(r.head.startsWith('data:audio/ogg; codecs=opus;base64,'), 'ogg data url: ' + r.head);
    h.assert(r.isOgg, 'starts with OggS');
    h.assert(Math.abs(r.duration - 2) < 0.1, 'Chrome decodes it back with ~2 s: ' + r.duration);
    if (process.env.SAVE_OGG) fs.writeFileSync(process.env.SAVE_OGG, Buffer.from((await h.page.evaluate(() => window.__lastOgg)).split(',')[1], 'base64'));
  },

  async 'quick reply with an MP3 voice note is sent as OGG/Opus and the file is converted once'(h) {
    const reply = { id: 'r1', nome: 'Áudio', atalho: 'audio', pasta: '', etapas: [{ tipo: 'midia', tipoMidia: 'audio', midiaId: 'm1', mime: 'audio/mpeg', nomeArquivo: 'audio', ptt: true, espera: 0 }] };
    await h.setStorage({ respostas: [reply], 'midia:m1': MP3, config: { usarHorario: false, simularDigitacao: false } });
    await h.reload();
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.type('#origem', 'lista');
    await h.type('#origemLista', '5511999990003;Ana');
    await h.type('#usarResp', 'r1');
    await h.sleep(600);
    await h.click('#criar');
    await h.dialog('Começar envio');
    await h.waitUntil(() => window.__sent.length > 0, 'audio sent', 20000);
    const sent = (await h.page.evaluate(() => window.__sent))[0];
    h.equal(sent.type, 'file', 'sent as a file message');
    h.equal(sent.op.type, 'audio', 'audio type');
    h.equal(sent.op.isPtt, true, 'as a voice note');
    h.equal(sent.op.mimetype, 'audio/ogg; codecs=opus', 'with the OGG/Opus mime type');
    const stored = (await h.storage())['midia:m1'];
    h.assert(stored.startsWith('data:audio/ogg'), 'stored file replaced by the converted one');
  },

  async 'audio sent as a regular file (not a voice note) is left untouched'(h) {
    const reply = { id: 'r2', nome: 'Arquivo', atalho: 'arq', pasta: '', etapas: [{ tipo: 'midia', tipoMidia: 'audio', midiaId: 'm2', mime: 'audio/mpeg', nomeArquivo: 'musica.mp3', ptt: false, espera: 0 }] };
    await h.setStorage({ respostas: [reply], 'midia:m2': MP3, config: { usarHorario: false, simularDigitacao: false } });
    await h.reload();
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.type('#origem', 'lista');
    await h.type('#origemLista', '5511999990003;Ana');
    await h.type('#usarResp', 'r2');
    await h.sleep(600);
    await h.click('#criar');
    await h.dialog('Começar envio');
    await h.waitUntil(() => window.__sent.length > 0, 'audio sent', 20000);
    const sent = (await h.page.evaluate(() => window.__sent))[0];
    h.equal(sent.op.mimetype, 'audio/mpeg', 'keeps MP3');
    h.assert((await h.storage())['midia:m2'].startsWith('data:audio/mpeg'), 'stored file unchanged');
  },
};
