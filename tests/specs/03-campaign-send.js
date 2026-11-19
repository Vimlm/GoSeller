// End to end: create a campaign for a pasted number and check the fake WhatsApp received the message.
module.exports = {
  async 'sends the first message of a new campaign'(h) {
    await h.setStorage({ config: { usarHorario: false, simularDigitacao: false } });
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.type('#nome', 'Teste envio');
    await h.type('#origem', 'lista');
    await h.type('#origemLista', '5511999990003;Ana');
    await h.type('#modelosCamp textarea[data-campo="texto"]', 'Oi {primeiro_nome}, tudo bem?');
    await h.sleep(600); // audience count is debounced
    h.assert((await h.text('#publico')).includes('1 lead'), 'audience shows 1 lead');
    await h.click('#criar');
    await h.dialog('Começar envio');
    await h.waitUntil(() => window.__sent.length > 0, 'a message was sent', 15000);
    const sent = await h.page.evaluate(() => window.__sent);
    h.equal(sent[0].id, '5511999990003@c.us', 'sent to the pasted number');
    h.equal(sent[0].text, 'Oi Ana, tudo bem?', 'variables were filled');
  },
};
