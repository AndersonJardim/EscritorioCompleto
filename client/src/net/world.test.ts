import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../../shared/types';
import { fullParts, draftAppearance } from '../ui/world/world-model';
import {
  FAKE_CODE,
  FAKE_EMAIL,
  FAKE_PASSWORD,
  FakeWorldApi,
  HttpWorldApi,
  fakeWorldStateFrom,
  parseWorldStatus,
  readWorldMeta,
  worldErrorCode,
  worldSource,
  type WorldCharacterInput,
} from './world';

type Call = { url: string; init?: RequestInit };

function recorder(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status }));
  }) as unknown as typeof fetch;
  return { calls, api: new HttpWorldApi(fetchImpl) };
}

const snap = (world: unknown): OfficeSnapshot => ({ meta: { world } }) as unknown as OfficeSnapshot;

const CHARACTER: WorldCharacterInput = {
  name: 'Pixel Dev',
  look: 'f',
  parts: fullParts(draftAppearance('f')),
  traits: ['cafeina', 'games'],
  intro: 'coffee',
};

describe('HttpWorldApi', () => {
  it('cada ação vai para a rota do contrato, com JSON (mesmo vazio) nos POST/PUT', async () => {
    const { calls, api } = recorder(202, {});
    await api.register({ email: 'a@b.co', password: 'x'.repeat(12), locale: 'pt-BR' });
    await api.verify({ email: 'a@b.co', code: '123456' });
    await api.login({ email: 'a@b.co', password: 'x'.repeat(12) });
    await api.logout();
    await api.resend({ email: 'a@b.co' });
    await api.forgotPassword({ email: 'a@b.co' });
    await api.resetPassword({ email: 'a@b.co', code: '123456', password: 'y'.repeat(12) });
    await api.saveCharacter(CHARACTER);
    await api.saveVisibility({ mode: 'discreet', closed: true, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false });
    await api.revokeDevice('d/1');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'POST /api/world/register',
      'POST /api/world/verify',
      'POST /api/world/login',
      'POST /api/world/logout',
      'POST /api/world/resend',
      'POST /api/world/password/forgot',
      'POST /api/world/password/reset',
      'PUT /api/world/character',
      'PUT /api/world/visibility',
      'POST /api/world/devices/d%2F1/revoke',
    ]);
    for (const c of calls) {
      expect(c.init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(typeof c.init?.body).toBe('string');
    }
    expect(calls[3].init?.body).toBe('{}');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ email: 'a@b.co', password: 'x'.repeat(12), locale: 'pt-BR' });
    expect(JSON.parse(String(calls[7].init?.body))).toEqual(CHARACTER);
  });

  it('GET sem corpo; o status vem conferido', async () => {
    const { calls, api } = recorder(200, { available: true, configured: true, state: 'waiting', account: { emailMasked: 'vo***@exemplo.com', access: 'waiting' } });
    const r = await api.status();
    expect(calls[0].url).toBe('/api/world/status');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(r).toEqual({ ok: true, data: { available: true, configured: true, state: 'waiting', account: { emailMasked: 'vo***@exemplo.com', access: 'waiting' } } });
  });

  it('status torto vira erro, não estado inventado', async () => {
    expect((await recorder(200, { state: 'dancing' }).api.status()).ok).toBe(false);
    expect((await recorder(200, '<html>').api.status()).ok).toBe(false);
  });

  it('dispositivos: aceita a lista solta ou dentro de {devices}', async () => {
    const list = [{ id: 'd1', label: 'Dispositivo 1', current: true }, { id: 'd2', label: 'Dispositivo 2' }];
    const a = await recorder(200, list).api.devices();
    const b = await recorder(200, { devices: list }).api.devices();
    expect(a).toEqual(b);
    expect(a.ok && a.data.map((d) => d.current)).toEqual([true, false]);
  });

  it('erro do contrato: o código vem do corpo e o status vai junto', async () => {
    const r = await recorder(409, { error: { code: 'name_taken', message: 'Name taken' } }).api.saveCharacter(CHARACTER);
    expect(r).toEqual({ ok: false, code: 'name_taken', status: 409 });
  });

  it('sem código (guarda, rota desligada, corpo vazio): decide pelo status HTTP', async () => {
    expect(await recorder(403, { error: 'Origem não permitida.' }).api.logout()).toMatchObject({ code: 'forbidden' });
    expect(await recorder(404, undefined).api.status()).toMatchObject({ code: 'not_configured' });
    expect(await recorder(429, '').api.resend({ email: 'a@b.co' })).toMatchObject({ code: 'rate_limited' });
    expect(await recorder(500, { error: { code: 'algo_novo' } }).api.logout()).toMatchObject({ code: 'unknown' });
  });

  it('sem resposta do Habblaud: offline', async () => {
    const api = new HttpWorldApi((() => Promise.reject(new TypeError('rede'))) as unknown as typeof fetch);
    expect(await api.login({ email: 'a@b.co', password: 'x' })).toEqual({ ok: false, code: 'offline', status: 0 });
  });

  it('worldErrorCode só aceita os códigos conhecidos', () => {
    expect(worldErrorCode(400, { error: { code: 'invalid_code' } })).toBe('invalid_code');
    expect(worldErrorCode(400, { error: { code: '__proto__' } })).toBe('unknown');
  });
});

