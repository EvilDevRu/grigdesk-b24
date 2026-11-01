import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, sentFields } from './fixtures/portal.js';

for (const authMode of ['token', 'password']) {
  test(`${authMode}: start, pause и stop используют настоящий REST и локальную карту`, async (t) => {
    const raw = {
      id: '42',
      status: '3',
      createdBy: { id: '7', name: 'Автор' },
      responsible: { id: '7', name: 'Исполнитель' },
      timeSpentInLogs: '125',
    };
    const { driver, calls } = fixture(t, { authMode, respond: (method) => {
      if (method === 'tasks.task.get') {
        return Response.json({ result: { task: raw } });
      }

      return null;
    } });
    const initial = await driver.taskDetail('42');

    assert.equal(driver.capabilities.timer, true);
    assert.equal(initial.timerRunning, false);
    assert.equal(initial.timerStartedAt, null);
    assert.equal(initial.timerElapsed, 125);
    assert.deepEqual(initial.createdBy, raw.createdBy);
    assert.equal(initial.responsibleId, 7);

    const before = Math.floor(Date.now() / 1000);

    await driver.timer('start', '42');

    const running = await driver.taskDetail('42');

    assert.equal(running.timerRunning, true);
    assert.equal(running.statusKind, 'running');
    assert.ok(running.timerStartedAt >= before);
    assert.ok(running.timerStartedAt <= Math.floor(Date.now() / 1000));
    assert.equal(running.timerElapsed, 125);
    assert.equal((await driver.listTasks())[0].timerRunning, true);

    for (const action of ['pause', 'stop']) {
      if (action === 'stop') {
        await driver.timer('start', '42');
      }

      await driver.timer(action, '42');

      const paused = await driver.taskDetail('42');

      assert.equal(paused.timerRunning, false);
      assert.equal(paused.timerStartedAt, null);
      assert.equal(paused.timerElapsed, 125);
    }

    const timerCalls = calls.filter(({ url }) => /timer$/u.test(url));

    assert.deepEqual(timerCalls.map(({ url }) => url.split('/').at(-1)), [
      'tasks.task.starttimer', 'tasks.task.pausetimer',
      'tasks.task.starttimer', 'tasks.task.pausetimer',
    ]);
    assert.ok(timerCalls.every((call) => String(sentFields(call).taskId) === '42'));
    raw.timeSpentInLogs = null;
    assert.equal((await driver.taskDetail('42')).timerElapsed, 0);
    await assert.rejects(driver.timer('get', '42'), /Неизвестное действие/u);
  });

  test(`${authMode}: отказ timer не меняет карту, смена аккаунта её очищает`, async (t) => {
    const { driver, state, change } = fixture(t, { authMode });

    state.restMethod = 'tasks.task.starttimer';
    state.restError = 'ACCESS_DENIED';
    await assert.rejects(driver.timer('start', '42'));
    state.restError = null;
    assert.equal((await driver.taskDetail('42')).timerRunning, false);
    await driver.timer('start', '42');
    state.restMethod = 'tasks.task.pausetimer';
    state.restError = 'ACCESS_DENIED';
    await assert.rejects(driver.timer('pause', '42'));
    state.restError = null;
    assert.equal((await driver.taskDetail('42')).timerRunning, true);
    change(authMode === 'token' ? { accessToken: 'other-token' } : { password: 'other-password' });
    assert.equal((await driver.taskDetail('42')).timerRunning, false);
  });

  test(`${authMode}: overdue зависит от срока и статуса, select содержит секунды`, async (t) => {
    const past = '2020-01-01T01:00:00+07:00';
    const future = '2099-01-01T01:00:00+07:00';
    const cases = [
      [past, '3', true], [past, '4', true], [past, '5', false],
      [past, '6', false], [future, '3', false], [null, '3', false], ['invalid', '3', false],
    ];
    const { driver } = fixture(t, { authMode, respond: (method, fields) => {
      if (method !== 'tasks.task.list') {
        return null;
      }

      assert.ok(Object.values(fields.select).includes('TIME_SPENT_IN_LOGS'));

      return Response.json({ result: { tasks: cases.map(([deadline, status], index) => ({
        id: String(index + 1),
        title: 'Задача',
        status,
        deadline,
        timeSpentInLogs: '3600',
        group: { name: 'Проект' },
        responsible: { name: 'Исполнитель' },
      })) } });
    } });
    const tasks = await driver.listTasks();

    assert.deepEqual(tasks.map((task) => task.overdue), cases.map(([, , over]) => over));
    assert.ok(tasks.every((task) => task.timerElapsed === 3600));
    assert.ok(tasks.every((task) => task.group === 'Проект' && task.responsible === 'Исполнитель'));
  });

  for (const tagsFail of [false, true]) {
    test(`${authMode}: pageData с тегами и подзадачами, отказ тегов=${tagsFail}`, async (t) => {
      const { driver } = fixture(t, { authMode, respond: (method, fields) => {
        if (method === 'task.item.gettags') {
          assert.equal(String(fields.TASKID), '42');

          return tagsFail ? Response.json({ error: 'ACCESS_DENIED' }, { status: 403 })
            : Response.json({ result: ['Релиз', 'Проверить'] });
        }

        if (method === 'tasks.task.list') {
          assert.deepEqual(fields.filter, { PARENT_ID: '42' });
          assert.deepEqual(Object.values(fields.select), ['ID', 'TITLE', 'STATUS']);

          return Number(fields.start) === 0
            ? Response.json({ result: { tasks: [{
              id: '43',
              title: 'Первая',
              status: '2',
            }] }, next: 50 })
            : Response.json({ result: { tasks: [{
              id: '44',
              title: 'Вторая',
              status: '5',
            }] } });
        }

        return null;
      } });
      const page = await driver.taskPageData('42');

      assert.deepEqual(page.comments, []);
      assert.deepEqual(page.attachments, []);
      assert.deepEqual(page.tags, tagsFail ? [] : ['Релиз', 'Проверить']);
      assert.deepEqual(page.subtasks, [
        {
          id: 43,
          title: 'Первая',
          statusText: 'Ждёт выполнения',
        },
        {
          id: 44,
          title: 'Вторая',
          statusText: 'Завершена',
        },
      ]);
    });
  }
}
