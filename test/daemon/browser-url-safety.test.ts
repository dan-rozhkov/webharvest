import { describe, it, expect, vi } from 'vitest';
import { assertUrlIsSafe, assertSessionUrlSafePure } from '../../src/daemon/service.js';
import { HarvestError } from '../../src/core/errors.js';

// Мокаем DNS-резолв, чтобы без реальной сети смоделировать транзиентный сбой
// резолвера (а не политику безопасности) — единственный способ получить код
// `network` из assertPublicHost() детерминированно в юнит-тесте. Не задет ни
// один тест выше/ниже с IP-литералами: для них isIP()/isPrivateAddress() —
// синхронная ветка, `lookup()` вообще не вызывается.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    throw new Error('ENOTFOUND: имя не резолвится (смоделированный сбой резолвера)');
  }),
}));

const UNRESOLVABLE_URL = 'http://this-host-name-does-not-resolve.example/';

// Специально IP-литералы, а не имена хостов: assertPublicHost() резолвит
// имя через настоящий DNS (node:dns/promises), а для IP-литерала уходит по
// синхронной ветке isIP()/isPrivateAddress() и в сеть не лезет вовсе. Юнит-
// тесты не должны трогать сеть — эти два случая позволяют проверить и
// приватную, и публичную ветку без единого реального запроса.
const PRIVATE_URL = 'http://169.254.169.254/latest/meta-data/';
const PUBLIC_URL = 'http://93.184.216.34/';

describe('assertUrlIsSafe: SSRF-барьер browser use (та же пара, что у fetcher.validate())', () => {
  it('приватный/внутренний адрес отклоняется', async () => {
    await expect(assertUrlIsSafe(PRIVATE_URL, false)).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('обычный публичный адрес не задет', async () => {
    await expect(assertUrlIsSafe(PUBLIC_URL, false)).resolves.toBeUndefined();
  });

  it('allowPrivate=true явно пропускает приватный адрес', async () => {
    await expect(assertUrlIsSafe(PRIVATE_URL, true)).resolves.toBeUndefined();
  });

  it('allowPrivate=true всё равно отклоняет синтаксически невалидный url', async () => {
    await expect(assertUrlIsSafe('не url', true)).rejects.toMatchObject({ code: 'invalid_url' });
  });
});

function fakeSession(url: string) {
  return { id: 's_1', page: { url: () => url } };
}

describe('assertSessionUrlSafePure: пост-навигационная проверка живой сессии', () => {
  it('навигация на приватный/внутренний адрес после первичной проверки — SSRF-ошибка, сессия закрывается', async () => {
    const close = vi.fn(async () => {});
    const session = fakeSession(PRIVATE_URL);

    await expect(assertSessionUrlSafePure(session, false, close)).rejects.toBeInstanceOf(HarvestError);
    await expect(assertSessionUrlSafePure(session, false, close)).rejects.toMatchObject({ code: 'invalid_url' });
    // Сессия закрыта сразу при нарушении — использовать её дальше (например,
    // снять снапшот и вернуть его наружу) уже нельзя.
    expect(close).toHaveBeenCalledWith('s_1');
  });

  it('обычная публичная навигация не затронута — сессия не закрывается', async () => {
    const close = vi.fn(async () => {});
    const session = fakeSession(PUBLIC_URL);

    await expect(assertSessionUrlSafePure(session, false, close)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it('allowPrivate=true по-прежнему разрешает приватный адрес живой сессии', async () => {
    const close = vi.fn(async () => {});
    const session = fakeSession(PRIVATE_URL);

    await expect(assertSessionUrlSafePure(session, true, close)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it('транзиентный сбой DNS-резолвера (код network) не закрывает сессию, но ошибка доходит до вызывающего', async () => {
    // Это не нарушение политики — это "прямо сейчас не смогли проверить".
    // Агент несколько шагов внутри аутентифицированной сессии не должен
    // терять страницу и её cookies из-за кратковременной недоступности DNS.
    const close = vi.fn(async () => {});
    const session = fakeSession(UNRESOLVABLE_URL);

    await expect(assertSessionUrlSafePure(session, false, close)).rejects.toMatchObject({ code: 'network' });
    expect(close).not.toHaveBeenCalled();
  });
});
