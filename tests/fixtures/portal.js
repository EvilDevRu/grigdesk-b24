import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createDriver from '../../driver.ts';

/**
 * Эмулятор портала проверяет форму, куки и CSRF отдельно от ответов REST.
 * Смена реквизитов и истечение сессии управляются тестом без настоящего подключения.
 * cloudPage имитирует облачные порталы: страницы не содержат bitrix_sessid,
 * и токен выдаётся только отказом session_failed на первом REST-запросе.
 */
export function fixture(t, {
  authMode = 'password', challenge = null, redirect = '/', respond = null, cloudPage = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stock-auth-'));
  const calls = [];
  const state = {
    session: 0,
    rotation: 0,
    csrf: null,
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

  const page = () => new Response(cloudPage
    ? '<html id="cloud-shell">Задачи</html>'
    : `BX.message({'bitrix_sessid':'${state.csrf}'});`);

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
        state.rotation = 0;
        state.csrf = `csrf${state.session}x${state.rotation}`;

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

      let fields;

      if (values.authMode === 'password') {
        assert.equal(cookie, `PHPSESSID=session${state.session}`);
        assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
        assert.match(options.headers['Content-Type'] ?? '', /application\/x-www-form-urlencoded/u);

        if (state.expired) {
          return Response.json({ error: 'NO_AUTH' }, { status: 401 });
        }

        const params = new URLSearchParams(options.body);

        if (params.get('sessid') !== state.csrf) {
          state.rotation += 1;
          state.csrf = `csrf${state.session}x${state.rotation}`;

          return Response.json({
            error: 'session_failed',
            error_description: 'Sessid check failed',
            sessid: state.csrf,
          }, { status: 401 });
        }

        fields = expand(params);
      } else {
        assert.equal(options.redirect, 'error');
        assert.equal(cookie, '');
        fields = JSON.parse(options.body);
        assert.equal(fields.auth, values.accessToken);
        assert.equal(Object.hasOwn(fields, 'sessid'), false);
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

/**
 * Плоская форма REST возвращается к исходной форме полей: a[b] становится вложенным.
 * Числа остаются строками — точное сравнение типов ведут сами тесты.
 */
function expand(params) {
  const root = {};

  for (const [key, value] of params) {
    if (key === 'sessid') {
      continue;
    }

    const path = key.replace(/\]/gu, '').split('[');
    let node = root;

    for (let index = 0; index + 1 < path.length; index += 1) {
      node = node[path[index]] ??= {};
    }

    node[path.at(-1)] = value;
  }

  return root;
}

/**
 * Поля отправленного REST-запроса в исходной форме для любого режима авторизации.
 * Тесты проверяют семантику вызова, не завися от транспорта режима.
 */
export function sentFields(call) {
  const type = call.options.headers['Content-Type'] ?? call.options.headers['content-type'] ?? '';

  if (type.includes('json')) {
    const { auth, ...fields } = JSON.parse(call.options.body);

    return fields;
  }

  return expand(new URLSearchParams(call.options.body));
}
