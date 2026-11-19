// "Nova campanha" keeps its state while switching sections, and starts clean after a reload.
module.exports = {
  async 'draft survives switching sections'(h) {
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.type('#nome', 'Black November');
    await h.type('#origem', 'lista');
    await h.type('#origemLista', '11988887777;Carla');
    await h.type('#modelosCamp textarea[data-campo="texto"]', 'Oi {primeiro_nome}!');
    await h.sleep(500); // draft save is debounced

    await h.click('#trilho [data-abrir="respostas"]');
    await h.click('#trilho [data-abrir="config"]');
    await h.click('#trilho [data-abrir="envio"]');

    h.assert(await h.exists('#nome'), 'reopened straight into Nova campanha');
    h.equal(await h.value('#nome'), 'Black November', 'campaign name kept');
    h.equal(await h.value('#origem'), 'lista', 'audience source kept');
    h.equal(await h.value('#origemLista'), '11988887777;Carla', 'pasted numbers kept');
    h.equal(await h.value('#modelosCamp textarea[data-campo="texto"]'), 'Oi {primeiro_nome}!', 'message text kept');
  },

  async 'reload starts clean'(h) {
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.type('#nome', 'Rascunho');
    await h.sleep(500);
    await h.reload();
    await h.click('#trilho [data-abrir="envio"]');
    h.assert(await h.exists('#nova'), 'opens the campaign list, not the form');
    await h.click('#nova');
    h.equal(await h.value('#nome'), '', 'name is empty after reload');
    h.assert(!('rascunhoCampanha' in (await h.storage())), 'no draft stored');
  },

  async 'clicking the active section icon closes the panel'(h) {
    await h.click('#trilho [data-abrir="envio"]');
    await h.click('#nova');
    await h.click('#trilho [data-abrir="envio"]');
    h.assert(await h.exists('#lateral.oculto'), 'panel closed');
    await h.click('#trilho [data-abrir="envio"]');
    h.assert(await h.exists('#nome'), 'reopens on Nova campanha');
  },
};
