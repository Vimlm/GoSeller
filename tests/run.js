// Runs every spec in specs/ against the fake WhatsApp page in headless Chrome.
// Usage: cd tests && npm install && npm test        (or: npm test -- campaign  to filter)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_URL = 'file://' + path.join(__dirname, 'harness', 'whatsapp.html');
const filter = process.argv[2] || '';

// Helpers given to every spec. Selectors are searched inside the extension's two shadow roots.
function helpers(page) {
  const inShadow = (selector) => {
    for (const id of ['vf-host', 'vf-host-flut']) {
      const el = document.getElementById(id)?.shadowRoot?.querySelector(selector);
      if (el) return el;
    }
    return null;
  };
  const h = {
    page,
    async load({ keepStorage = false } = {}) {
      if (!keepStorage) {
        await page.goto(PAGE_URL);
        await page.evaluate(() => localStorage.clear());
      }
      await page.goto(PAGE_URL);
      await h.waitFor('#trilho');
      await h.sleep(300);
    },
    reload: () => h.load({ keepStorage: true }),
    // Opens a chat in the fake WhatsApp (fires the same event as clicking a conversation)
    async openChat(id) {
      await page.evaluate((x) => WPP.chat.openChatBottom(x), id);
      await h.sleep(1500); // header buttons are placed by a 1.2s check
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(selector, timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await h.exists(selector)) return;
        await h.sleep(50);
      }
      throw new Error(`Timed out waiting for ${selector}`);
    },
    async waitUntil(fn, label, timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await page.evaluate(fn)) return;
        await h.sleep(100);
      }
      throw new Error(`Timed out waiting until: ${label}`);
    },
    exists: (selector) => page.evaluate((s, f) => !!new Function('selector', `return (${f})(selector)`)(s), selector, inShadow.toString()),
    async click(selector) {
      await h.waitFor(selector);
      await page.evaluate((s, f) => {
        const el = new Function('selector', `return (${f})(selector)`)(s);
        // same sequence as a real mouse click (some screens react to pointerdown/up, e.g. drag-to-reorder)
        const opts = { bubbles: true, composed: true, button: 0, isPrimary: true, pointerId: 1 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.click();
      }, selector, inShadow.toString());
      await h.sleep(150);
    },
    async type(selector, text) {
      await h.waitFor(selector);
      await page.evaluate((s, f, t) => {
        const el = new Function('selector', `return (${f})(selector)`)(s);
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }, selector, inShadow.toString(), text);
      await h.sleep(150);
    },
    value: (selector) => page.evaluate((s, f) => new Function('selector', `return (${f})(selector)`)(s)?.value, selector, inShadow.toString()),
    text: (selector) => page.evaluate((s, f) => new Function('selector', `return (${f})(selector)`)(s)?.textContent || '', selector, inShadow.toString()),
    handle: (selector) => page.evaluateHandle((s, f) => new Function('selector', `return (${f})(selector)`)(s), selector, inShadow.toString()),
    storage: () => page.evaluate(() => JSON.parse(localStorage.getItem('goseller-test-storage') || '{}')),
    setStorage: (data) => page.evaluate((d) => chrome.storage.local.set(d), data),
    // Clicks a button in the confirmation dialog by its visible text
    async dialog(buttonText) {
      await h.waitFor('#dialogo:not(.oculto)');
      await page.evaluate((t) => {
        const d = document.getElementById('vf-host-flut').shadowRoot.querySelector('#dialogo');
        [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === t).click();
      }, buttonText);
      await h.sleep(150);
    },
    assert(cond, message) {
      if (!cond) throw new Error('Assertion failed: ' + message);
    },
    equal(actual, expected, message) {
      if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
  };
  return h;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--allow-file-access-from-files', '--no-first-run', '--window-size=1400,900'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const specs = fs.readdirSync(path.join(__dirname, 'specs')).filter((f) => f.endsWith('.js') && f.includes(filter)).sort();
  let passed = 0;
  let failed = 0;
  for (const file of specs) {
    const tests = require(path.join(__dirname, 'specs', file));
    for (const [name, fn] of Object.entries(tests)) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
      const h = helpers(page);
      try {
        await h.load();
        await fn(h);
        if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
        console.log(`  ✓ ${file} › ${name}`);
        passed++;
      } catch (e) {
        console.log(`  ✗ ${file} › ${name}\n      ${e.message}`);
        await page.screenshot({ path: path.join(__dirname, `fail-${file.replace('.js', '')}-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {});
        failed++;
      }
      await page.close();
    }
  }
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
