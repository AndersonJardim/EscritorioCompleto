// Capturas da seção do Habblaud World no modo demonstração (?mock=1&world=approved: só dados fictícios do
// FakeWorldApi, nada do escritório de verdade): o cartão "Seu prédio" (docs/screenshots/world-predio.png) e a janela
// "Ver o que foi enviado" (docs/screenshots/world-enviado.png). Sobe o Vite sozinho (ou usa --url de um Habblaud já
// rodando) e fotografa com o Chromium headless do Playwright, sem tocar no navegador de quem roda.
//
// Uso: npm run shots:world [-- --url http://localhost:4747] [--out docs/screenshots] [--chromium /caminho/do/chrome]
// Sem o Chromium headless da versão do playwright-core do projeto: npx playwright-core install chromium-headless-shell,
// ou --chromium (ou HABBLAUD_CHROMIUM) com o caminho de outro executável.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(root, opt('out') ?? 'docs/screenshots');
const executablePath = opt('chromium') ?? process.env.HABBLAUD_CHROMIUM;

let base = opt('url');
let vite;
if (!base) {
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: join(root, 'vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'error' });
  await vite.listen();
  base = vite.resolvedUrls.local[0].replace(/\/$/, '');
}

const problems = [];
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR' });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  // Português (a língua de origem), mesmo com o navegador em outra língua.
  await page.addInitScript(() => localStorage.setItem('habblaud:locale', 'pt-BR'));
  await page.goto(`${base}/?mock=1&world=approved`, { waitUntil: 'load', timeout: 60_000 });

  // O chip "no mundo" da barra do topo abre Configurações › Habblaud World.
  await page.locator('.ui-world-chip').click({ timeout: 20_000 });
  const card = page.locator('.ui-world__building.is-connected');
  await card.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  mkdirSync(out, { recursive: true });
  await page.locator('#ui-world').screenshot({ path: join(out, 'world-predio.png'), animations: 'disabled' });
  console.log('salvo:', join(out, 'world-predio.png'));

  await card.getByRole('button', { name: 'Ver o que foi enviado' }).click();
  await page.locator('.ui-world-sent__json').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.locator('.ui-world-sent').screenshot({ path: join(out, 'world-enviado.png'), animations: 'disabled' });
  console.log('salvo:', join(out, 'world-enviado.png'));
} finally {
  await browser.close();
  await vite?.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
