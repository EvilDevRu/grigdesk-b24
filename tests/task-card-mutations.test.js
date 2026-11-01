import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, sentFields } from './fixtures/portal.js';

/**
 * Отделяет целевой REST-вызов от авторизации и проверяет отсутствие повторной мутации.
 * Возвращает декодированное тело для проверки обоих транспортов пакета.
 */
function sent(calls, method) {
  const matching = calls.filter((call) => call.url.endsWith(`/rest/${method}`));

  assert.equal(matching.length, 1);

  return sentFields(matching[0]);
}

for (const authMode of ['token', 'password']) {
  for (const [action, status] of [['renew', 2], ['approve', 5], ['disapprove', 2]]) {
    test(`${authMode}: ${action} проверяет новый статус в задаче REST`, async (t) => {
      const method = `tasks.task.${action}`;
      const { driver, calls } = fixture(t, { authMode, respond: (name) => name === method
        ? Response.json({ result: { task: {
          id: '42',
          status: String(status),
          title: 'Задача',
        } } })
        : null });
      const task = await driver[`${action}Task`]('42');

      assert.equal(task.id, 42);
      assert.equal(task.status, status);
      assert.deepEqual(sent(calls, method), { taskId: '42' });
      assert.equal(driver.capabilities[action === 'renew' ? 'renew' : 'review'], true);
    });

    for (const result of [true, {}, { task: { id: '42', status: '4' } },
      { task: { id: '43', status: String(status) } }]) {
      test(`${authMode}: ${action} не маскирует неверный ответ ${JSON.stringify(result)}`, async (t) => {
        const { driver } = fixture(t, { authMode, respond: (method) => method === `tasks.task.${action}`
          ? Response.json({ result }) : null });

        await assert.rejects(driver[`${action}Task`]('42'), { code: 'tracker_rest_error' });
      });
    }
  }

  for (const parentId of [undefined, '10']) {
    test(`${authMode}: добавление пункта, parent=${parentId}`, async (t) => {
      const { driver, calls } = fixture(t, {
        authMode,
        respond: (method) => method === 'task.checklistitem.add'
        ? Response.json({ result: 11 }) : null });

      assert.equal(await driver.addChecklistItem('42', { title: 'Пункт', parentId }), '11');
      assert.deepEqual(sent(calls, 'task.checklistitem.add'), {
        TASKID: '42',
        FIELDS: { TITLE: 'Пункт', ...(parentId ? { PARENT_ID: parentId } : {}) },
      });
      assert.equal(driver.capabilities.checklist, true);
    });
  }

  for (const [input, method, fields] of [
    [{ title: 'Новое имя' }, 'update', { FIELDS: { TITLE: 'Новое имя' } }],
    [{ complete: true }, 'complete', {}],
    [{ complete: false }, 'renew', {}],
  ]) {
    test(`${authMode}: изменение пункта через ${method}`, async (t) => {
      const rest = `task.checklistitem.${method}`;
      const { driver, calls } = fixture(t, { authMode, respond: (name) => name === rest
        ? Response.json({ result: method === 'complete' ? true : null }) : null });

      assert.equal(await driver.updateChecklistItem('42', '11', input), true);
      assert.deepEqual(sent(calls, rest), {
        TASKID: '42',
        ITEMID: '11',
        ...fields,
      });
    });
  }

  test(`${authMode}: удаление пункта через старый API`, async (t) => {
    const { driver, calls } = fixture(t, {
      authMode,
      respond: (method) => method === 'task.checklistitem.delete'
      ? Response.json({ result: true }) : null });

    assert.equal(await driver.deleteChecklistItem('42', '11'), true);
    assert.deepEqual(sent(calls, 'task.checklistitem.delete'), { TASKID: '42', ITEMID: '11' });
  });

  for (const tags of [[], ['Версия', 'Релиз']]) {
    test(`${authMode}: теги ${JSON.stringify(tags)} сохраняют очистку в urlencoded`, async (t) => {
      const { driver, calls } = fixture(t, { authMode, respond: (method) => method === 'task.item.update'
        ? Response.json({ result: null }) : null });

      await driver.updateTaskTags('42', tags);

      const expected = tags.length ? tags : [''];

      assert.deepEqual(sent(calls, 'task.item.update'), {
        TASKID: '42',
        FIELDS: { TAGS: authMode === 'password' ? { ...expected } : expected },
      });
      assert.equal(driver.capabilities.tags, true);
    });
  }

  for (const value of ['', null, [], [7, '9']]) {
    test(`${authMode}: участники ${JSON.stringify(value)} передаются без потери очистки`, async (t) => {
      const { driver, calls } = fixture(t, { authMode });

      await driver.updateTask('42', { accomplices: value, auditors: value });

      const expected = Array.isArray(value) && value.length
        ? authMode === 'password' ? { 0: '7', 1: '9' } : [7, 9] : '';

      assert.deepEqual(sent(calls, 'tasks.task.update'), {
        taskId: '42',
        fields: { ACCOMPLICES: expected, AUDITORS: expected },
      });
    });
  }

  for (const [method, invoke] of [
    ['tasks.task.renew', (driver) => driver.renewTask('42')],
    ['tasks.task.approve', (driver) => driver.approveTask('42')],
    ['tasks.task.disapprove', (driver) => driver.disapproveTask('42')],
    ['task.checklistitem.add', (driver) => driver.addChecklistItem('42', { title: 'Пункт' })],
    ['task.checklistitem.update', (driver) => driver.updateChecklistItem('42', '11', { title: 'Имя' })],
    ['task.checklistitem.complete', (driver) => driver.updateChecklistItem('42', '11', { complete: true })],
    ['task.checklistitem.renew', (driver) => driver.updateChecklistItem('42', '11', { complete: false })],
    ['task.checklistitem.delete', (driver) => driver.deleteChecklistItem('42', '11')],
    ['task.item.update', (driver) => driver.updateTaskTags('42', [])],
  ]) {
    test(`${authMode}: ${method} сохраняет 404 и не повторяет мутацию`, async (t) => {
      const { driver, state, calls } = fixture(t, { authMode });

      Object.assign(state, {
        restMethod: method,
        restError: 'TASK_NOT_FOUND',
        restStatus: 404,
      });
      await assert.rejects(invoke(driver), { code: 'task_not_found', status: 404 });
      assert.equal(calls.filter((call) => call.url.endsWith(`/rest/${method}`)).length, 1);
    });
  }
}

test('Неверные участники отклоняются до портала, undefined оставляет поле отсутствующим', async (t) => {
  const { driver, calls } = fixture(t);

  for (const key of ['accomplices', 'auditors']) {
    for (const value of ['7', {}, [0], [-1], [1.2], [true], [null], ['7x']]) {
      await assert.rejects(driver.updateTask('42', { [key]: value }), { code: 'tracker_bad_request' });
    }
  }

  assert.equal(calls.length, 0);
  await driver.updateTask('42', { accomplices: undefined, title: 'Имя' });
  assert.deepEqual(sent(calls, 'tasks.task.update').fields, { TITLE: 'Имя' });
});
