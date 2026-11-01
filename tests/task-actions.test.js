import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, sentFields } from './fixtures/portal.js';

const COMPLETE = 'tasks.task.complete';
const UPDATE = 'tasks.task.update';
const DELETE = 'tasks.task.delete';

/**
 * Выделяет задачные REST-вызовы из формы входа и чтений страницы сессии.
 * Порядок и число запросов доказывают отсутствие повторных мутаций.
 */
function actions(calls) {
  return calls.filter(({ url }) => [COMPLETE, UPDATE, DELETE]
    .some((method) => url.endsWith(`/rest/${method}`)));
}

for (const authMode of ['token', 'password']) {
  test(`${authMode}: обычное завершение не меняет статус отдельным запросом`, async (t) => {
    const { driver, calls } = fixture(t, { authMode });

    assert.deepEqual(await driver.completeTask('42'), { ok: true });
    assert.equal(actions(calls).length, 1);
    assert.ok(actions(calls)[0].url.endsWith(COMPLETE));
    assert.deepEqual(sentFields(actions(calls)[0]), { taskId: '42' });
  });

  test(`${authMode}: отказ нового модуля завершает через STATUS=5 ровно один раз`, async (t) => {
    const { driver, state, calls } = fixture(t, { authMode });

    state.completeDenied = true;
    assert.deepEqual(await driver.completeTask('42'), { ok: true });

    const sent = actions(calls);

    assert.deepEqual(sent.map(({ url }) => new URL(url).pathname), [`/rest/${COMPLETE}`, `/rest/${UPDATE}`]);
    assert.deepEqual(sentFields(sent[1]), {
      taskId: '42',
      fields: { STATUS: authMode === 'password' ? '5' : 5 },
    });
  });

  for (const [status, error, description] of [
    [400, '0', 'Нет разрешения'],
    [403, '0', 'Нет разрешения'],
    [400, 'ACCESS_DENIED', 'Действие над задачей не разрешено'],
    [403, 'ACCESS_DENIED', 'Действие над задачей не разрешено'],
  ]) {
    test(`${authMode}: fallback распознаёт ${status}/${error}/${description}`, async (t) => {
      const { driver, state, calls } = fixture(t, { authMode });

      Object.assign(state, {
        restMethod: COMPLETE,
        restError: error,
        restStatus: status,
        restDescription: description,
      });
      assert.deepEqual(await driver.completeTask('42'), { ok: true });
      assert.equal(actions(calls).filter(({ url }) => url.endsWith(UPDATE)).length, 1);
    });
  }

  for (const [status, error, description] of [
    [200, '0', 'Действие над задачей не разрешено'],
    [503, '0', 'Действие над задачей не разрешено'],
    [400, 'TASK_NOT_FOUND', 'Задачи нет'],
    [403, 'ACCESS_DENIED', 'Доступ запрещён'],
  ]) {
    test(`${authMode}: ${status}/${error} без нужного признака не запускает fallback`, async (t) => {
      const { driver, state, calls } = fixture(t, { authMode });

      Object.assign(state, {
        restMethod: COMPLETE,
        restError: error,
        restStatus: status,
        restDescription: description,
      });
      await assert.rejects(driver.completeTask('42'));
      assert.equal(actions(calls).length, 1);
    });
  }

  for (const failure of ['portal', 'network', 'malformed']) {
    test(`${authMode}: отказ fallback ${failure} сохраняет исходную ошибку без секретов`, async (t) => {
      const { driver, state, calls } = fixture(t, { authMode, respond: (method) => {
        if (method !== UPDATE) {
          return null;
        }

        if (failure === 'network') {
          throw new Error('fixture-password fixture-token');
        }

        return failure === 'malformed' ? Response.json({ result: false })
          : Response.json({ error: 'UPDATE_DENIED', error_description: 'Ошибка запасного запроса' },
            { status: 403 });
      } });
      const secrets = authMode === 'password' ? 'fixture-password csrf1x0 session1' : 'fixture-token';

      Object.assign(state, {
        restMethod: COMPLETE,
        restError: '0',
        restStatus: 400,
        restDescription: `Исходный отказ: ${secrets}`,
      });
      await assert.rejects(driver.completeTask('42'), (error) => {
        assert.equal(error.code, 'tracker_rest_error');
        assert.equal(error.status, 502);
        assert.match(error.message, /^Исходный отказ: \[скрыто\]/u);
        assert.equal(/fixture-|csrf1|session1|запасного/u.test(error.message), false);

        return true;
      });
      assert.equal(actions(calls).length, 2);
      assert.equal(actions(calls).filter(({ url }) => url.endsWith(UPDATE)).length, 1);
    });
  }

  test(`${authMode}: deleteTask передаёт номер задачи и подтверждает удаление`, async (t) => {
    const { driver, calls } = fixture(t, { authMode });

    assert.deepEqual(await driver.deleteTask('42'), { ok: true });
    assert.equal(actions(calls).length, 1);
    assert.ok(actions(calls)[0].url.endsWith(DELETE));
    assert.deepEqual(sentFields(actions(calls)[0]), { taskId: '42' });
  });

  test(`${authMode}: ошибка портала при удалении не повторяет запрос и скрывает секрет`, async (t) => {
    const { driver, state, calls } = fixture(t, { authMode });

    Object.assign(state, {
      restMethod: DELETE,
      restError: 'ACCESS_DENIED',
      restStatus: 403,
      restDescription: authMode === 'token' ? 'fixture-token' : 'fixture-password',
    });
    await assert.rejects(driver.deleteTask('42'), (error) => {
      assert.equal(error.code, 'tracker_rest_error');
      assert.equal(error.status, 403);
      assert.equal(error.message.includes('fixture-'), false);

      return true;
    });
    assert.equal(actions(calls).length, 1);
  });

  for (const result of [false, true, null, {}, { task: false }, { task: 'true' }]) {
    test(`${authMode}: удаление отвергает result=${JSON.stringify(result)}`, async (t) => {
      const { driver, calls } = fixture(t, { authMode, respond: (method) => method === DELETE
        ? Response.json({ result }) : null });

      await assert.rejects(driver.deleteTask('42'), { code: 'tracker_rest_error', status: 502 });
      assert.equal(actions(calls).length, 1);
    });
  }
}
