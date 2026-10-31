import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createDriver from '../../driver.ts';

/**
 * Эмулятор портала проверяет форму, куки и CSRF отдельно от ответов REST.
 * Смена реквизитов и истечение сессии управляются тестом без настоящего подключения.
 */
export function fixture(t, {
  authMode = 'password', challenge = null, redirect = '/', respond = null,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stock-auth-'));
  const calls = [];
  const state = {
    session: 0,
    expired: false,
    restError: null,
    restMethod: null,
    restStatus: 200,
    restDescription: null,
    challenge,
    redirect,
  };
  let values = {
    baseUrl: 'https://portal.fixture',
    authMode,
    accessToken: 'fixture-token',
    login: 'fixture-login',
    password: 'fixture-password',
  };

  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const page = () => new Response(`BX.message({'bitrix_sessid':'csrf${state.session}'});`);
  const host = {
    credentials: { read: () => values },
    cookiePath: join(directory, 'cookies.json'),
    dataDir: directory,
    serial: (operation) => operation(),
    logger: { info: () => {}, warn: () => {} },
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const cookie = options.headers.Cookie ?? '';

      calls.push({ url, options });

      if (options.method === 'POST' && path === '/') {
        const form = new URLSearchParams(options.body);

        assert.equal(form.get('AUTH_FORM'), 'Y');
        assert.equal(form.get('TYPE'), 'AUTH');
        assert.equal(form.get('USER_REMEMBER'), 'Y');
        assert.equal(form.get('USER_LOGIN'), values.login);
        assert.equal(form.get('USER_PASSWORD'), values.password);
        assert.equal(cookie, '');

        if (state.challenge) {
          return new Response(`<input name="${state.challenge}">`);
        }

        if (values.password === 'invalid') {
          return new Response('<input name="USER_PASSWORD"><div>Неверный пароль</div>');
        }

        state.session += 1;
        state.expired = false;

        return new Response(null, { status: 302, headers: {
          location: state.redirect,
          'set-cookie': `PHPSESSID=session${state.session}; Path=/; HttpOnly`,
        } });
      }

      if (path === '/') {
        assert.equal(cookie, `PHPSESSID=session${state.session}`);

        return page();
      }

      assert.ok(path.startsWith('/rest/'));

      const fields = JSON.parse(options.body);

      if (values.authMode === 'password') {
        assert.equal(cookie, `PHPSESSID=session${state.session}`);
        assert.equal(fields.sessid, `csrf${state.session}`);
        assert.equal(options.headers['X-Bitrix-Csrf-Token'], fields.sessid);
        assert.equal(Object.hasOwn(fields, 'auth'), false);

        if (state.expired) {
          return Response.json({ error: 'NO_AUTH' }, { status: 401 });
        }
      } else {
        assert.equal(fields.auth, values.accessToken);
        assert.equal(Object.hasOwn(fields, 'sessid'), false);
        assert.equal(cookie, '');
        assert.equal(options.redirect, 'error');
      }

      const method = path.slice('/rest/'.length);

      if (state.restError && (!state.restMethod || state.restMethod === method)) {
        return Response.json({
          error: state.restError,
          error_description: state.restDescription ?? values.password,
        }, { status: state.restStatus });
      }

      if (respond) {
        const response = await respond(method, fields, state);

        if (response) {
          return response;
        }
      }

      const task = {
        id: '42',
        title: 'Задача',
        status: '3',
        responsibleId: '7',
        createdBy: '7',
      };
      const responses = {
        'user.current': { ID: '7' },
        'tasks.task.list': { tasks: [task] },
        'tasks.task.get': { task },
        'tasks.task.add': { task },
        'tasks.task.update': { task },
        'tasks.task.complete': true,
        'task.commentitem.getlist': [],
        'task.commentitem.add': 101,
        'user.get': [{ ID: '7', NAME: 'Иван' }],
        'sonet_group.get': [{ ID: '9', NAME: 'Проект' }],
      };

      assert.ok(Object.hasOwn(responses, method), method);

      return Response.json({ result: responses[method] });
    },
  };

  return {
    driver: createDriver(host),
    host,
    state,
    calls,
    loginCalls: () => calls.filter((call) => new URL(call.url).searchParams.has('login')),
    change: (changes) => {
      values = { ...values, ...changes };
    },
  };
}

