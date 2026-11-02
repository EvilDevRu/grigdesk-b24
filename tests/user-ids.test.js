import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, sentFields } from './fixtures/portal.js';

for (const key of ['responsibleId', 'accomplices', 'auditors']) {
  test(`Стоковый Б24 отвергает непрозрачный ${key} до сети`, async (t) => {
    const { driver, calls } = fixture(t, { authMode: 'token' });
    const value = key === 'responsibleId' ? 'jira:account' : [7, 'jira:account'];

    for (const operation of [
      () => driver.updateTask('42', { [key]: value }),
      () => driver.createTask({ title: 'Новая', [key]: value }),
    ]) {
      await assert.rejects(operation(), {
        code: 'b24_bad_request',
        message: /нужен числовой id портала/u,
      });
    }

    assert.equal(calls.length, 0);
  });
}

test('Стоковый Б24 сохраняет числовых участников и явную очистку', async (t) => {
  const { driver, calls } = fixture(t, { authMode: 'token' });

  await driver.updateTask('42', {
    responsibleId: '7',
    accomplices: [7, '9'],
    auditors: [],
  });
  assert.deepEqual(sentFields(calls.at(-1)).fields, {
    RESPONSIBLE_ID: 7,
    ACCOMPLICES: [7, 9],
    AUDITORS: '',
  });
});