describe('meta.world e status', () => {
  it('readWorldMeta: ausente, torto ou com estado desconhecido', () => {
    expect(readWorldMeta(null)).toBeUndefined();
    expect(readWorldMeta(snap(undefined))).toBeUndefined();
    expect(readWorldMeta(snap({ configured: true }))).toBeUndefined();
    expect(readWorldMeta(snap({ enabled: true, configured: true, state: 'waiting' }))).toEqual({ enabled: true, configured: true, state: 'waiting' });
    expect(readWorldMeta(snap({ enabled: true, state: 'zzz' }))).toEqual({ enabled: true, configured: false, state: 'off' });
  });

  it('parseWorldStatus completa a visibilidade do personagem com os padrões', () => {
    const s = parseWorldStatus({ state: 'approved', configured: true, player: { name: 'Pixel', look: 'm', parts: {}, traits: ['games', 'cafeina'], intro: 'coffee', visibility: { mode: 'discreet' } } });
    expect(s?.player?.visibility).toEqual({ mode: 'discreet', closed: false, hideCountry: false, tokensVisible: true, leaderboard: false, compactions: false });
  });

  it('parseWorldStatus: mustRename só quando é true', () => {
    const player = { name: '???', look: 'm', parts: {}, traits: ['games', 'cafeina'], intro: 'coffee' };
    expect(parseWorldStatus({ state: 'approved', player: { ...player, mustRename: true } })?.player?.mustRename).toBe(true);
    expect(parseWorldStatus({ state: 'approved', player: { ...player, mustRename: 1 } })?.player).not.toHaveProperty('mustRename');
  });
});

