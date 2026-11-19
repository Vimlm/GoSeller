// Chat header: our pencil sits after the name, the tabs button sits left of the label/list chip.
module.exports = {
  async 'tabs button goes left of the "Adicionar à lista" chip'(h) {
    await h.openChat('5511999990001@c.us');
    const order = await h.page.evaluate(() => {
      const actions = document.querySelector('#main header .acoes');
      return [...actions.children].map((el) => el.id || (el.querySelector('[aria-label]') || {}).ariaLabel || el.textContent.trim());
    });
    h.equal(order[0], 'vf-abas-wa', 'tabs button first in the actions row: ' + order.join(' | '));
    h.equal(order[1], 'chipLista', 'then the list chip');
  },
};
