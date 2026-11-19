// Unified tabs: any tab can be linked to a WhatsApp label and still accept contacts by hand.
// Fake data: label 1 "Lead" = Maria (…0001) + João (…0002); label 2 "Quente" = João.
const tabsOf = async (h) => (await h.storage()).abas || [];
const idsOf = (tab) => tab.chats.map((c) => c.ids[0]).sort();

async function createTab(h, name, labelId, mode) {
  await h.click('#novaAba');
  await h.type('#nomeAba', name);
  await h.type('#etqAba', labelId);
  if (mode === 'copiar') await h.click('input[name="modoEtq"][value="copiar"]');
  await h.click('#salvarAba');
  await h.page.waitForFunction((n) => (JSON.parse(localStorage.getItem('goseller-test-storage') || '{}').abas || []).some((a) => a.nome === n), {}, name);
  return (await tabsOf(h)).find((a) => a.nome === name);
}

module.exports = {
  async 'old label-only tab is converted and filled from the label'(h) {
    await h.setStorage({ abas: [{ id: 't1', nome: 'Leads', cor: '#25d366', tipo: 'etiqueta', etiquetaId: '1' }] });
    await h.reload();
    await h.page.waitForFunction(() => ((JSON.parse(localStorage.getItem('goseller-test-storage')).abas || [])[0].chats || []).length === 2);
    const [tab] = await tabsOf(h);
    h.equal(tab.tipo, 'manual', 'tab type converted');
    h.equal(tab.sincronizar, true, 'kept in sync with the label');
    h.equal(idsOf(tab).join(), '5511999990001@c.us,5511999990002@c.us', 'label contacts imported');
  },

  async 'synced tab pulls contacts that get the label later'(h) {
    const tab = await createTab(h, 'Quentes', '2');
    h.equal(idsOf(tab).join(), '5511999990002@c.us', 'imported João');
    h.equal(tab.sincronizar, true, 'sync mode is the default');
    await h.page.evaluate(() => window.__setLabels('5511999990003@c.us', ['2']));
    await h.click(`#pilulas [data-aba="${tab.id}"]`);
    await h.page.waitForFunction((id) => JSON.parse(localStorage.getItem('goseller-test-storage')).abas.find((a) => a.id === id).chats.length === 2, {}, tab.id);
    h.equal(idsOf((await tabsOf(h)).find((a) => a.id === tab.id)).join(), '5511999990002@c.us,5511999990003@c.us', 'Ana entered on her own');
  },

  async 'contact removed by hand does not come back'(h) {
    const tab = await createTab(h, 'Leads', '1');
    // after saving, the panel shows the tabs list: open this tab's editor
    await h.click(`[data-id="${tab.id}"] .aba-nome`);
    await h.waitFor('[data-tirar]');
    await h.click('[data-tirar="0"]');
    await h.click('#salvarAba');
    await h.page.waitForFunction((id) => JSON.parse(localStorage.getItem('goseller-test-storage')).abas.find((a) => a.id === id).chats.length === 1, {}, tab.id);
    await h.click(`#pilulas [data-aba="${tab.id}"]`);
    await h.sleep(500);
    h.equal((await tabsOf(h)).find((a) => a.id === tab.id).chats.length, 1, 'removed contact stays out');
  },

  async 'copy once does not pull new contacts'(h) {
    const tab = await createTab(h, 'Cópia', '1', 'copiar');
    h.equal(idsOf(tab).length, 2, 'copied the two contacts');
    h.assert(!tab.etiquetaId && !tab.sincronizar, 'not linked after copying');
    await h.page.evaluate(() => window.__setLabels('5511999990003@c.us', ['1']));
    await h.click(`#pilulas [data-aba="${tab.id}"]`);
    await h.sleep(500);
    h.equal((await tabsOf(h)).find((a) => a.id === tab.id).chats.length, 2, 'Ana did not enter');
  },

  async 'label tab accepts contacts by hand and shows in the header menu'(h) {
    const tab = await createTab(h, 'Quentes', '2');
    await h.openChat('5511999990001@c.us');
    await h.page.evaluate(() => document.getElementById('vf-abas-wa').click());
    await h.waitFor('#pop:not(.oculto)');
    h.assert((await h.text('#pop')).includes('Quentes'), 'label tab listed for manual add');
    await h.page.evaluate(() => {
      const pop = document.getElementById('vf-host-flut').shadowRoot.querySelector('#pop');
      [...pop.querySelectorAll('button[data-i]')].find((b) => b.textContent.includes('Quentes')).click();
    });
    await h.page.waitForFunction((id) => JSON.parse(localStorage.getItem('goseller-test-storage')).abas.find((a) => a.id === id).chats.length === 2, {}, tab.id);
    h.assert(idsOf((await tabsOf(h)).find((a) => a.id === tab.id)).includes('5511999990001@c.us'), 'Maria (open chat) added by hand');
  },
};
