import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

import createDriver from '../driver.ts';
import { fixture } from './fixtures/portal.js';

for (const authMode of ['token', 'password']) {
  test(`${authMode}: все объявленные операции выполняются с реквизитами выбранного режима`, async (t) => {
    const { driver, loginCalls } = fixture(t, { authMode });

    assert.equal(driver.isConfigured(), true);
    assert.deepEqual(await driver.testAuth(), { ok: true, userId: 7 });
    assert.equal((await driver.listTasks())[0].id, 42);
    assert.equal((await driver.getDashboard()).tasks[0].id, 42);
    assert.equal((await driver.taskDetail('42')).id, 42);
    assert.deepEqual(await driver.createTask({ title: 'Новая' }), { ok: true, id: 42 });
    assert.deepEqual(await driver.updateTask('42', { title: 'Правка' }), { ok: true, id: 42 });
    assert.deepEqual(await driver.taskPageData('42'), { attachments: [], comments: [] });
    assert.deepEqual(await driver.addComment('42', 'Комментарий'), { ok: true, commentId: 101 });
    assert.deepEqual(await driver.completeTask('42'), { ok: true });
    assert.deepEqual(await driver.findUsers('Иван'), [{ id: 7, name: 'Иван' }]);
    assert.deepEqual(await driver.listGroups(), [{ id: 9, name: 'Проект' }]);
    assert.equal(await driver.probeTaskNumber('42'), 'exists');
    assert.match(await driver.sourceUrl('42'), /\/user\/7\/tasks\/task\/view\/42\/$/u);
    assert.equal(loginCalls().length, authMode === 'password' ? 1 : 0);
  });
}

test('Переключение режимов и аккаунта исключает чужие реквизиты и сбрасывает identity', async (t) => {
  const f = fixture(t, { authMode: 'token' });

  await f.driver.accountIdentity();
  f.change({ authMode: 'password' });
  await f.driver.accountIdentity();
  f.change({ authMode: 'token' });
  await f.driver.accountIdentity();
  f.change({ authMode: 'password', login: 'another-user' });
  await f.driver.accountIdentity();
  assert.equal(f.loginCalls().length, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/user.current')).length, 4);
});

for (const changes of [
  { authMode: undefined }, { authMode: 'unknown' },
  { authMode: 'token', accessToken: '' }, { authMode: 'token', accessToken: 1 },
  { authMode: 'password', login: '' }, { authMode: 'password', password: '' },
  { authMode: 'password', password: false }, { authMode: 'password', login: ' ' },
]) {
  test(`Неполная конфигурация ${JSON.stringify(changes)} не обращается к сети`, async (t) => {
    const f = fixture(t);

    f.change(changes);
    assert.equal(f.driver.isConfigured(), false);
    assert.equal((await f.driver.testAuth()).ok, false);
    await assert.rejects(f.driver.listTasks());
    assert.equal(f.calls.length, 0);
  });
}

test('Неверный пароль не повторяет вход и не попадает в ошибку', async (t) => {
  const f = fixture(t);

  f.change({ password: 'invalid' });

  const result = await f.driver.testAuth();

  assert.equal(result.ok, false);
  assert.match(result.error, /проверьте логин и пароль/iu);
  assert.equal(f.loginCalls().length, 1);
  assert.equal(result.error.includes('invalid'), false);
});

for (const challenge of ['captcha_word', 'captcha_sid', 'USER_OTP', 'SECURITY_CODE']) {
  test(`Проверка ${challenge}: явная ошибка подключения без повторов`, async (t) => {
    const f = fixture(t, { challenge });
    const result = await f.driver.testAuth();

    assert.deepEqual(result, {
      ok: false,
      error: 'Требуется код/капча — войдите в портал и повторите',
    });
    assert.equal(f.calls.length, 1);
  });
}

test('Ротация сессии обновляет куки и sessid; отказ прав не повторяет мутацию', async (t) => {
  const f = fixture(t);

  await f.driver.accountIdentity();
  f.state.expired = true;
  await f.driver.completeTask('42');
  assert.equal(f.loginCalls().length, 2);
  assert.equal(f.state.session, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/tasks.task.complete')).length, 2);
  assert.equal(statSync(f.host.cookiePath).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.host.cookiePath, 'utf8').includes('fixture-password'), false);
  f.state.restError = 'ACCESS_DENIED';
  await assert.rejects(f.driver.createTask({ title: 'Новая' }), /\[скрыто\]/u);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/tasks.task.add')).length, 1);
  assert.equal(f.loginCalls().length, 2);
});

test('Куки восстанавливаются только для тех же реквизитов, CSRF перечитывается со страницы', async (t) => {
  const f = fixture(t);

  await f.driver.accountIdentity();

  const restored = createDriver(f.host);

  await restored.accountIdentity();
  assert.equal(f.loginCalls().length, 1);
  assert.equal(f.calls.filter((call) => call.options.method !== 'POST').length, 2);
});

test('Капча при ротации сразу завершает REST и не повторяет форму', async (t) => {
  const f = fixture(t);

  await f.driver.accountIdentity();
  f.state.expired = true;
  f.state.challenge = 'USER_OTP';
  await assert.rejects(f.driver.completeTask('42'), /Требуется код\/капча/iu);
  assert.equal(f.loginCalls().length, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/tasks.task.complete')).length, 1);
});

test('Перенаправление входа на другой origin не отправляет туда куки и пароль', async (t) => {
  const f = fixture(t, { redirect: 'https://other.fixture/' });
  const result = await f.driver.testAuth();

  assert.equal(result.ok, false);
  assert.match(result.error, /другой адрес/iu);
  assert.equal(f.calls.length, 1);
});

test('Повторный отказ авторизации ограничивает ротацию одной попыткой', async (t) => {
  const f = fixture(t);

  await f.driver.accountIdentity();
  f.state.restError = 'NO_AUTH';
  await assert.rejects(f.driver.completeTask('42'), /не подтвердил сессию после входа/iu);
  assert.equal(f.loginCalls().length, 2);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/tasks.task.complete')).length, 2);
});

test('Сетевой сбой REST не повторяет мутацию и скрывает реквизиты', async (t) => {
  const f = fixture(t);

  await f.driver.accountIdentity();

  const transport = f.host.fetch;
  let attempts = 0;

  f.host.fetch = async (url, options) => {
    attempts += 1;

    throw new Error('fixture-password');
  };

  // Новый экземпляр получает другой транспорт, но восстанавливает куки того же аккаунта.
  const driver = createDriver({
    ...f.host,
    fetch: async (url, options) => url.endsWith('/tasks.task.complete')
      ? f.host.fetch(url, options) : transport(url, options),
  });

  await assert.rejects(driver.completeTask('42'), (error) => {
    assert.equal(error.code, 'tracker_rest_error');
    assert.equal(error.message.includes('fixture-password'), false);

    return true;
  });
  assert.equal(attempts, 1);
});
