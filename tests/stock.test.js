import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import createDriver from '../driver.ts';

const TOKEN = 'секрет-только-в-теле';

/**
 * Пакет получает обычный host без импортов из ядра и обращается к наблюдаемому транспорту.
 * Ответы REST позволяют проверить преобразование полей и отсутствие повторов мутаций.
 */
function fixture({ error = null, baseUrl = 'https://cloud.fixture' } = {}) {
  const calls = [];
  let values = {
    baseUrl,
    authMode: 'token',
    accessToken: TOKEN,
  };
  const driver = createDriver({
    credentials: { read: () => values },
    dataDir: '/fixture',
    cookiePath: '/fixture/cookies.json',
    serial: (operation) => operation(),
    logger: { info: () => {}, warn: () => {} },
    fetch: async (url, options) => {
      calls.push({ url, options });

      const method = new URL(url).pathname.slice('/rest/'.length);
      const fields = JSON.parse(options.body);
      const task = {
        id: '42',
        title: 'Облачная задача',
        status: '4',
        createdBy: '9',
        responsibleId: '7',
      };
      const responses = {
        'user.current': { ID: '7' },
        'tasks.task.list': { tasks: fields.start ? [] : [task] },
        'tasks.task.get': { task },
        'tasks.task.add': { task },
        'tasks.task.complete': true,
        'user.get': [{
          ID: '7',
          NAME: 'Иван',
          LAST_NAME: 'Тестовый',
        }],
        'sonet_group.get': [{ ID: '9', NAME: 'Проект' }],
      };

      assert.ok(Object.hasOwn(responses, method), method);

      if (error && method === 'tasks.task.add') {
        return Response.json({ error: 'ACCESS_DENIED', error_description: TOKEN }, { status: error });
      }

      return Response.json({ result: responses[method] });
    },
  });

  return {
    driver,
    calls,
    changeToken: () => {
      values = { ...values, accessToken: 'новый-токен' };
    },
  };
}

test('Пакет объявляет схему и только доступные возможности', async () => {
  const manifest = JSON.parse(await readFile(new URL('../driver.json', import.meta.url), 'utf8'));
  const { driver } = fixture();

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(manifest.id, driver.id);
  assert.equal(manifest.version, '0.1.5');
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.contract, 1);
  assert.equal(manifest.settings.accessToken.secret, true);
  assert.deepEqual(Object.keys(driver.capabilities).filter((key) => driver.capabilities[key]).sort(),
    ['comments', 'complete', 'create', 'delete', 'editing', 'projects', 'timer', 'users']);
  assert.equal(typeof driver.timer, 'function');
  assert.equal(typeof driver.addComment, 'function');
  assert.equal(typeof driver.updateTask, 'function');
});

test('REST преобразует dashboard, детали, создание, завершение и справочники', async () => {
  const { driver, calls } = fixture();
  const dashboard = await driver.getDashboard();

  assert.deepEqual(dashboard.widgets, []);
  assert.equal(dashboard.tasks.length, 0);
  assert.equal(dashboard.toReview[0].statusKind, 'await_acceptance');
  assert.equal((await driver.taskDetail('42')).statusText, 'Сдана — ждёт приёмки постановщиком');
  assert.deepEqual(await driver.createTask({ title: 'Новая', priority: 2 }), { ok: true, id: 42 });
  assert.deepEqual(await driver.completeTask('42'), { ok: true });
  assert.deepEqual(await driver.findUsers('Иван'), [{ id: 7, name: 'Иван Тестовый' }]);
  assert.deepEqual(await driver.listGroups(), [{ id: 9, name: 'Проект' }]);
  assert.match(await driver.sourceUrl('42'), /\/user\/7\/tasks\/task\/view\/42\/$/u);

  for (const { url, options } of calls) {
    assert.equal(url.includes(TOKEN), false);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(JSON.parse(options.body).auth, TOKEN);
  }

  const add = calls.find(({ url }) => url.endsWith('/tasks.task.add'));

  assert.deepEqual(JSON.parse(add.options.body).fields, { TITLE: 'Новая', PRIORITY: 2 });
});

test('Смена реквизитов сбрасывает кеш идентичности', async () => {
  const { driver, calls, changeToken } = fixture();

  await driver.accountIdentity();
  await driver.accountIdentity();
  changeToken();
  await driver.accountIdentity();

  assert.equal(calls.length, 2);
});

for (const error of [200, 403, 429, 503]) {
  test(`REST ${error}: ошибка скрывает токен и не повторяет создание`, async () => {
    const { driver, calls } = fixture({ error });

    await assert.rejects(driver.createTask({ title: 'Новая' }), (failure) => {
      assert.equal(failure.code, 'tracker_rest_error');
      assert.equal(failure.message.includes(TOKEN), false);

      return true;
    });
    assert.equal(calls.length, 1);
  });
}

for (const baseUrl of ['http://cloud.fixture', 'https://user@cloud.fixture', 'https://cloud.fixture/rest/']) {
  test(`Недопустимый origin ${baseUrl} не обращается к сети`, async () => {
    const { driver, calls } = fixture({ baseUrl });

    assert.equal(driver.isConfigured(), false);
    await assert.rejects(driver.listTasks());
    assert.equal(calls.length, 0);
  });
}
