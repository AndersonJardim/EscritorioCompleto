// WorldService: a releitura automática de /v1/me na lista de espera (relógio falso; o resto do serviço é coberto pelas
// rotas em http.test.ts).
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse, WorldAccess } from '../../shared/world/protocol';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import type { WorldClient, WorldResult } from './client';
import { WAITING_POLL_MS, WorldService } from './service';
import { WorldSettingsStore } from './settings';

setQuiet(true);

const TOKEN = 't'.repeat(43);

function me(access: WorldAccess): WorldResult<MeResponse> {
  return {
    ok: true,
    status: 200,
    data: { account: { emailMasked: 'a***@exemplo.com', access, locale: 'pt-BR', createdAt: '' }, devices: [] },
  };
}

describe('WorldService: lista de espera', () => {
  let cleanup: () => void;
  let store: WorldSettingsStore;
  let services: WorldService[];

  beforeEach(() => {
    vi.useFakeTimers();
    const t = tempDir();
    cleanup = t.cleanup;
    store = new WorldSettingsStore(join(t.dir, 'world.json'));
    services = [];
  });

  afterEach(() => {
    services.forEach((s) => s.stop());
    vi.useRealTimers();
    cleanup();
  });

  function start(opts: { access?: WorldAccess | null; terminal?: boolean; meFn?: () => Promise<WorldResult<MeResponse>> } = {}) {
    const access = opts.access === undefined ? 'waiting' : opts.access;
    if (access) store.save({ deviceId: 'dev1', token: TOKEN, email: 'ana@exemplo.com', access });
    const meFn = vi.fn(opts.meFn ?? (async () => me('waiting')));
    const logout = vi.fn(async () => ({ ok: true as const, status: 204, data: {} }));
    const client = { me: meFn, logout } as unknown as WorldClient;
    const onChange = vi.fn();
    const service = new WorldService({ config: { enabled: true, dev: true, url: 'http://127.0.0.1:1' }, terminal: opts.terminal ?? true, store, client, onChange });
    services.push(service);
    return { service, meFn, logout, onChange };
  }

  it('relê /v1/me a cada 30 min enquanto espera e vira "approved" sozinho, avisando o snapshot', async () => {
    let access: WorldAccess = 'waiting';
    const { service, meFn, onChange } = start({ meFn: async () => me(access) });
    expect(WAITING_POLL_MS).toBe(30 * 60_000);

    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS - 1);
    expect(meFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(meFn).toHaveBeenCalledTimes(1);
    expect(service.state()).toBe('waiting');
    expect(onChange).not.toHaveBeenCalled();

    access = 'approved';
    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
    expect(meFn).toHaveBeenCalledTimes(2);
    expect(service.state()).toBe('approved');
    expect(service.meta()).toEqual({ enabled: true, configured: true, state: 'approved' });
    expect(store.get()?.access).toBe('approved');
    expect(onChange).toHaveBeenCalledTimes(1);

    // Aprovada: para de perguntar.
    await vi.advanceTimersByTimeAsync(4 * WAITING_POLL_MS);
    expect(meFn).toHaveBeenCalledTimes(2);
  });

  it('servidor fora do ar: continua tentando no mesmo ritmo, com lastError network', async () => {
    const { service, meFn } = start({ meFn: async () => ({ ok: false, status: 502, code: 'world_unreachable' }) });
    await vi.advanceTimersByTimeAsync(2 * WAITING_POLL_MS);
    expect(meFn).toHaveBeenCalledTimes(2);
    expect(service.state()).toBe('waiting');
    expect((await service.status()).lastError).toBe('network');
  });

  it('token recusado (401): apaga a sessão e para', async () => {
    const { service, meFn } = start({ meFn: async () => ({ ok: false, status: 401, code: 'unauthorized' }) });
    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
    expect(service.state()).toBe('logged_out');
    await vi.advanceTimersByTimeAsync(3 * WAITING_POLL_MS);
    expect(meFn).toHaveBeenCalledTimes(1);
  });

  it('não relê sem conta, já aprovado, sem a trava do terminal, depois de sair ou de stop()', async () => {
    const none = start({ access: null });
    const approved = start({ access: 'approved' });
    await vi.advanceTimersByTimeAsync(2 * WAITING_POLL_MS);
    expect(none.meFn).not.toHaveBeenCalled();
    expect(approved.meFn).not.toHaveBeenCalled();

    store.clear();
    const noTerminal = start({ terminal: false });
    await vi.advanceTimersByTimeAsync(2 * WAITING_POLL_MS);
    expect(noTerminal.meFn).not.toHaveBeenCalled();

    store.clear();
    const out = start();
    await out.service.logout();
    await vi.advanceTimersByTimeAsync(2 * WAITING_POLL_MS);
    expect(out.meFn).not.toHaveBeenCalled();

    const stopped = start();
    stopped.service.stop();
    await vi.advanceTimersByTimeAsync(2 * WAITING_POLL_MS);
    expect(stopped.meFn).not.toHaveBeenCalled();
  });
});
