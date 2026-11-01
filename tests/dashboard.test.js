import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './fixtures/portal.js';

for (const authMode of ['token', 'password']) {
  for (const [label, group, responsible, expected] of [
    ['объекты REST', { id: '9', name: 'Проект' }, { id: '7', name: 'Исполнитель' },
      { group: 'Проект', responsible: 'Исполнитель' }],
    ['пустой проект облака', {}, {
      id: '7',
      name: 'Исполнитель',
      workPosition: '',
    },
      { group: '', responsible: 'Исполнитель' }],
    ['строковые подписи', 'Проект', 'Исполнитель', { group: 'Проект', responsible: 'Исполнитель' }],
    ['отсутствующие подписи', undefined, undefined, { group: '', responsible: '' }],
    ['пустые подписи', null, null, { group: '', responsible: '' }],
    ['некорректные имена', { name: 123 }, { name: false }, { group: '', responsible: '' }],
  ]) {
    test(`${authMode}: доска переводит ${label} в строковые подписи во всех ролях`, async (t) => {
      const raw = {
        id: '42',
        title: 'Задача',
        status: '3',
        responsibleId: '7',
        createdBy: '7',
        group,
        responsible,
      };
      const { driver } = fixture(t, { authMode, respond: (method) => method === 'tasks.task.list'
        ? Response.json({ result: { tasks: [raw] } }) : null });
      const dashboard = await driver.getDashboard();

      for (const key of ['tasks', 'created', 'accomplice', 'auditor']) {
        assert.equal(dashboard[key].length, 1);
        assert.equal(dashboard[key][0].group, expected.group);
        assert.equal(dashboard[key][0].responsible, expected.responsible);
      }
    });
  }

  test(`${authMode}: доска нормализует задачу приёмки, детали сохраняют объект исполнителя`, async (t) => {
    const responsible = {
      id: '7',
      name: 'Исполнитель',
      link: '/user/7/',
      workPosition: '',
    };
    const group = { id: '9', name: 'Проект' };
    const raw = {
      id: '42',
      title: 'Задача на приёмке',
      status: '4',
      responsibleId: '7',
      createdBy: '7',
      responsible,
      group,
    };
    const { driver } = fixture(t, { authMode, respond: (method) => {
      if (method === 'tasks.task.list') {
        return Response.json({ result: { tasks: [raw] } });
      }

      return method === 'tasks.task.get' ? Response.json({ result: { task: raw } }) : null;
    } });
    const dashboard = await driver.getDashboard();
    const detail = await driver.taskDetail('42');

    assert.equal(dashboard.tasks.length, 0);
    assert.equal(dashboard.toReview[0].responsible, 'Исполнитель');
    assert.equal(dashboard.toReview[0].group, 'Проект');
    assert.deepEqual(detail.responsible, responsible);
    assert.deepEqual(detail.group, group);
  });
}
