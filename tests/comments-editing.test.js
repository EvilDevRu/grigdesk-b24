import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, sentFields } from './fixtures/portal.js';

const LIST = 'task.commentitem.getlist';
const ADD = 'task.commentitem.add';
const UPDATE = 'tasks.task.update';
const DATE = '2026-10-31T14:30:00+07:00';

/**
 * Показывает именно REST-попытки указанного метода, без формы входа и страниц сессии.
 * Счётчик позволяет отличить допустимую ротацию от повторного выполнения мутации.
 */
function requests(calls, method) {
  return calls.filter(({ url }) => url.endsWith(`/rest/${method}`));
}

for (const authMode of ['token', 'password']) {
  test(`${authMode}: комментарии читают все next и сворачивают автора, дату и текст`, async (t) => {
    const first = {
      ID: '101',
      AUTHOR_ID: '7',
      AUTHOR_NAME: ' Иван Тестовый ',
      POST_DATE: DATE,
      POST_MESSAGE: ' Первая строка\nВторая строка ',
      POST_MESSAGE_HTML: '<b>Другой текст</b>',
      AUTHOR_EMAIL: 'private@portal.fixture',
    };
    const { driver, calls } = fixture(t, { authMode, respond: (method, fields) => {
      if (method !== LIST) {
        return null;
      }

      assert.equal(fields.TASKID, '42');
      assert.deepEqual(fields.ORDER, { ID: 'asc' });

      if (Number(fields.start) === 0) {
        return Response.json({ result: [first], next: 3 });
      }

      if (Number(fields.start) === 3) {
        return Response.json({ result: [first, { ID: '102' }], next: '19' });
      }

      assert.equal(Number(fields.start), 19);

      return Response.json({ result: [{ ...first, ID: '103' }] });
    } });
    const page = await driver.taskPageData('42');

    assert.deepEqual(page, {
      attachments: [],
      comments: [{
        mid: 101,
        authorId: 7,
        author: 'Иван Тестовый',
        time: DATE,
        text: ' Первая строка\nВторая строка ',
        isSystem: false,
        unread: false,
        attachments: [],
      }, {
        mid: 102,
        authorId: null,
        author: '—',
        time: '',
        text: '',
        isSystem: false,
        unread: false,
        attachments: [],
      }, {
        mid: 103,
        authorId: 7,
        author: 'Иван Тестовый',
        time: DATE,
        text: ' Первая строка\nВторая строка ',
        isSystem: false,
        unread: false,
        attachments: [],
      }],
    });
    assert.deepEqual(requests(calls, LIST).map((call) => Number(sentFields(call).start)), [0, 3, 19]);
  });

  test(`${authMode}: пустое обсуждение завершает чтение одной страницей`, async (t) => {
    const { driver, calls } = fixture(t, { authMode });

    assert.deepEqual(await driver.taskPageData('42'), { attachments: [], comments: [] });
    assert.equal(requests(calls, LIST).length, 1);
  });

  test(`${authMode}: добавление передаёт только текст и возвращает номер комментария`, async (t) => {
    const { driver, calls } = fixture(t, { authMode });
    const text = ' Комментарий\nс новой строкой ';

    assert.deepEqual(await driver.addComment('42', text), { ok: true, commentId: 101 });

    const sent = requests(calls, ADD);
    const body = sentFields(sent[0]);

    assert.equal(sent.length, 1);
    assert.equal(body.TASKID, '42');
    assert.deepEqual(body.FIELDS, { POST_MESSAGE: text });
    assert.equal(requests(calls, LIST).length, 0);
    assert.equal(requests(calls, 'tasks.task.get').length, 0);
  });

  for (const [input, expected] of [
    [{ title: 'Новое название' }, { TITLE: 'Новое название' }],
    [{ description: 'Новое описание' }, { DESCRIPTION: 'Новое описание' }],
    [{ description: '' }, { DESCRIPTION: '' }],
    [{ responsibleId: 9 }, { RESPONSIBLE_ID: 9 }],
    [{ deadline: DATE }, { DEADLINE: DATE }],
    [{ deadline: null }, { DEADLINE: null }],
    [{ deadline: '' }, { DEADLINE: '' }],
    [{ groupId: 9 }, { GROUP_ID: 9 }],
    [{ groupId: null }, { GROUP_ID: 0 }],
    [{ priority: 0 }, { PRIORITY: 0 }],
    [{ title: undefined, description: 'Только описание' }, { DESCRIPTION: 'Только описание' }],
    [{
      title: 'Название',
      description: 'Описание',
      responsibleId: 9,
      deadline: DATE,
    }, {
      TITLE: 'Название',
      DESCRIPTION: 'Описание',
      RESPONSIBLE_ID: 9,
      DEADLINE: DATE,
    }],
  ]) {
    test(`${authMode}: частичная правка ${JSON.stringify(input)}`, async (t) => {
      const { driver, calls } = fixture(t, { authMode });

      assert.deepEqual(await driver.updateTask('42', input), { ok: true, id: 42 });

      const sent = requests(calls, UPDATE);
      const body = sentFields(sent[0]);

      assert.equal(sent.length, 1);
      assert.equal(body.taskId, '42');

      const form = authMode === 'password'
        ? Object.fromEntries(Object.entries(expected)
          .map(([key, value]) => [key, value === null ? '' : String(value)]))
        : expected;

      assert.deepEqual(body.fields, form);
      assert.equal(requests(calls, 'tasks.task.get').length, 0);
    });
  }

  for (const [method, invoke] of [
    [LIST, (driver) => driver.taskPageData('42')],
    [ADD, (driver) => driver.addComment('42', 'Текст')],
    [UPDATE, (driver) => driver.updateTask('42', { title: 'Правка' })],
  ]) {
    for (const [error, status, message] of [
      ['ACCESS_DENIED', 200, 'Недостаточно прав для этой операции'],
      ['ACCESS_DENIED', 401, 'Нет права комментировать или изменять задачу'],
      ['ACCESS_DENIED', 403, 'Доступ запрещён порталом'],
      ['TASK_NOT_FOUND', 400, 'Задача удалена с портала'],
      ['ERROR_TASK_NOT_FOUND', 404, 'Такой задачи не существует'],
      ['ERROR_CORE', 400, 'TASKS_ERROR_EXCEPTION_#8; Action failed'],
    ]) {
      test(`${authMode}: ${method}, ${error}/${status} сохраняет текст без повторов`, async (t) => {
        const { driver, state, calls, loginCalls } = fixture(t, { authMode });

        state.restMethod = method;
        state.restError = error;
        state.restStatus = status;
        state.restDescription = message;

        await assert.rejects(invoke(driver), (failure) => {
          assert.equal(failure.message, message);
          assert.equal(failure.code, error.includes('TASK_NOT_FOUND')
            ? 'task_not_found' : 'tracker_rest_error');
          assert.equal(failure.status, error.includes('TASK_NOT_FOUND')
            ? 404 : error === 'ACCESS_DENIED' ? 403 : 502);

          return true;
        });
        assert.equal(requests(calls, method).length, 1);
        assert.equal(loginCalls().length, authMode === 'password' ? 1 : 0);

        // Отказ обсуждения не участвует в отдельной загрузке основных данных карточки.
        assert.equal((await driver.taskDetail('42')).id, 42);
      });
    }
  }

  for (const next of [0, -1, 'не-число', 1.5]) {
    test(`${authMode}: некорректный next ${next} не зацикливает обсуждение`, async (t) => {
      const { driver, calls } = fixture(t, { authMode, respond: (method) => method === LIST
        ? Response.json({ result: [], next }) : null });

      await assert.rejects(driver.taskPageData('42'), /пагинация комментариев/u);
      assert.equal(requests(calls, LIST).length, 1);
    });
  }

  for (const [method, invoke] of [
    [ADD, (driver) => driver.addComment('42', 'Текст')],
    [UPDATE, (driver) => driver.updateTask('42', { description: 'Правка' })],
  ]) {
    test(`${authMode}: сетевой сбой ${method} не повторяет мутацию`, async (t) => {
      const { driver, calls } = fixture(t, { authMode, respond: (current) => {
        if (current === method) {
          throw new Error('fixture-token fixture-password');
        }

        return null;
      } });

      await assert.rejects(invoke(driver), (failure) => {
        assert.equal(failure.code, 'tracker_rest_error');
        assert.equal(failure.message.includes('fixture-'), false);

        return true;
      });
      assert.equal(requests(calls, method).length, 1);
    });
  }

  test(`${authMode}: ошибка портала скрывает реквизиты и сохраняет причину`, async (t) => {
    const { driver, state } = fixture(t, { authMode });

    state.restError = 'ACCESS_DENIED';
    state.restDescription = authMode === 'token' ? 'Нет прав: fixture-token'
      : 'Нет прав: fixture-password; csrf1x0; session1';

    await assert.rejects(driver.addComment('42', 'Текст'), (failure) => {
      assert.match(failure.message, /^Нет прав: \[скрыто\]/u);
      assert.equal(/fixture-|csrf1|session1/u.test(failure.message), false);

      return true;
    });
  });

  for (const [method, result, invoke] of [
    [LIST, {}, (driver) => driver.taskPageData('42')],
    [LIST, [{ ID: 'нет номера' }], (driver) => driver.taskPageData('42')],
    [ADD, true, (driver) => driver.addComment('42', 'Текст')],
    [ADD, null, (driver) => driver.addComment('42', 'Текст')],
    [UPDATE, false, (driver) => driver.updateTask('42', { title: 'Правка' })],
  ]) {
    test(`${authMode}: ${method} не маскирует некорректный result ${JSON.stringify(result)}`, async (t) => {
      const { driver, calls } = fixture(t, { authMode, respond: (current) => current === method
        ? Response.json({ result }) : null });

      await assert.rejects(invoke(driver), { code: 'tracker_rest_error' });
      assert.equal(requests(calls, method).length, 1);
    });
  }
}

