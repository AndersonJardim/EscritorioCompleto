// Contas do Gemini: descoberta de pastas, aliases, email e metadados.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { detectGeminiAccounts, discoverGeminiDirs } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function createHome() {
  const tmp = tempDir('habblaud-gemini-test-');
  cleanups.push(tmp.cleanup);
  const geminiDir = (name: string, marker: 'accounts' | 'tmp' | 'none' = 'accounts') => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    if (marker === 'accounts') {
      writeFileSync(join(dir, 'google_accounts.json'), JSON.stringify({ active: 'user@example.com' }));
    } else if (marker === 'tmp') {
      mkdirSync(join(dir, 'tmp', 'proj1', 'chats'), { recursive: true });
    }
    return dir;
  };
  return { dir: tmp.dir, geminiDir };
}

describe('contas do Gemini', () => {
  it('descoberta: ~/.gemini com marcadores, GEMINI_HOME e HABBLAUD_GEMINI_DIRS', () => {
    const h = createHome();
    const main = h.geminiDir('.gemini', 'accounts');
    const work = h.geminiDir('.gemini-work', 'tmp');
    h.geminiDir('.gemini-empty', 'none');

    const discovered = discoverGeminiDirs({}, h.dir);
    expect(discovered).toContain(main);
    expect(discovered).toContain(work);

    const custom = h.geminiDir('custom-gemini');
    expect(discoverGeminiDirs({ GEMINI_HOME: custom }, h.dir)).toContain(custom);

    const list = discoverGeminiDirs({ HABBLAUD_GEMINI_DIRS: `${custom}, ${main}` }, h.dir);
    expect(list).toEqual([custom, main]);
  });

  it('detecta contas: lê e-mail do google_accounts.json, alias de shell e atribui cor', () => {
    const h = createHome();
    const main = h.geminiDir('.gemini');
    const work = h.geminiDir('.gemini-work');
    writeFileSync(
      join(h.dir, '.bashrc'),
      "alias gm='gemini'\nalias c='claude'\n",
    );

    const accs = detectGeminiAccounts([main, work], {
      home: h.dir,
      env: {},
      taken: { shorts: ['C'], colors: [ACCOUNT_COLORS[0]] },
    });

    expect(accs.length).toBe(2);
    expect(accs[0]).toMatchObject({
      id: '.gemini',
      provider: 'gemini',
      short: 'GM',
      name: 'Gemini GM',
      email: 'user@example.com',
      configDir: main,
    });
    expect(accs[0].color).toBe(ACCOUNT_COLORS[1]);
  });

  it('sem alias: deriva letra G e nome simples quando única conta', () => {
    const h = createHome();
    const main = h.geminiDir('.gemini');

    const accs = detectGeminiAccounts([main], {
      home: h.dir,
      env: {},
      taken: { shorts: ['C'], colors: [] },
    });

    expect(accs[0].short).toBe('G');
    expect(accs[0].name).toBe('Gemini');
  });
});