describe('FakeWorldApi', () => {
  const fake = (state?: ConstructorParameters<typeof FakeWorldApi>[0]) => new FakeWorldApi({ delayMs: 0, ...state });

  it('cadastro → código → lista de espera → aprovado', async () => {
    const api = fake();
    expect(api.meta()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
    expect((await api.register({ email: 'nova@exemplo.com', password: 'cavalo correto bateria', locale: 'pt-BR' })).ok).toBe(true);
    expect(await api.verify({ email: 'nova@exemplo.com', code: '000000' })).toMatchObject({ ok: false, code: 'invalid_code' });
    expect((await api.verify({ email: 'nova@exemplo.com', code: FAKE_CODE })).ok).toBe(true);
    expect(api.meta().state).toBe('waiting');
    const st = await api.status();
    expect(st.ok && st.data.account).toEqual({ emailMasked: 'no***@exemplo.com', access: 'waiting' });
    api.approve();
    expect(api.meta().state).toBe('approved');
  });

  it('nome trocado à força: o status pede um nome novo e salvar o personagem resolve', async () => {
    const api = fake({ state: 'approved' });
    api.forceRename();
    const before = await api.status();
    expect(before.ok && before.data.player).toMatchObject({ name: '???', mustRename: true });
    const p = before.ok ? before.data.player! : null;
    expect((await api.saveCharacter({ name: 'Pixel Nova', look: p!.look, parts: p!.parts, traits: p!.traits, intro: p!.intro })).ok).toBe(true);
    const after = await api.status();
    expect(after.ok && after.data.player?.name).toBe('Pixel Nova');
    expect(after.ok && after.data.player).not.toHaveProperty('mustRename');
  });

  it('login: credenciais erradas, e-mail sem confirmar, banido', async () => {
    const api = fake();
    await api.register({ email: 'nova@exemplo.com', password: 'cavalo correto bateria', locale: 'pt-BR' });
    expect(await api.login({ email: 'nova@exemplo.com', password: 'outra senha qualquer' })).toMatchObject({ code: 'invalid_credentials' });
    expect(await api.login({ email: 'nova@exemplo.com', password: 'cavalo correto bateria' })).toMatchObject({ code: 'email_not_verified' });
    expect(await api.login({ email: 'banido@exemplo.com', password: 'cavalo correto bateria' })).toMatchObject({ code: 'banned' });
    expect(await api.login({ email: 'ninguem@exemplo.com', password: 'cavalo correto bateria' })).toMatchObject({ code: 'invalid_credentials' });
  });

  it('cadastro com e-mail que já existe responde igual (não revela quem tem conta)', async () => {
    const api = fake({ state: 'waiting' });
    await api.logout();
    expect((await api.register({ email: FAKE_EMAIL, password: 'cavalo correto bateria', locale: 'pt-BR' })).ok).toBe(true);
    // A senha antiga continua valendo.
    expect((await api.login({ email: FAKE_EMAIL, password: FAKE_PASSWORD })).ok).toBe(true);
  });

  it('personagem: nome em uso, reservado, inválido e traços que não combinam', async () => {
    const api = fake({ state: 'waiting' });
    expect(await api.saveCharacter({ ...CHARACTER, name: 'Marina' })).toMatchObject({ code: 'name_taken' });
    expect(await api.saveCharacter({ ...CHARACTER, name: 'Admin' })).toMatchObject({ code: 'name_blocked' });
    expect(await api.saveCharacter({ ...CHARACTER, name: 'a!' })).toMatchObject({ code: 'name_invalid' });
    expect(await api.saveCharacter({ ...CHARACTER, traits: ['timidez', 'piadas'] })).toMatchObject({ code: 'invalid' });
    expect((await api.saveCharacter(CHARACTER)).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data.player).toMatchObject({ name: 'Pixel Dev', traits: ['cafeina', 'games'], intro: 'coffee', country: 'BR' });
  });

  it('visibilidade só com personagem; esconder o país tira o país do perfil', async () => {
    const api = fake({ state: 'approved' });
    const vis = { mode: 'live', closed: false, hideCountry: true, tokensVisible: false, leaderboard: false, compactions: false } as const;
    expect((await api.saveVisibility(vis)).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data.player?.visibility).toEqual(vis);
    expect(st.ok && st.data.player?.country).toBeUndefined();
    const fresh = fake({ state: 'waiting' });
    expect(await fresh.saveVisibility(vis)).toMatchObject({ code: 'invalid' });
  });

  it('dispositivos: revogar outro some da lista; revogar este sai da conta', async () => {
    const api = fake({ state: 'approved' });
    const list = await api.devices();
    expect(list.ok && list.data.map((d) => [d.label, d.current])).toEqual([['Dispositivo 2', false], ['Dispositivo 1', true]]);
    const other = list.ok ? list.data.find((d) => !d.current)! : null;
    expect((await api.revokeDevice(other!.id)).ok).toBe(true);
    const after = await api.devices();
    expect(after.ok && after.data).toHaveLength(1);
    const me = after.ok ? after.data[0] : null;
    await api.revokeDevice(me!.id);
    expect(api.meta().state).toBe('logged_out');
  });

  it('esqueci a senha: código errado, código certo troca a senha e desconecta tudo', async () => {
    const api = fake({ state: 'waiting' });
    expect((await api.forgotPassword({ email: FAKE_EMAIL })).ok).toBe(true);
    expect(await api.resetPassword({ email: FAKE_EMAIL, code: '111111', password: 'senha nova bem longa' })).toMatchObject({ code: 'invalid_code' });
    expect((await api.resetPassword({ email: FAKE_EMAIL, code: FAKE_CODE, password: 'senha nova bem longa' })).ok).toBe(true);
    expect(api.meta().state).toBe('logged_out');
    expect(await api.login({ email: FAKE_EMAIL, password: FAKE_PASSWORD })).toMatchObject({ code: 'invalid_credentials' });
    expect((await api.login({ email: FAKE_EMAIL, password: 'senha nova bem longa' })).ok).toBe(true);
  });

  it('reenviar o código: 3 por hora', async () => {
    let now = 1_000_000;
    const api = fake({ now: () => now });
    for (let i = 0; i < 3; i++) expect((await api.resend({ email: 'a@b.co' })).ok).toBe(true);
    expect(await api.resend({ email: 'a@b.co' })).toMatchObject({ code: 'rate_limited' });
    now += 3_600_001;
    expect((await api.resend({ email: 'a@b.co' })).ok).toBe(true);
  });

  it('failNext simula erro de rede ou do servidor do mundo na próxima chamada', async () => {
    const api = fake({ state: 'waiting' });
    api.failNext('network');
    expect(await api.status()).toMatchObject({ ok: false, code: 'network' });
    expect((await api.status()).ok).toBe(true);
  });

  it('sem servidor configurado: tudo responde not_configured', async () => {
    const api = fake({ state: 'off' });
    expect(api.meta()).toEqual({ enabled: false, configured: false, state: 'off' });
    expect(await api.login({ email: 'a@b.co', password: 'x' })).toMatchObject({ code: 'not_configured' });
  });

  it('avisa quem escuta quando o estado muda', async () => {
    const api = fake();
    let n = 0;
    const off = api.onChange(() => n++);
    await api.register({ email: 'nova@exemplo.com', password: 'cavalo correto bateria', locale: 'pt-BR' });
    await api.verify({ email: 'nova@exemplo.com', code: FAKE_CODE });
    expect(n).toBe(2);
    // Ler não avisa (senão a interface releria o status sem parar).
    await api.status();
    await api.devices();
    expect(n).toBe(2);
    off();
    api.approve();
    expect(n).toBe(2);
  });
});

describe('de onde vêm os dados', () => {
  it('?world= escolhe o estado inicial do falso (valor desconhecido: sem conta)', () => {
    expect(fakeWorldStateFrom('?mock=1')).toBeNull();
    expect(fakeWorldStateFrom('?mock=1&world')).toBe('logged_out');
    expect(fakeWorldStateFrom('?mock=1&world=waiting')).toBe('waiting');
    expect(fakeWorldStateFrom('?world=xyz')).toBe('logged_out');
  });

  it('modo demonstração sem &world: nada do World (as capturas antigas não mudam)', () => {
    const src = worldSource({ mock: true, liveSnapshot: null }, '?mock=1');
    expect(src.client).toBeNull();
    expect(src.meta()).toBeUndefined();
  });

  it('modo demonstração com &world: o falso responde', () => {
    const src = worldSource({ mock: true, liveSnapshot: null }, '?mock=1&world=approved');
    expect(src.fake).toBe(true);
    expect(src.client).toBeInstanceOf(FakeWorldApi);
    expect(src.meta()).toEqual({ enabled: true, configured: true, state: 'approved' });
  });

  it('ao vivo: rotas locais e o meta.world do snapshot ao vivo', () => {
    const store = { mock: false, liveSnapshot: snap({ enabled: true, configured: true, state: 'logged_out' }) };
    const src = worldSource(store, '?world=waiting');
    expect(src.client).toBeInstanceOf(HttpWorldApi);
    expect(src.meta()).toEqual({ enabled: true, configured: true, state: 'logged_out' });
  });
});