test('Ротация сессии при добавлении обновляет cookie и CSRF, комментарий создаётся один раз', async (t) => {
  let writes = 0;
  const { driver, calls, state, loginCalls } = fixture(t, { respond: (method) => {
    if (method === ADD) {
      writes += 1;
    }

    return null;
  } });

  await driver.accountIdentity();
  state.expired = true;
  assert.deepEqual(await driver.addComment('42', 'Текст после ротации'), { ok: true, commentId: 101 });
  assert.equal(writes, 1);
  assert.equal(loginCalls().length, 2);

  const sent = requests(calls, ADD);

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(({ options }) => options.headers.Cookie),
    ['PHPSESSID=session1', 'PHPSESSID=session2']);
  assert.deepEqual(sent.map(({ options }) => new URLSearchParams(options.body).get('sessid')),
    ['csrf1x0', 'csrf2x0']);
  assert.deepEqual(sent.map((call) => sentFields(call).FIELDS),
    [{ POST_MESSAGE: 'Текст после ротации' }, { POST_MESSAGE: 'Текст после ротации' }]);
});

test('Неверные изменения и пустые комментарии отклоняются до подключения к порталу', async (t) => {
  const { driver, calls } = fixture(t);

  for (const input of [null, [], {}, { title: ' ' }, { description: null },
    { responsibleId: 0 }, { deadline: 123 }, { unknown: 'поле' }, { title: undefined }, { priority: null }]) {
    await assert.rejects(driver.updateTask('42', input), { code: 'tracker_bad_request' });
  }

  for (const text of ['', ' \n ', null, {}]) {
    await assert.rejects(driver.addComment('42', text), { code: 'tracker_bad_request' });
  }

  assert.equal(calls.length, 0);
});

test('Повторный отказ сессии при добавлении ограничен одним обновлением авторизации', async (t) => {
  const { driver, calls, state, loginCalls } = fixture(t);

  state.restMethod = ADD;
  state.restError = 'NO_AUTH';
  await assert.rejects(driver.addComment('42', 'Текст'), /не подтвердил сессию после входа/u);
  assert.equal(requests(calls, ADD).length, 2);
  assert.equal(loginCalls().length, 2);
});

test('Отказ прав без кода ошибки на HTTP 401 сохраняет текст и не повторяет добавление', async (t) => {
  const { driver, calls, loginCalls } = fixture(t, { respond: (method) => method === ADD
    ? Response.json({ error: '', error_description: 'Нет права добавлять комментарии' }, { status: 401 })
    : null });

  await assert.rejects(driver.addComment('42', 'Текст'), /Нет права добавлять комментарии/u);
  assert.equal(requests(calls, ADD).length, 1);
  assert.equal(loginCalls().length, 1);
});
